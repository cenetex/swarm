#!/usr/bin/env node
/**
 * Telegram Screenshot Monitor for Claude Code
 * 
 * Captures screenshots of the Telegram window, detects changes,
 * and sends them to Claude Code for analysis. Waits for Claude's
 * response before checking for the next change.
 * 
 * Features:
 * - Window capture via screencapture (macOS)
 * - Change detection via image hash comparison
 * - 30-minute heartbeat even without changes
 * - Blocks during Claude processing (no overlapping requests)
 * 
 * Usage:
 *   ./scripts/telegram-monitor.mjs [--window "Telegram"] [--heartbeat 30]
 */

import { spawn, execSync } from 'child_process';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// Configuration
const CONFIG = {
  windowName: process.argv.includes('--window') 
    ? process.argv[process.argv.indexOf('--window') + 1] 
    : 'Telegram',
  heartbeatMinutes: process.argv.includes('--heartbeat')
    ? parseInt(process.argv[process.argv.indexOf('--heartbeat') + 1], 10)
    : 30,
  pollIntervalMs: 5000, // Check for changes every 5 seconds
  screenshotDir: join(process.cwd(), 'test-screenshots', 'telegram-monitor'),
  projectContext: `You are monitoring the Telegram desktop app for the aws-swarm project.
This project manages AI avatars that respond on Telegram and Twitter.
Key avatars: Chamuel (agent-18-sp9g), Opus (agent-1-6yan).
Look for: new messages, errors, bot responses, user interactions.
Report any issues or interesting activity you observe.`,
};

// State
let lastImageHash = null;
let lastHeartbeat = Date.now();
let isProcessing = false;
let screenshotCounter = 0;

// Ensure screenshot directory exists
if (!existsSync(CONFIG.screenshotDir)) {
  mkdirSync(CONFIG.screenshotDir, { recursive: true });
}

/**
 * Get the window ID for the target window
 */
function getWindowId(windowName) {
  try {
    // Use AppleScript to get window ID
    const script = `
      tell application "System Events"
        set appList to every process whose name contains "${windowName}"
        if (count of appList) > 0 then
          set targetApp to item 1 of appList
          set appName to name of targetApp
          tell process appName
            if (count of windows) > 0 then
              return id of window 1
            end if
          end tell
        end if
      end tell
      return ""
    `;
    const result = execSync(`osascript -e '${script.replace(/'/g, "'\"'\"'")}'`, { encoding: 'utf8' }).trim();
    return result || null;
  } catch (err) {
    return null;
  }
}

/**
 * Capture screenshot of the entire screen
 */
function captureScreenshot() {
  const timestamp = Date.now();
  const filename = `screen-${timestamp}.png`;
  const filepath = join(CONFIG.screenshotDir, filename);
  
  try {
    // Capture entire screen silently (-x = no sound)
    execSync(`screencapture -x "${filepath}"`, { encoding: 'utf8', timeout: 10000 });
    
    return filepath;
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Screenshot failed:`, err.message);
    return null;
  }
}

/**
 * Compute hash of image file for change detection
 */
function getImageHash(filepath) {
  try {
    const data = readFileSync(filepath);
    return createHash('md5').update(data).digest('hex');
  } catch (err) {
    return null;
  }
}

/**
 * Send screenshot to Claude Code and wait for response
 */
async function sendToClaude(screenshotPath, reason) {
  return new Promise((resolve, reject) => {
    const prompt = `${CONFIG.projectContext}

[Screenshot attached: ${screenshotPath}]

Reason for this update: ${reason}

Please analyze this Telegram screenshot and:
1. Describe what you see (messages, notifications, any activity)
2. Note any errors or issues visible
3. Identify if any action is needed
4. Summarize the current state of the monitored channels

If you see messages from bots (Opus, Chamuel, etc.), note their responses.
If you see errors or the bot not responding, flag it.

After analysis, respond with your findings. I'll send you the next screenshot when there are changes or after 30 minutes.`;

    console.log(`[${new Date().toISOString()}] Sending to Claude Code...`);
    console.log(`  Reason: ${reason}`);
    console.log(`  Screenshot: ${screenshotPath}`);
    
    // Build the claude command with image attachment
    const claudeArgs = [
      '--print',  // Non-interactive, print response
      '--add-dir', '.',  // Add current directory for context
      prompt
    ];
    
    // Note: Claude CLI image attachment syntax may vary
    // Try using file:// URL or direct path
    const fullPrompt = `${prompt}\n\n[Image: file://${screenshotPath}]`;
    
    const claude = spawn('claude', ['--print', fullPrompt], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env }
    });
    
    let stdout = '';
    let stderr = '';
    
    claude.stdout.on('data', (data) => {
      stdout += data.toString();
      process.stdout.write(data); // Stream output
    });
    
    claude.stderr.on('data', (data) => {
      stderr += data.toString();
      process.stderr.write(data);
    });
    
    claude.on('close', (code) => {
      if (code === 0) {
        console.log(`\n[${new Date().toISOString()}] Claude response complete`);
        resolve(stdout);
      } else {
        console.error(`\n[${new Date().toISOString()}] Claude exited with code ${code}`);
        reject(new Error(`Claude exited with code ${code}: ${stderr}`));
      }
    });
    
    claude.on('error', (err) => {
      console.error(`[${new Date().toISOString()}] Failed to spawn Claude:`, err.message);
      reject(err);
    });
  });
}

/**
 * Main monitoring loop
 */
async function monitorLoop() {
  console.log(`[${new Date().toISOString()}] Starting Telegram monitor`);
  console.log(`  Window: ${CONFIG.windowName}`);
  console.log(`  Heartbeat: ${CONFIG.heartbeatMinutes} minutes`);
  console.log(`  Poll interval: ${CONFIG.pollIntervalMs}ms`);
  console.log(`  Screenshots: ${CONFIG.screenshotDir}`);
  console.log('');
  
  while (true) {
    try {
      // Skip if still processing previous request
      if (isProcessing) {
        await sleep(CONFIG.pollIntervalMs);
        continue;
      }
      
      const now = Date.now();
      const minutesSinceHeartbeat = (now - lastHeartbeat) / 1000 / 60;
      const isHeartbeat = minutesSinceHeartbeat >= CONFIG.heartbeatMinutes;
      
      // Capture screenshot
      const screenshotPath = captureScreenshot();
      if (!screenshotPath) {
        console.log(`[${new Date().toISOString()}] No screenshot captured, retrying...`);
        await sleep(CONFIG.pollIntervalMs);
        continue;
      }
      
      // Check for changes
      const currentHash = getImageHash(screenshotPath);
      const hasChanged = currentHash && currentHash !== lastImageHash;
      
      // Decide whether to send to Claude
      let reason = null;
      if (isHeartbeat) {
        reason = `Heartbeat check (${CONFIG.heartbeatMinutes} minute interval)`;
      } else if (hasChanged) {
        reason = 'Screen content changed';
      } else if (lastImageHash === null) {
        reason = 'Initial capture';
      }
      
      if (reason) {
        isProcessing = true;
        lastImageHash = currentHash;
        lastHeartbeat = now;
        screenshotCounter++;
        
        try {
          await sendToClaude(screenshotPath, reason);
        } catch (err) {
          console.error(`[${new Date().toISOString()}] Claude error:`, err.message);
        }
        
        isProcessing = false;
        console.log(`\n[${new Date().toISOString()}] Waiting for next change or heartbeat...\n`);
      }
      
      await sleep(CONFIG.pollIntervalMs);
      
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Monitor error:`, err.message);
      isProcessing = false;
      await sleep(CONFIG.pollIntervalMs);
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log(`\n[${new Date().toISOString()}] Shutting down monitor...`);
  process.exit(0);
});

// Start the monitor
monitorLoop().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
