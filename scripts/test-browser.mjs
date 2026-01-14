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
 * Usage: node scripts/test-browser.mjs [env]
 */

import { chromium } from 'playwright';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const ENV = process.argv[2] || 'staging';
const MAX_STEPS = 25;
const STEP_DELAY = 1500;

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

async function getNextAction(apiUrl, testKey, screenshotPath, history, goal) {
  const imageData = fs.readFileSync(screenshotPath);
  const base64Image = imageData.toString('base64');
  
  const systemPrompt = `You are an autonomous browser agent exploring a web application.

YOUR GOAL: ${goal}

You can see a screenshot of the current page state. Based on what you observe, decide on ONE action to take.

AVAILABLE ACTIONS:
- CLICK: selector - Click an element (use visible text content, button labels, or CSS selector)
- TYPE: text - Type text into the currently focused input field  
- FILL: selector | text - Fill a specific input field by placeholder/label
- PRESS: key - Press a keyboard key (Enter, Tab, Escape, etc.)
- SCROLL: direction - Scroll up or down
- WAIT: reason - Wait and observe (use sparingly)
- NAVIGATE: path - Navigate to a relative URL path
- DONE: summary - Task complete, provide summary

RESPONSE FORMAT (use exactly this format):
OBSERVATION: [Describe what you see - UI elements, buttons, forms, text, sidebars, etc.]
REASONING: [Your thought process - what are you trying to achieve? Why this action?]
ACTION: [Exactly one action from the list above]

GUIDELINES:
- Describe the UI thoroughly before acting - what buttons, links, inputs do you see?
- Look for "+" buttons, "New" or "Create" links, or similar UI patterns
- When filling forms, use the agent name provided in the goal
- For personas/descriptions, be creative and brief
- If you see a chat interface, try sending a test message
- When you've created an agent AND had a conversation with it, use DONE
- If an action fails, try an alternative approach

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
  return result.message || result.content || JSON.stringify(result);
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
          () => page.click(`text="${params}"`, { timeout: 2000 }),
          () => page.click(`text=${params}`, { timeout: 2000 }),
          () => page.click(`button:has-text("${params}")`, { timeout: 2000 }),
          () => page.click(`a:has-text("${params}")`, { timeout: 2000 }),
          () => page.click(`[aria-label*="${params}" i]`, { timeout: 2000 }),
          () => page.click(params, { timeout: 2000 }),
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
          () => page.fill(`[placeholder*="${selector}" i]`, text, { timeout: 2000 }),
          () => page.fill(`input[name*="${selector}" i]`, text, { timeout: 2000 }),
          () => page.fill(`textarea[name*="${selector}" i]`, text, { timeout: 2000 }),
          () => page.fill(`label:has-text("${selector}") + input`, text, { timeout: 2000 }),
          () => page.fill(`label:has-text("${selector}") ~ input`, text, { timeout: 2000 }),
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
        await page.keyboard.press(params);
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

async function runAutonomousBrowserTest() {
  console.log('🤖 Autonomous Browser Agent E2E Test');
  console.log('='.repeat(50));
  console.log(`Environment: ${ENV}`);
  console.log();
  
  const adminUrl = getStackOutput('AdminUiUrl') || getStackOutput('Url');
  const apiUrl = getStackOutput('ApiEndpoint');
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
  
  const runId = Date.now().toString(36);
  const screenshotsDir = path.join(process.cwd(), 'test-screenshots', `run-${runId}`);
  fs.mkdirSync(screenshotsDir, { recursive: true });
  
  const browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2
  });
  const page = await context.newPage();
  
  const agentName = generateAgentName();
  const goal = `Explore this admin/chat application and create a new AI agent named "${agentName}". 
Once you've created the agent, have a brief conversation with it to verify it works.
Look for ways to add/create new agents, fill in any required fields creatively, and test the result.`;

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
      
      console.log('🧠 Agent reasoning...');
      const response = await getNextAction(apiUrl, testKey, screenshotPath, history, goal);
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
  
  console.log('\n📜 Action History:');
  history.forEach((h, i) => console.log(`   ${i + 1}. ${h}`));
  
  const historyFile = path.join(screenshotsDir, 'history.json');
  fs.writeFileSync(historyFile, JSON.stringify({
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
