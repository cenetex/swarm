/**
 * Memory Service — Graph RAG: Edge CRUD & Auto-Linking
 *
 * Create / read / update / delete graph edges between memories,
 * and automatic edge discovery via semantic similarity.
 *
 * @module memory/graph
 */
import {
  PutCommand,
  QueryCommand,
  DeleteCommand,
  UpdateCommand,
} from '@swarm/core';
import { logger } from '@swarm/core';
import type {
  AvatarMemory,
  MemoryEdge,
  MemoryEdgeType,
} from '../../types.js';
import {
  cosineSimilarity,
} from '../embedding.js';
import {
  promiseAllWithTimeout,
} from '../promise-timeout.js';
import {
  ADMIN_TABLE,
  getDynamoClient,
  computeMemoryTtl,
  validateAvatarId,
  batchWriteWithRetry,
} from './shared.js';
import { searchMemories } from './search.js';

// ============================================================================
// Graph RAG: Edge CRUD Operations
// ============================================================================

/**
 * Create a graph edge between two memories.
 *
 * Edges are bidirectional for traversal: we store source->target and query
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
