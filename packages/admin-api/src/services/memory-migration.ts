/**
 * Memory Migration Service
 *
 * Backfills embeddings for existing memories that lack them.
 * Designed to run as a background job or on-demand via admin chat.
 *
 * @module memory-migration
 */
import {
  type DynamoDBDocumentClient,
  UpdateCommand,
  QueryCommand,
} from '@swarm/core';
import { logger } from '@swarm/core';
import { getDynamoClient as getSharedDynamoClient } from './dynamo-client.js';
import {
  getEmbeddingService,
  EMBEDDING_VERSION,
} from './embedding.js';
import type { AvatarMemory, MemoryTier } from '../types.js';

// ============================================================================
// Configuration
// ============================================================================

const ADMIN_TABLE = process.env.ADMIN_TABLE || 'swarm-admin-table';

// ============================================================================
// DynamoDB Client
// ============================================================================

function getDynamoClient(): DynamoDBDocumentClient {
  return getSharedDynamoClient();
}

// ============================================================================
// Types
// ============================================================================

export interface MigrationResult {
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
  errors: string[];
}

export interface EmbeddingStats {
  total: number;
  withEmbedding: number;
  withoutEmbedding: number;
  outdatedEmbedding: number;
  coveragePercent: number;
  byTier: Record<MemoryTier, {
    total: number;
    withEmbedding: number;
  }>;
}

export interface BackfillOptions {
  batchSize?: number;
  dryRun?: boolean;
  forceRegenerate?: boolean;
  delayBetweenBatches?: number;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get all memories for an avatar
 */
async function getAllMemories(avatarId: string): Promise<AvatarMemory[]> {
  const memories: AvatarMemory[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const result = await getDynamoClient().send(new QueryCommand({
      TableName: ADMIN_TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': `MEMORY#${avatarId}`,
      },
      ExclusiveStartKey: lastEvaluatedKey,
      Limit: 500,
    }));

    if (result.Items) {
      memories.push(...(result.Items as AvatarMemory[]));
    }

    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return memories;
}

// ============================================================================
// Main Functions
// ============================================================================

/**
 * Get embedding statistics for an avatar's memories
 *
 * @param avatarId - The avatar's unique identifier
 * @returns Statistics about embedding coverage
 */
export async function getEmbeddingStats(avatarId: string): Promise<EmbeddingStats> {
  const memories = await getAllMemories(avatarId);

  const stats: EmbeddingStats = {
    total: memories.length,
    withEmbedding: 0,
    withoutEmbedding: 0,
    outdatedEmbedding: 0,
    coveragePercent: 0,
    byTier: {
      immediate: { total: 0, withEmbedding: 0 },
      recent: { total: 0, withEmbedding: 0 },
      core: { total: 0, withEmbedding: 0 },
      ephemeral: { total: 0, withEmbedding: 0 },
      durable: { total: 0, withEmbedding: 0 },
      archival: { total: 0, withEmbedding: 0 },
    },
  };

  for (const m of memories) {
    stats.byTier[m.tier].total++;

    if (m.embedding && Array.isArray(m.embedding) && m.embedding.length > 0) {
      if (m.embeddingVersion === EMBEDDING_VERSION) {
        stats.withEmbedding++;
        stats.byTier[m.tier].withEmbedding++;
      } else {
        stats.outdatedEmbedding++;
      }
    } else {
      stats.withoutEmbedding++;
    }
  }

  stats.coveragePercent = stats.total > 0
    ? Math.round((stats.withEmbedding / stats.total) * 100)
    : 100;

  return stats;
}

/**
 * Backfill embeddings for an avatar's memories
 *
 * @param avatarId - The avatar's unique identifier
 * @param options - Backfill options
 * @returns Migration result with statistics
 */
export async function backfillEmbeddings(
  avatarId: string,
  options: BackfillOptions = {}
): Promise<MigrationResult> {
  const {
    batchSize = 10,
    dryRun = false,
    forceRegenerate = false,
    delayBetweenBatches = 500,
  } = options;

  const result: MigrationResult = {
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  // Get all memories for the avatar
  const memories = await getAllMemories(avatarId);

  // Filter to memories needing embeddings
  const needsEmbedding = memories.filter(m => {
    if (forceRegenerate) return true;
    if (!m.embedding || !Array.isArray(m.embedding) || m.embedding.length === 0) return true;
    if (m.embeddingVersion !== EMBEDDING_VERSION) return true;
    return false;
  });

  logger.info('Starting embedding backfill', {
    event: 'embedding_backfill_start',
    avatarId,
    totalMemories: memories.length,
    needsEmbedding: needsEmbedding.length,
    dryRun,
    forceRegenerate,
  });

  if (needsEmbedding.length === 0) {
    logger.info('No memories need embedding backfill', {
      event: 'embedding_backfill_complete',
      avatarId,
      reason: 'all_current',
    });
    return result;
  }

  // Get embedding service
  let embeddingService;
  try {
    embeddingService = getEmbeddingService();
  } catch (error) {
    const errorMsg = `Failed to initialize embedding service: ${error instanceof Error ? error.message : 'Unknown'}`;
    result.errors.push(errorMsg);
    logger.error('Embedding backfill failed', {
      event: 'embedding_backfill_error',
      avatarId,
      error: errorMsg,
    });
    return result;
  }

  // Process in batches
  for (let i = 0; i < needsEmbedding.length; i += batchSize) {
    const batch = needsEmbedding.slice(i, i + batchSize);

    for (const memory of batch) {
      result.processed++;

      if (dryRun) {
        result.skipped++;
        continue;
      }

      try {
        // Generate embedding
        const embedding = await embeddingService.embed(memory.content);

        // Update memory in DynamoDB
        await getDynamoClient().send(new UpdateCommand({
          TableName: ADMIN_TABLE,
          Key: { pk: memory.pk, sk: memory.sk },
          UpdateExpression: 'SET embedding = :emb, embeddingModel = :model, embeddingVersion = :ver, updatedAt = :now',
          ExpressionAttributeValues: {
            ':emb': embedding,
            ':model': embeddingService.modelId,
            ':ver': EMBEDDING_VERSION,
            ':now': Date.now(),
          },
        }));

        result.succeeded++;

        logger.debug('Memory embedding updated', {
          event: 'embedding_backfill_memory',
          avatarId,
          memoryId: memory.id,
          tier: memory.tier,
        });
      } catch (error) {
        result.failed++;
        const errorMsg = `Memory ${memory.id}: ${error instanceof Error ? error.message : 'Unknown'}`;
        result.errors.push(errorMsg);

        logger.warn('Failed to backfill embedding for memory', {
          event: 'embedding_backfill_memory_error',
          avatarId,
          memoryId: memory.id,
          error: error instanceof Error ? error.message : 'Unknown',
        });
      }
    }

    // Delay between batches to avoid throttling
    if (i + batchSize < needsEmbedding.length && delayBetweenBatches > 0) {
      await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
    }

    // Log progress every 50 memories
    if (result.processed % 50 === 0) {
      logger.info('Embedding backfill progress', {
        event: 'embedding_backfill_progress',
        avatarId,
        processed: result.processed,
        total: needsEmbedding.length,
        succeeded: result.succeeded,
        failed: result.failed,
      });
    }
  }

  logger.info('Embedding backfill complete', {
    event: 'embedding_backfill_complete',
    avatarId,
    ...result,
    errorCount: result.errors.length,
  });

  return result;
}

/**
 * Backfill embeddings for all avatars
 *
 * @param options - Backfill options
 * @returns Map of avatar ID to migration result
 */
export async function backfillAllAvatars(
  _options: BackfillOptions = {}
): Promise<Map<string, MigrationResult>> {
  const results = new Map<string, MigrationResult>();

  // This would need to scan for all unique avatar IDs
  // For now, this is a placeholder - in production you'd query a list of avatars
  logger.warn('backfillAllAvatars not fully implemented - use backfillEmbeddings per avatar', {
    event: 'backfill_all_not_implemented',
  });

  return results;
}

/**
 * Estimate cost of backfilling embeddings
 *
 * @param avatarId - The avatar's unique identifier
 * @returns Estimated cost in USD
 */
export async function estimateBackfillCost(avatarId: string): Promise<{
  memoriesNeedingEmbedding: number;
  estimatedTokens: number;
  estimatedCostUSD: number;
}> {
  const stats = await getEmbeddingStats(avatarId);
  const needsEmbedding = stats.withoutEmbedding + stats.outdatedEmbedding;

  // Estimate ~100 tokens per memory (average)
  const estimatedTokens = needsEmbedding * 100;

  // Bedrock Titan v2 pricing: $0.02 per 1M input tokens
  const estimatedCostUSD = (estimatedTokens / 1_000_000) * 0.02;

  return {
    memoriesNeedingEmbedding: needsEmbedding,
    estimatedTokens,
    estimatedCostUSD: Math.round(estimatedCostUSD * 10000) / 10000, // Round to 4 decimal places
  };
}
