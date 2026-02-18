/**
 * Memory Service
 *
 * Tiered memory system for avatar personality evolution.
 * Implements immediate/recent/core memory tiers with:
 * - Strength-based retention (reinforcement + decay)
 * - Automatic consolidation (summarization + promotion)
 * - Semantic search via embeddings (future)
 *
 * DynamoDB Key Schema:
 * - pk: MEMORY#{avatarId}
 * - sk: {tier}#{timestamp}#{id}
 *
 * @module memory
 */
import { randomUUID } from 'crypto';
import {
  DynamoDBClient,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import {
  type DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  DeleteCommand,
  UpdateCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { getDynamoClient as getSharedDynamoClient, _setDynamoClient as _setSharedDynamoClient } from './dynamo-client.js';
import { logger } from '@swarm/core';
import type {
  AvatarMemory,
  MemoryTier,
  MemoryType,
  MemoryQueryOptions,
  MemoryConsolidationConfig,
  AvatarIdentitySnapshot,
  MemoryEdge,
  MemoryEdgeType,
  GraphPruneConfig,
  GraphSearchResult,
} from '../types.js';
import {
  getEmbeddingService,
  cosineSimilarity,
  EMBEDDING_VERSION,
} from './embedding.js';
import {
  promiseAllWithTimeout,
  promiseAllSettledWithTimeout,
} from './promise-timeout.js';

// ============================================================================
// Configuration
// ============================================================================

const ADMIN_TABLE = process.env.ADMIN_TABLE || 'swarm-admin-table';

/** Maximum content length for a single memory (characters) */
const MAX_CONTENT_LENGTH = 2000;

/** Maximum number of themes per memory */
const MAX_THEMES = 10;

/** Maximum strength value (capped on reinforcement) */
const MAX_STRENGTH = 2.0;

/** Default memory retention in days when no plan config is available */
const DEFAULT_RETENTION_DAYS = 30;

/** Seconds in a day */
const SECONDS_PER_DAY = 86400;

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
    const { getMemoryConfig } = await import('./entitlements.js');
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

function getDynamoClient(): DynamoDBDocumentClient {
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
function validateAvatarId(avatarId: string): string {
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
function validateContent(content: string): string {
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
function validateThemes(themes?: string[]): string[] | undefined {
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
function validateStrength(strength?: number): number {
  if (strength === undefined || strength === null) {
    return 1.0;
  }
  if (typeof strength !== 'number' || isNaN(strength)) {
    return 1.0;
  }
  return Math.max(0, Math.min(MAX_STRENGTH, strength));
}

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
 * Get memories for an avatar with optional filters
 *
 * @param avatarId - The avatar's unique identifier
 * @param options - Query options (tier, type, filters, limit)
 * @returns Array of matching memories, newest first
 */
export async function getMemories(
  avatarId: string,
  options: MemoryQueryOptions = {}
): Promise<AvatarMemory[]> {
  const validAvatarId = validateAvatarId(avatarId);
  const { tier, limit = 100, minStrength = 0 } = options;

  // Cap limit to prevent excessive reads
  const safeLimit = Math.min(limit, 500);

  // Build key condition
  let keyCondition = 'pk = :pk';
  const expressionValues: Record<string, unknown> = {
    ':pk': `MEMORY#${validAvatarId}`,
  };

  if (tier) {
    keyCondition += ' AND begins_with(sk, :tier)';
    expressionValues[':tier'] = `${tier}#`;
  }

  // Build filter expression
  const filterParts: string[] = [];
  const expressionNames: Record<string, string> = {};

  if (options.type) {
    filterParts.push('#memtype = :type');
    expressionNames['#memtype'] = 'type';
    expressionValues[':type'] = options.type;
  }
  if (options.about) {
    filterParts.push('about = :about');
    expressionValues[':about'] = options.about;
  }
  if (options.userId) {
    filterParts.push('userId = :userId');
    expressionValues[':userId'] = options.userId;
  }
  if (minStrength > 0) {
    filterParts.push('strength >= :minStrength');
    expressionValues[':minStrength'] = minStrength;
  }

  try {
    const result = await getDynamoClient().send(new QueryCommand({
      TableName: ADMIN_TABLE,
      KeyConditionExpression: keyCondition,
      ExpressionAttributeValues: expressionValues,
      ...(filterParts.length > 0 ? {
        FilterExpression: filterParts.join(' AND '),
        ExpressionAttributeNames: expressionNames,
      } : {}),
      ScanIndexForward: false, // Newest first
      Limit: safeLimit,
    }));

    return (result.Items || []) as AvatarMemory[];
  } catch (error) {
    logger.error('Failed to get memories', {
      event: 'memory_query_error',
      avatarId: validAvatarId,
      tier,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
    return [];
  }
}

/**
 * Get memory counts by tier (parallelized)
 *
 * @param avatarId - The avatar's unique identifier
 * @returns Object with counts per tier
 */
export async function getMemoryCounts(avatarId: string): Promise<Record<MemoryTier, number>> {
  const validAvatarId = validateAvatarId(avatarId);

  // Run all three queries in parallel with timeout protection
  const [immediateResult, recentResult, coreResult] = await promiseAllWithTimeout([
    getDynamoClient().send(new QueryCommand({
      TableName: ADMIN_TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :tier)',
      ExpressionAttributeValues: {
        ':pk': `MEMORY#${validAvatarId}`,
        ':tier': 'immediate#',
      },
      Select: 'COUNT',
    })),
    getDynamoClient().send(new QueryCommand({
      TableName: ADMIN_TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :tier)',
      ExpressionAttributeValues: {
        ':pk': `MEMORY#${validAvatarId}`,
        ':tier': 'recent#',
      },
      Select: 'COUNT',
    })),
    getDynamoClient().send(new QueryCommand({
      TableName: ADMIN_TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :tier)',
      ExpressionAttributeValues: {
        ':pk': `MEMORY#${validAvatarId}`,
        ':tier': 'core#',
      },
      Select: 'COUNT',
    })),
  ], undefined, 'getMemoryCounts');

  return {
    immediate: immediateResult.Count || 0,
    recent: recentResult.Count || 0,
    core: coreResult.Count || 0,
    ephemeral: 0,
    durable: 0,
    archival: 0,
  };
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

// ============================================================================
// Memory Query Helpers
// ============================================================================

/**
 * Get memories about a specific topic/person
 *
 * @param avatarId - The avatar's unique identifier
 * @param about - The topic or person to search for
 * @param limit - Maximum number of results
 * @returns Array of matching memories
 */
export async function recallAbout(
  avatarId: string,
  about: string,
  limit: number = 10
): Promise<AvatarMemory[]> {
  const validAvatarId = validateAvatarId(avatarId);
  const safeLimit = Math.min(limit, 50);

  // Use pagination to collect enough filtered results without over-fetching
  const results: AvatarMemory[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  const MAX_PAGES = 10; // Safety limit to prevent infinite loops
  let pagesQueried = 0;

  while (results.length < safeLimit && pagesQueried < MAX_PAGES) {
    const result = await getDynamoClient().send(new QueryCommand({
      TableName: ADMIN_TABLE,
      KeyConditionExpression: 'pk = :pk',
      FilterExpression: 'about = :about',
      ExpressionAttributeValues: {
        ':pk': `MEMORY#${validAvatarId}`,
        ':about': about.trim(),
      },
      ScanIndexForward: false,
      Limit: safeLimit, // Query only what we need
      ExclusiveStartKey: lastEvaluatedKey,
    }));

    const items = (result.Items || []) as AvatarMemory[];
    results.push(...items);
    lastEvaluatedKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    pagesQueried++;

    // Stop if no more results
    if (!lastEvaluatedKey) {
      break;
    }
  }

  return results.slice(0, safeLimit);
}

/**
 * Search memories with semantic understanding
 *
 * Hybrid scoring formula (from cosyworld research):
 *   score = (0.55 × semantic_similarity) +
 *           (0.25 × recency_score) +
 *           (0.15 × strength) +
 *           (0.05 × about_match_bonus)
 *
 * Falls back to keyword-only search if embeddings unavailable.
 *
 * @param avatarId - The avatar's unique identifier
 * @param query - Search query string
 * @param limit - Maximum number of results
 * @param options - Search options (semanticSearch, minSimilarity)
 * @returns Array of matching memories, sorted by relevance
 */
export async function searchMemories(
  avatarId: string,
  query: string,
  limit: number = 10,
  options: {
    semanticSearch?: boolean;
    minSimilarity?: number;
  } = {}
): Promise<AvatarMemory[]> {
  const validAvatarId = validateAvatarId(avatarId);
  const queryLower = query.toLowerCase().trim();
  const safeLimit = Math.min(limit, 50);
  const { semanticSearch = true, minSimilarity = 0.3 } = options;

  if (queryLower.length === 0) {
    return [];
  }

  // Generate query embedding for semantic search
  let queryEmbedding: number[] | null = null;
  if (semanticSearch) {
    try {
      const embeddingService = getEmbeddingService();
      queryEmbedding = await embeddingService.embed(query);
    } catch (error) {
      logger.warn('Failed to generate query embedding, falling back to keyword search', {
        event: 'embedding_query_error',
        avatarId: validAvatarId,
        error: error instanceof Error ? error.message : 'Unknown',
      });
    }
  }

  // Fetch candidate memories with pagination (no artificial ceiling)
  const memories: AvatarMemory[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  const MAX_CANDIDATES = 500; // Safety limit

  do {
    const result = await getDynamoClient().send(new QueryCommand({
      TableName: ADMIN_TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': `MEMORY#${validAvatarId}`,
      },
      ScanIndexForward: false,
      Limit: 200,
      ExclusiveStartKey: lastEvaluatedKey,
    }));

    memories.push(...((result.Items || []) as AvatarMemory[]));
    lastEvaluatedKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey && memories.length < MAX_CANDIDATES);
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  // Score memories with hybrid formula
  const scored = memories
    .map(m => {
      let semanticScore = 0;
      let keywordScore = 0;

      // Semantic similarity (if embeddings available)
      if (queryEmbedding && m.embedding) {
        semanticScore = cosineSimilarity(queryEmbedding, m.embedding);
      }

      // Keyword matching (fallback/boost)
      const contentLower = m.content.toLowerCase();
      const aboutLower = (m.about || '').toLowerCase();

      if (aboutLower === queryLower) keywordScore = 1.0;
      else if (aboutLower.includes(queryLower)) keywordScore = 0.7;
      else if (contentLower.includes(queryLower)) keywordScore = 0.5;
      else if (m.themes?.some(t => t.toLowerCase().includes(queryLower))) keywordScore = 0.3;

      // Determine primary relevance signal
      const hasSemanticMatch = queryEmbedding && m.embedding && semanticScore >= minSimilarity;
      const hasKeywordMatch = keywordScore > 0;

      // Skip if no relevance signal
      if (!hasSemanticMatch && !hasKeywordMatch) {
        return { memory: m, score: 0 };
      }

      // Recency score (exponential decay over 30 days)
      const ageMs = now - m.createdAt;
      const ageDays = ageMs / dayMs;
      const recencyScore = Math.exp(-ageDays / 30);

      // About field exact match bonus
      const aboutBonus = aboutLower === queryLower ? 1.0 :
                         aboutLower.includes(queryLower) ? 0.5 : 0;

      // Hybrid scoring formula
      // If we have semantic embeddings, use them; otherwise fall back to keyword
      const semanticComponent = hasSemanticMatch
        ? semanticScore
        : keywordScore; // Fall back to keyword if no embedding

      const score = (0.55 * semanticComponent) +
                    (0.25 * recencyScore) +
                    (0.15 * m.strength) +
                    (0.05 * aboutBonus);

      // Tier multiplier
      const tierMultiplier = m.tier === 'core' ? 1.3 :
                             m.tier === 'recent' ? 1.1 : 1.0;

      return { memory: m, score: score * tierMultiplier };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, safeLimit);

  logger.info('Memory search completed', {
    event: 'memory_search',
    avatarId: validAvatarId,
    query: query.slice(0, 50),
    usedSemanticSearch: !!queryEmbedding,
    candidateCount: memories.length,
    resultCount: scored.length,
  });

  return scored.map(({ memory }) => memory);
}

/**
 * Get core memories (identity, learnings, patterns)
 *
 * @param avatarId - The avatar's unique identifier
 * @returns Array of core memories
 */
export async function getCoreMemories(avatarId: string): Promise<AvatarMemory[]> {
  return getMemories(avatarId, {
    tier: 'core',
    minStrength: DEFAULT_CONFIG.pruneThreshold,
    limit: DEFAULT_CONFIG.coreMaxCount,
  });
}

/**
 * Get identity statements
 *
 * @param avatarId - The avatar's unique identifier
 * @returns Array of identity memories
 */
export async function getIdentity(avatarId: string): Promise<AvatarMemory[]> {
  return getMemories(avatarId, {
    tier: 'core',
    type: 'identity',
    limit: 5,
  });
}

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

// ============================================================================
// High-Level Memory API (for MCP tools)
// ============================================================================

/**
 * Remember a fact (creates immediate memory, reinforces if similar exists)
 *
 * @param avatarId - The avatar's unique identifier
 * @param fact - The fact to remember
 * @param about - Who or what this fact is about
 * @param userId - Associated user ID
 * @returns Result with saved status and memory ID
 */
export async function remember(
  avatarId: string,
  fact: string,
  about?: string,
  userId?: string
): Promise<{ saved: boolean; memoryId: string; reinforced?: boolean }> {
  const validAvatarId = validateAvatarId(avatarId);
  const validFact = validateContent(fact);

  // Look up retention days for TTL enforcement
  const retentionDays = await getRetentionDaysForAvatar(validAvatarId);

  // Check for similar existing memory to reinforce
  if (about) {
    const existing = await recallAbout(validAvatarId, about, 5);
    const factLower = validFact.toLowerCase();

    const similar = existing.find(m => {
      const contentLower = m.content.toLowerCase();
      // Check for significant overlap (>50% of shorter string)
      const shorter = Math.min(factLower.length, contentLower.length);
      const overlapThreshold = Math.floor(shorter * 0.5);

      return (
        contentLower.includes(factLower.slice(0, overlapThreshold)) ||
        factLower.includes(contentLower.slice(0, overlapThreshold))
      );
    });

    if (similar) {
      await reinforceMemory(validAvatarId, similar.id, similar.sk);
      return { saved: true, memoryId: similar.id, reinforced: true };
    }
  }

  // Create new immediate memory with TTL based on avatar's retention config
  const memory = await createMemory(validAvatarId, {
    tier: 'immediate',
    type: about ? 'fact' : 'event',
    content: validFact,
    about: about?.trim(),
    userId: userId?.trim(),
    retentionDays,
  });

  // Auto-link to related memories via graph edges (async, don't block)
  autoLinkMemory(validAvatarId, memory, { retentionDays }).catch(err => {
    logger.warn('Background auto-link failed', {
      event: 'auto_link_background_error',
      avatarId: validAvatarId,
      memoryId: memory.id,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  });

  // Check if we need to promote memories (async, don't block)
  promoteImmediateToRecent(validAvatarId).catch(err => {
    logger.warn('Background promotion failed', {
      event: 'memory_promotion_background_error',
      avatarId: validAvatarId,
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  });

  return { saved: true, memoryId: memory.id };
}

/**
 * Recall facts (searches across all tiers)
 *
 * @param avatarId - The avatar's unique identifier
 * @param query - Search query string
 * @param userId - Filter by user ID
 * @returns Array of matching facts with metadata
 */
export async function recall(
  avatarId: string,
  query: string,
  userId?: string
): Promise<{ facts: Array<{ fact: string; about?: string; timestamp: number; strength: number }> }> {
  const validAvatarId = validateAvatarId(avatarId);
  const memories = await searchMemories(validAvatarId, query, 10);

  // Filter by userId if provided
  const filtered = userId
    ? memories.filter(m => !m.userId || m.userId === userId)
    : memories;

  return {
    facts: filtered.map(m => ({
      fact: m.content,
      about: m.about,
      timestamp: m.createdAt,
      strength: m.strength,
    })),
  };
}

/**
 * Get memory context for prompt injection
 * Formats memories into a human-readable string for the LLM
 *
 * @param avatarId - The avatar's unique identifier
 * @returns Formatted memory context string
 */
export async function getMemoryContext(avatarId: string): Promise<string> {
  const validAvatarId = validateAvatarId(avatarId);

  const [coreMemories, recentMemories, identity] = await promiseAllWithTimeout([
    getCoreMemories(validAvatarId),
    getMemories(validAvatarId, { tier: 'recent', limit: 10 }),
    getIdentity(validAvatarId),
  ], undefined, 'getMemoryContext');

  const sections: string[] = [];

  // Identity section
  if (identity.length > 0) {
    sections.push('## Who I Am');
    for (const mem of identity) {
      sections.push(`- ${mem.content}`);
    }
  }

  // Core learnings and patterns
  const learnings = coreMemories.filter(m => m.type === 'learning' || m.type === 'pattern');
  if (learnings.length > 0) {
    sections.push('\n## What I\'ve Learned');
    for (const mem of learnings.slice(0, 5)) {
      sections.push(`- ${mem.content}`);
    }
  }

  // Relationships
  const relationships = coreMemories.filter(m => m.type === 'relationship');
  if (relationships.length > 0) {
    sections.push('\n## People I Know');
    for (const mem of relationships.slice(0, 5)) {
      const aboutStr = mem.about ? ` (${mem.about})` : '';
      sections.push(`- ${mem.content}${aboutStr}`);
    }
  }

  // Recent experiences
  if (recentMemories.length > 0) {
    sections.push('\n## Recent Experiences');
    for (const mem of recentMemories.slice(0, 5)) {
      const aboutStr = mem.about ? ` (about ${mem.about})` : '';
      sections.push(`- ${mem.content}${aboutStr}`);
    }
  }

  return sections.length > 0 ? sections.join('\n') : '';
}

/**
 * Get memory context for prompt injection, tailored to the current user query.
 *
 * This is a higher-signal variant of getMemoryContext(): it uses semantic search
 * to surface the most relevant memories, then formats them consistently for
 * prompt injection.
 */
export async function getMemoryContextForQuery(
  avatarId: string,
  query: string,
  options: {
    limit?: number;
    minSimilarity?: number;
    maxChars?: number;
  } = {}
): Promise<string> {
  const validAvatarId = validateAvatarId(avatarId);
  const queryText = query.trim();
  if (!queryText) {
    return getMemoryContext(validAvatarId);
  }

  const limit = Math.min(options.limit ?? 12, 25);
  const minSimilarity = options.minSimilarity ?? 0.28;
  const maxChars = options.maxChars ?? 2400;

  const [identity, relevant] = await promiseAllWithTimeout([
    getIdentity(validAvatarId),
    searchMemories(validAvatarId, queryText, limit, { semanticSearch: true, minSimilarity }),
  ], undefined, 'getMemoryContextForQuery');

  const sections: string[] = [];

  if (identity.length > 0) {
    sections.push('## Who I Am');
    for (const mem of identity) {
      sections.push(`- ${mem.content}`);
    }
  }

  const identityIds = new Set(identity.map((m) => m.id));
  const picked = relevant
    .filter((m) => !identityIds.has(m.id))
    .slice(0, limit);

  if (picked.length > 0) {
    sections.push('\n## Relevant Memories');
    for (const mem of picked) {
      const aboutStr = mem.about ? ` (about ${mem.about})` : '';
      sections.push(`- ${mem.content}${aboutStr}`);
    }
  }

  const out = sections.length > 0 ? sections.join('\n') : '';
  return out.length > maxChars ? out.slice(0, maxChars) : out;
}

// ============================================================================
// Statistics & Diagnostics
// ============================================================================

/**
 * Get comprehensive memory statistics for an avatar
 *
 * @param avatarId - The avatar's unique identifier
 * @returns Memory statistics
 */
export async function getMemoryStats(avatarId: string): Promise<{
  counts: Record<MemoryTier, number>;
  totalMemories: number;
  averageStrength: Record<MemoryTier, number>;
  oldestMemory?: { tier: MemoryTier; createdAt: number };
  newestMemory?: { tier: MemoryTier; createdAt: number };
}> {
  const validAvatarId = validateAvatarId(avatarId);
  const counts = await getMemoryCounts(validAvatarId);
  const totalMemories = counts.immediate + counts.recent + counts.core + counts.ephemeral + counts.durable + counts.archival;

  // Get memories for average strength calculation
  const [immediate, recent, core] = await promiseAllWithTimeout([
    getMemories(validAvatarId, { tier: 'immediate', limit: 100 }),
    getMemories(validAvatarId, { tier: 'recent', limit: 100 }),
    getMemories(validAvatarId, { tier: 'core', limit: 100 }),
  ], undefined, 'getMemoryStats');

  const avgStrength = (memories: AvatarMemory[]) =>
    memories.length > 0
      ? memories.reduce((sum, m) => sum + m.strength, 0) / memories.length
      : 0;

  // Find oldest and newest
  const allMemories = [...immediate, ...recent, ...core];
  let oldestMemory: { tier: MemoryTier; createdAt: number } | undefined;
  let newestMemory: { tier: MemoryTier; createdAt: number } | undefined;

  for (const m of allMemories) {
    if (!oldestMemory || m.createdAt < oldestMemory.createdAt) {
      oldestMemory = { tier: m.tier, createdAt: m.createdAt };
    }
    if (!newestMemory || m.createdAt > newestMemory.createdAt) {
      newestMemory = { tier: m.tier, createdAt: m.createdAt };
    }
  }

  return {
    counts,
    totalMemories,
    averageStrength: {
      immediate: avgStrength(immediate),
      recent: avgStrength(recent),
      core: avgStrength(core),
      ephemeral: 0,
      durable: 0,
      archival: 0,
    },
    oldestMemory,
    newestMemory,
  };
}
// ============================================================================
// Graph RAG: Edge CRUD Operations
// ============================================================================

/**
 * Create a graph edge between two memories.
 *
 * Edges are bidirectional for traversal: we store source→target and query
 * both directions using begins_with on the sk.
 */
export async function createEdge(
  avatarId: string,
  params: {
    sourceMemoryId: string;
    targetMemoryId: string;
    edgeType: MemoryEdgeType;
    weight?: number;
    metadata?: Record<string, unknown>;
    retentionDays?: number;
  }
): Promise<MemoryEdge> {
  const validAvatarId = validateAvatarId(avatarId);
  const now = Date.now();
  const weight = Math.max(0, Math.min(1, params.weight ?? 0.5));

  const ttl = computeMemoryTtl(params.retentionDays);

  const edge: MemoryEdge = {
    pk: `EDGE#${validAvatarId}`,
    sk: `${params.sourceMemoryId}#${params.targetMemoryId}`,
    avatarId: validAvatarId,
    sourceMemoryId: params.sourceMemoryId,
    targetMemoryId: params.targetMemoryId,
    edgeType: params.edgeType,
    weight,
    metadata: params.metadata,
    createdAt: now,
    updatedAt: now,
  };

  const dynamoItem: Record<string, unknown> = { ...edge };
  if (ttl !== undefined) {
    dynamoItem.ttl = ttl;
  }

  await getDynamoClient().send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: dynamoItem,
  }));

  logger.info('Edge created', {
    event: 'edge_created',
    avatarId: validAvatarId,
    source: params.sourceMemoryId,
    target: params.targetMemoryId,
    edgeType: params.edgeType,
    weight,
  });

  return edge;
}

/**
 * Get all edges from a source memory (outgoing)
 */
export async function getEdgesFrom(
  avatarId: string,
  memoryId: string,
  limit: number = 50
): Promise<MemoryEdge[]> {
  const validAvatarId = validateAvatarId(avatarId);

  const result = await getDynamoClient().send(new QueryCommand({
    TableName: ADMIN_TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: {
      ':pk': `EDGE#${validAvatarId}`,
      ':prefix': `${memoryId}#`,
    },
    Limit: Math.min(limit, 100),
  }));

  return (result.Items || []) as MemoryEdge[];
}

/**
 * Get all edges pointing to a target memory (incoming).
 *
 * This requires a filter scan since our sk is {source}#{target}.
 * We query all edges for the avatar and filter by target.
 */
export async function getEdgesTo(
  avatarId: string,
  memoryId: string,
  limit: number = 50
): Promise<MemoryEdge[]> {
  const validAvatarId = validateAvatarId(avatarId);

  // Use pagination to collect enough filtered results without over-fetching
  const results: MemoryEdge[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  const safeLimit = Math.min(limit, 100);
  const MAX_PAGES = 10; // Safety limit to prevent infinite loops
  let pagesQueried = 0;

  while (results.length < safeLimit && pagesQueried < MAX_PAGES) {
    const result = await getDynamoClient().send(new QueryCommand({
      TableName: ADMIN_TABLE,
      KeyConditionExpression: 'pk = :pk',
      FilterExpression: 'targetMemoryId = :targetId',
      ExpressionAttributeValues: {
        ':pk': `EDGE#${validAvatarId}`,
        ':targetId': memoryId,
      },
      Limit: safeLimit, // Query only what we need
      ExclusiveStartKey: lastEvaluatedKey,
    }));

    const items = (result.Items || []) as MemoryEdge[];
    results.push(...items);
    lastEvaluatedKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    pagesQueried++;

    // Stop if no more results
    if (!lastEvaluatedKey) {
      break;
    }
  }

  return results.slice(0, safeLimit);
}

/**
 * Get all edges connected to a memory (both directions)
 */
export async function getEdgesForMemory(
  avatarId: string,
  memoryId: string,
  limit: number = 50
): Promise<MemoryEdge[]> {
  const [outgoing, incoming] = await promiseAllWithTimeout([
    getEdgesFrom(avatarId, memoryId, limit),
    getEdgesTo(avatarId, memoryId, limit),
  ], undefined, 'getEdgesForMemory');

  // Deduplicate (an edge could appear in both if source === target, unlikely but safe)
  const seen = new Set<string>();
  const combined: MemoryEdge[] = [];
  for (const edge of [...outgoing, ...incoming]) {
    if (!seen.has(edge.sk)) {
      seen.add(edge.sk);
      combined.push(edge);
    }
  }

  return combined
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit);
}

/**
 * Get all edges for an avatar (for pruning/stats)
 */
export async function getAllEdges(
  avatarId: string,
  limit: number = 2000
): Promise<MemoryEdge[]> {
  const validAvatarId = validateAvatarId(avatarId);
  const edges: MemoryEdge[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const result = await getDynamoClient().send(new QueryCommand({
      TableName: ADMIN_TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': `EDGE#${validAvatarId}`,
      },
      Limit: 200,
      ExclusiveStartKey: lastEvaluatedKey,
    }));

    edges.push(...((result.Items || []) as MemoryEdge[]));
    lastEvaluatedKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey && edges.length < limit);

  return edges.slice(0, limit);
}

/**
 * Reinforce an edge (increase its weight)
 */
export async function reinforceEdge(
  avatarId: string,
  sourceMemoryId: string,
  targetMemoryId: string,
  boost: number = 0.1
): Promise<void> {
  const validAvatarId = validateAvatarId(avatarId);
  const sk = `${sourceMemoryId}#${targetMemoryId}`;

  try {
    await getDynamoClient().send(new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: {
        pk: `EDGE#${validAvatarId}`,
        sk,
      },
      UpdateExpression: 'SET weight = if_not_exists(weight, :half) + :boost, updatedAt = :now',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: {
        ':boost': Math.min(boost, 0.5),
        ':half': 0.5,
        ':now': Date.now(),
      },
    }));

    // Cap at 1.0
    await getDynamoClient().send(new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: {
        pk: `EDGE#${validAvatarId}`,
        sk,
      },
      UpdateExpression: 'SET weight = :max',
      ConditionExpression: 'weight > :max',
      ExpressionAttributeValues: { ':max': 1.0 },
    })).catch(() => { /* already <= 1.0 */ });
  } catch {
    // Edge may not exist, that's fine
  }
}

/**
 * Delete an edge
 */
export async function deleteEdge(
  avatarId: string,
  sourceMemoryId: string,
  targetMemoryId: string
): Promise<void> {
  const validAvatarId = validateAvatarId(avatarId);

  await getDynamoClient().send(new DeleteCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: `EDGE#${validAvatarId}`,
      sk: `${sourceMemoryId}#${targetMemoryId}`,
    },
  }));
}

/**
 * Batch delete edges
 */
export async function deleteEdges(avatarId: string, edges: Array<{ source: string; target: string }>): Promise<void> {
  if (edges.length === 0) return;
  const validAvatarId = validateAvatarId(avatarId);

  const batches: Array<Array<{ source: string; target: string }>> = [];
  for (let i = 0; i < edges.length; i += 25) {
    batches.push(edges.slice(i, i + 25));
  }

  for (const batch of batches) {
    try {
      await batchWriteWithRetry({
        [ADMIN_TABLE]: batch.map(e => ({
          DeleteRequest: {
            Key: {
              pk: `EDGE#${validAvatarId}`,
              sk: `${e.source}#${e.target}`,
            },
          },
        })),
      });
    } catch (error) {
      logger.warn('Some edge batch deletes failed', {
        event: 'edge_batch_delete_error',
        avatarId: validAvatarId,
        error: error instanceof Error ? error.message : 'Unknown',
      });
    }
  }
}

// ============================================================================
// Graph RAG: Auto-Linking
// ============================================================================

/**
 * Automatically discover and create edges between a new memory and
 * semantically related existing memories.
 *
 * Called after creating a new memory. Uses the new memory's embedding
 * to find related memories and creates edges weighted by similarity.
 */
export async function autoLinkMemory(
  avatarId: string,
  newMemory: AvatarMemory,
  options: {
    maxEdges?: number;
    minSimilarity?: number;
    retentionDays?: number;
  } = {}
): Promise<MemoryEdge[]> {
  const { maxEdges = 5, minSimilarity = 0.4, retentionDays } = options;

  if (!newMemory.embedding) {
    return []; // Can't link without embeddings
  }

  // Find semantically related memories
  const related = await searchMemories(avatarId, newMemory.content, maxEdges * 2, {
    semanticSearch: true,
    minSimilarity,
  });

  // Filter out self
  const candidates = related.filter(m => m.id !== newMemory.id);
  const edges: MemoryEdge[] = [];

  for (const candidate of candidates.slice(0, maxEdges)) {
    // Determine edge type heuristically
    let edgeType: MemoryEdgeType = 'related_to';
    if (candidate.about && newMemory.about && candidate.about === newMemory.about) {
      edgeType = 'about_same';
    } else if (newMemory.sourceMemoryIds?.includes(candidate.id)) {
      edgeType = 'promoted_from';
    }

    // Weight is the semantic similarity (approximate via content overlap + embedding if available)
    const weight = candidate.embedding && newMemory.embedding
      ? cosineSimilarity(newMemory.embedding, candidate.embedding)
      : 0.5;

    if (weight >= minSimilarity) {
      try {
        const edge = await createEdge(avatarId, {
          sourceMemoryId: newMemory.id,
          targetMemoryId: candidate.id,
          edgeType,
          weight: Math.min(weight, 1.0),
          retentionDays,
        });
        edges.push(edge);
      } catch (error) {
        logger.warn('Failed to create auto-link edge', {
          event: 'auto_link_error',
          avatarId,
          source: newMemory.id,
          target: candidate.id,
          error: error instanceof Error ? error.message : 'Unknown',
        });
      }
    }
  }

  if (edges.length > 0) {
    logger.info('Auto-linked memory', {
      event: 'memory_auto_linked',
      avatarId,
      memoryId: newMemory.id,
      edgesCreated: edges.length,
    });
  }

  return edges;
}

// ============================================================================
// Graph RAG: Graph-Enhanced Search
// ============================================================================

/**
 * Search memories with graph traversal.
 *
 * 1. Semantic search finds the top-N direct matches
 * 2. For each direct match, traverse graph edges to surface associated memories
 * 3. Deduplicate and rank by combined relevance
 *
 * This is the primary search function for the memory system.
 */
export async function graphSearch(
  avatarId: string,
  query: string,
  options: {
    directLimit?: number;
    graphDepth?: number;
    maxGraphMatches?: number;
    minSimilarity?: number;
    semanticSearch?: boolean;
  } = {}
): Promise<GraphSearchResult> {
  const {
    directLimit = 8,
    graphDepth = 1,
    maxGraphMatches = 8,
    minSimilarity = 0.3,
    semanticSearch = true,
  } = options;

  // Step 1: Semantic search for direct matches
  const directMatches = await searchMemories(avatarId, query, directLimit, {
    semanticSearch,
    minSimilarity,
  });

  const directIds = new Set(directMatches.map(m => m.id));

  // Step 2: Graph traversal from direct matches
  const graphCandidateIds = new Set<string>();
  let edgesTraversed = 0;

  // BFS traversal up to graphDepth
  let frontier = directMatches.map(m => m.id);

  for (let depth = 0; depth < graphDepth && frontier.length > 0; depth++) {
    const nextFrontier: string[] = [];

    // Fetch edges for all frontier nodes in parallel (partial results OK)
    const edgeSettled = await promiseAllSettledWithTimeout(
      frontier.map(memId => getEdgesForMemory(avatarId, memId, DEFAULT_GRAPH_CONFIG.maxEdgesPerNode)),
      undefined, 'graphSearch:edges',
    );
    const edgeBatches = edgeSettled
      .filter((r): r is { status: 'fulfilled'; value: MemoryEdge[] } => r.status === 'fulfilled')
      .map(r => r.value);

    for (const edges of edgeBatches) {
      for (const edge of edges) {
        edgesTraversed++;
        // Get the neighbor ID (the other end of the edge)
        const neighborId = edge.sourceMemoryId === frontier.find(f =>
          f === edge.sourceMemoryId || f === edge.targetMemoryId
        ) ? edge.targetMemoryId : edge.sourceMemoryId;

        if (!directIds.has(neighborId) && !graphCandidateIds.has(neighborId)) {
          graphCandidateIds.add(neighborId);
          nextFrontier.push(neighborId);
        }
      }
    }

    frontier = nextFrontier;
  }

  // Step 3: Fetch graph-discovered memories
  const graphMatches: AvatarMemory[] = [];
  if (graphCandidateIds.size > 0) {
    // Fetch memories by ID (we need to search all tiers)
    const fetchPromises = Array.from(graphCandidateIds)
      .slice(0, maxGraphMatches * 2) // Over-fetch slightly
      .map(id => getMemory(avatarId, id));

    const fetchSettled = await promiseAllSettledWithTimeout(
      fetchPromises, undefined, 'graphSearch:fetchMemories',
    );
    const results = fetchSettled
      .filter((r): r is { status: 'fulfilled'; value: AvatarMemory | null } => r.status === 'fulfilled')
      .map(r => r.value);
    for (const mem of results) {
      if (mem && graphMatches.length < maxGraphMatches) {
        graphMatches.push(mem);
      }
    }
  }

  // Step 4: Combine and deduplicate
  const seenIds = new Set<string>();
  const combined: AvatarMemory[] = [];

  // Direct matches first (higher priority)
  for (const mem of directMatches) {
    if (!seenIds.has(mem.id)) {
      seenIds.add(mem.id);
      combined.push(mem);
    }
  }

  // Then graph matches
  for (const mem of graphMatches) {
    if (!seenIds.has(mem.id)) {
      seenIds.add(mem.id);
      combined.push(mem);
    }
  }

  logger.info('Graph search completed', {
    event: 'graph_search',
    avatarId,
    query: query.slice(0, 50),
    directMatches: directMatches.length,
    graphMatches: graphMatches.length,
    edgesTraversed,
    totalResults: combined.length,
  });

  return {
    directMatches,
    graphMatches,
    combined,
    edgesTraversed,
  };
}

// ============================================================================
// Graph RAG: Pruning
// ============================================================================

/**
 * Prune the memory graph for an avatar.
 *
 * This is called during consolidation and performs:
 * 1. Decay all edge weights by edgeDecayRate
 * 2. Delete edges below minEdgeWeight
 * 3. Delete edges pointing to non-existent memories (orphans)
 * 4. Cap edges per node at maxEdgesPerNode (keep strongest)
 * 5. Cap total edges at maxTotalEdges (keep strongest)
 */
export async function pruneGraph(
  avatarId: string,
  config: Partial<GraphPruneConfig> = {}
): Promise<{ decayed: number; pruned: number; orphansRemoved: number }> {
  const validAvatarId = validateAvatarId(avatarId);
  const {
    minEdgeWeight = DEFAULT_GRAPH_CONFIG.minEdgeWeight,
    edgeDecayRate = DEFAULT_GRAPH_CONFIG.edgeDecayRate,
    maxEdgesPerNode = DEFAULT_GRAPH_CONFIG.maxEdgesPerNode,
    maxTotalEdges = DEFAULT_GRAPH_CONFIG.maxTotalEdges,
  } = config;

  const edges = await getAllEdges(validAvatarId, maxTotalEdges + 500);

  let decayed = 0;
  let pruned = 0;
  let orphansRemoved = 0;

  const toDelete: Array<{ source: string; target: string }> = [];
  const toUpdate: Array<{ sk: string; newWeight: number }> = [];

  // Get all existing memory IDs for orphan detection
  const memoryResult = await getDynamoClient().send(new QueryCommand({
    TableName: ADMIN_TABLE,
    KeyConditionExpression: 'pk = :pk',
    ExpressionAttributeValues: {
      ':pk': `MEMORY#${validAvatarId}`,
    },
    ProjectionExpression: 'id',
  }));
  const existingMemoryIds = new Set(
    (memoryResult.Items || []).map((item: Record<string, unknown>) => item.id as string)
  );

  // Step 1: Decay weights and identify pruning targets
  for (const edge of edges) {
    // Check for orphans
    if (!existingMemoryIds.has(edge.sourceMemoryId) || !existingMemoryIds.has(edge.targetMemoryId)) {
      toDelete.push({ source: edge.sourceMemoryId, target: edge.targetMemoryId });
      orphansRemoved++;
      continue;
    }

    // Apply decay
    const newWeight = edge.weight * edgeDecayRate;
    if (newWeight < minEdgeWeight) {
      toDelete.push({ source: edge.sourceMemoryId, target: edge.targetMemoryId });
      pruned++;
    } else {
      toUpdate.push({ sk: edge.sk, newWeight });
      decayed++;
    }
  }

  // Step 2: Enforce per-node edge limit
  const edgesByNode = new Map<string, MemoryEdge[]>();
  for (const edge of edges) {
    // Skip already-deleted edges
    if (toDelete.some(d => d.source === edge.sourceMemoryId && d.target === edge.targetMemoryId)) {
      continue;
    }

    for (const nodeId of [edge.sourceMemoryId, edge.targetMemoryId]) {
      const nodeEdges = edgesByNode.get(nodeId) || [];
      nodeEdges.push(edge);
      edgesByNode.set(nodeId, nodeEdges);
    }
  }

  for (const [, nodeEdges] of edgesByNode) {
    if (nodeEdges.length > maxEdgesPerNode) {
      const sorted = nodeEdges.sort((a, b) => b.weight - a.weight);
      for (const excess of sorted.slice(maxEdgesPerNode)) {
        if (!toDelete.some(d => d.source === excess.sourceMemoryId && d.target === excess.targetMemoryId)) {
          toDelete.push({ source: excess.sourceMemoryId, target: excess.targetMemoryId });
          pruned++;
        }
      }
    }
  }

  // Step 3: Enforce total edge limit
  const surviving = edges
    .filter(e => !toDelete.some(d => d.source === e.sourceMemoryId && d.target === e.targetMemoryId))
    .sort((a, b) => b.weight - a.weight);

  if (surviving.length > maxTotalEdges) {
    for (const excess of surviving.slice(maxTotalEdges)) {
      toDelete.push({ source: excess.sourceMemoryId, target: excess.targetMemoryId });
      pruned++;
    }
  }

  // Step 4: Apply updates
  const now = Date.now();
  const updateBatches: Array<Array<{ sk: string; newWeight: number }>> = [];
  for (let i = 0; i < toUpdate.length; i += 25) {
    updateBatches.push(toUpdate.slice(i, i + 25));
  }

  for (const batch of updateBatches) {
    await promiseAllSettledWithTimeout(
      batch.map(({ sk, newWeight }) =>
        getDynamoClient().send(new UpdateCommand({
          TableName: ADMIN_TABLE,
          Key: { pk: `EDGE#${validAvatarId}`, sk },
          UpdateExpression: 'SET weight = :w, updatedAt = :now',
          ExpressionAttributeValues: { ':w': newWeight, ':now': now },
        })).catch(err => {
          logger.warn('Failed to update edge weight', {
            event: 'edge_decay_error',
            sk,
            error: err instanceof Error ? err.message : 'Unknown',
          });
        })
      ),
      undefined, 'pruneGraph',
    );
  }

  // Step 5: Delete pruned edges
  if (toDelete.length > 0) {
    await deleteEdges(validAvatarId, toDelete);
  }

  logger.info('Graph pruned', {
    event: 'graph_pruned',
    avatarId: validAvatarId,
    totalEdges: edges.length,
    decayed,
    pruned,
    orphansRemoved,
    surviving: edges.length - toDelete.length,
  });

  return { decayed, pruned, orphansRemoved };
}

// ============================================================================
// Enhanced Memory Context (Graph-Aware)
// ============================================================================

/**
 * Get memory context for prompt injection using graph-enhanced search.
 *
 * Uses semantic search + graph RAG to surface the most relevant memories
 * and their associations. Formats them for LLM prompt injection.
 */
export async function getGraphMemoryContext(
  avatarId: string,
  query: string,
  options: {
    limit?: number;
    maxChars?: number;
    includeGraph?: boolean;
  } = {}
): Promise<string> {
  const validAvatarId = validateAvatarId(avatarId);
  const queryText = query.trim();

  if (!queryText) {
    return getMemoryContext(validAvatarId);
  }

  const limit = Math.min(options.limit ?? 12, 25);
  const maxChars = options.maxChars ?? 2400;
  const includeGraph = options.includeGraph ?? true;

  const [identity, searchResult] = await promiseAllWithTimeout([
    getIdentity(validAvatarId),
    includeGraph
      ? graphSearch(validAvatarId, queryText, {
          directLimit: Math.ceil(limit * 0.6),
          maxGraphMatches: Math.ceil(limit * 0.4),
          graphDepth: 1,
        })
      : searchMemories(validAvatarId, queryText, limit, { semanticSearch: true }).then(
          directMatches => ({ directMatches, graphMatches: [] as AvatarMemory[], combined: directMatches, edgesTraversed: 0 })
        ),
  ], undefined, 'getGraphMemoryContext');

  const sections: string[] = [];

  // Identity section
  if (identity.length > 0) {
    sections.push('## Who I Am');
    for (const mem of identity) {
      sections.push(`- ${mem.content}`);
    }
  }

  // Filter out identity mems from search results
  const identityIds = new Set(identity.map(m => m.id));
  const directPicked = searchResult.directMatches
    .filter(m => !identityIds.has(m.id))
    .slice(0, limit);

  if (directPicked.length > 0) {
    sections.push('\n## Relevant Memories');
    for (const mem of directPicked) {
      const aboutStr = mem.about ? ` (about ${mem.about})` : '';
      sections.push(`- ${mem.content}${aboutStr}`);
    }
  }

  // Graph-discovered associated memories
  const graphPicked = searchResult.graphMatches
    .filter(m => !identityIds.has(m.id) && !directPicked.some(d => d.id === m.id))
    .slice(0, Math.ceil(limit * 0.4));

  if (graphPicked.length > 0) {
    sections.push('\n## Associated Context');
    for (const mem of graphPicked) {
      const aboutStr = mem.about ? ` (about ${mem.about})` : '';
      sections.push(`- ${mem.content}${aboutStr}`);
    }
  }

  const out = sections.length > 0 ? sections.join('\n') : '';
  return out.length > maxChars ? out.slice(0, maxChars) : out;
}

/**
 * Get graph statistics for an avatar
 */
export async function getGraphStats(avatarId: string): Promise<{
  totalEdges: number;
  edgesByType: Record<string, number>;
  averageWeight: number;
}> {
  const validAvatarId = validateAvatarId(avatarId);
  const edges = await getAllEdges(validAvatarId, 2000);

  const edgesByType: Record<string, number> = {};
  let totalWeight = 0;

  for (const edge of edges) {
    edgesByType[edge.edgeType] = (edgesByType[edge.edgeType] || 0) + 1;
    totalWeight += edge.weight;
  }

  return {
    totalEdges: edges.length,
    edgesByType,
    averageWeight: edges.length > 0 ? totalWeight / edges.length : 0,
  };
}