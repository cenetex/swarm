/**
 * Memory Service — Tier Operations
 *
 * Decay, promotion (immediate -> recent), identity snapshots,
 * and identity history.
 *
 * @module memory/tiers
 */
import { randomUUID } from 'crypto';
import {
  DynamoDBClient,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import {
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { logger } from '@swarm/core';
import type {
  AvatarMemory,
  AvatarIdentitySnapshot,
  MemoryTier,
} from '../../types.js';
import {
  promiseAllSettledWithTimeout,
} from '../promise-timeout.js';
import {
  ADMIN_TABLE,
  DEFAULT_CONFIG,
  getDynamoClient,
  computeMemoryTtl,
  getRetentionDaysForAvatar,
  validateAvatarId,
  validateContent,
} from './shared.js';
import { createMemory, deleteMemories } from './crud.js';
import { getMemories } from './search.js';
import { createEdge } from './graph.js';

// ============================================================================
// Consolidation Operations
// ============================================================================

/**
 * Apply decay to all memories in a tier
 * Uses batch updates for efficiency
 *
 * @param avatarId - The avatar's unique identifier
 * @param tier - The memory tier to apply decay to
 * @param decayRate - Multiplier for strength (default: 0.95)
 * @returns Statistics about the decay operation
 */
export async function applyDecay(
  avatarId: string,
  tier: MemoryTier,
  decayRate: number = DEFAULT_CONFIG.decayRate
): Promise<{ decayed: number; pruned: number }> {
  const validAvatarId = validateAvatarId(avatarId);
  const memories = await getMemories(validAvatarId, { tier, limit: 500 });

  let decayed = 0;
  let pruned = 0;
  const toPrune: string[] = [];
  const toUpdate: Array<{ sk: string; newStrength: number }> = [];

  // Calculate new strengths
  for (const memory of memories) {
    const newStrength = memory.strength * decayRate;

    if (newStrength < DEFAULT_CONFIG.pruneThreshold) {
      toPrune.push(memory.sk);
      pruned++;
    } else {
      toUpdate.push({ sk: memory.sk, newStrength });
      decayed++;
    }
  }

  // Batch update strengths (in groups of 25 for reasonable parallelism)
  const updateBatches: Array<Array<{ sk: string; newStrength: number }>> = [];
  for (let i = 0; i < toUpdate.length; i += 25) {
    updateBatches.push(toUpdate.slice(i, i + 25));
  }

  const now = Date.now();
  for (const batch of updateBatches) {
    await promiseAllSettledWithTimeout(
      batch.map(({ sk, newStrength }) =>
        getDynamoClient().send(new UpdateCommand({
          TableName: ADMIN_TABLE,
          Key: { pk: `MEMORY#${validAvatarId}`, sk },
          UpdateExpression: 'SET strength = :strength, updatedAt = :now, consolidatedAt = :now',
          ExpressionAttributeValues: {
            ':strength': newStrength,
            ':now': now,
          },
        })).catch(err => {
          logger.warn('Failed to update memory strength', {
            event: 'memory_decay_update_error',
            avatarId: validAvatarId,
            sk,
            error: err instanceof Error ? err.message : 'Unknown error',
          });
        })
      ),
      undefined, 'applyDecay',
    );
  }

  // Delete pruned memories
  if (toPrune.length > 0) {
    await deleteMemories(validAvatarId, toPrune);
  }

  logger.info('Memory decay applied', {
    event: 'memory_decay',
    avatarId: validAvatarId,
    tier,
    decayed,
    pruned,
  });

  return { decayed, pruned };
}

/**
 * Promote oldest immediate memories to recent tier
 * Uses DynamoDB transactions for atomicity
 *
 * @param avatarId - The avatar's unique identifier
 * @param maxImmediate - Maximum memories to keep in immediate tier
 * @returns Statistics about the promotion operation
 */
export async function promoteImmediateToRecent(
  avatarId: string,
  maxImmediate: number = DEFAULT_CONFIG.immediateMaxCount
): Promise<{ promoted: number }> {
  const validAvatarId = validateAvatarId(avatarId);
  const immediateMemories = await getMemories(validAvatarId, { tier: 'immediate', limit: 500 });

  if (immediateMemories.length <= maxImmediate) {
    return { promoted: 0 };
  }

  // Look up retention days for TTL on promoted memories
  const retentionDays = await getRetentionDaysForAvatar(validAvatarId);
  const ttl = computeMemoryTtl(retentionDays);

  // Sort by creation time, oldest first
  const sorted = [...immediateMemories].sort((a, b) => a.createdAt - b.createdAt);
  const toPromote = sorted.slice(0, sorted.length - maxImmediate);

  let promoted = 0;

  // Process one at a time with transaction for atomicity
  // This ensures we don't lose memories if the process fails partway through
  for (const memory of toPromote) {
    const now = Date.now();
    const newId = randomUUID();
    const newMemory: AvatarMemory = {
      pk: `MEMORY#${validAvatarId}`,
      sk: `recent#${now}#${newId}`,
      id: newId,
      avatarId: validAvatarId,
      tier: 'recent',
      type: memory.type,
      content: memory.content,
      about: memory.about,
      userId: memory.userId,
      themes: memory.themes,
      strength: memory.strength * 0.9, // Slight decay on promotion
      // Preserve embedding on promotion (avoids re-embedding cost)
      embedding: memory.embedding,
      embeddingModel: memory.embeddingModel,
      embeddingVersion: memory.embeddingVersion,
      metadata: memory.metadata,
      createdAt: now,
      updatedAt: now,
      sourceMemoryIds: [memory.id],
    };

    // Include TTL in the marshalled item for DynamoDB auto-expiration
    const dynamoItem: Record<string, unknown> = { ...newMemory };
    if (ttl !== undefined) {
      dynamoItem.ttl = ttl;
    }

    try {
      // Use transaction to ensure both write and delete succeed together
      const client = new DynamoDBClient({});
      await client.send(new TransactWriteItemsCommand({
        TransactItems: [
          {
            Put: {
              TableName: ADMIN_TABLE,
              Item: marshall(dynamoItem, { removeUndefinedValues: true }),
            },
          },
          {
            Delete: {
              TableName: ADMIN_TABLE,
              Key: marshall({
                pk: `MEMORY#${validAvatarId}`,
                sk: memory.sk,
              }),
            },
          },
        ],
      }));
      promoted++;

      // Create graph edge tracking the promotion lineage
      createEdge(validAvatarId, {
        sourceMemoryId: newId,
        targetMemoryId: memory.id,
        edgeType: 'promoted_from',
        weight: 0.8,
        retentionDays: retentionDays === -1 ? undefined : retentionDays,
      }).catch(() => { /* Best-effort edge creation */ });
    } catch (error) {
      logger.error('Failed to promote memory', {
        event: 'memory_promotion_error',
        avatarId: validAvatarId,
        memoryId: memory.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      // Continue with other memories
    }
  }

  logger.info('Immediate memories promoted to recent', {
    event: 'memory_promotion',
    avatarId: validAvatarId,
    promoted,
    attempted: toPromote.length,
  });

  return { promoted };
}

/**
 * Save an identity snapshot
 *
 * @param avatarId - The avatar's unique identifier
 * @param statement - The identity statement (e.g., "I am becoming more curious")
 * @param triggeringMemories - IDs of memories that led to this identity
 * @param previousStatement - The previous identity statement for tracking evolution
 * @returns The created identity snapshot
 */
export async function saveIdentitySnapshot(
  avatarId: string,
  statement: string,
  triggeringMemories: string[],
  previousStatement?: string
): Promise<AvatarIdentitySnapshot> {
  const validAvatarId = validateAvatarId(avatarId);
  const validStatement = validateContent(statement);

  // Look up retention days for TTL
  const retentionDays = await getRetentionDaysForAvatar(validAvatarId);
  const ttl = computeMemoryTtl(retentionDays);

  const now = Date.now();
  const snapshot: AvatarIdentitySnapshot = {
    pk: `IDENTITY#${validAvatarId}`,
    sk: `SNAPSHOT#${now}`,
    avatarId: validAvatarId,
    statement: validStatement,
    previousStatement,
    triggeringMemories,
    createdAt: now,
  };

  // Build DynamoDB item with optional TTL
  const dynamoItem: Record<string, unknown> = { ...snapshot };
  if (ttl !== undefined) {
    dynamoItem.ttl = ttl;
  }

  try {
    await getDynamoClient().send(new PutCommand({
      TableName: ADMIN_TABLE,
      Item: dynamoItem,
    }));

    // Also create a core memory for the identity (retentionDays passed through)
    await createMemory(validAvatarId, {
      tier: 'core',
      type: 'identity',
      content: validStatement,
      strength: 1.0,
      metadata: { snapshotSk: snapshot.sk },
      retentionDays,
    });

    logger.info('Identity snapshot saved', {
      event: 'identity_snapshot',
      avatarId: validAvatarId,
      statement: validStatement.slice(0, 100),
    });

    return snapshot;
  } catch (error) {
    logger.error('Failed to save identity snapshot', {
      event: 'identity_snapshot_error',
      avatarId: validAvatarId,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    throw error;
  }
}

/**
 * Get identity history (evolution over time)
 *
 * @param avatarId - The avatar's unique identifier
 * @param limit - Maximum number of snapshots to return
 * @returns Array of identity snapshots, newest first
 */
export async function getIdentityHistory(
  avatarId: string,
  limit: number = 10
): Promise<AvatarIdentitySnapshot[]> {
  const validAvatarId = validateAvatarId(avatarId);
  const safeLimit = Math.min(limit, 50);

  const result = await getDynamoClient().send(new QueryCommand({
    TableName: ADMIN_TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: {
      ':pk': `IDENTITY#${validAvatarId}`,
      ':prefix': 'SNAPSHOT#',
    },
    ScanIndexForward: false,
    Limit: safeLimit,
  }));

  return (result.Items || []) as AvatarIdentitySnapshot[];
}
