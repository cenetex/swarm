/**
 * Memory Service — Graph RAG: Search, Pruning & Context
 *
 * graphSearch(), pruneGraph(), getGraphMemoryContext(), getGraphStats().
 *
 * @module memory/graph-search
 */
import {
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { logger } from '@swarm/core';
import type {
  AvatarMemory,
  MemoryEdge,
  GraphPruneConfig,
  GraphSearchResult,
} from '../../types.js';
import {
  promiseAllWithTimeout,
  promiseAllSettledWithTimeout,
} from '../promise-timeout.js';
import {
  ADMIN_TABLE,
  DEFAULT_GRAPH_CONFIG,
  getDynamoClient,
  validateAvatarId,
} from './shared.js';
import { getMemory } from './crud.js';
import { searchMemories, getIdentity } from './search.js';
import { getMemoryContext } from './facts.js';
import {
  getEdgesForMemory,
  getAllEdges,
  deleteEdges,
} from './graph.js';

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
