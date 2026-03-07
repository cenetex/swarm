/**
 * Avatar Health Service
 *
 * Aggregates per-avatar health metrics from existing DynamoDB records:
 * - Memory counts (by tier)
 * - Last activity timestamp (from avatar updatedAt + latest log)
 * - Consolidation status (from memory tier distribution)
 * - Error event counts
 *
 * All queries are read-only and use existing indexes.
 *
 * @module avatar-health
 */
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from '@swarm/core';
import { getDynamoClient } from './dynamo-client.js';
import * as avatarService from './avatars.js';
import { getMemoryCounts } from './memory.js';
import type { AvatarRecord } from '../types.js';

const ADMIN_TABLE = process.env.ADMIN_TABLE || 'swarm-admin-table';

// ============================================================================
// Types
// ============================================================================

export interface AvatarHealthSummary {
  avatarId: string;
  name: string;
  status: string;
  memoryCounts: {
    immediate: number;
    recent: number;
    core: number;
    total: number;
  };
  lastActiveAt: number;
  consolidationStatus: 'healthy' | 'needs_consolidation' | 'empty' | 'unknown';
  errorCount: number;
}

export interface AvatarHealthResponse {
  avatars: AvatarHealthSummary[];
  total: number;
  cursor?: string;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Determine consolidation status from memory tier distribution.
 *
 * - 'empty': no memories at all
 * - 'needs_consolidation': immediate tier has more than 10 items (overflow)
 * - 'healthy': memory tiers look balanced
 */
function deriveConsolidationStatus(
  counts: { immediate: number; recent: number; core: number },
): AvatarHealthSummary['consolidationStatus'] {
  const total = counts.immediate + counts.recent + counts.core;
  if (total === 0) return 'empty';
  if (counts.immediate > 10) return 'needs_consolidation';
  return 'healthy';
}

/**
 * Count recent error events for an avatar (last 24h).
 * Uses existing EVENT# sort key prefix with ERROR level filtering.
 */
async function countRecentErrors(avatarId: string): Promise<number> {
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  try {
    const result = await getDynamoClient().send(new QueryCommand({
      TableName: ADMIN_TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      FilterExpression: '#ts >= :since AND #lvl = :errorLevel',
      ExpressionAttributeNames: {
        '#ts': 'timestamp',
        '#lvl': 'level',
      },
      ExpressionAttributeValues: {
        ':pk': `AVATAR#${avatarId}`,
        ':prefix': 'LOG#',
        ':since': oneDayAgo,
        ':errorLevel': 'ERROR',
      },
      Select: 'COUNT',
    }));
    return result.Count || 0;
  } catch (error) {
    logger.warn('Failed to count errors for avatar', {
      event: 'avatar_health_error_count_failed',
      avatarId,
      error: error instanceof Error ? error.message : 'Unknown',
    });
    return 0;
  }
}

/**
 * Build health summary for a single avatar.
 */
async function buildHealthSummary(avatar: AvatarRecord): Promise<AvatarHealthSummary> {
  const [memoryCounts, errorCount] = await Promise.all([
    getMemoryCounts(avatar.avatarId).catch(() => ({
      immediate: 0, recent: 0, core: 0, ephemeral: 0, durable: 0, archival: 0,
    })),
    countRecentErrors(avatar.avatarId),
  ]);

  const total = memoryCounts.immediate + memoryCounts.recent + memoryCounts.core;

  return {
    avatarId: avatar.avatarId,
    name: avatar.name,
    status: avatar.status,
    memoryCounts: {
      immediate: memoryCounts.immediate,
      recent: memoryCounts.recent,
      core: memoryCounts.core,
      total,
    },
    lastActiveAt: avatar.updatedAt,
    consolidationStatus: deriveConsolidationStatus(memoryCounts),
    errorCount,
  };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Get paginated health summaries for all avatars.
 *
 * @param limit - Max avatars per page (default 20, max 100)
 * @param cursor - Opaque cursor for pagination (base64-encoded offset)
 */
export async function getAvatarHealthSummaries(
  limit: number = 20,
  cursor?: string,
): Promise<AvatarHealthResponse> {
  const effectiveLimit = Math.min(Math.max(1, limit), 100);

  // Decode cursor (offset-based pagination over the avatar list)
  let offset = 0;
  if (cursor) {
    try {
      offset = Number.parseInt(Buffer.from(cursor, 'base64').toString('utf-8'), 10);
      if (!Number.isFinite(offset) || offset < 0) offset = 0;
    } catch {
      offset = 0;
    }
  }

  // Get all avatars (these are CONFIG records, already indexed)
  const allAvatars = await avatarService.listAvatars();

  // Sort by updatedAt descending (most recently active first)
  allAvatars.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  const total = allAvatars.length;
  const page = allAvatars.slice(offset, offset + effectiveLimit);

  // Build health summaries in parallel (bounded concurrency)
  const summaries = await Promise.all(page.map(buildHealthSummary));

  const nextOffset = offset + effectiveLimit;
  const nextCursor = nextOffset < total
    ? Buffer.from(String(nextOffset)).toString('base64')
    : undefined;

  return {
    avatars: summaries,
    total,
    cursor: nextCursor,
  };
}
