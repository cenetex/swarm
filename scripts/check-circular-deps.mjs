#!/usr/bin/env node
/**
 * Check for circular dependencies in the codebase
 * 
 * This script uses madge to detect circular imports and compares them
 * against a known allowlist. New circular dependencies cause CI to fail.
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';

// Known circular dependencies that are allowed (to be resolved over time)
const ALLOWED_CYCLES = [
  // These are the same cycle viewed from different entry points
  'types/index.ts > types/service.ts > types/envelope.ts > types/platform.ts',
  'envelope.ts > platform.ts > index.ts > service.ts',
  'platform.ts > index.ts > service.ts',
  'platform.ts > index.ts > service.ts > response.ts',
  'platform.ts > index.ts > service.ts > state.ts',
];

function runMadge(packagePath) {
  try {
    execSync(`npx madge --circular --extensions ts,tsx ${packagePath} 2>&1`, {
      encoding: 'utf-8',
    });
    return null; // No cycles found
  } catch (error) {
    // madge exits with code 1 when cycles are found
    // The 2>&1 redirects stderr to stdout so we capture everything
    return error.stdout || error.message;
  }
}

function parseMadgeOutput(output) {
  if (!output) return [];
  
  const lines = output.split('\n');
  const cycles = [];
  let inCycleSection = false;
  
  for (const line of lines) {
    if (line.includes('Found') && line.includes('circular')) {
      inCycleSection = true;
      continue;
    }
    
    if (inCycleSection && line.trim() && !line.includes('Processed')) {
      // Remove the numbering prefix like "1) "
      const cycle = line.replace(/^\d+\)\s+/, '').trim();
      if (cycle) {
        cycles.push(cycle);
      }
    }
  }
  
  return cycles;
}

function normalizeCycle(cycle) {
  // Normalize cycle representation for comparison
  return cycle.replace(/\s+/g, ' ').trim();
}

function main() {
  console.log('🔍 Checking for circular dependencies...\n');
  
  const packages = [
    'packages/core/src/',
    'packages/core/src/types/',  // Check types directory specifically
    'packages/handlers/src/',
    'packages/admin-api/src/',
    'packages/admin-ui/src/',
    'packages/mcp-server/src/',
  ];
  
  const allCycles = [];
  const newCycles = [];
  
  for (const pkg of packages) {
    console.log(`Checking ${pkg}...`);
    const output = runMadge(pkg);
    
    if (!output) {
      console.log(`  ✓ No circular dependencies found\n`);
      continue;
    }
    
    const cycles = parseMadgeOutput(output);
    
    if (cycles.length === 0) {
      console.log(`  ✓ No circular dependencies found\n`);
      continue;
    }
    
    console.log(`  ⚠️  Found ${cycles.length} circular dependency(ies):\n`);
    
    for (const cycle of cycles) {
      const normalized = normalizeCycle(cycle);
      allCycles.push({ package: pkg, cycle: normalized });
      
      // Check if this cycle is in the allowlist
      const isAllowed = ALLOWED_CYCLES.some(allowed => 
        normalized.includes(normalizeCycle(allowed)) || 
        normalizeCycle(allowed).includes(normalized)
      );
      
      if (isAllowed) {
        console.log(`    - ${cycle} [ALLOWED]`);
      } else {
        console.log(`    - ${cycle} [NEW - BLOCKING]`);
        newCycles.push({ package: pkg, cycle: normalized });
      }
    }
    console.log();
  }
  
  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('Summary:\n');
  console.log(`Total circular dependencies: ${allCycles.length}`);
  console.log(`Allowed (existing): ${allCycles.length - newCycles.length}`);
  console.log(`New (blocking): ${newCycles.length}`);
  
  if (newCycles.length > 0) {
    console.log('\n❌ New circular dependencies detected!\n');
    console.log('The following circular dependencies must be resolved:\n');
    
    for (const { package: pkg, cycle } of newCycles) {
      console.log(`  Package: ${pkg}`);
      console.log(`  Cycle: ${cycle}\n`);
    }
    
    console.log('To resolve circular dependencies:');
    console.log('1. Extract shared types into a separate file');
    console.log('2. Use dependency injection instead of direct imports');
    console.log('3. Restructure the module hierarchy');
    console.log('4. Consider using interfaces/types only in one direction\n');
    
    process.exit(1);
  } else if (allCycles.length > 0) {
    console.log('\n⚠️  Found allowed circular dependencies');
    console.log('These should be resolved over time:\n');
    
    for (const allowed of ALLOWED_CYCLES) {
      console.log(`  - ${allowed}`);
    }
    console.log();
  } else {
    console.log('\n✅ No circular dependencies found!\n');
  }
  
  process.exit(0);
}

main();
