/**
 * Memory Service — CRUD Operations
 *
 * Core create / read / update / delete operations for avatar memories.
 *
 * @module memory/crud
 */
import { randomUUID } from 'crypto';
import {
  PutCommand,
  QueryCommand,
  DeleteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { logger } from '@swarm/core';
import type {
  AvatarMemory,
  MemoryTier,
  MemoryType,
} from '../../types.js';
import {
  getEmbeddingService,
  EMBEDDING_VERSION,
} from '../embedding.js';
import {
  ADMIN_TABLE,
  MAX_STRENGTH,
  DEFAULT_CONFIG,
  getDynamoClient,
  computeMemoryTtl,
  validateAvatarId,
  validateContent,
  validateThemes,
  validateStrength,
  batchWriteWithRetry,
} from './shared.js';

// ============================================================================
// Memory CRUD Operations
// ============================================================================

/**
 * Create a new memory
 *
 * Automatically generates vector embeddings for semantic search unless
 * an embedding is provided or generation fails (graceful degradation).
 *
 * @param avatarId - The avatar's unique identifier
 * @param params - Memory creation parameters
 * @returns The created memory record
 * @throws Error if validation fails
 */
export async function createMemory(
  avatarId: string,
  params: {
    tier: MemoryTier;
    type: MemoryType;
    content: string;
    about?: string;
    userId?: string;
    themes?: string[];
    strength?: number;
    embedding?: number[];
    skipEmbedding?: boolean;
    metadata?: Record<string, unknown>;
    sourceMemoryIds?: string[];
    /** Memory retention in days. -1 = unlimited, 0/undefined = default (30d). */
    retentionDays?: number;
  }
): Promise<AvatarMemory> {
  // Validate inputs
  const validAvatarId = validateAvatarId(avatarId);
  const validContent = validateContent(params.content);
  const validThemes = validateThemes(params.themes);
  const validStrength = validateStrength(params.strength);

  const now = Date.now();
  const id = randomUUID();
  const tier = params.tier;

  // Generate embedding if not provided and not skipped
  let embedding = params.embedding;
  let embeddingModel: string | undefined;
  let embeddingVersion: number | undefined;

  if (!embedding && !params.skipEmbedding) {
    try {
      const embeddingService = getEmbeddingService();
      embedding = await embeddingService.embed(validContent);
      embeddingModel = embeddingService.modelId;
      embeddingVersion = EMBEDDING_VERSION;
    } catch (error) {
      // Graceful degradation - continue without embedding
      logger.warn('Failed to generate embedding for memory', {
        event: 'embedding_generation_error',
        avatarId: validAvatarId,
        memoryId: id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // Compute TTL for DynamoDB automatic expiration
  const ttl = computeMemoryTtl(params.retentionDays);

  const memory: AvatarMemory = {
    pk: `MEMORY#${validAvatarId}`,
    sk: `${tier}#${now}#${id}`,
    id,
    avatarId: validAvatarId,
    tier,
    type: params.type,
    content: validContent,
    about: params.about?.trim().slice(0, 100),
    userId: params.userId?.trim().slice(0, 100),
    themes: validThemes,
    strength: validStrength,
    embedding,
    embeddingModel,
    embeddingVersion,
    metadata: params.metadata,
    createdAt: now,
    updatedAt: now,
    sourceMemoryIds: params.sourceMemoryIds,
  };

  // Build DynamoDB item, including ttl only when defined (unlimited retention omits it)
  const dynamoItem: Record<string, unknown> = { ...memory };
  if (ttl !== undefined) {
    dynamoItem.ttl = ttl;
  }

  try {
    await getDynamoClient().send(new PutCommand({
      TableName: ADMIN_TABLE,
      Item: dynamoItem,
    }));

    logger.info('Memory created', {
      event: 'memory_created',
      avatarId: validAvatarId,
      memoryId: id,
      tier,
      type: params.type,
      contentLength: validContent.length,
      hasEmbedding: !!embedding,
      ttl: ttl ?? 'unlimited',
    });

    return memory;
  } catch (error) {
    logger.error('Failed to create memory', {
      event: 'memory_create_error',
      avatarId: validAvatarId,
      tier,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    throw error;
  }
}

/**
 * Get a single memory by ID
 *
 * @param avatarId - The avatar's unique identifier
 * @param memoryId - The memory's unique identifier
 * @param tier - The memory tier (required for efficient lookup)
 * @returns The memory record or null if not found
 */
export async function getMemory(
  avatarId: string,
  memoryId: string,
  tier?: MemoryTier
): Promise<AvatarMemory | null> {
  const validAvatarId = validateAvatarId(avatarId);

  // If tier is provided, we can do a more efficient query
  if (tier) {
    const result = await getDynamoClient().send(new QueryCommand({
      TableName: ADMIN_TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      FilterExpression: 'id = :id',
      ExpressionAttributeValues: {
        ':pk': `MEMORY#${validAvatarId}`,
        ':prefix': `${tier}#`,
        ':id': memoryId,
      },
      Limit: 1,
    }));
    return (result.Items?.[0] as AvatarMemory) || null;
  }

  // Without tier, search all tiers
  for (const t of ['immediate', 'recent', 'core'] as MemoryTier[]) {
    const result = await getDynamoClient().send(new QueryCommand({
      TableName: ADMIN_TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      FilterExpression: 'id = :id',
      ExpressionAttributeValues: {
        ':pk': `MEMORY#${validAvatarId}`,
        ':prefix': `${t}#`,
        ':id': memoryId,
      },
      Limit: 1,
    }));
    if (result.Items?.[0]) {
      return result.Items[0] as AvatarMemory;
    }
  }

  return null;
}

/**
 * Update memory strength (for reinforcement)
 * Strength is capped at MAX_STRENGTH to prevent unbounded growth
 *
 * @param avatarId - The avatar's unique identifier
 * @param memoryId - The memory's unique identifier (for logging)
 * @param sk - The sort key of the memory
 * @param boost - Amount to increase strength by
 */
export async function reinforceMemory(
  avatarId: string,
  memoryId: string,
  sk: string,
  boost: number = DEFAULT_CONFIG.reinforcementBoost
): Promise<void> {
  const validAvatarId = validateAvatarId(avatarId);

  try {
    await getDynamoClient().send(new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: {
        pk: `MEMORY#${validAvatarId}`,
        sk,
      },
      // Cap strength at MAX_STRENGTH
      UpdateExpression: 'SET strength = if_not_exists(strength, :one) + :boost, updatedAt = :now',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: {
        ':boost': Math.min(boost, MAX_STRENGTH - 1), // Prevent exceeding max in one boost
        ':one': 1.0,
        ':now': Date.now(),
      },
    }));

    // Cap the strength if it exceeded MAX_STRENGTH
    await getDynamoClient().send(new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: {
        pk: `MEMORY#${validAvatarId}`,
        sk,
      },
      UpdateExpression: 'SET strength = :max',
      ConditionExpression: 'strength > :max',
      ExpressionAttributeValues: {
        ':max': MAX_STRENGTH,
      },
    })).catch(() => {
      // Ignore condition check failure - strength was already <= MAX_STRENGTH
    });

    logger.info('Memory reinforced', {
      event: 'memory_reinforced',
      avatarId: validAvatarId,
      memoryId,
      boost,
    });
  } catch (error) {
    // Log but don't throw - reinforcement failure shouldn't break the caller
    logger.warn('Failed to reinforce memory', {
      event: 'memory_reinforce_error',
      avatarId: validAvatarId,
      memoryId,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}

/**
 * Delete a single memory
 *
 * @param avatarId - The avatar's unique identifier
 * @param sk - The sort key of the memory to delete
 */
export async function deleteMemory(avatarId: string, sk: string): Promise<void> {
  const validAvatarId = validateAvatarId(avatarId);

  try {
    await getDynamoClient().send(new DeleteCommand({
      TableName: ADMIN_TABLE,
      Key: {
        pk: `MEMORY#${validAvatarId}`,
        sk,
      },
    }));
  } catch (error) {
    logger.error('Failed to delete memory', {
      event: 'memory_delete_error',
      avatarId: validAvatarId,
      sk,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    throw error;
  }
}

/**
 * Delete multiple memories (batch operation)
 * Handles DynamoDB's 25-item batch limit automatically
 *
 * @param avatarId - The avatar's unique identifier
 * @param sks - Array of sort keys to delete
 */
export async function deleteMemories(avatarId: string, sks: string[]): Promise<void> {
  if (sks.length === 0) return;

  const validAvatarId = validateAvatarId(avatarId);

  // DynamoDB batch write limit is 25
  const batches: string[][] = [];
  for (let i = 0; i < sks.length; i += 25) {
    batches.push(sks.slice(i, i + 25));
  }

  const errors: Error[] = [];

  for (const batch of batches) {
    try {
      await batchWriteWithRetry({
        [ADMIN_TABLE]: batch.map(sk => ({
          DeleteRequest: {
            Key: {
              pk: `MEMORY#${validAvatarId}`,
              sk,
            },
          },
        })),
      });
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error('Unknown error'));
    }
  }

  if (errors.length > 0) {
    logger.error('Some batch deletes failed', {
      event: 'memory_batch_delete_error',
      avatarId: validAvatarId,
      totalBatches: batches.length,
      failedBatches: errors.length,
    });
  }
}
