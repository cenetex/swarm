#!/usr/bin/env node
/**
 * Vanity Wallet Generator (Multi-threaded)
 * 
 * Generates Solana keypairs in parallel until finding one with a desired pattern.
 * Uses all CPU cores for maximum speed. Always saves to GitHub secrets.
 * 
 * Usage:
 *   node scripts/generate-vanity-wallet.mjs [pattern] [--start] [--secret-name NAME]
 * 
 * Examples:
 *   node scripts/generate-vanity-wallet.mjs RATi                    # "RATi" anywhere
 *   node scripts/generate-vanity-wallet.mjs RATi --start            # "RATi" at start
 *   node scripts/generate-vanity-wallet.mjs RATi --secret-name RELEASE_SIGNING_KEY
 * 
 * Environment:
 *   GITHUB_ACTIONS=true  - Running in CI (uses gh secret set)
 *   GH_TOKEN             - GitHub token for CI (auto-provided in Actions)
 */

import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import { cpus } from 'os';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const NUM_WORKERS = cpus().length;

// Worker thread code
if (!isMainThread) {
  const { pattern, matchStart, caseInsensitive } = workerData;
  
  const nacl = (await import('tweetnacl')).default;
  const bs58 = (await import('bs58')).default;
  
  let attempts = 0;
  
  while (true) {
    attempts++;
    
    const keypair = nacl.sign.keyPair();
    const publicKey = bs58.encode(keypair.publicKey);
    
    let matches = false;
    if (caseInsensitive) {
      const lowerKey = publicKey.toLowerCase();
      const lowerPattern = pattern.toLowerCase();
      matches = matchStart ? lowerKey.startsWith(lowerPattern) : lowerKey.includes(lowerPattern);
    } else {
      matches = matchStart ? publicKey.startsWith(pattern) : publicKey.includes(pattern);
    }
    
    if (matches) {
      parentPort.postMessage({
        type: 'found',
        publicKey,
        secretKey: bs58.encode(keypair.secretKey),
        attempts,
      });
      break;
    }
    
    if (attempts % 10000 === 0) {
      parentPort.postMessage({ type: 'progress', attempts });
    }
  }
} else {
  // Main thread
  const args = process.argv.slice(2);
  const pattern = args.find(a => !a.startsWith('--')) || 'RATi';
  const matchStart = args.includes('--start');
  const caseInsensitive = args.includes('--ignore-case');
  const dryRun = args.includes('--dry-run');
  
  // Parse --secret-name NAME
  const secretNameIndex = args.indexOf('--secret-name');
  const secretName = secretNameIndex >= 0 ? args[secretNameIndex + 1] : 'TEST_WALLET_PRIVATE_KEY';
  
  // Also output public key to a separate secret
  const publicKeySecretName = secretName.replace('PRIVATE', 'PUBLIC').replace('_KEY', '_ADDRESS');

  // Validate pattern
  const BASE58_CHARS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  for (const char of pattern) {
    if (!BASE58_CHARS.includes(char)) {
      console.error(`❌ Invalid character '${char}' in pattern`);
      console.error(`   Base58 alphabet excludes: 0, O, I, l`);
      process.exit(1);
    }
  }

  function calculateExpectedAttempts(patternLength, matchAtStart) {
    const base = 58;
    const addressLength = 44;
    if (matchAtStart) {
      return Math.pow(base, patternLength);
    } else {
      const positions = addressLength - patternLength + 1;
      return Math.pow(base, patternLength) / positions;
    }
  }

  const expectedAttempts = calculateExpectedAttempts(pattern.length, matchStart);
  const estimatedSeconds = expectedAttempts / (10000 * NUM_WORKERS);
  const timeStr = estimatedSeconds < 60 
    ? `${Math.round(estimatedSeconds)}s` 
    : estimatedSeconds < 3600 
      ? `${Math.round(estimatedSeconds / 60)}m`
      : `${(estimatedSeconds / 3600).toFixed(1)}h`;

  console.log('🔑 Vanity Wallet Generator');
  console.log('='.repeat(50));
  console.log(`Pattern: "${pattern}" (${matchStart ? 'prefix' : 'anywhere'})`);
  console.log(`Workers: ${NUM_WORKERS} threads`);
  console.log(`Target secret: ${secretName}`);
  console.log(`Expected: ~${Math.round(expectedAttempts).toLocaleString()} attempts (~${timeStr})`);
  console.log();

  const startTime = Date.now();
  let totalAttempts = 0;
  let found = null;
  const workers = [];
  const workerAttempts = new Map();

  const scriptPath = fileURLToPath(import.meta.url);
  
  for (let i = 0; i < NUM_WORKERS; i++) {
    const worker = new Worker(scriptPath, {
      workerData: { pattern, matchStart, caseInsensitive },
    });
    
    workerAttempts.set(worker.threadId, 0);
    
    worker.on('message', (msg) => {
      if (msg.type === 'progress') {
        workerAttempts.set(worker.threadId, msg.attempts);
        totalAttempts = Array.from(workerAttempts.values()).reduce((a, b) => a + b, 0);
        
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = Math.round(totalAttempts / elapsed);
        const progress = (totalAttempts / expectedAttempts * 100).toFixed(1);
        process.stdout.write(`\r⏳ ${totalAttempts.toLocaleString()} | ${rate.toLocaleString()}/s | ${progress}%`);
      } else if (msg.type === 'found' && !found) {
        found = msg;
        for (const w of workers) w.terminate();
      }
    });
    
    workers.push(worker);
  }

  await Promise.race(workers.map(w => new Promise(resolve => w.on('exit', resolve))));

  if (!found) {
    console.error('\n❌ No wallet found');
    process.exit(1);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  
  // Highlight pattern in address
  const idx = caseInsensitive 
    ? found.publicKey.toLowerCase().indexOf(pattern.toLowerCase())
    : found.publicKey.indexOf(pattern);
  const highlighted = idx >= 0
    ? `${found.publicKey.slice(0, idx)}\x1b[32m${found.publicKey.slice(idx, idx + pattern.length)}\x1b[0m${found.publicKey.slice(idx + pattern.length)}`
    : found.publicKey;

  console.log(`\n\n✅ Found in ${elapsed}s`);
  console.log(`   ${highlighted}`);

  if (dryRun) {
    console.log('\n🔒 Dry run - not saving to secrets');
    process.exit(0);
  }

  // Save to GitHub secrets
  console.log('\n💾 Saving to GitHub secrets...');
  
  try {
    execSync('gh --version', { stdio: 'pipe' });
    
    // Save private key (via stdin to avoid exposure in process list)
    execSync(`gh secret set ${secretName}`, {
      input: found.secretKey,
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    
    // Save public address as a separate secret (useful for verification)
    execSync(`gh secret set ${publicKeySecretName}`, {
      input: found.publicKey,
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    
    console.log(`✅ ${secretName} = [hidden]`);
    console.log(`✅ ${publicKeySecretName} = ${found.publicKey}`);
    
    // Output for GitHub Actions
    if (process.env.GITHUB_ACTIONS) {
      console.log(`\n::set-output name=wallet_address::${found.publicKey}`);
    }
  } catch (err) {
    console.error('❌ Failed to save to GitHub secrets');
    console.error('   Ensure gh CLI is authenticated: gh auth login');
    process.exit(1);
  }
};
