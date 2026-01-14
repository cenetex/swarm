#!/usr/bin/env node
/**
 * Autonomous Browser Agent E2E Test
 * 
 * An LLM agent that explores the admin UI with minimal context,
 * discovers how to create an agent, and has a conversation.
 * 
 * The agent receives only:
 * - A screenshot of the current page state
 * - A high-level goal ("explore this app and create a new AI agent")
 * - Its own history of observations and actions
 * 
 * Authentication:
 * - Cloudflare Access: Uses service token headers (CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET)
 * - Wallet Auth: Uses a test wallet keypair to sign challenges programmatically
 * 
 * Usage: node scripts/test-browser.mjs [env]
 * 
 * Environment Variables:
 *   CF_ACCESS_CLIENT_ID     - Cloudflare Access service token client ID
 *   CF_ACCESS_CLIENT_SECRET - Cloudflare Access service token client secret
 *   TEST_WALLET_PRIVATE_KEY - Base58 encoded private key for test wallet (optional)
 */

import { chromium } from 'playwright';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

const ENV = process.argv[2] || 'staging';
const MAX_STEPS = 25;
const STEP_DELAY = 1500;

function getStackOutput(exportNameSuffix) {
  const stack = `SwarmStack-${ENV === 'production' ? 'prod' : ENV}`;
  const exportName = `swarm-${exportNameSuffix}-${ENV === 'production' ? 'prod' : ENV}`;
  try {
    // Use ExportName which is stable (not OutputKey which has CDK hash suffix)
    const result = execSync(
      `aws cloudformation describe-stacks --stack-name ${stack} --query "Stacks[0].Outputs[?ExportName=='${exportName}'].OutputValue | [0]" --output text`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    return result && result !== 'None' ? result : null;
  } catch {
    return null;
  }
}

function getInternalTestKey() {
  const stack = `SwarmStack-${ENV === 'production' ? 'prod' : ENV}`;
  try {
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

// ============================================================================
// Cloudflare Access Authentication
// ============================================================================

const CF_ACCESS_CLIENT_ID = process.env.CF_ACCESS_CLIENT_ID;
const CF_ACCESS_CLIENT_SECRET = process.env.CF_ACCESS_CLIENT_SECRET;

function getCloudflareAccessHeaders() {
  if (!CF_ACCESS_CLIENT_ID || !CF_ACCESS_CLIENT_SECRET) {
    return {};
  }
  return {
    'CF-Access-Client-Id': CF_ACCESS_CLIENT_ID,
    'CF-Access-Client-Secret': CF_ACCESS_CLIENT_SECRET,
  };
}

// ============================================================================
// Test Wallet for Programmatic Signing
// ============================================================================

/**
 * Generate or load a test wallet keypair
 * If TEST_WALLET_PRIVATE_KEY is set, use it; otherwise generate a new one
 */
function getTestWallet() {
  const privateKeyBase58 = process.env.TEST_WALLET_PRIVATE_KEY;
  
  if (privateKeyBase58) {
    // Load existing wallet from private key
    const secretKey = bs58.decode(privateKeyBase58);
    const keypair = nacl.sign.keyPair.fromSecretKey(secretKey);
    const publicKey = bs58.encode(keypair.publicKey);
    console.log(`📛 Using test wallet: ${publicKey.slice(0, 8)}...`);
    return { keypair, publicKey };
  }
  
  // Generate ephemeral test wallet
  const keypair = nacl.sign.keyPair();
  const publicKey = bs58.encode(keypair.publicKey);
  const secretKeyBase58 = bs58.encode(keypair.secretKey);
  console.log(`🔑 Generated ephemeral test wallet: ${publicKey.slice(0, 8)}...`);
  console.log(`   (Set TEST_WALLET_PRIVATE_KEY=${secretKeyBase58} to reuse)`);
  return { keypair, publicKey };
}

/**
 * Sign a message with the test wallet
 */
function signMessage(message, keypair) {
  const messageBytes = new TextEncoder().encode(message);
  const signature = nacl.sign.detached(messageBytes, keypair.secretKey);
  return bs58.encode(signature);
}

/**
 * Authenticate with the API using wallet signature
 * Returns the session cookie to use in subsequent requests
 */
async function authenticateWithWallet(apiUrl, testKey) {
  const wallet = getTestWallet();
  
  console.log('🔐 Authenticating with wallet...');
  
  // Step 1: Request challenge
  const challengeResponse = await fetch(`${apiUrl}/auth/challenge`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-test-key': testKey,
      ...getCloudflareAccessHeaders(),
    },
    body: JSON.stringify({ walletAddress: wallet.publicKey }),
  });
  
  if (!challengeResponse.ok) {
    const text = await challengeResponse.text();
    throw new Error(`Challenge request failed: ${challengeResponse.status} ${text}`);
  }
  
  const { nonce, message } = await challengeResponse.json();
  console.log(`   Challenge received (nonce: ${nonce.slice(0, 16)}...)`);
  
  // Step 2: Sign the challenge
  const signature = signMessage(message, wallet.keypair);
  console.log(`   Message signed`);
  
  // Step 3: Verify and get session
  const verifyResponse = await fetch(`${apiUrl}/auth/verify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-test-key': testKey,
      ...getCloudflareAccessHeaders(),
    },
    body: JSON.stringify({
      signature,
      publicKey: wallet.publicKey,
      nonce,
    }),
  });
  
  if (!verifyResponse.ok) {
    const text = await verifyResponse.text();
    throw new Error(`Verify request failed: ${verifyResponse.status} ${text}`);
  }
  
  // Extract session cookie from response
  const setCookie = verifyResponse.headers.get('set-cookie');
  const result = await verifyResponse.json();
  
  console.log(`   ✅ Authenticated as ${wallet.publicKey.slice(0, 8)}...`);
  
  return {
    sessionCookie: setCookie,
    walletAddress: wallet.publicKey,
    user: result.user,
  };
}

async function getPageElements(page) {
  try {
    const buttons = await page.locator('button:visible').allTextContents();
    const links = await page.locator('a:visible').allTextContents();
    
    // Extract input field info including aria-label, placeholder, name, and id
    const inputs = await page.locator('input:visible, textarea:visible').evaluateAll(els => 
      els.map(e => {
        const ariaLabel = e.getAttribute('aria-label');
        const placeholder = e.getAttribute('placeholder');
        const name = e.getAttribute('name');
        const id = e.id;
        const dataTestId = e.getAttribute('data-testid');
        
        // Prefer aria-label, then placeholder, then name, then id, then data-testid
        return ariaLabel || placeholder || name || id || dataTestId || e.type || '[unnamed]';
      }).filter(Boolean)
    );
    
    // Also extract buttons with aria-labels for icon buttons
    const ariaButtons = await page.locator('button:visible[aria-label]').evaluateAll(els =>
      els.map(e => e.getAttribute('aria-label')).filter(Boolean)
    );
    
    // Merge button texts with aria-labels
    const allButtons = [...buttons, ...ariaButtons];
    
    // Clean up - remove empty strings and duplicates
    const cleanButtons = [...new Set(allButtons.map(b => b.trim()).filter(b => b && b.length < 50))];
    const cleanLinks = [...new Set(links.map(l => l.trim()).filter(l => l && l.length < 50))];
    const cleanInputs = [...new Set(inputs.filter(i => i && i.length < 50))];
    
    return { buttons: cleanButtons, links: cleanLinks, inputs: cleanInputs };
  } catch {
    return { buttons: [], links: [], inputs: [] };
  }
}

async function getNextAction(apiUrl, testKey, screenshotPath, history, goal, pageElements) {
  const imageData = fs.readFileSync(screenshotPath);
  const base64Image = imageData.toString('base64');
  
  // Format available elements for the prompt
  const elementsSection = `
AVAILABLE CLICKABLE ELEMENTS ON THIS PAGE:
Buttons: ${pageElements.buttons.length > 0 ? pageElements.buttons.map(b => `"${b}"`).join(', ') : '(none visible)'}
Links: ${pageElements.links.length > 0 ? pageElements.links.map(l => `"${l}"`).join(', ') : '(none visible)'}
Input fields: ${pageElements.inputs.length > 0 ? pageElements.inputs.map(i => `"${i}"`).join(', ') : '(none visible)'}
`;

  const systemPrompt = `You are an autonomous browser agent exploring a web application.

YOUR GOAL: ${goal}

You can see a screenshot of the current page state. Based on what you observe, decide on ONE action to take.
${elementsSection}
AVAILABLE ACTIONS:
- CLICK: text - Click a button/link using EXACT text from the lists above
- TYPE: text - Type text into the currently focused input field  
- FILL: placeholder | text - Fill an input field (e.g., "Enter agent name | MyAgent")
- PRESS: key - Press a keyboard key (Enter, Tab, Escape)
- SCROLL: down/up - Scroll the page
- NAVIGATE: /path - Navigate to a URL path (e.g., "/agents/new")
- DONE: summary - Task complete, provide summary

CRITICAL RULES:
1. For CLICK: Copy the EXACT text from the "Buttons" or "Links" list above
2. For FILL: Use a value from the "Input fields" list as the first part
3. If no suitable button exists, try NAVIGATE to /agents/new or /agents
4. Don't invent button names - use only what's in the lists above

RESPONSE FORMAT (use exactly this format on separate lines):
OBSERVATION: [What you see on screen]
REASONING: [Why you're taking this action]
ACTION: [Exactly one action, e.g., CLICK: Create New Agent]

HISTORY OF YOUR ACTIONS:
${history.length > 0 ? history.map((h, i) => `Step ${i + 1}: ${h}`).join('\n') : '(Starting fresh - explore the interface!)'}
`;

  const payload = {
    message: 'Analyze the screenshot and decide your next action.',
    history: [],
    systemPrompt,
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
    throw new Error(`LLM request failed: ${response.status} ${text}`);
  }
  
  const result = await response.json();
  // The chat API returns { response: "...", history: [...] }
  return result.response || result.message || result.content || '';
}

function parseAction(response) {
  const lines = response.split('\n');
  let observation = '';
  let reasoning = '';
  let action = null;
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('OBSERVATION:')) {
      observation = trimmed.replace('OBSERVATION:', '').trim();
    } else if (trimmed.startsWith('REASONING:')) {
      reasoning = trimmed.replace('REASONING:', '').trim();
    } else if (trimmed.startsWith('ACTION:')) {
      action = trimmed.replace('ACTION:', '').trim();
    }
  }
  
  if (action) {
    const match = action.match(/^(\w+):\s*(.*)$/);
    if (match) {
      return {
        observation,
        reasoning,
        type: match[1].toUpperCase(),
        params: match[2].trim(),
        raw: action
      };
    }
  }
  
  const actionMatch = response.match(/ACTION:\s*(\w+):\s*(.*?)(\n|$)/i);
  if (actionMatch) {
    return {
      observation,
      reasoning,
      type: actionMatch[1].toUpperCase(),
      params: actionMatch[2].trim(),
      raw: actionMatch[0]
    };
  }
  
  return { observation, reasoning, type: 'WAIT', params: 'Could not parse action', raw: response };
}

async function executeAction(page, action) {
  const { type, params } = action;
  
  try {
    switch (type) {
      case 'CLICK': {
        const strategies = [
          // Exact text match
          () => page.click(`text="${params}"`, { timeout: 2000 }),
          // Partial/fuzzy text match  
          () => page.click(`text=${params}`, { timeout: 2000 }),
          // Button with text
          () => page.click(`button:has-text("${params}")`, { timeout: 2000 }),
          // Link with text
          () => page.click(`a:has-text("${params}")`, { timeout: 2000 }),
          // Any element with text (div, span, etc)
          () => page.click(`*:has-text("${params}"):visible`, { timeout: 2000 }),
          // Role-based selectors
          () => page.click(`role=button[name="${params}"]`, { timeout: 2000 }),
          () => page.click(`role=link[name="${params}"]`, { timeout: 2000 }),
          // Aria label
          () => page.click(`[aria-label*="${params}" i]`, { timeout: 2000 }),
          // Title attribute
          () => page.click(`[title*="${params}" i]`, { timeout: 2000 }),
          // Data-testid (common in React apps)
          () => page.click(`[data-testid*="${params.toLowerCase().replace(/\s+/g, '-')}"]`, { timeout: 2000 }),
          // Try as raw CSS selector
          () => page.click(params, { timeout: 2000 }),
          // Get first visible button with matching text using locator
          () => page.locator(`button`, { hasText: params }).first().click({ timeout: 2000 }),
        ];
        
        for (const strategy of strategies) {
          try {
            await strategy();
            return { success: true };
          } catch { /* try next */ }
        }
        
        return { success: false, error: `Could not find clickable element: ${params}` };
      }
      
      case 'TYPE': {
        await page.keyboard.type(params);
        return { success: true };
      }
      
      case 'FILL': {
        const separatorIndex = params.indexOf('|');
        if (separatorIndex === -1) {
          const focused = await page.$(':focus');
          if (focused) {
            await focused.fill(params);
            return { success: true };
          }
          return { success: false, error: 'No separator and no focused element' };
        }
        
        const selector = params.substring(0, separatorIndex).trim();
        const text = params.substring(separatorIndex + 1).trim();
        
        const fillStrategies = [
          // By aria-label (most specific for accessibility)
          () => page.fill(`input[aria-label*="${selector}" i]`, text, { timeout: 2000 }),
          () => page.fill(`textarea[aria-label*="${selector}" i]`, text, { timeout: 2000 }),
          // By placeholder text
          () => page.fill(`[placeholder*="${selector}" i]`, text, { timeout: 2000 }),
          // By input name
          () => page.fill(`input[name*="${selector}" i]`, text, { timeout: 2000 }),
          () => page.fill(`textarea[name*="${selector}" i]`, text, { timeout: 2000 }),
          // By data-testid
          () => page.fill(`input[data-testid*="${selector.toLowerCase().replace(/\s+/g, '-')}" i]`, text, { timeout: 2000 }),
          () => page.fill(`textarea[data-testid*="${selector.toLowerCase().replace(/\s+/g, '-')}" i]`, text, { timeout: 2000 }),
          // By associated label
          () => page.fill(`label:has-text("${selector}") + input`, text, { timeout: 2000 }),
          () => page.fill(`label:has-text("${selector}") ~ input`, text, { timeout: 2000 }),
          () => page.fill(`label:has-text("${selector}") ~ textarea`, text, { timeout: 2000 }),
          // By id containing text
          () => page.fill(`input[id*="${selector.toLowerCase().replace(/\s+/g, '')}" i]`, text, { timeout: 2000 }),
          () => page.fill(`textarea[id*="${selector.toLowerCase().replace(/\s+/g, '')}" i]`, text, { timeout: 2000 }),
          // Role-based
          () => page.locator(`role=textbox[name="${selector}"]`).fill(text, { timeout: 2000 }),
          // Using getByLabel (Playwright testing library style)
          () => page.getByLabel(selector).fill(text, { timeout: 2000 }),
          // Using getByPlaceholder
          () => page.getByPlaceholder(selector).fill(text, { timeout: 2000 }),
          // Raw selector as fallback
          () => page.fill(selector, text, { timeout: 2000 }),
        ];
        
        for (const strategy of fillStrategies) {
          try {
            await strategy();
            return { success: true };
          } catch { /* try next */ }
        }
        return { success: false, error: `Could not fill field: ${selector}` };
      }
      
      case 'PRESS': {
        // Map common key names to Playwright key names
        const keyMap = {
          'enter': 'Enter',
          'tab': 'Tab',
          'escape': 'Escape',
          'esc': 'Escape',
          'backspace': 'Backspace',
          'delete': 'Delete',
          'arrowup': 'ArrowUp',
          'arrowdown': 'ArrowDown',
          'arrowleft': 'ArrowLeft',
          'arrowright': 'ArrowRight',
          'up': 'ArrowUp',
          'down': 'ArrowDown',
          'left': 'ArrowLeft',
          'right': 'ArrowRight',
          'space': 'Space',
          'home': 'Home',
          'end': 'End',
          'pageup': 'PageUp',
          'pagedown': 'PageDown',
        };
        const key = keyMap[params.toLowerCase()] || params;
        await page.keyboard.press(key);
        return { success: true };
      }
      
      case 'SCROLL': {
        const direction = params.toLowerCase();
        if (direction.includes('down')) {
          await page.evaluate(() => window.scrollBy(0, 400));
        } else {
          await page.evaluate(() => window.scrollBy(0, -400));
        }
        return { success: true };
      }
      
      case 'WAIT': {
        await page.waitForTimeout(2000);
        return { success: true };
      }
      
      case 'NAVIGATE': {
        const currentUrl = new URL(page.url());
        const newPath = params.startsWith('/') ? params : `/${params}`;
        await page.goto(`${currentUrl.origin}${newPath}`, { waitUntil: 'networkidle', timeout: 15000 });
        return { success: true };
      }
      
      case 'DONE': {
        return { success: true, done: true, summary: params };
      }
      
      default:
        return { success: false, error: `Unknown action: ${type}` };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function generateAgentName() {
  const adjectives = ['Curious', 'Clever', 'Swift', 'Bright', 'Bold', 'Wise', 'Keen', 'Quick'];
  const nouns = ['Explorer', 'Pioneer', 'Tester', 'Scout', 'Pathfinder', 'Seeker', 'Wanderer'];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const id = Date.now().toString(36).slice(-4);
  return `${adj}${noun}-${id}`;
}

/**
 * Generate a test report analyzing the browser agent's session
 */
async function generateTestReport(apiUrl, testKey, screenshotsDir, history, goal, success, agentName, walletAddress) {
  // Get final screenshot for context
  const finalScreenshotPath = path.join(screenshotsDir, 'final.png');
  let imageData = null;
  try {
    imageData = fs.readFileSync(finalScreenshotPath).toString('base64');
  } catch { /* no final screenshot */ }
  
  const systemPrompt = `You are a QA engineer analyzing the results of an automated browser test.

The test goal was: ${goal}

The agent took ${history.length} steps. ${success ? 'It completed successfully.' : 'It did NOT complete the task.'}

Based on the action history and final screenshot, write a concise test report covering:

## Summary
A 2-3 sentence overview of what happened.

## Bugs Found
List any bugs, broken UI elements, or unexpected behaviors discovered. If none, say "None detected."

## UX Issues
Note any confusing UI patterns, unclear labels, or poor user experience elements.

## What Worked Well
Highlight positive aspects of the application.

## Recommendations
Specific suggestions to improve the application or fix issues found.

Be specific and actionable. Reference actual UI elements and behaviors observed.`;

  const historyText = history.map((h, i) => `${i + 1}. ${h}`).join('\n');
  
  const payload = {
    message: `Here's the action history from the test session:\n\n${historyText}\n\nPlease analyze and generate the test report.`,
    history: [],
    systemPrompt,
    ...(imageData ? {
      attachments: [{
        type: 'image',
        data: `data:image/png;base64,${imageData}`,
        name: 'final-screenshot.png'
      }]
    } : {})
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
    return null;
  }
  
  const result = await response.json();
  return result.response || result.message || null;
}

async function runAutonomousBrowserTest() {
  console.log('🤖 Autonomous Browser Agent E2E Test');
  console.log('='.repeat(50));
  console.log(`Environment: ${ENV}`);
  console.log();
  
  const adminUrl = getStackOutput('admin-ui-url');
  const apiUrl = getStackOutput('admin-api-url');
  const testKey = getInternalTestKey();
  
  if (!adminUrl) {
    console.error('❌ Could not get Admin UI URL from stack outputs');
    process.exit(1);
  }
  
  if (!apiUrl || !testKey) {
    console.error('❌ Could not get API credentials for LLM agent');
    console.error('   This test requires the chat API to reason about screenshots');
    process.exit(1);
  }
  
  console.log(`📍 Admin UI: ${adminUrl}`);
  console.log(`📍 API: ${apiUrl}`);
  console.log(`📍 Max Steps: ${MAX_STEPS}`);
  console.log();
  
  // Check for Cloudflare Access credentials
  if (!CF_ACCESS_CLIENT_ID || !CF_ACCESS_CLIENT_SECRET) {
    console.warn('⚠️  No Cloudflare Access credentials found');
    console.warn('   Set CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET env vars');
    console.warn('   Create a service token at: Cloudflare Zero Trust > Access > Service Auth');
  } else {
    console.log('🔒 Cloudflare Access: Service token configured');
  }
  
  const runId = Date.now().toString(36);
  const screenshotsDir = path.join(process.cwd(), 'test-screenshots', `run-${runId}`);
  fs.mkdirSync(screenshotsDir, { recursive: true });
  
  // Get wallet info (even before auth attempt)
  const wallet = getTestWallet();
  const walletAddress = wallet.publicKey;
  
  // Display wallet prominently for CI logs
  console.log('='.repeat(50));
  console.log('🔑 TEST SIGNING WALLET');
  console.log(`   ${walletAddress}`);
  console.log('='.repeat(50));
  console.log();
  
  // Authenticate with wallet before launching browser
  let authSession = null;
  try {
    authSession = await authenticateWithWallet(apiUrl, testKey);
  } catch (err) {
    console.error(`⚠️  Wallet authentication failed: ${err.message}`);
    console.error('   Continuing without authentication (may hit login wall)');
  }
  
  const browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  // Parse the admin URL to get the domain for cookies
  const adminUrlParsed = new URL(adminUrl);
  
  // Create browser context with auth headers and cookies
  const contextOptions = {
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    extraHTTPHeaders: getCloudflareAccessHeaders(),
  };
  
  const context = await browser.newContext(contextOptions);
  
  // Inject session cookie if we have one
  if (authSession?.sessionCookie) {
    // Parse the Set-Cookie header to extract cookie details
    const cookieMatch = authSession.sessionCookie.match(/^([^=]+)=([^;]*)/);
    if (cookieMatch) {
      const [, name, value] = cookieMatch;
      await context.addCookies([{
        name,
        value,
        domain: adminUrlParsed.hostname,
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Strict',
      }]);
      console.log(`🍪 Session cookie injected for ${adminUrlParsed.hostname}`);
    }
  }
  
  const page = await context.newPage();
  
  const agentName = generateAgentName();
  const goal = `Create a new AI agent by clicking the create/add button (usually a + icon or "Create" button).
After the agent is created, send it a test message like "Hello" to verify it responds.
The agent name "${agentName}" may be auto-generated - you don't need to fill in forms manually.
Focus on: 1) Find and click the create button, 2) Verify the agent appears, 3) Send a message.`;

  console.log(`🎯 Goal: Create agent "${agentName}" and test conversation`);
  console.log();
  
  const history = [];
  let step = 0;
  let success = false;
  let finalSummary = '';
  
  try {
    console.log('📸 Loading application...');
    await page.goto(adminUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);
    
    while (step < MAX_STEPS && !success) {
      step++;
      console.log(`\n--- Step ${step}/${MAX_STEPS} ---`);
      
      const screenshotPath = path.join(screenshotsDir, `step-${step.toString().padStart(2, '0')}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false });
      
      // Extract available elements from the page
      const pageElements = await getPageElements(page);
      console.log(`📋 Found: ${pageElements.buttons.length} buttons, ${pageElements.links.length} links, ${pageElements.inputs.length} inputs`);
      
      console.log('🧠 Agent reasoning...');
      const response = await getNextAction(apiUrl, testKey, screenshotPath, history, goal, pageElements);
      const action = parseAction(response);
      
      console.log(`📝 Observation: ${(action.observation || '').substring(0, 120)}...`);
      console.log(`💭 Reasoning: ${(action.reasoning || '').substring(0, 120)}...`);
      console.log(`⚡ Action: ${action.type}: ${action.params}`);
      
      const result = await executeAction(page, action);
      
      if (result.error) {
        console.log(`⚠️  Action failed: ${result.error}`);
        history.push(`${action.type}: ${action.params} -> FAILED: ${result.error}`);
      } else if (result.done) {
        console.log(`✅ Agent completed: ${result.summary}`);
        success = true;
        finalSummary = result.summary;
        history.push(`DONE: ${result.summary}`);
      } else {
        console.log('✅ Action executed');
        history.push(`${action.type}: ${action.params} -> OK`);
      }
      
      await page.waitForTimeout(STEP_DELAY);
    }
    
    const finalScreenshot = path.join(screenshotsDir, 'final.png');
    await page.screenshot({ path: finalScreenshot, fullPage: true });
    console.log(`\n📸 Final screenshot: ${finalScreenshot}`);
    
  } catch (err) {
    console.error(`\n❌ Test error: ${err.message}`);
    const errorScreenshot = path.join(screenshotsDir, 'error.png');
    await page.screenshot({ path: errorScreenshot, fullPage: true }).catch(() => {});
  } finally {
    await browser.close();
  }
  
  console.log('\n' + '='.repeat(50));
  console.log('📊 Test Summary:');
  console.log(`   Steps taken: ${step}`);
  console.log(`   Screenshots: ${screenshotsDir}`);
  
  if (success) {
    console.log(`   Result: ✅ SUCCESS`);
    console.log(`   Summary: ${finalSummary}`);
  } else if (step >= MAX_STEPS) {
    console.log(`   Result: ⚠️  MAX STEPS REACHED`);
    console.log('   The agent did not complete the task within the step limit.');
  } else {
    console.log(`   Result: ❌ FAILED`);
  }
  
  // Generate AI-powered test report
  console.log('\n📝 Generating test report...');
  const report = await generateTestReport(apiUrl, testKey, screenshotsDir, history, goal, success, agentName, walletAddress);
  
  if (report) {
    console.log('\n' + '='.repeat(50));
    console.log('📋 TEST REPORT');
    console.log('='.repeat(50));
    console.log(report);
    console.log('='.repeat(50));
    
    // Save report to file
    const reportFile = path.join(screenshotsDir, 'report.md');
    fs.writeFileSync(reportFile, `# Browser Test Report\n\n**Date:** ${new Date().toISOString()}\n**Signing Wallet:** \`${walletAddress}\`\n**Goal:** ${goal}\n**Agent Name:** ${agentName}\n**Steps:** ${step}\n**Result:** ${success ? 'SUCCESS' : step >= MAX_STEPS ? 'MAX STEPS' : 'FAILED'}\n\n---\n\n${report}`);
    console.log(`\n📄 Report saved to: ${reportFile}`);
  } else {
    console.log('⚠️  Could not generate report');
    
    // Fallback: print action history
    console.log('\n📜 Action History:');
    history.forEach((h, i) => console.log(`   ${i + 1}. ${h}`));
  }
  
  const historyFile = path.join(screenshotsDir, 'history.json');
  fs.writeFileSync(historyFile, JSON.stringify({
    walletAddress,
    goal,
    agentName,
    steps: step,
    success,
    summary: finalSummary,
    history
  }, null, 2));
  
  // Allow max steps as soft pass - agent explored
  if (!success && step < MAX_STEPS) {
    process.exit(1);
  }
}

runAutonomousBrowserTest().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
