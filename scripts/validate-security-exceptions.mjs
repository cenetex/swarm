#!/usr/bin/env node
/**
 * Validate the security exception registry.
 *
 * Checks performed:
 *   1. JSON schema validation (required fields, types, enums).
 *   2. Unique exception IDs.
 *   3. Expired exceptions with status "active" are flagged as errors.
 *   4. Exceptions expiring within 14 days emit warnings.
 *   5. Summary suitable for CI step summaries and triage reports.
 *
 * Exit codes:
 *   0 - all checks pass (warnings may still be emitted)
 *   1 - validation errors or expired active exceptions detected
 *
 * Usage:
 *   node scripts/validate-security-exceptions.mjs [--warn-days 14] [--json]
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY_PATH = resolve(__dirname, '..', '.github/policy/security-exceptions.json');
const SCHEMA_PATH = resolve(__dirname, '..', '.github/policy/security-exceptions.schema.json');

const args = process.argv.slice(2);
const warnDaysIdx = args.indexOf('--warn-days');
const WARN_DAYS = warnDaysIdx !== -1 ? Number(args[warnDaysIdx + 1]) : 14;
const JSON_OUTPUT = args.includes('--json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    console.error(`Failed to read ${path}: ${err.message}`);
    process.exit(1);
  }
}

function daysUntil(dateStr) {
  const target = new Date(dateStr + 'T00:00:00Z');
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  return Math.ceil((target - now) / (1000 * 60 * 60 * 24));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const registry = loadJson(REGISTRY_PATH);
const schema = loadJson(SCHEMA_PATH);

// 1. Schema validation
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);
const valid = validate(registry);

const errors = [];
const warnings = [];

if (!valid) {
  for (const err of validate.errors) {
    errors.push(`Schema error at ${err.instancePath || '/'}: ${err.message}`);
  }
}

// 2. Unique IDs
const idSet = new Set();
for (const ex of registry.exceptions ?? []) {
  if (idSet.has(ex.id)) {
    errors.push(`Duplicate exception ID: ${ex.id}`);
  }
  idSet.add(ex.id);
}

// 3. Expiry checks (only for active exceptions)
const today = new Date();
today.setUTCHours(0, 0, 0, 0);

const expired = [];
const expiringSoon = [];

for (const ex of registry.exceptions ?? []) {
  if (ex.status !== 'active') continue;

  const days = daysUntil(ex.expiry);

  if (days < 0) {
    expired.push({ ...ex, daysOverdue: Math.abs(days) });
    errors.push(
      `Exception ${ex.id} ("${ex.title}") expired ${Math.abs(days)} day(s) ago (expiry: ${ex.expiry}). ` +
      `Update its status to "expired" or "resolved", or extend the expiry date after review.`
    );
  } else if (days <= WARN_DAYS) {
    expiringSoon.push({ ...ex, daysRemaining: days });
    warnings.push(
      `Exception ${ex.id} ("${ex.title}") expires in ${days} day(s) (expiry: ${ex.expiry}). ` +
      `Owner: @${ex.owner}`
    );
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const activeExceptions = (registry.exceptions ?? []).filter(e => e.status === 'active');
const resolvedExceptions = (registry.exceptions ?? []).filter(e => e.status === 'resolved');
const revokedExceptions = (registry.exceptions ?? []).filter(e => e.status === 'revoked');
const expiredExceptions = (registry.exceptions ?? []).filter(e => e.status === 'expired');

const summary = {
  total: (registry.exceptions ?? []).length,
  active: activeExceptions.length,
  resolved: resolvedExceptions.length,
  revoked: revokedExceptions.length,
  expired: expiredExceptions.length,
  expiringSoon: expiringSoon.length,
  expiredActive: expired.length,
  errors: errors.length,
  warnings: warnings.length,
};

if (JSON_OUTPUT) {
  console.log(JSON.stringify({
    summary,
    errors,
    warnings,
    expired,
    expiringSoon,
  }, null, 2));
} else {
  console.log('=== Security Exception Registry Validation ===\n');
  console.log(`Registry:    ${REGISTRY_PATH}`);
  console.log(`Total:       ${summary.total} exception(s)`);
  console.log(`  Active:    ${summary.active}`);
  console.log(`  Resolved:  ${summary.resolved}`);
  console.log(`  Revoked:   ${summary.revoked}`);
  console.log(`  Expired:   ${summary.expired}`);
  console.log();

  if (errors.length > 0) {
    console.log(`ERRORS (${errors.length}):`);
    for (const e of errors) {
      console.log(`  [ERROR] ${e}`);
    }
    console.log();
  }

  if (warnings.length > 0) {
    console.log(`WARNINGS (${warnings.length}):`);
    for (const w of warnings) {
      console.log(`  [WARN] ${w}`);
    }
    console.log();
  }

  if (expiringSoon.length > 0) {
    console.log('Exceptions expiring soon:');
    for (const ex of expiringSoon) {
      console.log(`  - ${ex.id}: ${ex.title} (${ex.daysRemaining} day(s) remaining, owner: @${ex.owner})`);
    }
    console.log();
  }

  if (errors.length === 0 && warnings.length === 0) {
    console.log('All checks passed.\n');
  }
}

// ---------------------------------------------------------------------------
// GitHub Actions annotations
// ---------------------------------------------------------------------------

if (process.env.GITHUB_ACTIONS === 'true') {
  for (const e of errors) {
    console.log(`::error file=.github/policy/security-exceptions.json::${e}`);
  }
  for (const w of warnings) {
    console.log(`::warning file=.github/policy/security-exceptions.json::${w}`);
  }

  // Write step summary
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFileSync } = await import('fs');
    const lines = [
      '## Security Exception Registry',
      '',
      `| Metric | Count |`,
      `|--------|-------|`,
      `| Total exceptions | ${summary.total} |`,
      `| Active | ${summary.active} |`,
      `| Resolved | ${summary.resolved} |`,
      `| Expired (status) | ${summary.expired} |`,
      `| Expiring soon (${WARN_DAYS}d) | ${summary.expiringSoon} |`,
      `| Errors | ${summary.errors} |`,
      `| Warnings | ${summary.warnings} |`,
      '',
    ];

    if (expired.length > 0) {
      lines.push('### Expired Active Exceptions');
      lines.push('');
      for (const ex of expired) {
        lines.push(`- **${ex.id}**: ${ex.title} -- expired ${ex.daysOverdue} day(s) ago (owner: @${ex.owner})`);
      }
      lines.push('');
    }

    if (expiringSoon.length > 0) {
      lines.push('### Expiring Soon');
      lines.push('');
      for (const ex of expiringSoon) {
        lines.push(`- **${ex.id}**: ${ex.title} -- ${ex.daysRemaining} day(s) remaining (owner: @${ex.owner})`);
      }
      lines.push('');
    }

    appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n'));
  }
}

// ---------------------------------------------------------------------------
// Exit
// ---------------------------------------------------------------------------

if (errors.length > 0) {
  if (!JSON_OUTPUT) {
    console.log(`Validation FAILED with ${errors.length} error(s).`);
  }
  process.exit(1);
}

if (!JSON_OUTPUT) {
  console.log('Validation PASSED.');
}
process.exit(0);
