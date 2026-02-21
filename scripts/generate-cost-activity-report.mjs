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
const COST_CONTROL_THRESHOLDS = Object.freeze({
  awsCostJumpPercent: 30,
  awsCostJumpAbsUsd: 15,
  costPerMessageMultiplier: 2,
  costVsActivityCostRisePercent: 25,
  costVsActivityMessageFlatPercent: 10,
  projectedMonthEndBreachPercent: 20,
  costPerMessageBaselineDays: 7,
});

const SIGNAL_STATUS = Object.freeze({
  TRIGGERED: 'TRIGGERED',
  CLEAR: 'CLEAR',
  UNAVAILABLE: 'UNAVAILABLE',
});

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

function formatSignedUsd(value) {
  if (!Number.isFinite(value)) return 'n/a';
  const abs = formatUsd(Math.abs(value));
  if (value > 0) return `+${abs}`;
  if (value < 0) return `-${abs}`;
  return abs;
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

function formatSignedPercent(value, digits = 1) {
  if (!Number.isFinite(value)) return 'n/a';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}%`;
}

function computePercentChange(currentValue, previousValue) {
  if (!Number.isFinite(currentValue) || !Number.isFinite(previousValue) || previousValue <= 0) {
    return null;
  }
  return ((currentValue - previousValue) / previousValue) * 100;
}

function daysInUtcMonth(isoDate) {
  const [yearRaw, monthRaw] = String(isoDate || '').split('-');
  const year = Number.parseInt(yearRaw || '', 10);
  const month = Number.parseInt(monthRaw || '', 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    return null;
  }
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function buildCostPerMessageSeries(usageDays, awsCost) {
  const awsByDate = awsCost?.ok
    ? new Map((awsCost.daily || []).map((day) => [day.date, Number(day.amount || 0)]))
    : null;
  const source = awsByDate ? 'aws-unblended-cost' : 'estimated-usage-cost';

  return usageDays
    .map((day) => {
      const messages = Number(day.messagesProcessed || 0);
      if (!Number.isFinite(messages) || messages <= 0) return null;

      let costUsd;
      if (awsByDate) {
        if (!awsByDate.has(day.date)) return null;
        costUsd = awsByDate.get(day.date);
      } else {
        costUsd = Number(day.estimatedUsageCostUsd || 0);
      }

      if (!Number.isFinite(costUsd)) return null;

      return {
        date: day.date,
        source,
        costUsd,
        messages,
        costPerMessageUsd: costUsd / messages,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function evaluateCostControlSignals({ usage, awsCost, monthlyBudgetUsd }) {
  const usageByDate = new Map(usage.days.map((day) => [day.date, day]));
  const awsDaily = awsCost?.ok
    ? [...(awsCost.daily || [])]
      .map((day) => ({ date: day.date, amount: Number(day.amount || 0) }))
      .sort((a, b) => a.date.localeCompare(b.date))
    : [];

  const signals = {
    thresholds: {
      awsCostJumpPercent: COST_CONTROL_THRESHOLDS.awsCostJumpPercent,
      awsCostJumpAbsUsd: COST_CONTROL_THRESHOLDS.awsCostJumpAbsUsd,
      costPerMessageMultiplier: COST_CONTROL_THRESHOLDS.costPerMessageMultiplier,
      costVsActivityCostRisePercent: COST_CONTROL_THRESHOLDS.costVsActivityCostRisePercent,
      costVsActivityMessageFlatPercent: COST_CONTROL_THRESHOLDS.costVsActivityMessageFlatPercent,
      projectedMonthEndBreachPercent: COST_CONTROL_THRESHOLDS.projectedMonthEndBreachPercent,
      costPerMessageBaselineDays: COST_CONTROL_THRESHOLDS.costPerMessageBaselineDays,
    },
    monthlyBudgetUsd,
    awsCostJump: {
      id: 'awsCostJump',
      name: 'AWS unblended cost jump',
      severity: 'P2',
      status: SIGNAL_STATUS.UNAVAILABLE,
      threshold: `>= ${COST_CONTROL_THRESHOLDS.awsCostJumpPercent}% day-over-day and >= ${formatUsd(COST_CONTROL_THRESHOLDS.awsCostJumpAbsUsd)} absolute increase`,
      observed: `unavailable (${awsCost?.error || 'AWS cost not requested'})`,
      reason: awsCost?.error || 'AWS cost not requested',
    },
    costPerMessageJump: {
      id: 'costPerMessageJump',
      name: 'Cost per message jump',
      severity: 'P2',
      status: SIGNAL_STATUS.UNAVAILABLE,
      threshold: `>= ${COST_CONTROL_THRESHOLDS.costPerMessageMultiplier.toFixed(1)}x versus prior up to ${COST_CONTROL_THRESHOLDS.costPerMessageBaselineDays} days`,
      observed: 'unavailable (insufficient cost/message history)',
      reason: 'Insufficient cost/message history',
    },
    spendRiseActivityFlat: {
      id: 'spendRiseActivityFlat',
      name: 'Spend rises while activity is flat',
      severity: 'P2',
      status: SIGNAL_STATUS.UNAVAILABLE,
      threshold: `cost >= ${COST_CONTROL_THRESHOLDS.costVsActivityCostRisePercent}% and messages within +/-${COST_CONTROL_THRESHOLDS.costVsActivityMessageFlatPercent}% day-over-day`,
      observed: `unavailable (${awsCost?.error || 'AWS cost not requested'})`,
      reason: awsCost?.error || 'AWS cost not requested',
    },
    projectedMonthEndSpendBreach: {
      id: 'projectedMonthEndSpendBreach',
      name: 'Projected month-end spend breach',
      severity: 'P1',
      status: SIGNAL_STATUS.UNAVAILABLE,
      threshold: `forecast >= budget by ${COST_CONTROL_THRESHOLDS.projectedMonthEndBreachPercent}%`,
      observed: monthlyBudgetUsd
        ? `unavailable (${awsCost?.error || 'AWS cost not requested'})`
        : 'unavailable (MONTHLY_BUDGET_USD not set)',
      reason: monthlyBudgetUsd
        ? (awsCost?.error || 'AWS cost not requested')
        : 'MONTHLY_BUDGET_USD not set',
    },
    triggered: [],
    triggeredCount: 0,
  };

  const latestAwsDay = awsDaily.at(-1);
  const previousAwsDay = awsDaily.at(-2);

  if (awsCost?.ok) {
    if (!latestAwsDay || !previousAwsDay) {
      signals.awsCostJump.observed = 'unavailable (fewer than 2 AWS daily buckets)';
      signals.awsCostJump.reason = 'Fewer than 2 AWS daily buckets';
    } else {
      const deltaUsd = latestAwsDay.amount - previousAwsDay.amount;
      const deltaPercent = computePercentChange(latestAwsDay.amount, previousAwsDay.amount);
      if (deltaPercent === null) {
        signals.awsCostJump.observed = 'unavailable (previous daily cost is zero)';
        signals.awsCostJump.reason = 'Previous daily cost is zero';
      } else {
        const triggered = (
          deltaPercent >= COST_CONTROL_THRESHOLDS.awsCostJumpPercent
          && deltaUsd >= COST_CONTROL_THRESHOLDS.awsCostJumpAbsUsd
        );
        signals.awsCostJump.status = triggered ? SIGNAL_STATUS.TRIGGERED : SIGNAL_STATUS.CLEAR;
        signals.awsCostJump.observed = `${formatUsd(previousAwsDay.amount)} -> ${formatUsd(latestAwsDay.amount)} (${formatSignedUsd(deltaUsd)}, ${formatSignedPercent(deltaPercent)})`;
        signals.awsCostJump.details = {
          previousDate: previousAwsDay.date,
          date: latestAwsDay.date,
          previousUsd: previousAwsDay.amount,
          currentUsd: latestAwsDay.amount,
          deltaUsd,
          deltaPercent,
        };
        delete signals.awsCostJump.reason;
      }
    }
  }

  const costPerMessageSeries = buildCostPerMessageSeries(usage.days, awsCost);
  if (costPerMessageSeries.length >= 2) {
    const current = costPerMessageSeries.at(-1);
    const baseline = costPerMessageSeries.slice(
      Math.max(0, costPerMessageSeries.length - 1 - COST_CONTROL_THRESHOLDS.costPerMessageBaselineDays),
      costPerMessageSeries.length - 1,
    );
    if (baseline.length > 0) {
      const baselineAvg = baseline.reduce((sum, day) => sum + day.costPerMessageUsd, 0) / baseline.length;
      if (baselineAvg > 0) {
        const multiplier = current.costPerMessageUsd / baselineAvg;
        const triggered = multiplier >= COST_CONTROL_THRESHOLDS.costPerMessageMultiplier;
        signals.costPerMessageJump.status = triggered ? SIGNAL_STATUS.TRIGGERED : SIGNAL_STATUS.CLEAR;
        signals.costPerMessageJump.observed = `${formatUsd(current.costPerMessageUsd)}/msg vs ${formatUsd(baselineAvg)}/msg (${multiplier.toFixed(2)}x, ${current.source})`;
        signals.costPerMessageJump.details = {
          date: current.date,
          source: current.source,
          currentCostPerMessageUsd: current.costPerMessageUsd,
          baselineCostPerMessageUsd: baselineAvg,
          multiplier,
          baselineStartDate: baseline[0].date,
          baselineEndDate: baseline.at(-1).date,
          baselineDays: baseline.length,
        };
        delete signals.costPerMessageJump.reason;
      } else {
        signals.costPerMessageJump.observed = 'unavailable (baseline cost per message is zero)';
        signals.costPerMessageJump.reason = 'Baseline cost per message is zero';
      }
    }
  }

  if (awsCost?.ok) {
    if (!latestAwsDay || !previousAwsDay) {
      signals.spendRiseActivityFlat.observed = 'unavailable (fewer than 2 AWS daily buckets)';
      signals.spendRiseActivityFlat.reason = 'Fewer than 2 AWS daily buckets';
    } else {
      const previousMessages = Number(usageByDate.get(previousAwsDay.date)?.messagesProcessed || 0);
      const currentMessages = Number(usageByDate.get(latestAwsDay.date)?.messagesProcessed || 0);
      const costDeltaPercent = computePercentChange(latestAwsDay.amount, previousAwsDay.amount);
      const messagesDeltaPercent = computePercentChange(currentMessages, previousMessages);

      if (costDeltaPercent === null) {
        signals.spendRiseActivityFlat.observed = 'unavailable (previous daily cost is zero)';
        signals.spendRiseActivityFlat.reason = 'Previous daily cost is zero';
      } else if (messagesDeltaPercent === null) {
        signals.spendRiseActivityFlat.observed = 'unavailable (previous daily messages are zero)';
        signals.spendRiseActivityFlat.reason = 'Previous daily messages are zero';
      } else {
        const triggered = (
          costDeltaPercent >= COST_CONTROL_THRESHOLDS.costVsActivityCostRisePercent
          && Math.abs(messagesDeltaPercent) <= COST_CONTROL_THRESHOLDS.costVsActivityMessageFlatPercent
        );
        signals.spendRiseActivityFlat.status = triggered ? SIGNAL_STATUS.TRIGGERED : SIGNAL_STATUS.CLEAR;
        signals.spendRiseActivityFlat.observed = `cost ${formatSignedPercent(costDeltaPercent)}; messages ${formatSignedPercent(messagesDeltaPercent)}`;
        signals.spendRiseActivityFlat.details = {
          previousDate: previousAwsDay.date,
          date: latestAwsDay.date,
          previousCostUsd: previousAwsDay.amount,
          currentCostUsd: latestAwsDay.amount,
          costDeltaPercent,
          previousMessages,
          currentMessages,
          messagesDeltaPercent,
        };
        delete signals.spendRiseActivityFlat.reason;
      }
    }
  }

  if (!monthlyBudgetUsd || monthlyBudgetUsd <= 0) {
    signals.projectedMonthEndSpendBreach.observed = 'unavailable (MONTHLY_BUDGET_USD not set)';
    signals.projectedMonthEndSpendBreach.reason = 'MONTHLY_BUDGET_USD not set';
  } else if (!awsCost?.ok) {
    signals.projectedMonthEndSpendBreach.observed = `unavailable (${awsCost?.error || 'AWS cost not requested'})`;
    signals.projectedMonthEndSpendBreach.reason = awsCost?.error || 'AWS cost not requested';
  } else if (awsDaily.length === 0) {
    signals.projectedMonthEndSpendBreach.observed = 'unavailable (no AWS daily buckets)';
    signals.projectedMonthEndSpendBreach.reason = 'No AWS daily buckets';
  } else {
    const latestDate = latestAwsDay?.date;
    const monthDays = daysInUtcMonth(latestDate);
    if (!monthDays) {
      signals.projectedMonthEndSpendBreach.observed = 'unavailable (could not infer month days)';
      signals.projectedMonthEndSpendBreach.reason = 'Could not infer month days';
    } else {
      const totalWindowCost = awsDaily.reduce((sum, day) => sum + day.amount, 0);
      const averageDailyCost = totalWindowCost / awsDaily.length;
      const forecastMonthEndUsd = averageDailyCost * monthDays;
      const projectedOverBudgetPercent = computePercentChange(forecastMonthEndUsd, monthlyBudgetUsd);
      const triggered = forecastMonthEndUsd >= (
        monthlyBudgetUsd * (1 + (COST_CONTROL_THRESHOLDS.projectedMonthEndBreachPercent / 100))
      );

      signals.projectedMonthEndSpendBreach.status = triggered ? SIGNAL_STATUS.TRIGGERED : SIGNAL_STATUS.CLEAR;
      signals.projectedMonthEndSpendBreach.observed = `${formatUsd(forecastMonthEndUsd)} forecast vs ${formatUsd(monthlyBudgetUsd)} budget (${formatSignedPercent(projectedOverBudgetPercent)})`;
      signals.projectedMonthEndSpendBreach.details = {
        basedOnLatestDate: latestDate,
        windowDaysUsed: awsDaily.length,
        averageDailyCostUsd: averageDailyCost,
        forecastMonthEndUsd,
        budgetUsd: monthlyBudgetUsd,
        projectedOverBudgetPercent,
      };
      delete signals.projectedMonthEndSpendBreach.reason;
    }
  }

  const signalKeys = [
    'awsCostJump',
    'costPerMessageJump',
    'spendRiseActivityFlat',
    'projectedMonthEndSpendBreach',
  ];

  signals.triggered = signalKeys.filter((key) => signals[key].status === SIGNAL_STATUS.TRIGGERED);
  signals.triggeredCount = signals.triggered.length;

  return signals;
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
    signals,
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
  lines.push('## Cost Control Signals');
  lines.push('');
  lines.push(tableLine(['Signal', 'Severity', 'Status', 'Observed', 'Threshold']));
  lines.push(tableLine(['---', '---', '---', '---', '---']));
  lines.push(tableLine([
    signals.awsCostJump.name,
    signals.awsCostJump.severity,
    signals.awsCostJump.status,
    signals.awsCostJump.observed,
    signals.awsCostJump.threshold,
  ]));
  lines.push(tableLine([
    signals.costPerMessageJump.name,
    signals.costPerMessageJump.severity,
    signals.costPerMessageJump.status,
    signals.costPerMessageJump.observed,
    signals.costPerMessageJump.threshold,
  ]));
  lines.push(tableLine([
    signals.spendRiseActivityFlat.name,
    signals.spendRiseActivityFlat.severity,
    signals.spendRiseActivityFlat.status,
    signals.spendRiseActivityFlat.observed,
    signals.spendRiseActivityFlat.threshold,
  ]));
  lines.push(tableLine([
    signals.projectedMonthEndSpendBreach.name,
    signals.projectedMonthEndSpendBreach.severity,
    signals.projectedMonthEndSpendBreach.status,
    signals.projectedMonthEndSpendBreach.observed,
    signals.projectedMonthEndSpendBreach.threshold,
  ]));
  lines.push('');
  if (signals.triggeredCount > 0) {
    lines.push(`- Triggered signals (${signals.triggeredCount}): ${signals.triggered.map((signalId) => `\`${signalId}\``).join(', ')}`);
  } else {
    lines.push('- Triggered signals: none');
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
  lines.push('- `MONTHLY_BUDGET_USD` enables projected month-end budget breach detection.');
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
  --monthly-budget-usd <n>    Monthly budget target used for breach signal (optional)
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
  MONTHLY_BUDGET_USD
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
  const monthlyBudgetRaw = args['monthly-budget-usd'] ?? process.env.MONTHLY_BUDGET_USD;
  const monthlyBudgetParsed = parseNumberWithDefault(monthlyBudgetRaw, Number.NaN);
  const monthlyBudgetUsd = Number.isFinite(monthlyBudgetParsed) && monthlyBudgetParsed > 0
    ? monthlyBudgetParsed
    : null;

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
  const signals = evaluateCostControlSignals({
    usage,
    awsCost,
    monthlyBudgetUsd,
  });

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
    signals,
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
    signals,
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
    signals.triggeredCount
      ? `Triggered cost-control signals: ${signals.triggered.map((signalId) => `\`${signalId}\``).join(', ')}`
      : 'Triggered cost-control signals: none',
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
