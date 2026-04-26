/**
 * Identity Snapshot Service (handlers)
 *
 * Retrieves the latest identity snapshot for an avatar from DynamoDB.
 * Integrates with the memory consolidation workflow to inject avatar
 * self-reflection into the system prompt.
 */
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from '@swarm/core';
import { getDynamoClient } from './dynamo-client.js';

interface IdentitySnapshot {
  pk: string;
  sk: string;
  avatarId: string;
  statement: string;
  previousStatement?: string;
  triggeringMemories: string[];
  createdAt: number;
}

const STATE_TABLE = process.env.STATE_TABLE;

// 5-minute cache for identity snapshots (they only change daily)
interface CacheEntry {
  snapshot: IdentitySnapshot | null;
  timestamp: number;
}

const SNAPSHOT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const snapshotCache = new Map<string, CacheEntry>();

/**
 * Retrieve the latest identity snapshot for an avatar with caching.
 * Snapshots are generated daily by the consolidation worker and contain
 * "I am becoming..." statements that reflect the avatar's recent evolution.
 *
 * @param avatarId - The avatar's unique identifier
 * @returns Latest identity snapshot, or null if none exists
 */
export async function getLatestIdentitySnapshot(avatarId: string): Promise<IdentitySnapshot | null> {
  if (!STATE_TABLE) {
    logger.warn('STATE_TABLE not configured; skipping identity snapshot retrieval', {
      event: 'identity_snapshot_missing_config',
      avatarId,
    });
    return null;
  }

  const now = Date.now();
  const cached = snapshotCache.get(avatarId);

  // Return cached result if still valid
  if (cached && now - cached.timestamp < SNAPSHOT_CACHE_TTL_MS) {
    return cached.snapshot;
  }

  try {
    const result = await getDynamoClient().send(new QueryCommand({
      TableName: STATE_TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': `IDENTITY#${avatarId}`,
        ':prefix': 'SNAPSHOT#',
      },
      ScanIndexForward: false,
      Limit: 1,
    }));

    const snapshot = result.Items && result.Items.length > 0
      ? (result.Items[0] as IdentitySnapshot)
      : null;

    // Cache the result (even null results are cached to avoid repeated queries)
    snapshotCache.set(avatarId, {
      snapshot,
      timestamp: now,
    });

    return snapshot;
  } catch (error) {
    logger.error('Failed to fetch latest identity snapshot', {
      event: 'identity_snapshot_fetch_error',
      avatarId,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return null;
  }
}

/**
 * Clear the cache entry for an avatar.
 * Useful for testing or forcing a refresh.
 */
export function clearSnapshotCache(avatarId: string): void {
  snapshotCache.delete(avatarId);
}

/**
 * Clear all snapshot cache entries.
 * Useful for testing.
 */
export function clearAllSnapshotCache(): void {
  snapshotCache.clear();
}
