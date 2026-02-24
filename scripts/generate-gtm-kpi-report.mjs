#!/usr/bin/env node
/**
 * GTM KPI Report Generator
 *
 * Queries DynamoDB funnel events (F0-F6) and produces a weekly GTM KPI report
 * with conversion rates, failure breakdowns, and target comparisons.
 *
 * Funnel stages (from docs/GTM-STRATEGY-M2.md):
 *   F0 - Qualified visitor/session
 *   F1 - Authenticated account
 *   F2 - Avatar created
 *   F3 - First live response delivered
 *   F4 - Day-7 active avatar
 *   F5 - Paid conversion
 *   F6 - Expansion event (2+ active avatars or team usage)
 *
 * Usage:
 *   node scripts/generate-gtm-kpi-report.mjs [options]
 *
 * Options:
 *   --days <n>              Reporting window in days (default: 7)
 *   --environment <name>    Logical environment label (default: staging)
 *   --output <path>         Markdown output path
 *   --json-output <path>    JSON output path
 *   -h, --help              Show this help
 *
 * Required environment variables:
 *   ADMIN_TABLE             DynamoDB table with funnel event records
 *
 * Optional environment variables:
 *   AWS_REGION              AWS region (default: us-east-1)
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_REPORT_DAYS = 7;
const MAX_REPORT_DAYS = 90;
const DEFAULT_REGION = process.env.AWS_REGION || 'us-east-1';

const FUNNEL_STAGES = ['F0', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6'];

const FUNNEL_STAGE_LABELS = {
  F0: 'Qualified visitor/session',
  F1: 'Authenticated account',
  F2: 'Avatar created',
  F3: 'First live response delivered',
  F4: 'Day-7 active avatar',
  F5: 'Paid conversion',
  F6: 'Expansion event',
};

// M2 conversion targets from docs/GTM-STRATEGY-M2.md section 9
const CONVERSION_TARGETS = {
  'F1->F2': 0.60,
  'F2->F3': 0.70,
  'F3->F4': 0.35,
  'F4->F5': 0.10,
};

// ============================================================================
// Arg parsing
// ============================================================================

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') {
      out.help = 'true';
      continue;
    }
    if (!token.startsWith('--')) continue;
    const trimmed = token.slice(2);
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex >= 0) {
      out[trimmed.slice(0, eqIndex)] = trimmed.slice(eqIndex + 1);
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[trimmed] = 'true';
      continue;
    }
    out[trimmed] = next;
    i += 1;
  }
  return out;
}

function parseIntWithDefault(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// ============================================================================
// DynamoDB queries
// ============================================================================

/**
 * Query funnel events for a specific stage using the GSI1 index.
 * GSI1 schema: gsi1pk = FUNNEL_STAGE#<stage>, gsi1sk = <timestamp>
 */
async function queryFunnelEventsByStage(docClient, tableName, stage, sinceMs) {
  const items = [];
  let lastKey;

  do {
    const result = await docClient.send(new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI1',
      KeyConditionExpression: 'gsi1pk = :gsi1pk AND gsi1sk >= :since',
      ExpressionAttributeValues: {
        ':gsi1pk': `FUNNEL_STAGE#${stage}`,
        ':since': sinceMs,
      },
      Limit: 5000,
      ScanIndexForward: false,
      ExclusiveStartKey: lastKey,
    }));

    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return items;
}

// ============================================================================
// Report generation
// ============================================================================

async function generateReport(docClient, tableName, options) {
  const now = Date.now();
  const periodEnd = options.until ?? now;
  const periodStart = options.since ?? periodEnd - options.days * 24 * 60 * 60 * 1000;

  // Fetch events for each stage in parallel
  const stageEventsMap = new Map();

  const results = await Promise.all(
    FUNNEL_STAGES.map(async (stage) => {
      const events = await queryFunnelEventsByStage(docClient, tableName, stage, periodStart);
      // Filter events within the reporting window
      const filtered = events.filter(
        (e) => e.timestamp >= periodStart && e.timestamp <= periodEnd,
      );
      return { stage, events: filtered };
    }),
  );

  for (const { stage, events } of results) {
    stageEventsMap.set(stage, events);
  }

  // Build stage metrics
  const stages = FUNNEL_STAGES.map((stage) => {
    const events = stageEventsMap.get(stage) || [];
    const uniqueUsers = new Set(events.map((e) => e.userId));
    return {
      stage,
      label: FUNNEL_STAGE_LABELS[stage],
      count: events.length,
      uniqueUsers: uniqueUsers.size,
    };
  });

  // Build conversion steps
  const conversions = [];
  for (let i = 0; i < FUNNEL_STAGES.length - 1; i++) {
    const from = FUNNEL_STAGES[i];
    const to = FUNNEL_STAGES[i + 1];
    const fromMetrics = stages[i];
    const toMetrics = stages[i + 1];
    const key = `${from}->${to}`;
    const target = CONVERSION_TARGETS[key] ?? null;

    const rate = fromMetrics.uniqueUsers > 0
      ? toMetrics.uniqueUsers / fromMetrics.uniqueUsers
      : 0;

    conversions.push({
      from,
      to,
      fromCount: fromMetrics.uniqueUsers,
      toCount: toMetrics.uniqueUsers,
      conversionRate: Math.round(rate * 10000) / 10000,
      target,
      meetsTarget: target !== null ? rate >= target : true,
    });
  }

  // Build failure breakdowns
  const failures = [];
  for (const stage of FUNNEL_STAGES) {
    const events = stageEventsMap.get(stage) || [];
    const failedEvents = events.filter((e) => e.failureReason);

    if (failedEvents.length === 0) continue;

    const reasonCounts = new Map();
    for (const e of failedEvents) {
      const reason = e.failureReason;
      reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
    }

    const reasons = Array.from(reasonCounts.entries())
      .map(([reason, count]) => ({
        reason,
        count,
        percentage: Math.round((count / failedEvents.length) * 10000) / 100,
      }))
      .sort((a, b) => b.count - a.count);

    failures.push({ stage, reasons });
  }

  // Compute blocked-step rate (events with failureReason / total events)
  let totalEvents = 0;
  let totalFailedEvents = 0;
  for (const stage of FUNNEL_STAGES) {
    const events = stageEventsMap.get(stage) || [];
    totalEvents += events.length;
    totalFailedEvents += events.filter((e) => e.failureReason).length;
  }

  const blockedStepRate = totalEvents > 0
    ? Math.round((totalFailedEvents / totalEvents) * 10000) / 10000
    : 0;

  return {
    periodStart,
    periodEnd,
    stages,
    conversions,
    failures,
    blockedStepRate,
    totalEvents,
    totalFailedEvents,
    generatedAt: Date.now(),
  };
}

// ============================================================================
// Markdown formatting
// ============================================================================

function formatPercent(value) {
  return (value * 100).toFixed(1) + '%';
}

function formatDate(ms) {
  return new Date(ms).toISOString().split('T')[0];
}

function buildMarkdownReport(report, options) {
  const lines = [];
  const startDate = formatDate(report.periodStart);
  const endDate = formatDate(report.periodEnd);

  lines.push(`# Weekly GTM KPI Report`);
  lines.push('');
  lines.push(`- **Generated:** ${new Date(report.generatedAt).toISOString()}`);
  lines.push(`- **Environment:** ${options.environment}`);
  lines.push(`- **Period:** ${startDate} to ${endDate} (${options.days} days)`);
  lines.push(`- **Reference:** docs/GTM-STRATEGY-M2.md (section 9)`);
  lines.push('');

  // ── Summary KPIs ──
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|------:|');
  lines.push(`| Total funnel events | ${report.totalEvents} |`);
  lines.push(`| Failed events | ${report.totalFailedEvents} |`);
  lines.push(`| Blocked-step rate | ${formatPercent(report.blockedStepRate)} |`);

  // Highlight key conversion KPIs
  for (const c of report.conversions) {
    const key = `${c.from}->${c.to}`;
    if (CONVERSION_TARGETS[key] !== undefined) {
      const status = c.meetsTarget ? 'OK' : 'BELOW TARGET';
      lines.push(`| ${key} conversion | ${formatPercent(c.conversionRate)} (target: ${formatPercent(c.target)}, ${status}) |`);
    }
  }
  lines.push('');

  // ── Stage Metrics ──
  lines.push('## Stage Metrics');
  lines.push('');
  lines.push('| Stage | Label | Events | Unique Users |');
  lines.push('|-------|-------|-------:|-------------:|');
  for (const s of report.stages) {
    lines.push(`| ${s.stage} | ${s.label} | ${s.count} | ${s.uniqueUsers} |`);
  }
  lines.push('');

  // ── Conversion Rates ──
  lines.push('## Conversion Rates');
  lines.push('');
  lines.push('| Step | From | To | Rate | Target | Status |');
  lines.push('|------|-----:|---:|-----:|-------:|--------|');
  for (const c of report.conversions) {
    const pct = formatPercent(c.conversionRate);
    const targetStr = c.target !== null ? formatPercent(c.target) : '-';
    const status = c.target !== null
      ? (c.meetsTarget ? 'OK' : 'BELOW TARGET')
      : '-';
    lines.push(`| ${c.from}->${c.to} | ${c.fromCount} | ${c.toCount} | ${pct} | ${targetStr} | ${status} |`);
  }
  lines.push('');

  // ── Failure Reasons ──
  if (report.failures.length > 0) {
    lines.push('## Failure Reasons');
    lines.push('');
    for (const f of report.failures) {
      lines.push(`### ${f.stage} (${FUNNEL_STAGE_LABELS[f.stage]})`);
      lines.push('');
      lines.push('| Reason | Count | % of Failures |');
      lines.push('|--------|------:|--------------:|');
      for (const r of f.reasons) {
        lines.push(`| ${r.reason} | ${r.count} | ${r.percentage}% |`);
      }
      lines.push('');
    }
  }

  // ── Notes ──
  lines.push('## Notes');
  lines.push('');
  lines.push('- Funnel events sourced from DynamoDB GSI1 (`FUNNEL_STAGE#<stage>`).');
  lines.push('- Conversion rates use unique user counts per stage.');
  lines.push('- KPI targets from docs/GTM-STRATEGY-M2.md section 9.');
  lines.push('- Blocked-step rate = events with `failureReason` / total events.');
  lines.push('- This report is designed for weekly GTM review (section 13 cadence).');
  lines.push('');

  return lines.join('\n');
}

// ============================================================================
// Help
// ============================================================================

function printHelp() {
  process.stdout.write(`GTM KPI Report Generator

Queries DynamoDB funnel events and produces a weekly GTM KPI report
with conversion rates, failure breakdowns, and target comparisons.

Usage:
  node scripts/generate-gtm-kpi-report.mjs [options]

Options:
  --days <n>              Reporting window in days (default: ${DEFAULT_REPORT_DAYS}, max: ${MAX_REPORT_DAYS})
  --environment <name>    Logical environment label (default: staging)
  --output <path>         Markdown output path (default: report-artifacts/gtm-kpi-report.md)
  --json-output <path>    JSON output path (default: markdown path with .json extension)
  -h, --help              Show this help

Required environment variables:
  ADMIN_TABLE             DynamoDB table with funnel event records

Optional environment variables:
  AWS_REGION              AWS region (default: us-east-1)
`);
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === 'true') {
    printHelp();
    return;
  }

  const daysRaw = parseIntWithDefault(args.days ?? process.env.REPORT_DAYS, DEFAULT_REPORT_DAYS);
  const days = clamp(daysRaw, 1, MAX_REPORT_DAYS);
  const environment = String(args.environment ?? process.env.REPORT_ENV ?? 'staging');

  const markdownOutput = resolve(
    args.output ?? process.env.REPORT_OUTPUT ?? 'report-artifacts/gtm-kpi-report.md',
  );
  const jsonOutput = resolve(
    args['json-output']
      ?? process.env.REPORT_JSON_OUTPUT
      ?? markdownOutput.replace(/\.md$/i, '.json'),
  );

  const tableName = process.env.ADMIN_TABLE;
  if (!tableName) {
    throw new Error('ADMIN_TABLE environment variable is required');
  }

  const ddbClient = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: DEFAULT_REGION }),
    { marshallOptions: { removeUndefinedValues: true } },
  );

  const report = await generateReport(ddbClient, tableName, { days });

  const markdown = buildMarkdownReport(report, { environment, days });

  const reportJson = {
    generatedAt: new Date(report.generatedAt).toISOString(),
    environment,
    region: DEFAULT_REGION,
    adminTable: tableName,
    window: {
      days,
      startDate: formatDate(report.periodStart),
      endDate: formatDate(report.periodEnd),
    },
    stages: report.stages,
    conversions: report.conversions,
    failures: report.failures,
    blockedStepRate: report.blockedStepRate,
    totalEvents: report.totalEvents,
    totalFailedEvents: report.totalFailedEvents,
  };

  // Write output files
  mkdirSync(dirname(markdownOutput), { recursive: true });
  mkdirSync(dirname(jsonOutput), { recursive: true });
  writeFileSync(markdownOutput, `${markdown}\n`, 'utf8');
  writeFileSync(jsonOutput, `${JSON.stringify(reportJson, null, 2)}\n`, 'utf8');

  // Summary for CI
  const belowTarget = report.conversions.filter((c) => c.target !== null && !c.meetsTarget);
  const summary = [
    `Wrote markdown report: ${markdownOutput}`,
    `Wrote JSON report: ${jsonOutput}`,
    `Period: ${formatDate(report.periodStart)} to ${formatDate(report.periodEnd)}`,
    `Total funnel events: ${report.totalEvents}`,
    `Blocked-step rate: ${formatPercent(report.blockedStepRate)}`,
    belowTarget.length > 0
      ? `Conversions below target: ${belowTarget.map((c) => `${c.from}->${c.to} (${formatPercent(c.conversionRate)} vs ${formatPercent(c.target)})`).join(', ')}`
      : 'All tracked conversions meet targets',
  ].join('\n');

  process.stdout.write(`${summary}\n`);

  // Append to GitHub Actions step summary if available
  if (process.env.GITHUB_STEP_SUMMARY) {
    const stepSummary = [
      '## GTM KPI Report',
      '',
      `**Period:** ${formatDate(report.periodStart)} to ${formatDate(report.periodEnd)}`,
      `**Total funnel events:** ${report.totalEvents}`,
      `**Blocked-step rate:** ${formatPercent(report.blockedStepRate)}`,
      '',
    ];

    if (belowTarget.length > 0) {
      stepSummary.push('### Conversions Below Target');
      stepSummary.push('');
      for (const c of belowTarget) {
        stepSummary.push(`- **${c.from}->${c.to}**: ${formatPercent(c.conversionRate)} (target: ${formatPercent(c.target)})`);
      }
    } else {
      stepSummary.push('All tracked conversions meet targets.');
    }

    stepSummary.push('');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, stepSummary.join('\n'), 'utf8');
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
