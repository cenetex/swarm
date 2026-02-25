/**
 * Memory Service — Search & Query Helpers
 *
 * getMemories (with semantic re-ranking), getMemoryCounts,
 * recallAbout, searchMemories, getCoreMemories, getIdentity.
 *
 * @module memory/search
 */
import {
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { logger } from '@swarm/core';
import type {
  AvatarMemory,
  MemoryTier,
  MemoryQueryOptions,
} from '../../types.js';
import {
  getEmbeddingService,
  cosineSimilarity,
} from '../embedding.js';
import {
  promiseAllWithTimeout,
} from '../promise-timeout.js';
import {
  ADMIN_TABLE,
  DEFAULT_CONFIG,
  getDynamoClient,
  validateAvatarId,
} from './shared.js';

// ============================================================================
// Memory Query Operations
// ============================================================================

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
  const startMs = Date.now();
  const validAvatarId = validateAvatarId(avatarId);
  const { tier, limit = 100, minStrength = 0 } = options;

  // Cap limit to prevent excessive reads
  const safeLimit = Math.min(limit, 500);

  // When semantic query is provided, we need to over-fetch for re-ranking
  const useSemantic = !!options.semantic?.query;
  const fetchLimit = useSemantic ? Math.min(safeLimit * 5, 500) : safeLimit;

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
    const queryStartMs = Date.now();
    const result = await getDynamoClient().send(new QueryCommand({
      TableName: ADMIN_TABLE,
      KeyConditionExpression: keyCondition,
      ExpressionAttributeValues: expressionValues,
      ...(filterParts.length > 0 ? {
        FilterExpression: filterParts.join(' AND '),
        ExpressionAttributeNames: expressionNames,
      } : {}),
      ScanIndexForward: false, // Newest first
      Limit: fetchLimit,
    }));
    const queryLatencyMs = Date.now() - queryStartMs;

    let memories = (result.Items || []) as AvatarMemory[];

    // Semantic re-ranking: when a query is provided, generate an embedding
    // and re-rank results by cosine similarity against stored embeddings.
    // Records without embeddings are included at the end (deterministic fallback).
    if (useSemantic && memories.length > 0) {
      const semanticStartMs = Date.now();
      const semanticQuery = options.semantic!.query;
      const threshold = options.semantic!.threshold ?? 0.3;
      let retrievalMethod: 'semantic' | 'deterministic' = 'deterministic';

      try {
        const embeddingService = getEmbeddingService();
        const queryEmbedding = await embeddingService.embed(semanticQuery);
        retrievalMethod = 'semantic';

        // Partition into records with and without embeddings
        const withEmbedding: Array<{ memory: AvatarMemory; similarity: number }> = [];
        const withoutEmbedding: AvatarMemory[] = [];

        for (const mem of memories) {
          if (mem.embedding && mem.embedding.length > 0) {
            const similarity = cosineSimilarity(queryEmbedding, mem.embedding);
            if (similarity >= threshold) {
              withEmbedding.push({ memory: mem, similarity });
            }
          } else {
            withoutEmbedding.push(mem);
          }
        }

        // Sort by similarity descending
        withEmbedding.sort((a, b) => b.similarity - a.similarity);

        // Merge: semantic matches first, then deterministic fallback
        memories = [
          ...withEmbedding.map(({ memory }) => memory),
          ...withoutEmbedding,
        ].slice(0, safeLimit);

        const semanticLatencyMs = Date.now() - semanticStartMs;
        logger.info('Semantic re-ranking applied in getMemories', {
          event: 'memory_semantic_rerank',
          avatarId: validAvatarId,
          tier: tier ?? 'all',
          query: semanticQuery.slice(0, 50),
          candidateCount: result.Items?.length ?? 0,
          withEmbeddingCount: withEmbedding.length,
          withoutEmbeddingCount: withoutEmbedding.length,
          resultCount: memories.length,
          retrievalMethod,
          queryLatencyMs,
          semanticLatencyMs,
          totalLatencyMs: Date.now() - startMs,
        });
      } catch (error) {
        // Graceful degradation: fall back to deterministic order
        memories = memories.slice(0, safeLimit);
        logger.warn('Semantic re-ranking failed, using deterministic fallback', {
          event: 'memory_semantic_rerank_fallback',
          avatarId: validAvatarId,
          tier: tier ?? 'all',
          retrievalMethod: 'deterministic',
          queryLatencyMs,
          totalLatencyMs: Date.now() - startMs,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    } else {
      memories = memories.slice(0, safeLimit);

      logger.info('Deterministic memory retrieval completed', {
        event: 'memory_query_complete',
        avatarId: validAvatarId,
        tier: tier ?? 'all',
        retrievalMethod: 'deterministic',
        resultCount: memories.length,
        queryLatencyMs,
        totalLatencyMs: Date.now() - startMs,
      });
    }

    return memories;
  } catch (error) {
    logger.error('Failed to get memories', {
      event: 'memory_query_error',
      avatarId: validAvatarId,
      tier,
      totalLatencyMs: Date.now() - startMs,
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

// ============================================================================
// Memory Search Operations
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
 *   score = (0.55 x semantic_similarity) +
 *           (0.25 x recency_score) +
 *           (0.15 x strength) +
 *           (0.05 x about_match_bonus)
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
  const startMs = Date.now();
  const validAvatarId = validateAvatarId(avatarId);
  const queryLower = query.toLowerCase().trim();
  const safeLimit = Math.min(limit, 50);
  const { semanticSearch = true, minSimilarity = 0.3 } = options;

  if (queryLower.length === 0) {
    return [];
  }

  // Generate query embedding for semantic search
  let queryEmbedding: number[] | null = null;
  const embeddingStartMs = Date.now();
  if (semanticSearch) {
    try {
      const embeddingService = getEmbeddingService();
      queryEmbedding = await embeddingService.embed(query);
    } catch (error) {
      logger.warn('Failed to generate query embedding, falling back to keyword search', {
        event: 'embedding_query_error',
        avatarId: validAvatarId,
        embeddingLatencyMs: Date.now() - embeddingStartMs,
        error: error instanceof Error ? error.message : 'Unknown',
      });
    }
  }
  const embeddingLatencyMs = Date.now() - embeddingStartMs;

  // Fetch candidate memories with pagination (no artificial ceiling)
  const memories: AvatarMemory[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  const MAX_CANDIDATES = 500; // Safety limit
  const queryStartMs = Date.now();

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
  const queryLatencyMs = Date.now() - queryStartMs;
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

  // Count memories with and without embeddings for diagnostics
  const withEmbeddingCount = memories.filter(m => m.embedding && m.embedding.length > 0).length;

  logger.info('Memory search completed', {
    event: 'memory_search',
    avatarId: validAvatarId,
    query: query.slice(0, 50),
    usedSemanticSearch: !!queryEmbedding,
    retrievalMethod: queryEmbedding ? 'semantic' : 'keyword',
    candidateCount: memories.length,
    withEmbeddingCount,
    withoutEmbeddingCount: memories.length - withEmbeddingCount,
    resultCount: scored.length,
    embeddingLatencyMs,
    queryLatencyMs,
    totalLatencyMs: Date.now() - startMs,
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
