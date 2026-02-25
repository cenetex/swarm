/**
 * Memory system types — tiered avatar memory, consolidation, graph RAG
 */

// ============================================================================
// Memory System - Tiered Avatar Memory for Personality Evolution
// ============================================================================

/**
 * Memory tier determines storage duration and detail level
 *
 * Legacy tiers (backward compatible):
 * - immediate: Last N interactions, full detail (short-term)
 * - recent: Summarized memories with themes (medium-term)
 * - core: Permanent learnings, patterns, identity (long-term)
 *
 * New durable tiers:
 * - ephemeral: Session-scoped, auto-expires (maps to immediate)
 * - durable: Long-term with decay (maps to recent)
 * - archival: Permanent, cost-optimized (maps to core)
 */
export type MemoryTier = 'immediate' | 'recent' | 'core' | 'ephemeral' | 'durable' | 'archival';

/**
 * Memory type categorizes what kind of memory this is
 */
export type MemoryType =
  | 'event'        // Something that happened (conversation, action)
  | 'fact'         // A factual piece of information
  | 'learning'     // Something the avatar learned
  | 'pattern'      // A behavioral pattern the avatar noticed
  | 'identity'     // Self-reflection about who the avatar is becoming
  | 'relationship' // Memory about a specific user or entity
  | 'preference';  // User or avatar preference

/**
 * A memory stored in the avatar's memory system
 * Key: pk=MEMORY#{avatarId}, sk={tier}#{timestamp}#{id}
 */
export interface AvatarMemory {
  pk: string;
  sk: string;
  id: string;
  avatarId: string;
  tier: MemoryTier;
  type: MemoryType;
  content: string;           // The memory content
  about?: string;            // Who/what this is about (username, topic)
  userId?: string;           // Associated user ID if applicable
  themes?: string[];         // Tags for retrieval (e.g., 'hunting', 'philosophy')
  strength: number;          // 0-1, how reinforced this memory is
  embedding?: number[];      // Vector embedding for semantic search
  embeddingModel?: string;   // Model used to generate embedding (e.g., 'amazon.titan-embed-text-v2:0')
  embeddingVersion?: number; // Embedding version for re-embedding on model upgrades
  metadata?: Record<string, unknown>; // Additional context
  createdAt: number;
  updatedAt: number;
  consolidatedAt?: number;   // When this was last processed by consolidation
  sourceMemoryIds?: string[]; // For summaries: IDs of memories that were consolidated
  ttl?: number;              // DynamoDB TTL (epoch seconds) for automatic expiration
}

/**
 * Configuration for memory consolidation
 */
export interface MemoryConsolidationConfig {
  // Immediate tier
  immediateMaxCount: number;     // Max memories before promotion (default: 10)
  // Recent tier
  recentMaxCount: number;        // Max memories before summarization (default: 50)
  recentSummaryThreshold: number; // Memories to trigger summary (default: 10)
  // Core tier
  coreMaxCount: number;          // Max core memories (default: 100)
  // Decay settings
  decayRate: number;             // Strength multiplier per cycle (default: 0.95)
  decayIntervalHours: number;    // Hours between decay cycles (default: 24)
  pruneThreshold: number;        // Remove memories below this strength (default: 0.1)
  // Reinforcement
  reinforcementBoost: number;    // Strength boost when pattern repeats (default: 0.1)
}

/**
 * Avatar's consolidated identity snapshot
 * Key: pk=IDENTITY#{avatarId}, sk=SNAPSHOT#{timestamp}
 */
export interface AvatarIdentitySnapshot {
  pk: string;
  sk: string;
  avatarId: string;
  statement: string;         // "I am becoming..." statement
  previousStatement?: string; // Previous identity for comparison
  triggeringMemories: string[]; // Memory IDs that led to this
  createdAt: number;
  ttl?: number;              // DynamoDB TTL (epoch seconds) for automatic expiration
}

/**
 * Memory query options
 */
export interface MemoryQueryOptions {
  tier?: MemoryTier;
  type?: MemoryType;
  about?: string;
  userId?: string;
  themes?: string[];
  minStrength?: number;
  limit?: number;
  semantic?: {
    query: string;
    threshold?: number;      // Minimum similarity (default: 0.5)
  };
}

// ============================================================================
// Memory Graph (Graph RAG)
// ============================================================================

/**
 * Edge relationship types for the memory graph
 */
export type MemoryEdgeType =
  | 'related_to'      // General semantic relatedness
  | 'caused_by'       // Causal relationship (A caused B)
  | 'about_same'      // Same entity/topic
  | 'contradicts'     // Conflicting information
  | 'elaborates'      // B provides more detail about A
  | 'temporal_next'   // B happened after A in sequence
  | 'promoted_from';  // B was promoted/consolidated from A

/**
 * An edge in the memory graph connecting two memories.
 *
 * DynamoDB Key Schema:
 * - pk: EDGE#{avatarId}
 * - sk: {sourceMemoryId}#{targetMemoryId}
 *
 * GSI (reverse lookup):
 * - pk: EDGE#{avatarId}
 * - sk: begins_with(targetMemoryId#) via scan/filter
 */
export interface MemoryEdge {
  pk: string;               // EDGE#{avatarId}
  sk: string;               // {sourceMemoryId}#{targetMemoryId}
  avatarId: string;
  sourceMemoryId: string;
  targetMemoryId: string;
  edgeType: MemoryEdgeType;
  weight: number;           // 0.0–1.0, strength of the relationship
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  ttl?: number;             // DynamoDB TTL (epoch seconds)
}

/**
 * Configuration for graph pruning during consolidation
 */
export interface GraphPruneConfig {
  /** Minimum edge weight to keep (edges below this are deleted). Default: 0.1 */
  minEdgeWeight: number;
  /** Decay multiplier applied to edge weights per consolidation cycle. Default: 0.95 */
  edgeDecayRate: number;
  /** Maximum edges per memory node (prune weakest above this). Default: 20 */
  maxEdgesPerNode: number;
  /** Maximum total edges per avatar. Default: 2000 */
  maxTotalEdges: number;
}

/**
 * Result of a graph-enhanced memory search
 */
export interface GraphSearchResult {
  /** Directly matched memories from semantic search */
  directMatches: AvatarMemory[];
  /** Associated memories surfaced via graph traversal */
  graphMatches: AvatarMemory[];
  /** Combined and deduplicated results */
  combined: AvatarMemory[];
  /** Graph edges traversed */
  edgesTraversed: number;
}
