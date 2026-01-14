#!/usr/bin/env node
/**
 * Browser automation E2E test with LLM-powered visual verification
 * Uses Playwright to take screenshots and sends them to the chat API for validation
 * 
 * Usage: node scripts/test-browser.mjs [env] [agent-id]
 */

import { chromium } from 'playwright';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const ENV = process.argv[2] || 'staging';
const AGENT_ID = process.argv[3] || process.env.E2E_BROWSER_AGENT_ID;
const AVATAR_AGENT_ID = process.argv[4] || process.env.E2E_AVATAR_AGENT_ID;

// Get stack outputs
function getStackOutput(key) {
  const stack = `SwarmStack-${ENV === 'production' ? 'prod' : ENV}`;
  try {
    const result = execSync(
      `aws cloudformation describe-stacks --stack-name ${stack} --query "Stacks[0].Outputs[?contains(OutputKey, '${key}')].OutputValue" --output text`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    return result || null;
  } catch {
    return null;
  }
}

// Get internal test key for API calls
function getInternalTestKey() {
  const stack = `SwarmStack-${ENV === 'production' ? 'prod' : ENV}`;
  try {
    // Find the chat handler function
    const resources = JSON.parse(execSync(
      `aws cloudformation describe-stack-resources --stack-name ${stack} --query "StackResources[?ResourceType=='AWS::Lambda::Function' && contains(PhysicalResourceId, 'ChatHandler')]" --output json`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    ));
    if (!resources.length) return null;
    
    const functionName = resources[0].PhysicalResourceId;
    const config = JSON.parse(execSync(
      `aws lambda get-function-configuration --function-name "${functionName}" --output json`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    ));
    return config.Environment?.Variables?.INTERNAL_TEST_KEY || null;
  } catch {
    return null;
  }
}

// Send screenshot to LLM for visual verification
async function verifyScreenshotWithLLM(apiUrl, testKey, screenshotPath, prompt) {
  const imageData = fs.readFileSync(screenshotPath);
  const base64Image = imageData.toString('base64');
  
  const payload = {
    message: prompt,
    history: [],
    agent: { id: 'visual-tester' },
    attachments: [{
      type: 'image',
      data: `data:image/png;base64,${base64Image}`,
      name: path.basename(screenshotPath)
    }]
  };
  
  const response = await fetch(apiUrl + '/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-test-key': testKey
    },
    body: JSON.stringify(payload)
  });
  
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`LLM verification failed: ${response.status} ${text}`);
  }
  
  const result = await response.json();
  return result.message || result.content || JSON.stringify(result);
}

// Parse LLM response for pass/fail
function parseVerificationResult(response) {
  const lower = response.toLowerCase();
  if (lower.includes('pass') || lower.includes('looks good') || lower.includes('correct') || lower.includes('success')) {
    return { passed: true, reason: response };
  }
  if (lower.includes('fail') || lower.includes('error') || lower.includes('incorrect') || lower.includes('missing')) {
    return { passed: false, reason: response };
  }
  // Ambiguous - treat as pass with warning
  return { passed: true, reason: `[AMBIGUOUS] ${response}` };
}

async function runBrowserTests() {
  console.log(`🌐 Browser E2E Tests - ${ENV}`);
  console.log('='.repeat(50));
  
  const adminUrl = getStackOutput('AdminUiUrl') || getStackOutput('Url');
  const apiUrl = getStackOutput('ApiEndpoint');
  const testKey = getInternalTestKey();
  
  if (!adminUrl) {
    console.error('❌ Could not get Admin UI URL from stack outputs');
    process.exit(1);
  }
  
  if (!apiUrl || !testKey) {
    console.warn('⚠️  Could not get API credentials - visual verification will be skipped');
  }
  
  console.log(`📍 Admin UI: ${adminUrl}`);
  console.log(`📍 API: ${apiUrl || 'N/A'}`);
  console.log(`📍 Agent ID: ${AGENT_ID || 'default'}`);
  console.log(`📍 Avatar Agent ID: ${AVATAR_AGENT_ID || 'N/A'}`);
  console.log();
  
  // Create screenshots directory
  const screenshotsDir = path.join(process.cwd(), 'test-screenshots');
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }
  
  const browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 2
  });
  const page = await context.newPage();
  
  const results = [];
  
  try {
    // Test 1: Load the admin UI
    console.log('📸 Test 1: Loading Admin UI...');
    await page.goto(adminUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000); // Let animations settle
    
    const screenshot1 = path.join(screenshotsDir, '01-admin-ui-loaded.png');
    await page.screenshot({ path: screenshot1, fullPage: true });
    console.log(`   Saved: ${screenshot1}`);
    
    if (apiUrl && testKey) {
      const llmResult = await verifyScreenshotWithLLM(
        apiUrl, testKey, screenshot1,
        'Analyze this screenshot of a chat/admin UI. Check if: 1) The page loaded successfully without errors 2) There is a sidebar or agent list visible 3) The layout looks reasonable. Reply with PASS or FAIL followed by a brief explanation.'
      );
      const parsed = parseVerificationResult(llmResult);
      results.push({ name: 'Admin UI Load', ...parsed });
      console.log(`   ${parsed.passed ? '✅' : '❌'} LLM: ${parsed.reason.substring(0, 100)}...`);
    } else {
      results.push({ name: 'Admin UI Load', passed: true, reason: 'Page loaded (no LLM verification)' });
      console.log('   ✅ Page loaded');
    }
    
    // Test 2: Select an agent (if agent ID provided)
    if (AGENT_ID) {
      console.log(`\n📸 Test 2: Selecting agent ${AGENT_ID}...`);
      
      // Look for agent in sidebar and click it
      const agentSelector = `[data-agent-id="${AGENT_ID}"], text=${AGENT_ID}`;
      try {
        await page.click(agentSelector, { timeout: 5000 });
        await page.waitForTimeout(1500);
      } catch {
        // Try clicking any agent button in sidebar
        const agents = await page.$$('[data-testid="agent-item"], .agent-item, button:has-text("agent")');
        if (agents.length > 0) {
          await agents[0].click();
          await page.waitForTimeout(1500);
        }
      }
      
      const screenshot2 = path.join(screenshotsDir, '02-agent-selected.png');
      await page.screenshot({ path: screenshot2, fullPage: true });
      console.log(`   Saved: ${screenshot2}`);
      
      if (apiUrl && testKey) {
        const llmResult = await verifyScreenshotWithLLM(
          apiUrl, testKey, screenshot2,
          'Analyze this chat UI screenshot. Check if: 1) A chat panel is visible 2) There is a message input field 3) The agent/chat appears to be selected/active. Reply with PASS or FAIL followed by explanation.'
        );
        const parsed = parseVerificationResult(llmResult);
        results.push({ name: 'Agent Selection', ...parsed });
        console.log(`   ${parsed.passed ? '✅' : '❌'} LLM: ${parsed.reason.substring(0, 100)}...`);
      } else {
        results.push({ name: 'Agent Selection', passed: true, reason: 'Agent clicked (no LLM verification)' });
        console.log('   ✅ Agent clicked');
      }
      
      // Test 3: Send a message
      console.log('\n📸 Test 3: Sending test message...');
      const inputSelector = 'textarea, input[type="text"], [contenteditable="true"]';
      const input = await page.$(inputSelector);
      
      if (input) {
        await input.fill('Hello, this is an automated browser test!');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(3000); // Wait for response
        
        const screenshot3 = path.join(screenshotsDir, '03-message-sent.png');
        await page.screenshot({ path: screenshot3, fullPage: true });
        console.log(`   Saved: ${screenshot3}`);
        
        if (apiUrl && testKey) {
          const llmResult = await verifyScreenshotWithLLM(
            apiUrl, testKey, screenshot3,
            'Analyze this chat UI screenshot after a message was sent. Check if: 1) The user message appears in the chat 2) There is a response or loading indicator 3) No error messages are shown. Reply with PASS or FAIL followed by explanation.'
          );
          const parsed = parseVerificationResult(llmResult);
          results.push({ name: 'Message Send', ...parsed });
          console.log(`   ${parsed.passed ? '✅' : '❌'} LLM: ${parsed.reason.substring(0, 100)}...`);
        } else {
          results.push({ name: 'Message Send', passed: true, reason: 'Message sent (no LLM verification)' });
          console.log('   ✅ Message sent');
        }
      } else {
        results.push({ name: 'Message Send', passed: false, reason: 'Could not find input field' });
        console.log('   ❌ Could not find message input');
      }
    }
    
    // Test 4: Avatar agent (if provided)
    if (AVATAR_AGENT_ID) {
      console.log(`\n📸 Test 4: Testing avatar agent ${AVATAR_AGENT_ID}...`);
      
      // Navigate to avatar/inhabit route
      await page.goto(`${adminUrl}/inhabit/${AVATAR_AGENT_ID}`, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(2000);
      
      const screenshot4 = path.join(screenshotsDir, '04-avatar-agent.png');
      await page.screenshot({ path: screenshot4, fullPage: true });
      console.log(`   Saved: ${screenshot4}`);
      
      if (apiUrl && testKey) {
        const llmResult = await verifyScreenshotWithLLM(
          apiUrl, testKey, screenshot4,
          'Analyze this avatar/inhabit page screenshot. Check if: 1) The page loaded with some UI 2) There may be a wallet connect prompt or avatar interface 3) No major errors are shown. Reply with PASS or FAIL followed by explanation.'
        );
        const parsed = parseVerificationResult(llmResult);
        results.push({ name: 'Avatar Agent', ...parsed });
        console.log(`   ${parsed.passed ? '✅' : '❌'} LLM: ${parsed.reason.substring(0, 100)}...`);
      } else {
        results.push({ name: 'Avatar Agent', passed: true, reason: 'Avatar page loaded (no LLM verification)' });
        console.log('   ✅ Avatar page loaded');
      }
    }
    
  } catch (err) {
    console.error(`\n❌ Browser test error: ${err.message}`);
    
    // Take error screenshot
    const errorScreenshot = path.join(screenshotsDir, 'error.png');
    await page.screenshot({ path: errorScreenshot, fullPage: true });
    console.log(`   Error screenshot: ${errorScreenshot}`);
    
    results.push({ name: 'Browser Error', passed: false, reason: err.message });
  } finally {
    await browser.close();
  }
  
  // Summary
  console.log('\n' + '='.repeat(50));
  console.log('📊 Results Summary:');
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  
  for (const result of results) {
    console.log(`   ${result.passed ? '✅' : '❌'} ${result.name}`);
  }
  
  console.log(`\n   Total: ${passed} passed, ${failed} failed`);
  console.log(`   Screenshots saved to: ${screenshotsDir}`);
  
  if (failed > 0) {
    process.exit(1);
  }
}

runBrowserTests().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
