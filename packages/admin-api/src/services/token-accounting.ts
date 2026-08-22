/**
 * Token Accounting Service
 *
 * Provides durable per-request token usage tracking with aggregate rollups
 * by API key, avatar, and day. Replaces the rough `length / 4` estimation
 * with provider-reported usage when available, falling back to a model-aware
 * character-based estimate marked as estimated.
 *
 * DynamoDB Schema:
 *
 * Per-request log (for audit/drill-down):
 *   pk: TOKEN_LOG#{keyHash}
 *   sk: REQ#{YYYY-MM-DD}#{requestId}
 *
 * Daily rollup by API key:
 *   pk: TOKEN_ROLLUP#KEY#{keyHash}
 *   sk: DAY#{YYYY-MM-DD}
 *
 * Daily rollup by avatar:
 *   pk: TOKEN_ROLLUP#AVATAR#{avatarId}
 *   sk: DAY#{YYYY-MM-DD}
 *
 * All records use TTL for automatic cleanup (90 days for logs, 365 days for rollups).
 */
import { UpdateCommand, QueryCommand } from '@swarm/core';
import type { DynamoDBDocumentClient } from '@swarm/core';
import { logger } from '@swarm/core';
import { calculateCostMicroUsd } from './model-pricing.js';
import { getDynamoClient } from './dynamo-client.js';

// TTL constants
const LOG_TTL_DAYS = 90;
const ROLLUP_TTL_DAYS = 365;

// ============================================================================
// Types
// ============================================================================

/** Source of the token usage data */
export type UsageSource = 'provider' | 'estimated';

/**
 * Token usage for a single request, with source attribution.
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  usageSource: UsageSource;
}

/**
 * Full token accounting record for a single API request.
 */
export interface TokenAccountingRecord {
  requestId: string;
  keyHash: string;
  avatarId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  usageSource: UsageSource;
  inputCostMicroUsd: number;
  outputCostMicroUsd: number;
  totalCostMicroUsd: number;
  pricingVersion: number;
  timestamp: number;
}

/**
 * Daily rollup record (aggregated from per-request logs).
 */
export interface TokenRollup {
  date: string;
  requestCount: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalCostMicroUsd: number;
  providerReportedCount: number;
  estimatedCount: number;
}

/**
 * Dependencies for token accounting (enables DI for testing).
 */
export interface TokenAccountingDeps {
  dynamoClient: Pick<DynamoDBDocumentClient, 'send'>;
  tableName: string;
  now: () => number;
}

// ============================================================================
// Token estimation fallback
// ============================================================================

/**
 * Average characters per token by model family.
 * More accurate than the naive `length / 4` estimate.
 * Based on empirical token:character ratios for English text.
 */
const CHARS_PER_TOKEN: Record<string, number> = {
  'anthropic/': 3.5,
  'openai/': 4.0,
  'deepseek/': 3.8,
  'google/': 4.0,
  'x-ai/': 4.0,
  'minimax/': 4.0,
};

const DEFAULT_CHARS_PER_TOKEN = 4.0;

function getCharsPerToken(model: string): number {
  for (const [prefix, ratio] of Object.entries(CHARS_PER_TOKEN)) {
    if (model.startsWith(prefix)) {
      return ratio;
    }
  }
  return DEFAULT_CHARS_PER_TOKEN;
}

/**
 * Estimate token count from text length using model-aware ratio.
 * Returns the estimate and marks it as `estimated`.
 */
export function estimateTokens(text: string, model: string): number {
  const charsPerToken = getCharsPerToken(model);
  return Math.ceil(text.length / charsPerToken);
}

/**
 * Resolve token usage: prefer provider-reported, fall back to estimation.
 */
export function resolveTokenUsage(
  providerUsage: { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined,
  promptText: string,
  completionText: string,
  model: string,
): TokenUsage {
  // Use provider-reported if both prompt and completion tokens are present
  if (
    providerUsage &&
    typeof providerUsage.promptTokens === 'number' &&
    typeof providerUsage.completionTokens === 'number' &&
    providerUsage.promptTokens > 0
  ) {
    return {
      promptTokens: providerUsage.promptTokens,
      completionTokens: providerUsage.completionTokens,
      totalTokens: providerUsage.totalTokens ??
        (providerUsage.promptTokens + providerUsage.completionTokens),
      usageSource: 'provider',
    };
  }

  // Fall back to model-aware estimation
  const promptTokens = estimateTokens(promptText, model);
  const completionTokens = estimateTokens(completionText, model);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    usageSource: 'estimated',
  };
}

// ============================================================================
// Default deps (production)
// ============================================================================

function getDefaultDeps(): TokenAccountingDeps {
  return {
    dynamoClient: getDynamoClient(),
    tableName: process.env.ADMIN_TABLE!,
    now: () => Date.now(),
  };
}

// ============================================================================
// Record a request
// ============================================================================

/**
 * Record token usage for a single API request.
 *
 * Writes three items atomically-ish (fire-and-forget updates):
 * 1. Per-request log entry
 * 2. Daily rollup by API key
 * 3. Daily rollup by avatar
 *
 * This is designed to be non-blocking: failures are logged but do not
 * propagate to the caller.
 */
export async function recordTokenUsage(
  params: {
    requestId: string;
    keyHash: string;
    avatarId: string;
    model: string;
    usage: TokenUsage;
  },
  deps: TokenAccountingDeps = getDefaultDeps(),
): Promise<void> {
  const { requestId, keyHash, avatarId, model, usage } = params;
  const now = deps.now();
  const date = new Date(now).toISOString().split('T')[0];

  const cost = calculateCostMicroUsd(model, usage.promptTokens, usage.completionTokens);
  const logTtl = Math.floor(now / 1000) + LOG_TTL_DAYS * 86400;
  const rollupTtl = Math.floor(now / 1000) + ROLLUP_TTL_DAYS * 86400;

  const promises: Promise<unknown>[] = [];

  // 1. Per-request log
  promises.push(
    deps.dynamoClient.send(new UpdateCommand({
      TableName: deps.tableName,
      Key: {
        pk: `TOKEN_LOG#${keyHash}`,
        sk: `REQ#${date}#${requestId}`,
      },
      UpdateExpression: `SET
        avatarId = :avatarId,
        model = :model,
        promptTokens = :promptTokens,
        completionTokens = :completionTokens,
        totalTokens = :totalTokens,
        usageSource = :usageSource,
        inputCostMicroUsd = :inputCost,
        outputCostMicroUsd = :outputCost,
        totalCostMicroUsd = :totalCost,
        pricingVersion = :pricingVersion,
        #ts = :ts,
        #ttl = :ttl`,
      ExpressionAttributeNames: {
        '#ts': 'timestamp',
        '#ttl': 'ttl',
      },
      ExpressionAttributeValues: {
        ':avatarId': avatarId,
        ':model': model,
        ':promptTokens': usage.promptTokens,
        ':completionTokens': usage.completionTokens,
        ':totalTokens': usage.totalTokens,
        ':usageSource': usage.usageSource,
        ':inputCost': cost.inputCostMicroUsd,
        ':outputCost': cost.outputCostMicroUsd,
        ':totalCost': cost.totalCostMicroUsd,
        ':pricingVersion': cost.pricingVersion,
        ':ts': now,
        ':ttl': logTtl,
      },
    })),
  );

  // 2. Daily rollup by API key
  promises.push(
    incrementDailyRollup(
      `TOKEN_ROLLUP#KEY#${keyHash}`,
      date,
      usage,
      cost.totalCostMicroUsd,
      rollupTtl,
      deps,
    ),
  );

  // 3. Daily rollup by avatar
  promises.push(
    incrementDailyRollup(
      `TOKEN_ROLLUP#AVATAR#${avatarId}`,
      date,
      usage,
      cost.totalCostMicroUsd,
      rollupTtl,
      deps,
    ),
  );

  try {
    await Promise.all(promises);
    logger.info('Token usage recorded', {
      event: 'token_usage_recorded',
      subsystem: 'token-accounting',
      requestId,
      keyHash: keyHash.slice(0, 8),
      avatarId,
      model,
      totalTokens: usage.totalTokens,
      totalCostMicroUsd: cost.totalCostMicroUsd,
      usageSource: usage.usageSource,
    });
  } catch (err) {
    logger.warn('Failed to record token usage', {
      event: 'token_usage_record_failed',
      subsystem: 'token-accounting',
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ============================================================================
// Increment daily rollup
// ============================================================================

async function incrementDailyRollup(
  pk: string,
  date: string,
  usage: TokenUsage,
  costMicroUsd: number,
  ttl: number,
  deps: TokenAccountingDeps,
): Promise<void> {
  const isProvider = usage.usageSource === 'provider' ? 1 : 0;
  const isEstimated = usage.usageSource === 'estimated' ? 1 : 0;

  await deps.dynamoClient.send(new UpdateCommand({
    TableName: deps.tableName,
    Key: { pk, sk: `DAY#${date}` },
    UpdateExpression: `SET
      #date = :date,
      requestCount = if_not_exists(requestCount, :zero) + :one,
      totalPromptTokens = if_not_exists(totalPromptTokens, :zero) + :promptTokens,
      totalCompletionTokens = if_not_exists(totalCompletionTokens, :zero) + :completionTokens,
      totalTokens = if_not_exists(totalTokens, :zero) + :totalTokens,
      totalCostMicroUsd = if_not_exists(totalCostMicroUsd, :zero) + :costMicroUsd,
      providerReportedCount = if_not_exists(providerReportedCount, :zero) + :providerCount,
      estimatedCount = if_not_exists(estimatedCount, :zero) + :estimatedCount,
      #ttl = :ttl,
      updatedAt = :updatedAt`,
    ExpressionAttributeNames: {
      '#date': 'date',
      '#ttl': 'ttl',
    },
    ExpressionAttributeValues: {
      ':date': date,
      ':zero': 0,
      ':one': 1,
      ':promptTokens': usage.promptTokens,
      ':completionTokens': usage.completionTokens,
      ':totalTokens': usage.totalTokens,
      ':costMicroUsd': costMicroUsd,
      ':providerCount': isProvider,
      ':estimatedCount': isEstimated,
      ':ttl': ttl,
      ':updatedAt': deps.now(),
    },
  }));
}

// ============================================================================
// Query rollups (admin reporting)
// ============================================================================

/**
 * Get daily token usage rollups for an API key over a date range.
 */
export async function getKeyUsageRollups(
  keyHash: string,
  days: number = 7,
  deps: TokenAccountingDeps = getDefaultDeps(),
): Promise<TokenRollup[]> {
  return queryRollups(`TOKEN_ROLLUP#KEY#${keyHash}`, days, deps);
}

/**
 * Get daily token usage rollups for an avatar over a date range.
 */
export async function getAvatarUsageRollups(
  avatarId: string,
  days: number = 7,
  deps: TokenAccountingDeps = getDefaultDeps(),
): Promise<TokenRollup[]> {
  return queryRollups(`TOKEN_ROLLUP#AVATAR#${avatarId}`, days, deps);
}

async function queryRollups(
  pk: string,
  days: number,
  deps: TokenAccountingDeps,
): Promise<TokenRollup[]> {
  const now = deps.now();
  const endDate = new Date(now);
  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - days + 1);

  const startKey = `DAY#${formatDate(startDate)}`;
  const endKey = `DAY#${formatDate(endDate)}`;

  const result = await deps.dynamoClient.send(new QueryCommand({
    TableName: deps.tableName,
    KeyConditionExpression: 'pk = :pk AND sk BETWEEN :start AND :end',
    ExpressionAttributeValues: {
      ':pk': pk,
      ':start': startKey,
      ':end': endKey,
    },
    ScanIndexForward: true,
  }));

  const records = (result.Items || []) as Array<Record<string, unknown>>;
  const recordMap = new Map(records.map(r => [r.date as string, r]));

  // Fill in gaps with zero-value entries
  const rollups: TokenRollup[] = [];
  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    const dateStr = formatDate(d);
    const record = recordMap.get(dateStr);
    rollups.push({
      date: dateStr,
      requestCount: (record?.requestCount as number) ?? 0,
      totalPromptTokens: (record?.totalPromptTokens as number) ?? 0,
      totalCompletionTokens: (record?.totalCompletionTokens as number) ?? 0,
      totalTokens: (record?.totalTokens as number) ?? 0,
      totalCostMicroUsd: (record?.totalCostMicroUsd as number) ?? 0,
      providerReportedCount: (record?.providerReportedCount as number) ?? 0,
      estimatedCount: (record?.estimatedCount as number) ?? 0,
    });
  }

  return rollups;
}

function formatDate(d: Date): string {
  return d.toISOString().split('T')[0];
}

/**
 * Exposed for testing only — allows injecting deps into recordTokenUsage.
 */
export const _internal = {
  recordTokenUsage,
  getKeyUsageRollups,
  getAvatarUsageRollups,
};
