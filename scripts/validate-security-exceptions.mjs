#!/usr/bin/env node
/**
 * Validate security exception registry (.audit-exceptions.json)
 *
 * Checks:
 * - All required fields are present and match the schema
 * - No exceptions have expired (expiry date < today)
 * - Prints summary of active, expiring-soon (within 30 days), and expired exceptions
 *
 * Exit codes:
 *   0 - all exceptions valid and current
 *   1 - expired exceptions found or schema validation errors
 *
 * Usage:
 *   node scripts/validate-security-exceptions.mjs [--warn-days N] [--ci]
 *
 * Options:
 *   --warn-days N   Number of days before expiry to flag as "expiring soon" (default: 30)
 *   --ci            Output GitHub Actions annotations
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// --- Parse CLI args ---
const args = process.argv.slice(2);
let warnDays = 30;
let ciMode = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--warn-days' && args[i + 1]) {
    warnDays = parseInt(args[++i], 10);
  }
  if (args[i] === '--ci') {
    ciMode = true;
  }
}

// --- Load registry ---
const registryPath = resolve(ROOT, '.audit-exceptions.json');
let registry;
try {
  registry = JSON.parse(readFileSync(registryPath, 'utf8'));
} catch (err) {
  console.error(`Failed to read ${registryPath}: ${err.message}`);
  process.exit(1);
}

// --- Schema validation (lightweight, no external deps) ---
const REQUIRED_FIELDS = [
  'id', 'advisory', 'package', 'severity', 'owner',
  'rationale', 'mitigation', 'expiry', 'reviewCadence', 'status',
];
const VALID_SEVERITIES = ['low', 'moderate', 'high', 'critical'];
const VALID_CADENCES = ['weekly', 'monthly', 'quarterly'];
const VALID_STATUSES = ['active', 'expired', 'resolved'];
const ID_PATTERN = /^SE-\d{3,}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const errors = [];
const warnings = [];
const today = new Date();
today.setHours(0, 0, 0, 0);

const warnThreshold = new Date(today);
warnThreshold.setDate(warnThreshold.getDate() + warnDays);

if (!Array.isArray(registry.exceptions)) {
  console.error('Registry is missing "exceptions" array.');
  process.exit(1);
}

const active = [];
const expiringSoon = [];
const expired = [];
const resolved = [];
const seenIds = new Set();

for (const [idx, exc] of registry.exceptions.entries()) {
  const prefix = `exceptions[${idx}] (${exc.id || 'unknown'})`;

  // Check required fields
  for (const field of REQUIRED_FIELDS) {
    if (exc[field] === undefined || exc[field] === null || exc[field] === '') {
      errors.push(`${prefix}: missing required field "${field}"`);
    }
  }

  // Validate ID format
  if (exc.id && !ID_PATTERN.test(exc.id)) {
    errors.push(`${prefix}: id must match pattern SE-NNN (got "${exc.id}")`);
  }

  // Check for duplicate IDs
  if (exc.id) {
    if (seenIds.has(exc.id)) {
      errors.push(`${prefix}: duplicate id "${exc.id}"`);
    }
    seenIds.add(exc.id);
  }

  // Validate enums
  if (exc.severity && !VALID_SEVERITIES.includes(exc.severity)) {
    errors.push(`${prefix}: invalid severity "${exc.severity}" (expected: ${VALID_SEVERITIES.join(', ')})`);
  }
  if (exc.reviewCadence && !VALID_CADENCES.includes(exc.reviewCadence)) {
    errors.push(`${prefix}: invalid reviewCadence "${exc.reviewCadence}" (expected: ${VALID_CADENCES.join(', ')})`);
  }
  if (exc.status && !VALID_STATUSES.includes(exc.status)) {
    errors.push(`${prefix}: invalid status "${exc.status}" (expected: ${VALID_STATUSES.join(', ')})`);
  }

  // Validate date format
  if (exc.expiry && !DATE_PATTERN.test(exc.expiry)) {
    errors.push(`${prefix}: expiry must be ISO date YYYY-MM-DD (got "${exc.expiry}")`);
  }

  // Validate rationale and mitigation length
  if (exc.rationale && exc.rationale.length < 10) {
    errors.push(`${prefix}: rationale must be at least 10 characters`);
  }
  if (exc.mitigation && exc.mitigation.length < 10) {
    errors.push(`${prefix}: mitigation must be at least 10 characters`);
  }

  // Check expiry for active exceptions
  if (exc.status === 'active' && exc.expiry && DATE_PATTERN.test(exc.expiry)) {
    const expiryDate = new Date(exc.expiry + 'T00:00:00');

    if (expiryDate < today) {
      expired.push(exc);
      errors.push(`${prefix}: EXPIRED on ${exc.expiry} - must be renewed or resolved`);
    } else if (expiryDate <= warnThreshold) {
      expiringSoon.push(exc);
      const daysLeft = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24));
      warnings.push(`${prefix}: expiring in ${daysLeft} day(s) on ${exc.expiry}`);
    } else {
      active.push(exc);
    }
  } else if (exc.status === 'resolved') {
    resolved.push(exc);
  } else if (exc.status === 'expired') {
    expired.push(exc);
    errors.push(`${prefix}: marked as expired - must be renewed or resolved`);
  }

  // Cross-check: ignoredAdvisories should contain advisory
  if (exc.status === 'active' && registry.ignoredAdvisories) {
    if (!registry.ignoredAdvisories.includes(exc.advisory)) {
      warnings.push(`${prefix}: advisory "${exc.advisory}" is active but not in ignoredAdvisories array`);
    }
  }
}

// --- Print summary ---
console.log('');
console.log('=== Security Exception Registry ===');
console.log('');
console.log(`  Total exceptions:  ${registry.exceptions.length}`);
console.log(`  Active:            ${active.length}`);
console.log(`  Expiring soon:     ${expiringSoon.length} (within ${warnDays} days)`);
console.log(`  Expired:           ${expired.length}`);
console.log(`  Resolved:          ${resolved.length}`);
console.log('');

if (active.length > 0) {
  console.log('Active exceptions:');
  for (const exc of active) {
    console.log(`  - ${exc.id}: ${exc.package} (${exc.advisory}) expires ${exc.expiry}`);
  }
  console.log('');
}

if (expiringSoon.length > 0) {
  console.log('Expiring soon:');
  for (const exc of expiringSoon) {
    const expiryDate = new Date(exc.expiry + 'T00:00:00');
    const daysLeft = Math.ceil((expiryDate - today) / (1000 * 60 * 60 * 24));
    console.log(`  - ${exc.id}: ${exc.package} (${exc.advisory}) expires in ${daysLeft} day(s) on ${exc.expiry}`);
  }
  console.log('');
}

if (expired.length > 0) {
  console.log('EXPIRED (action required):');
  for (const exc of expired) {
    console.log(`  - ${exc.id}: ${exc.package} (${exc.advisory}) expired ${exc.expiry}`);
  }
  console.log('');
}

// --- CI annotations ---
if (ciMode) {
  for (const err of errors) {
    console.log(`::error file=.audit-exceptions.json::${err}`);
  }
  for (const warn of warnings) {
    console.log(`::warning file=.audit-exceptions.json::${warn}`);
  }
}

// --- Print errors and warnings ---
if (warnings.length > 0) {
  console.log('Warnings:');
  for (const w of warnings) {
    console.log(`  WARNING: ${w}`);
  }
  console.log('');
}

if (errors.length > 0) {
  console.log('Errors:');
  for (const e of errors) {
    console.log(`  ERROR: ${e}`);
  }
  console.log('');
  console.log(`FAILED: ${errors.length} error(s) found in security exception registry.`);
  process.exit(1);
}

console.log('PASSED: All security exceptions are valid and current.');
process.exit(0);
