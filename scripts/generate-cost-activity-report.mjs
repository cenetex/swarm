#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';

const ROADMAP_REVIEWED_AT = '2026-02-20';
const MAX_REPORT_DAYS = 30;
const DEFAULT_REPORT_DAYS = 7;
const DEFAULT_REGION = process.env.AWS_REGION || 'us-east-1';

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

function parseNumberWithDefault(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number.parseFloat(String(value));
  return Number.isFinite(n) ? n : fallback;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function utcStartOfDay(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addUtcDays(date, days) {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function formatUsd(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatCount(value) {
  return new Intl.NumberFormat('en-US').format(value);
}

function usageTemplate() {
  return {
    messagesProcessed: 0,
    mediaCreditsUsed: 0,
    voiceMinutesUsed: 0,
    toolCallsMade: 0,
    imageGenerations: 0,
    videoGenerations: 0,
    stickerGenerations: 0,
  };
}

function normalizeUsageRow(row, fallbackAvatarId) {
  return {
    avatarId: typeof row.avatarId === 'string' ? row.avatarId : fallbackAvatarId,
    date: typeof row.date === 'string' ? row.date : '',
    messagesProcessed: Number(row.messagesProcessed || 0),
    mediaCreditsUsed: Number(row.mediaCreditsUsed || 0),
    voiceMinutesUsed: Number(row.voiceMinutesUsed || 0),
    toolCallsMade: Number(row.toolCallsMade || 0),
    imageGenerations: Number(row.imageGenerations || 0),
    videoGenerations: Number(row.videoGenerations || 0),
    stickerGenerations: Number(row.stickerGenerations || 0),
  };
}

function computeActivityUnits(metrics) {
  return (
    metrics.messagesProcessed +
    metrics.mediaCreditsUsed +
    metrics.voiceMinutesUsed +
    metrics.toolCallsMade +
    metrics.imageGenerations +
    metrics.videoGenerations +
    metrics.stickerGenerations
  );
}

function computeEstimatedUsageCost(metrics, rates) {
  return (
    metrics.messagesProcessed * rates.message +
    metrics.mediaCreditsUsed * rates.mediaCredit +
    metrics.voiceMinutesUsed * rates.voiceMinute +
    metrics.toolCallsMade * rates.toolCall +
    metrics.imageGenerations * rates.imageGeneration +
    metrics.videoGenerations * rates.videoGeneration +
    metrics.stickerGenerations * rates.stickerGeneration
  );
}

async function mapWithConcurrency(items, limit, worker) {
  if (items.length === 0) return [];
  const results = new Array(items.length);
  let index = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      results[current] = await worker(items[current], current);
    }
  });

  await Promise.all(runners);
  return results;
}

async function listAvatarIds(docClient, tableName) {
  const avatarIds = new Set();
  let lastKey;

  do {
    const result = await docClient.send(new QueryCommand({
      TableName: tableName,
      IndexName: 'GSI1',
      KeyConditionExpression: 'sk = :sk AND begins_with(pk, :avatarPrefix)',
      FilterExpression: 'attribute_not_exists(#status) OR #status <> :deleted',
      ProjectionExpression: 'avatarId,pk,#status',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':sk': 'CONFIG',
        ':avatarPrefix': 'AVATAR#',
        ':deleted': 'deleted',
      },
      ExclusiveStartKey: lastKey,
    }));

    for (const item of result.Items || []) {
      if (typeof item.avatarId === 'string' && item.avatarId) {
        avatarIds.add(item.avatarId);
        continue;
      }
      if (typeof item.pk === 'string' && item.pk.startsWith('AVATAR#')) {
        avatarIds.add(item.pk.slice('AVATAR#'.length));
      }
    }

    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return [...avatarIds].sort();
}

async function getUsageRowsForAvatar(docClient, tableName, avatarId, startDate, endDate) {
  const items = [];
  let lastKey;

  do {
    const result = await docClient.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk AND sk BETWEEN :start AND :end',
      ProjectionExpression: 'avatarId,#date,messagesProcessed,mediaCreditsUsed,voiceMinutesUsed,toolCallsMade,imageGenerations,videoGenerations,stickerGenerations',
      ExpressionAttributeNames: {
        '#date': 'date',
      },
      ExpressionAttributeValues: {
        ':pk': `USAGE#${avatarId}`,
        ':start': `DAY#${startDate}`,
        ':end': `DAY#${endDate}`,
      },
      ScanIndexForward: true,
      ExclusiveStartKey: lastKey,
    }));

    items.push(...(result.Items || []));
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return items.map((item) => normalizeUsageRow(item, avatarId));
}

function aggregateUsage(usageRowsByAvatar, rates) {
  const totals = usageTemplate();
  const byDay = new Map();
  const byAvatar = new Map();
  let usageRows = 0;

  for (const entry of usageRowsByAvatar) {
    const avatarId = entry.avatarId;
    const rows = entry.rows;

    const avatarAgg = byAvatar.get(avatarId) || {
      avatarId,
      ...usageTemplate(),
      activityUnits: 0,
      estimatedUsageCostUsd: 0,
      activeDays: 0,
    };

    for (const row of rows) {
      usageRows += 1;

      totals.messagesProcessed += row.messagesProcessed;
      totals.mediaCreditsUsed += row.mediaCreditsUsed;
      totals.voiceMinutesUsed += row.voiceMinutesUsed;
      totals.toolCallsMade += row.toolCallsMade;
      totals.imageGenerations += row.imageGenerations;
      totals.videoGenerations += row.videoGenerations;
      totals.stickerGenerations += row.stickerGenerations;

      avatarAgg.messagesProcessed += row.messagesProcessed;
      avatarAgg.mediaCreditsUsed += row.mediaCreditsUsed;
      avatarAgg.voiceMinutesUsed += row.voiceMinutesUsed;
      avatarAgg.toolCallsMade += row.toolCallsMade;
      avatarAgg.imageGenerations += row.imageGenerations;
      avatarAgg.videoGenerations += row.videoGenerations;
      avatarAgg.stickerGenerations += row.stickerGenerations;

      const dayAgg = byDay.get(row.date) || {
        date: row.date,
        ...usageTemplate(),
        activityUnits: 0,
        estimatedUsageCostUsd: 0,
      };
      dayAgg.messagesProcessed += row.messagesProcessed;
      dayAgg.mediaCreditsUsed += row.mediaCreditsUsed;
      dayAgg.voiceMinutesUsed += row.voiceMinutesUsed;
      dayAgg.toolCallsMade += row.toolCallsMade;
      dayAgg.imageGenerations += row.imageGenerations;
      dayAgg.videoGenerations += row.videoGenerations;
      dayAgg.stickerGenerations += row.stickerGenerations;
      byDay.set(row.date, dayAgg);
    }

    avatarAgg.activityUnits = computeActivityUnits(avatarAgg);
    avatarAgg.estimatedUsageCostUsd = computeEstimatedUsageCost(avatarAgg, rates);
    avatarAgg.activeDays = rows.length;
    byAvatar.set(avatarId, avatarAgg);
  }

  const totalsEstimatedUsageCostUsd = computeEstimatedUsageCost(totals, rates);
  const totalsActivityUnits = computeActivityUnits(totals);
  const activeAvatarCount = [...byAvatar.values()].filter((a) => a.activityUnits > 0).length;

  const days = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)).map((day) => ({
    ...day,
    activityUnits: computeActivityUnits(day),
    estimatedUsageCostUsd: computeEstimatedUsageCost(day, rates),
  }));

  const avatars = [...byAvatar.values()].sort((a, b) => {
    if (b.estimatedUsageCostUsd !== a.estimatedUsageCostUsd) {
      return b.estimatedUsageCostUsd - a.estimatedUsageCostUsd;
    }
    return b.activityUnits - a.activityUnits;
  });

  return {
    totals,
    totalsActivityUnits,
    totalsEstimatedUsageCostUsd,
    usageRows,
    activeAvatarCount,
    days,
    avatars,
  };
}

function getAwsCostAndUsageBreakdown(startDateInclusive, endDateExclusive) {
  const command = [
    'aws ce get-cost-and-usage',
    `--time-period Start=${startDateInclusive},End=${endDateExclusive}`,
    '--granularity DAILY',
    '--metrics UnblendedCost',
    '--group-by Type=DIMENSION,Key=SERVICE',
    '--output json',
  ].join(' ');

  try {
    const raw = execSync(command, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(raw);

    const daily = [];
    const byService = new Map();
    let totalUsd = 0;

    for (const bucket of parsed.ResultsByTime || []) {
      const date = bucket?.TimePeriod?.Start || '';
      let amount = Number(bucket?.Total?.UnblendedCost?.Amount || 0);
      const unit = String(bucket?.Total?.UnblendedCost?.Unit || 'USD');

      // When grouped, Total can be missing/zero. Use grouped sum for daily cost.
      if ((!Number.isFinite(amount) || amount === 0) && Array.isArray(bucket.Groups) && bucket.Groups.length > 0) {
        amount = bucket.Groups.reduce(
          (sum, group) => sum + Number(group?.Metrics?.UnblendedCost?.Amount || 0),
          0,
        );
      }

      daily.push({ date, amount, unit });
      totalUsd += amount;

      for (const group of bucket.Groups || []) {
        const service = (group.Keys && group.Keys[0]) || 'Unknown';
        const serviceAmount = Number(group?.Metrics?.UnblendedCost?.Amount || 0);
        byService.set(service, (byService.get(service) || 0) + serviceAmount);
      }
    }

    const services = [...byService.entries()]
      .map(([service, amount]) => ({ service, amount }))
      .sort((a, b) => b.amount - a.amount);

    return {
      ok: true,
      totalUsd,
      daily,
      services,
      source: 'aws-cost-explorer',
    };
  } catch (error) {
    const stderr = String(error?.stderr || '').trim();
    const stdout = String(error?.stdout || '').trim();
    const message = stderr || stdout || String(error?.message || 'Unknown error');
    return {
      ok: false,
      error: message,
      source: 'aws-cost-explorer',
    };
  }
}

function tableLine(values) {
  return `| ${values.join(' | ')} |`;
}

function toPercent(numerator, denominator) {
  if (!denominator) return '0.0%';
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function buildMarkdownReport(params) {
  const {
    generatedAtIso,
    environment,
    region,
    tableName,
    days,
    startDate,
    endDate,
    avatarCount,
    usage,
    rates,
    awsCost,
  } = params;

  const avgActivityPerActiveAvatar = usage.activeAvatarCount
    ? usage.totalsActivityUnits / usage.activeAvatarCount
    : 0;
  const avgEstimatedUsageCostPerActiveAvatar = usage.activeAvatarCount
    ? usage.totalsEstimatedUsageCostUsd / usage.activeAvatarCount
    : 0;
  const awsCostPerActiveAvatar = awsCost?.ok && usage.activeAvatarCount
    ? awsCost.totalUsd / usage.activeAvatarCount
    : 0;
  const awsCostPerMessage = awsCost?.ok && usage.totals.messagesProcessed
    ? awsCost.totalUsd / usage.totals.messagesProcessed
    : 0;

  const topAvatars = usage.avatars.slice(0, 10);
  const topActiveAvatars = usage.avatars.filter((avatar) => avatar.activityUnits > 0).slice(0, 10);
  const topAwsServices = awsCost?.ok ? awsCost.services.slice(0, 8) : [];

  const lines = [];
  lines.push('# Cost & Activity Report');
  lines.push('');
  lines.push(`- Generated: ${generatedAtIso}`);
  lines.push(`- Environment: ${environment}`);
  lines.push(`- Region: ${region}`);
  lines.push(`- Admin table: ${tableName}`);
  lines.push(`- Window: ${startDate} to ${endDate} (${days} days)`);
  lines.push(`- Roadmap reviewed: ${ROADMAP_REVIEWED_AT} (ROADMAP.md + PLAN.md)`);
  lines.push('');
  lines.push('## Roadmap KPI Coverage');
  lines.push('');
  lines.push('- `M2: Usage metering surfaced in admin UI`');
  lines.push(`  - Metered operations in window: **${formatCount(usage.totalsActivityUnits)}**`);
  lines.push(`  - Active avatars: **${formatCount(usage.activeAvatarCount)} / ${formatCount(avatarCount)}** (${toPercent(usage.activeAvatarCount, avatarCount)})`);
  lines.push('- `M2: Operational hardening`');
  lines.push(`  - Usage records collected: **${formatCount(usage.usageRows)}**`);
  lines.push(`  - Avg activity per active avatar: **${formatCount(Math.round(avgActivityPerActiveAvatar))} ops**`);
  lines.push('- `M3: Reliability and cost optimization for scale`');
  lines.push(`  - Estimated usage cost (configured rates): **${formatUsd(usage.totalsEstimatedUsageCostUsd)}**`);
  if (awsCost?.ok) {
    lines.push(`  - AWS unblended cost (Cost Explorer): **${formatUsd(awsCost.totalUsd)}**`);
  } else {
    lines.push('  - AWS unblended cost: **unavailable** (see notes)');
  }
  lines.push('');
  lines.push('## Activity Totals');
  lines.push('');
  lines.push(tableLine(['Metric', 'Total']));
  lines.push(tableLine(['---', '---:']));
  lines.push(tableLine(['Messages processed', formatCount(usage.totals.messagesProcessed)]));
  lines.push(tableLine(['Media credits used', formatCount(usage.totals.mediaCreditsUsed)]));
  lines.push(tableLine(['Voice minutes used', formatCount(usage.totals.voiceMinutesUsed)]));
  lines.push(tableLine(['Tool calls made', formatCount(usage.totals.toolCallsMade)]));
  lines.push(tableLine(['Image generations', formatCount(usage.totals.imageGenerations)]));
  lines.push(tableLine(['Video generations', formatCount(usage.totals.videoGenerations)]));
  lines.push(tableLine(['Sticker generations', formatCount(usage.totals.stickerGenerations)]));
  lines.push(tableLine(['Total metered activity units', formatCount(usage.totalsActivityUnits)]));
  lines.push('');
  lines.push('## Cost Summary');
  lines.push('');
  lines.push(tableLine(['Metric', 'Value']));
  lines.push(tableLine(['---', '---:']));
  lines.push(tableLine(['Estimated usage cost (configured rates)', formatUsd(usage.totalsEstimatedUsageCostUsd)]));
  lines.push(tableLine(['Estimated usage cost per active avatar', formatUsd(avgEstimatedUsageCostPerActiveAvatar)]));
  if (awsCost?.ok) {
    lines.push(tableLine(['AWS unblended cost (Cost Explorer)', formatUsd(awsCost.totalUsd)]));
    lines.push(tableLine(['AWS cost per active avatar', formatUsd(awsCostPerActiveAvatar)]));
    lines.push(tableLine(['AWS cost per message', usage.totals.messagesProcessed ? formatUsd(awsCostPerMessage) : 'n/a']));
  } else {
    lines.push(tableLine(['AWS unblended cost (Cost Explorer)', `unavailable (${awsCost?.error || 'not requested'})`]));
  }
  lines.push('');
  lines.push('## Top Avatars by Estimated Usage Cost');
  lines.push('');
  lines.push(tableLine(['Avatar', 'Activity Units', 'Messages', 'Media', 'Voice Min', 'Tools', 'Estimated Cost']));
  lines.push(tableLine(['---', '---:', '---:', '---:', '---:', '---:', '---:']));
  if (topActiveAvatars.length === 0) {
    lines.push(tableLine(['_none_', '0', '0', '0', '0', '0', formatUsd(0)]));
  } else {
    for (const avatar of topActiveAvatars) {
      lines.push(tableLine([
        `\`${avatar.avatarId}\``,
        formatCount(avatar.activityUnits),
        formatCount(avatar.messagesProcessed),
        formatCount(avatar.mediaCreditsUsed),
        formatCount(avatar.voiceMinutesUsed),
        formatCount(avatar.toolCallsMade),
        formatUsd(avatar.estimatedUsageCostUsd),
      ]));
    }
  }
  lines.push('');
  lines.push('## Daily Activity Trend');
  lines.push('');
  lines.push(tableLine(['Date', 'Activity Units', 'Messages', 'Media', 'Voice Min', 'Tools', 'Estimated Cost']));
  lines.push(tableLine(['---', '---:', '---:', '---:', '---:', '---:', '---:']));
  if (usage.days.length === 0) {
    lines.push(tableLine(['_none_', '0', '0', '0', '0', '0', formatUsd(0)]));
  } else {
    for (const day of usage.days) {
      lines.push(tableLine([
        day.date,
        formatCount(day.activityUnits),
        formatCount(day.messagesProcessed),
        formatCount(day.mediaCreditsUsed),
        formatCount(day.voiceMinutesUsed),
        formatCount(day.toolCallsMade),
        formatUsd(day.estimatedUsageCostUsd),
      ]));
    }
  }
  lines.push('');
  if (awsCost?.ok) {
    lines.push('## AWS Cost by Service');
    lines.push('');
    lines.push(tableLine(['Service', 'Unblended Cost']));
    lines.push(tableLine(['---', '---:']));
    for (const svc of topAwsServices) {
      lines.push(tableLine([svc.service, formatUsd(svc.amount)]));
    }
    lines.push('');
  }
  lines.push('## Configured Unit Rates');
  lines.push('');
  lines.push(tableLine(['Rate Key', 'USD']));
  lines.push(tableLine(['---', '---:']));
  lines.push(tableLine(['message', String(rates.message)]));
  lines.push(tableLine(['mediaCredit', String(rates.mediaCredit)]));
  lines.push(tableLine(['voiceMinute', String(rates.voiceMinute)]));
  lines.push(tableLine(['toolCall', String(rates.toolCall)]));
  lines.push(tableLine(['imageGeneration', String(rates.imageGeneration)]));
  lines.push(tableLine(['videoGeneration', String(rates.videoGeneration)]));
  lines.push(tableLine(['stickerGeneration', String(rates.stickerGeneration)]));
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push('- Usage activity is sourced from `USAGE#{avatarId}` daily records in `ADMIN_TABLE`.');
  lines.push(`- Report window is capped to ${MAX_REPORT_DAYS} days because usage records have ~35 day TTL.`);
  lines.push('- Estimated usage cost uses configurable unit rates; defaults are zero until rates are provided.');
  lines.push('- AWS cost comes from Cost Explorer (`ce:GetCostAndUsage`) and can be unavailable if IAM permissions are missing.');
  lines.push('- Token-level LLM spend per API key is not yet durable in current model (tracked separately in issue #206).');
  lines.push('');

  return lines.join('\n');
}

function printHelp() {
  process.stdout.write(`Cost & Activity Report Generator

Usage:
  node scripts/generate-cost-activity-report.mjs [options]

Options:
  --days <n>                  Reporting window in days (default: ${DEFAULT_REPORT_DAYS}, max: ${MAX_REPORT_DAYS})
  --environment <name>        Logical environment label (default: unknown)
  --output <path>             Markdown output path (default: test-outputs/reports/cost-activity-report.md)
  --json-output <path>        JSON output path (default: markdown path with .json extension)
  --include-aws-cost <bool>   Query Cost Explorer via AWS CLI (default: true)
  -h, --help                  Show this help

Required environment variables:
  ADMIN_TABLE                 DynamoDB table with avatar configs + usage records

Optional environment variables:
  AWS_REGION                  AWS region (default: us-east-1)
  COST_PER_MESSAGE_USD
  COST_PER_MEDIA_CREDIT_USD
  COST_PER_VOICE_MINUTE_USD
  COST_PER_TOOL_CALL_USD
  COST_PER_IMAGE_GEN_USD
  COST_PER_VIDEO_GEN_USD
  COST_PER_STICKER_GEN_USD
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (parseBoolean(args.help, false)) {
    printHelp();
    return;
  }

  const daysRaw = parseIntWithDefault(args.days ?? process.env.REPORT_DAYS, DEFAULT_REPORT_DAYS);
  const days = clamp(daysRaw, 1, MAX_REPORT_DAYS);

  const environment = String(args.environment ?? process.env.REPORT_ENV ?? 'unknown');
  const includeAwsCost = parseBoolean(
    args['include-aws-cost'] ?? process.env.REPORT_INCLUDE_AWS_COST,
    true,
  );

  const markdownOutput = resolve(
    args.output ?? process.env.REPORT_OUTPUT ?? 'test-outputs/reports/cost-activity-report.md',
  );
  const jsonOutput = resolve(
    args['json-output']
      ?? process.env.REPORT_JSON_OUTPUT
      ?? markdownOutput.replace(/\.md$/i, '.json'),
  );

  const tableName = process.env.ADMIN_TABLE;
  if (!tableName) {
    throw new Error('ADMIN_TABLE is required');
  }

  const rates = {
    message: parseNumberWithDefault(process.env.COST_PER_MESSAGE_USD, 0),
    mediaCredit: parseNumberWithDefault(process.env.COST_PER_MEDIA_CREDIT_USD, 0),
    voiceMinute: parseNumberWithDefault(process.env.COST_PER_VOICE_MINUTE_USD, 0),
    toolCall: parseNumberWithDefault(process.env.COST_PER_TOOL_CALL_USD, 0),
    imageGeneration: parseNumberWithDefault(process.env.COST_PER_IMAGE_GEN_USD, 0),
    videoGeneration: parseNumberWithDefault(process.env.COST_PER_VIDEO_GEN_USD, 0),
    stickerGeneration: parseNumberWithDefault(process.env.COST_PER_STICKER_GEN_USD, 0),
  };

  const endDate = utcStartOfDay(new Date());
  const startDate = addUtcDays(endDate, -(days - 1));
  const endDateExclusive = addUtcDays(endDate, 1);
  const startDateStr = toIsoDate(startDate);
  const endDateStr = toIsoDate(endDate);
  const endDateExclusiveStr = toIsoDate(endDateExclusive);

  const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: DEFAULT_REGION }), {
    marshallOptions: { removeUndefinedValues: true },
  });

  const avatarIds = await listAvatarIds(ddbClient, tableName);
  const usageRowsByAvatar = await mapWithConcurrency(
    avatarIds,
    12,
    async (avatarId) => ({
      avatarId,
      rows: await getUsageRowsForAvatar(ddbClient, tableName, avatarId, startDateStr, endDateStr),
    }),
  );

  const usage = aggregateUsage(usageRowsByAvatar, rates);
  const awsCost = includeAwsCost
    ? getAwsCostAndUsageBreakdown(startDateStr, endDateExclusiveStr)
    : { ok: false, error: 'disabled', source: 'aws-cost-explorer' };

  const generatedAtIso = new Date().toISOString();
  const markdown = buildMarkdownReport({
    generatedAtIso,
    environment,
    region: DEFAULT_REGION,
    tableName,
    days,
    startDate: startDateStr,
    endDate: endDateStr,
    avatarCount: avatarIds.length,
    usage,
    rates,
    awsCost,
  });

  const reportJson = {
    generatedAt: generatedAtIso,
    roadmapReviewedAt: ROADMAP_REVIEWED_AT,
    environment,
    region: DEFAULT_REGION,
    adminTable: tableName,
    window: {
      days,
      startDate: startDateStr,
      endDate: endDateStr,
      endDateExclusive: endDateExclusiveStr,
    },
    avatarCount: avatarIds.length,
    usage,
    rates,
    awsCost,
  };

  mkdirSync(dirname(markdownOutput), { recursive: true });
  mkdirSync(dirname(jsonOutput), { recursive: true });
  writeFileSync(markdownOutput, `${markdown}\n`, 'utf8');
  writeFileSync(jsonOutput, `${JSON.stringify(reportJson, null, 2)}\n`, 'utf8');

  const summary = [
    `Wrote markdown report: ${markdownOutput}`,
    `Wrote JSON report: ${jsonOutput}`,
    `Avatars evaluated: ${formatCount(avatarIds.length)}`,
    `Active avatars: ${formatCount(usage.activeAvatarCount)}`,
    `Activity units: ${formatCount(usage.totalsActivityUnits)}`,
    `Estimated usage cost: ${formatUsd(usage.totalsEstimatedUsageCostUsd)}`,
    awsCost.ok
      ? `AWS unblended cost: ${formatUsd(awsCost.totalUsd)}`
      : `AWS unblended cost: unavailable (${awsCost.error})`,
  ].join('\n');

  process.stdout.write(`${summary}\n`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Cost & Activity Report\n\n${summary}\n`, 'utf8');
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
