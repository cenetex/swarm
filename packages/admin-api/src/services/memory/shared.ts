/**
 * Memory Service — Shared Utilities
 *
 * Configuration constants, validation helpers, TTL computation,
 * DynamoDB client accessor, and batch-write-with-retry.
 *
 * Every other file in services/memory/ imports from this module;
 * it MUST NOT import from any sibling to avoid circular deps.
 *
 * @module memory/shared
 */
import {
  type DynamoDBDocumentClient,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { getDynamoClient as getSharedDynamoClient, _setDynamoClient as _setSharedDynamoClient } from '../dynamo-client.js';
import { logger } from '@swarm/core';
import type {
  MemoryConsolidationConfig,
  GraphPruneConfig,
} from '../../types.js';

// ============================================================================
// Configuration
// ============================================================================

export const ADMIN_TABLE = process.env.ADMIN_TABLE || 'swarm-admin-table';

/** Maximum content length for a single memory (characters) */
export const MAX_CONTENT_LENGTH = 2000;

/** Maximum number of themes per memory */
export const MAX_THEMES = 10;

/** Maximum strength value (capped on reinforcement) */
export const MAX_STRENGTH = 2.0;

/** Default memory retention in days when no plan config is available */
export const DEFAULT_RETENTION_DAYS = 30;

/** Seconds in a day */
export const SECONDS_PER_DAY = 86400;

// ============================================================================
// TTL Helpers
// ============================================================================

/**
 * Compute a DynamoDB TTL value (epoch seconds) from a retention period.
 *
 * @param retentionDays - Number of days to retain the item.
 *   - >0: TTL is now + retentionDays * 86400
 *   - 0 or undefined: uses DEFAULT_RETENTION_DAYS (30 days)
 *   - -1: unlimited retention, returns undefined (no TTL set)
 * @returns Epoch-seconds TTL or undefined for unlimited
 */
export function computeMemoryTtl(retentionDays?: number): number | undefined {
  if (retentionDays === -1) {
    // Unlimited retention - no TTL
    return undefined;
  }

  const effectiveDays = (retentionDays && retentionDays > 0)
    ? retentionDays
    : DEFAULT_RETENTION_DAYS;

  return Math.floor(Date.now() / 1000) + (effectiveDays * SECONDS_PER_DAY);
}

/**
 * Get the memory retention days for an avatar by looking up its entitlement.
 *
 * Falls back to DEFAULT_RETENTION_DAYS if no entitlement is found.
 * This import is done lazily to avoid circular dependency issues.
 */
export async function getRetentionDaysForAvatar(avatarId: string): Promise<number> {
  if (_retentionDaysOverride) return _retentionDaysOverride(avatarId);
  try {
    const { getMemoryConfig } = await import('../entitlements.js');
    const config = await getMemoryConfig(avatarId);
    // retentionDays: 0 = no retention (free tier, memory disabled)
    // In free tier memoryEnabled is false, so memories shouldn't be written at all.
    // But if they are, apply default TTL rather than leaving them forever.
    if (config.retentionDays === 0 && !config.enabled) {
      return DEFAULT_RETENTION_DAYS;
    }
    return config.retentionDays || DEFAULT_RETENTION_DAYS;
  } catch (error) {
    logger.warn('Failed to get retention days, using default', {
      event: 'retention_days_lookup_error',
      avatarId,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return DEFAULT_RETENTION_DAYS;
  }
}

/** Default configuration for memory consolidation */
export const DEFAULT_CONFIG: MemoryConsolidationConfig = {
  immediateMaxCount: 10,
  recentMaxCount: 50,
  recentSummaryThreshold: 10,
  coreMaxCount: 100,
  decayRate: 0.95,
  decayIntervalHours: 24,
  pruneThreshold: 0.1,
  reinforcementBoost: 0.1,
};

/** Default configuration for graph pruning */
export const DEFAULT_GRAPH_CONFIG: GraphPruneConfig = {
  minEdgeWeight: 0.1,
  edgeDecayRate: 0.95,
  maxEdgesPerNode: 20,
  maxTotalEdges: 2000,
};

// ============================================================================
// DynamoDB Client
// ============================================================================

export function getDynamoClient(): DynamoDBDocumentClient {
  return getSharedDynamoClient();
}

// For testing - allows injecting a mock client
export function _setDynamoClient(client: DynamoDBDocumentClient | null): void {
  _setSharedDynamoClient(client);
}

// For testing - allows overriding getRetentionDaysForAvatar to avoid
// the dynamic import('./entitlements.js') which interacts poorly with
// bun:test's process-global mock.module.
let _retentionDaysOverride: ((avatarId: string) => Promise<number>) | null = null;
export function _setRetentionDaysOverride(fn: ((avatarId: string) => Promise<number>) | null): void {
  _retentionDaysOverride = fn;
}

// ============================================================================
// Batch Write Helper (retry unprocessed items)
// ============================================================================

/**
 * Send a BatchWriteCommand and retry any UnprocessedItems with exponential
 * backoff.  DynamoDB can return unprocessed items when provisioned throughput
 * is exceeded — silently ignoring them leads to data loss.
 *
 * @param requestItems - The RequestItems map for BatchWriteCommand
 * @param maxRetries   - Maximum number of retries (default 3)
 * @param baseDelayMs  - Base delay in ms for exponential backoff (default 100)
 */
export async function batchWriteWithRetry(
  requestItems: Record<string, unknown[]>,
  maxRetries: number = 3,
  baseDelayMs: number = 100,
): Promise<void> {
  let unprocessed: Record<string, unknown[]> | undefined = requestItems;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await getDynamoClient().send(new BatchWriteCommand({
      RequestItems: unprocessed as Record<string, Array<{ DeleteRequest?: { Key: Record<string, unknown> }; PutRequest?: { Item: Record<string, unknown> } }>>,
    }));

    const remaining = result.UnprocessedItems;

    // Check if there are unprocessed items remaining
    if (!remaining || Object.keys(remaining).length === 0) {
      return; // All items processed successfully
    }

    // If we've exhausted retries, log a warning and throw
    if (attempt === maxRetries) {
      const totalUnprocessed = Object.values(remaining).reduce(
        (sum, items) => sum + (items?.length ?? 0),
        0,
      );
      logger.warn('BatchWrite: unprocessed items remain after max retries', {
        event: 'batch_write_unprocessed_items',
        attempt,
        maxRetries,
        unprocessedCount: totalUnprocessed,
      });
      throw new Error(
        `BatchWrite failed: ${totalUnprocessed} items still unprocessed after ${maxRetries} retries`,
      );
    }

    // Exponential backoff before retrying
    const delay = baseDelayMs * Math.pow(2, attempt);
    logger.warn('BatchWrite: retrying unprocessed items', {
      event: 'batch_write_retry',
      attempt: attempt + 1,
      maxRetries,
      unprocessedCount: Object.values(remaining).reduce(
        (sum, items) => sum + (items?.length ?? 0),
        0,
      ),
      delayMs: delay,
    });
    await new Promise(resolve => setTimeout(resolve, delay));

    unprocessed = remaining as Record<string, unknown[]>;
  }
}

// ============================================================================
// Validation Helpers
// ============================================================================

/**
 * Validate and sanitize avatar ID
 */
export function validateAvatarId(avatarId: string): string {
  if (!avatarId || typeof avatarId !== 'string') {
    throw new Error('avatarId is required');
  }
  const trimmed = avatarId.trim();
  if (trimmed.length === 0) {
    throw new Error('avatarId cannot be empty');
  }
  if (trimmed.length > 100) {
    throw new Error('avatarId too long (max 100 characters)');
  }
  // Sanitize: only allow alphanumeric, dash, underscore
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    throw new Error('avatarId contains invalid characters');
  }
  return trimmed;
}

/**
 * Validate and sanitize memory content
 */
export function validateContent(content: string): string {
  if (!content || typeof content !== 'string') {
    throw new Error('content is required');
  }
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    throw new Error('content cannot be empty');
  }
  if (trimmed.length > MAX_CONTENT_LENGTH) {
    // Truncate instead of throwing - graceful degradation
    logger.warn('Memory content truncated', {
      event: 'memory_content_truncated',
      originalLength: content.length,
      maxLength: MAX_CONTENT_LENGTH,
    });
    return trimmed.slice(0, MAX_CONTENT_LENGTH);
  }
  return trimmed;
}

/**
 * Validate and sanitize themes array
 */
export function validateThemes(themes?: string[]): string[] | undefined {
  if (!themes || !Array.isArray(themes)) {
    return undefined;
  }
  return themes
    .filter(t => typeof t === 'string' && t.trim().length > 0)
    .map(t => t.trim().toLowerCase().slice(0, 50))
    .slice(0, MAX_THEMES);
}

/**
 * Validate strength value
 */
export function validateStrength(strength?: number): number {
  if (strength === undefined || strength === null) {
    return 1.0;
  }
  if (typeof strength !== 'number' || isNaN(strength)) {
    return 1.0;
  }
  return Math.max(0, Math.min(MAX_STRENGTH, strength));
}
