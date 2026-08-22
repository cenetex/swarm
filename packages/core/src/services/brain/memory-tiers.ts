/**
 * Memory Tier Manager
 *
 * Implements durable memory tiers with different retention and cost
 * characteristics, plus automatic promotion/demotion based on access patterns.
 *
 * Tiers:
 * - ephemeral: Session-scoped, auto-expires, full detail (maps to existing 'immediate')
 * - durable:   Long-term storage with decay, medium detail (maps to existing 'recent')
 * - archival:  Permanent, cost-optimized, summarized (maps to existing 'core')
 *
 * The tier manager provides:
 * 1. Tier policies (retention, limits, cost weights)
 * 2. Access-pattern-based promotion/demotion scoring
 * 3. Batch tier migration operations
 * 4. Migration tools for converting existing memories to the new tier scheme
 *
 * @module memory-tiers
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
} from '@swarm/core';

// ============================================================================
// Types
// ============================================================================

/**
 * Extended memory tier type that includes the new durable tiers
 * alongside the legacy tier names for backward compatibility.
 */
export type DurableMemoryTier = 'ephemeral' | 'durable' | 'archival';

/**
 * Legacy tier names for backward compatibility
 */
export type LegacyMemoryTier = 'immediate' | 'recent' | 'core';

/**
 * Union of all supported tier names
 */
export type AnyMemoryTier = DurableMemoryTier | LegacyMemoryTier;

/**
 * Policy configuration for a single memory tier
 */
export interface TierPolicy {
  /** Tier identifier */
  tier: DurableMemoryTier;
  /** Human-readable display name */
  displayName: string;
  /** Maximum retention in days. -1 = unlimited */
  retentionDays: number;
  /** Maximum number of memories in this tier per avatar */
  maxCount: number;
  /** Cost weight (relative cost multiplier for storage optimization) */
  costWeight: number;
  /** Decay rate per consolidation cycle (1.0 = no decay) */
  decayRate: number;
  /** Minimum strength threshold before pruning */
  pruneThreshold: number;
  /** Whether embeddings are stored for this tier */
  storeEmbeddings: boolean;
  /** Whether full content is stored (false = summary only) */
  storeFullContent: boolean;
}

/**
 * Access pattern metrics for a single memory
 */
export interface AccessMetrics {
  /** Memory ID */
  memoryId: string;
  /** Sort key for DynamoDB operations */
  sk: string;
  /** Current tier */
  tier: AnyMemoryTier;
  /** Number of times this memory was accessed/recalled */
  accessCount: number;
  /** Timestamp of last access */
  lastAccessedAt: number;
  /** Current strength */
  strength: number;
  /** When the memory was created */
  createdAt: number;
}

/**
 * Result of evaluating a memory for tier transition
 */
export interface TierTransition {
  /** Memory ID */
  memoryId: string;
  /** Sort key */
  sk: string;
  /** Current tier */
  fromTier: DurableMemoryTier;
  /** Recommended tier */
  toTier: DurableMemoryTier;
  /** Score that determined the transition (higher = should be in higher tier) */
  score: number;
  /** Reason for the transition */
  reason: string;
}

/**
 * Result of a batch tier migration operation
 */
export interface TierMigrationResult {
  /** Avatar being migrated */
  avatarId: string;
  /** Number of memories promoted (ephemeral->durable or durable->archival) */
  promoted: number;
  /** Number of memories demoted (archival->durable or durable->ephemeral) */
  demoted: number;
  /** Number of memories pruned (below threshold) */
  pruned: number;
  /** Number of memories unchanged */
  unchanged: number;
  /** Total memories evaluated */
  total: number;
  /** Errors encountered */
  errors: string[];
  /** Duration in milliseconds */
  durationMs: number;
}

/**
 * Options for the tier evaluation algorithm
 */
export interface TierEvaluationOptions {
  /** Weight for access frequency in scoring (default: 0.3) */
  accessFrequencyWeight?: number;
  /** Weight for recency in scoring (default: 0.3) */
  recencyWeight?: number;
  /** Weight for strength in scoring (default: 0.4) */
  strengthWeight?: number;
  /** Minimum access count to consider for promotion to archival (default: 3) */
  minAccessForArchival?: number;
  /** Minimum age in days before considering for archival (default: 7) */
  minAgeDaysForArchival?: number;
  /** Maximum age in days in ephemeral before forced demotion/promotion (default: 1) */
  maxEphemeralAgeDays?: number;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Default tier policies
 */
export const TIER_POLICIES: Record<DurableMemoryTier, TierPolicy> = {
  ephemeral: {
    tier: 'ephemeral',
    displayName: 'Ephemeral (Session)',
    retentionDays: 1,
    maxCount: 50,
    costWeight: 1.0,
    decayRate: 0.8,
    pruneThreshold: 0.2,
    storeEmbeddings: true,
    storeFullContent: true,
  },
  durable: {
    tier: 'durable',
    displayName: 'Durable (Long-term)',
    retentionDays: 90,
    maxCount: 500,
    costWeight: 0.5,
    decayRate: 0.95,
    pruneThreshold: 0.1,
    storeEmbeddings: true,
    storeFullContent: true,
  },
  archival: {
    tier: 'archival',
    displayName: 'Archival (Permanent)',
    retentionDays: -1,
    maxCount: 200,
    costWeight: 0.1,
    decayRate: 1.0,
    pruneThreshold: 0.0,
    storeEmbeddings: false,
    storeFullContent: false,
  },
};

/**
 * Mapping from legacy tiers to new durable tiers
 */
export const LEGACY_TIER_MAP: Record<LegacyMemoryTier, DurableMemoryTier> = {
  immediate: 'ephemeral',
  recent: 'durable',
  core: 'archival',
};

/**
 * Reverse mapping from durable tiers to legacy tiers
 */
export const DURABLE_TO_LEGACY_MAP: Record<DurableMemoryTier, LegacyMemoryTier> = {
  ephemeral: 'immediate',
  durable: 'recent',
  archival: 'core',
};

const DEFAULT_EVALUATION_OPTIONS: Required<TierEvaluationOptions> = {
  accessFrequencyWeight: 0.3,
  recencyWeight: 0.3,
  strengthWeight: 0.4,
  minAccessForArchival: 3,
  minAgeDaysForArchival: 7,
  maxEphemeralAgeDays: 1,
};

const SECONDS_PER_DAY = 86400;
const MS_PER_DAY = SECONDS_PER_DAY * 1000;

// ============================================================================
// DynamoDB Client (test-injectable)
// ============================================================================

let _client: DynamoDBDocumentClient | null = null;

function getDynamoClient(): DynamoDBDocumentClient {
  if (!_client) {
    _client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }
  return _client;
}

/** Test hook: inject a mock DynamoDB document client. */
export function _setDynamoClient(client: DynamoDBDocumentClient | null): void {
  _client = client;
}

// ============================================================================
// Tier Resolution
// ============================================================================

/**
 * Normalize any tier name (legacy or new) to a DurableMemoryTier.
 */
export function normalizeTier(tier: AnyMemoryTier): DurableMemoryTier {
  if (tier === 'immediate' || tier === 'recent' || tier === 'core') {
    return LEGACY_TIER_MAP[tier];
  }
  return tier;
}

/**
 * Convert a DurableMemoryTier back to the legacy tier name.
 *
 * Needed for backward-compatible DynamoDB sort keys which use
 * {tier}#{timestamp}#{id} format with legacy names.
 */
export function toLegacyTier(tier: DurableMemoryTier): LegacyMemoryTier {
  return DURABLE_TO_LEGACY_MAP[tier];
}

/**
 * Get the policy for a given tier (accepts legacy or new tier names).
 */
export function getTierPolicy(tier: AnyMemoryTier): TierPolicy {
  const normalized = normalizeTier(tier);
  return TIER_POLICIES[normalized];
}

// ============================================================================
// Access Pattern Scoring
// ============================================================================

/**
 * Compute a tier retention score for a memory based on its access metrics.
 *
 * Score range: 0.0 (should be in lowest tier) to 1.0 (should be in highest tier).
 *
 * Factors:
 * - Access frequency: how often the memory is recalled (0-1 normalized)
 * - Recency: how recently the memory was accessed (exponential decay)
 * - Strength: current reinforcement strength
 */
export function computeRetentionScore(
  metrics: AccessMetrics,
  options: TierEvaluationOptions = {},
): number {
  const opts = { ...DEFAULT_EVALUATION_OPTIONS, ...options };
  const now = Date.now();

  // 1. Access frequency score (0-1)
  // Logarithmic scaling: 1 access = ~0, 10 accesses = ~0.7, 100 = ~1.0
  const accessScore = metrics.accessCount > 0
    ? Math.min(1.0, Math.log10(metrics.accessCount + 1) / 2.0)
    : 0;

  // 2. Recency score (0-1)
  // Exponential decay based on last access time
  const daysSinceAccess = (now - metrics.lastAccessedAt) / MS_PER_DAY;
  const recencyScore = Math.exp(-daysSinceAccess / 30); // half-life ~21 days

  // 3. Strength score (0-1, already normalized)
  const strengthScore = Math.min(1.0, Math.max(0, metrics.strength));

  // Weighted combination
  const score =
    accessScore * opts.accessFrequencyWeight +
    recencyScore * opts.recencyWeight +
    strengthScore * opts.strengthWeight;

  return Math.min(1.0, Math.max(0, score));
}

/**
 * Determine the recommended tier for a memory based on its retention score
 * and other criteria.
 */
export function recommendTier(
  metrics: AccessMetrics,
  options: TierEvaluationOptions = {},
): DurableMemoryTier {
  const opts = { ...DEFAULT_EVALUATION_OPTIONS, ...options };
  const score = computeRetentionScore(metrics, opts);
  const now = Date.now();
  const ageDays = (now - metrics.createdAt) / MS_PER_DAY;

  // Force ephemeral memories older than max age to promote
  if (ageDays <= opts.maxEphemeralAgeDays && score < 0.3) {
    return 'ephemeral';
  }

  // Archival requires minimum access count and age
  if (
    score >= 0.6 &&
    metrics.accessCount >= opts.minAccessForArchival &&
    ageDays >= opts.minAgeDaysForArchival
  ) {
    return 'archival';
  }

  // Durable for moderate scores or aged ephemeral
  if (score >= 0.2 || ageDays > opts.maxEphemeralAgeDays) {
    return 'durable';
  }

  return 'ephemeral';
}

// ============================================================================
// Tier Transition Evaluation
// ============================================================================

/**
 * Evaluate a batch of memories and determine which should transition tiers.
 */
export function evaluateTierTransitions(
  memories: AccessMetrics[],
  options: TierEvaluationOptions = {},
): TierTransition[] {
  const transitions: TierTransition[] = [];

  for (const metrics of memories) {
    const currentTier = normalizeTier(metrics.tier);
    const recommended = recommendTier(metrics, options);

    if (recommended !== currentTier) {
      const score = computeRetentionScore(metrics, options);
      const direction = tierOrder(recommended) > tierOrder(currentTier) ? 'promoted' : 'demoted';
      transitions.push({
        memoryId: metrics.memoryId,
        sk: metrics.sk,
        fromTier: currentTier,
        toTier: recommended,
        score,
        reason: `${direction}: score=${score.toFixed(3)}, ` +
          `accessCount=${metrics.accessCount}, ` +
          `strength=${metrics.strength.toFixed(2)}`,
      });
    }
  }

  return transitions;
}

/**
 * Get the ordinal position of a tier (for comparing promotion vs demotion).
 * Higher = more permanent.
 */
function tierOrder(tier: DurableMemoryTier): number {
  switch (tier) {
    case 'ephemeral': return 0;
    case 'durable': return 1;
    case 'archival': return 2;
  }
}

// ============================================================================
// TTL Computation
// ============================================================================

/**
 * Compute the DynamoDB TTL for a given tier.
 */
export function computeTierTtl(
  tier: AnyMemoryTier,
  customRetentionDays?: number,
): number | undefined {
  const policy = getTierPolicy(tier);
  const retentionDays = customRetentionDays ?? policy.retentionDays;

  if (retentionDays === -1) {
    return undefined; // unlimited retention
  }

  return Math.floor(Date.now() / 1000) + retentionDays * SECONDS_PER_DAY;
}

// ============================================================================
// Cost Estimation
// ============================================================================

/**
 * Estimate the relative storage cost for a set of memories across tiers.
 *
 * Returns a cost score (not actual dollars) useful for comparing
 * before/after tier optimization.
 */
export function estimateStorageCost(
  tierCounts: Record<DurableMemoryTier, number>,
): number {
  let cost = 0;
  for (const [tier, count] of Object.entries(tierCounts)) {
    const policy = TIER_POLICIES[tier as DurableMemoryTier];
    if (policy) {
      cost += count * policy.costWeight;
    }
  }
  return cost;
}

/**
 * Estimate cost savings from moving memories to optimal tiers.
 */
export function estimateCostSavings(
  currentCounts: Record<DurableMemoryTier, number>,
  optimizedCounts: Record<DurableMemoryTier, number>,
): { before: number; after: number; savingsPercent: number } {
  const before = estimateStorageCost(currentCounts);
  const after = estimateStorageCost(optimizedCounts);
  const savingsPercent = before > 0 ? ((before - after) / before) * 100 : 0;
  return {
    before,
    after,
    savingsPercent: Math.round(savingsPercent * 10) / 10,
  };
}

// ============================================================================
// Access Tracking (DynamoDB operations)
// ============================================================================

/**
 * Record an access event for a memory, incrementing its access count
 * and updating lastAccessedAt.
 */
export async function recordAccess(
  tableName: string,
  avatarId: string,
  sk: string,
): Promise<{ accessCount: number }> {
  const now = Date.now();
  const result = await getDynamoClient().send(new UpdateCommand({
    TableName: tableName,
    Key: { pk: `MEMORY#${avatarId}`, sk },
    UpdateExpression:
      'SET accessCount = if_not_exists(accessCount, :zero) + :one, ' +
      'lastAccessedAt = :now, updatedAt = :now',
    ExpressionAttributeValues: {
      ':zero': 0,
      ':one': 1,
      ':now': now,
    },
    ReturnValues: 'ALL_NEW',
  }));

  const accessCount = (result.Attributes?.accessCount as number) ?? 1;
  return { accessCount };
}

/**
 * Fetch access metrics for all memories of an avatar.
 */
export async function fetchAccessMetrics(
  tableName: string,
  avatarId: string,
): Promise<AccessMetrics[]> {
  const metrics: AccessMetrics[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const result = await getDynamoClient().send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': `MEMORY#${avatarId}`,
      },
      ProjectionExpression: 'id, sk, tier, accessCount, lastAccessedAt, strength, createdAt',
      ExclusiveStartKey: lastEvaluatedKey,
      Limit: 500,
    }));

    if (result.Items) {
      for (const item of result.Items) {
        metrics.push({
          memoryId: item.id as string,
          sk: item.sk as string,
          tier: item.tier as AnyMemoryTier,
          accessCount: (item.accessCount as number) ?? 0,
          lastAccessedAt: (item.lastAccessedAt as number) ?? (item.createdAt as number),
          strength: (item.strength as number) ?? 1.0,
          createdAt: item.createdAt as number,
        });
      }
    }

    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  return metrics;
}

// ============================================================================
// Legacy Migration
// ============================================================================

/**
 * Analyze existing memories and produce a migration plan mapping
 * legacy tiers to the new durable tier scheme.
 *
 * This does NOT modify any data -- it returns a read-only plan.
 */
export async function planTierMigration(
  tableName: string,
  avatarId: string,
  options: TierEvaluationOptions = {},
): Promise<{
  avatarId: string;
  transitions: TierTransition[];
  currentCounts: Record<DurableMemoryTier, number>;
  optimizedCounts: Record<DurableMemoryTier, number>;
  costEstimate: { before: number; after: number; savingsPercent: number };
}> {
  const metrics = await fetchAccessMetrics(tableName, avatarId);

  // Count current distribution (mapping legacy tiers)
  const currentCounts: Record<DurableMemoryTier, number> = {
    ephemeral: 0,
    durable: 0,
    archival: 0,
  };
  for (const m of metrics) {
    const tier = normalizeTier(m.tier);
    currentCounts[tier]++;
  }

  // Evaluate transitions
  const transitions = evaluateTierTransitions(metrics, options);

  // Compute optimized counts
  const optimizedCounts: Record<DurableMemoryTier, number> = { ...currentCounts };
  for (const t of transitions) {
    optimizedCounts[t.fromTier]--;
    optimizedCounts[t.toTier]++;
  }

  const costEstimate = estimateCostSavings(currentCounts, optimizedCounts);

  return {
    avatarId,
    transitions,
    currentCounts,
    optimizedCounts,
    costEstimate,
  };
}

/**
 * Apply tier label updates to memories in DynamoDB.
 *
 * Updates the `tier` field on each memory. The SK prefix is retained
 * for backward compatibility -- the tier field is used for filtering
 * and policy enforcement.
 */
export async function applyTierTransitions(
  tableName: string,
  avatarId: string,
  transitions: TierTransition[],
): Promise<TierMigrationResult> {
  const start = Date.now();
  const result: TierMigrationResult = {
    avatarId,
    promoted: 0,
    demoted: 0,
    pruned: 0,
    unchanged: 0,
    total: transitions.length,
    errors: [],
    durationMs: 0,
  };

  for (const transition of transitions) {
    try {
      const now = Date.now();
      const ttl = computeTierTtl(transition.toTier);

      const updateExprParts = ['tier = :tier', 'updatedAt = :now'];
      const expressionAttributeValues: Record<string, unknown> = {
        ':tier': transition.toTier,
        ':now': now,
      };
      let expressionAttributeNames: Record<string, string> | undefined;

      if (ttl !== undefined) {
        updateExprParts.push('#ttl = :ttl');
        expressionAttributeValues[':ttl'] = ttl;
        expressionAttributeNames = { '#ttl': 'ttl' };
      }

      const updateExpression = ttl !== undefined
        ? `SET ${updateExprParts.join(', ')}`
        : `SET tier = :tier, updatedAt = :now REMOVE #ttl`;

      if (ttl === undefined) {
        expressionAttributeNames = { '#ttl': 'ttl' };
      }

      await getDynamoClient().send(new UpdateCommand({
        TableName: tableName,
        Key: { pk: `MEMORY#${avatarId}`, sk: transition.sk },
        UpdateExpression: updateExpression,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
      }));

      if (tierOrder(transition.toTier) > tierOrder(transition.fromTier)) {
        result.promoted++;
      } else {
        result.demoted++;
      }
    } catch (error) {
      result.errors.push(
        `Failed to transition ${transition.memoryId}: ` +
        (error instanceof Error ? error.message : 'Unknown error'),
      );
    }
  }

  result.durationMs = Date.now() - start;
  return result;
}
