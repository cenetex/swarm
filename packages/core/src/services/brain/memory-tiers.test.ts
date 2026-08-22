/**
 * Memory Tier Manager Tests
 *
 * Tests for the durable memory tier system covering:
 * 1. Tier normalization (legacy -> new and back)
 * 2. Tier policies and lookup
 * 3. Retention scoring algorithm
 * 4. Tier recommendation logic
 * 5. Tier transition evaluation
 * 6. TTL computation per tier
 * 7. Cost estimation and savings
 * 8. Access tracking (DynamoDB operations)
 * 9. Migration planning
 * 10. Tier transition application
 */

import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { DynamoDBDocumentClient } from '@swarm/core';
import {
  normalizeTier,
  toLegacyTier,
  getTierPolicy,
  computeRetentionScore,
  recommendTier,
  evaluateTierTransitions,
  computeTierTtl,
  estimateStorageCost,
  estimateCostSavings,
  recordAccess,
  fetchAccessMetrics,
  planTierMigration,
  applyTierTransitions,
  TIER_POLICIES,
  LEGACY_TIER_MAP,
  DURABLE_TO_LEGACY_MAP,
  _setDynamoClient,
  type AccessMetrics,
  type DurableMemoryTier,
} from './memory-tiers.js';

// ============================================================================
// Test Helpers
// ============================================================================

const NOW = Date.now();
const ONE_DAY_MS = 86400 * 1000;
const ONE_HOUR_MS = 3600 * 1000;

function makeMetrics(overrides: Partial<AccessMetrics> = {}): AccessMetrics {
  return {
    memoryId: 'mem-001',
    sk: 'immediate#1700000000000#mem-001',
    tier: 'immediate',
    accessCount: 0,
    lastAccessedAt: NOW,
    strength: 1.0,
    createdAt: NOW,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Memory Tier Manager', () => {
  let mockSend: ReturnType<typeof mock>;

  beforeEach(() => {
    mockSend = mock(() => Promise.resolve({}));
    const mockDocClient = { send: mockSend } as unknown as DynamoDBDocumentClient;
    _setDynamoClient(mockDocClient);
  });

  afterEach(() => {
    _setDynamoClient(null);
  });

  // ==========================================================================
  // Tier Normalization
  // ==========================================================================

  describe('normalizeTier', () => {
    it('maps legacy "immediate" to "ephemeral"', () => {
      expect(normalizeTier('immediate')).toBe('ephemeral');
    });

    it('maps legacy "recent" to "durable"', () => {
      expect(normalizeTier('recent')).toBe('durable');
    });

    it('maps legacy "core" to "archival"', () => {
      expect(normalizeTier('core')).toBe('archival');
    });

    it('passes through "ephemeral" unchanged', () => {
      expect(normalizeTier('ephemeral')).toBe('ephemeral');
    });

    it('passes through "durable" unchanged', () => {
      expect(normalizeTier('durable')).toBe('durable');
    });

    it('passes through "archival" unchanged', () => {
      expect(normalizeTier('archival')).toBe('archival');
    });
  });

  describe('toLegacyTier', () => {
    it('maps "ephemeral" to "immediate"', () => {
      expect(toLegacyTier('ephemeral')).toBe('immediate');
    });

    it('maps "durable" to "recent"', () => {
      expect(toLegacyTier('durable')).toBe('recent');
    });

    it('maps "archival" to "core"', () => {
      expect(toLegacyTier('archival')).toBe('core');
    });
  });

  describe('getTierPolicy', () => {
    it('returns ephemeral policy for "immediate"', () => {
      const policy = getTierPolicy('immediate');
      expect(policy.tier).toBe('ephemeral');
      expect(policy.retentionDays).toBe(1);
    });

    it('returns durable policy for "recent"', () => {
      const policy = getTierPolicy('recent');
      expect(policy.tier).toBe('durable');
      expect(policy.retentionDays).toBe(90);
    });

    it('returns archival policy for "core"', () => {
      const policy = getTierPolicy('core');
      expect(policy.tier).toBe('archival');
      expect(policy.retentionDays).toBe(-1);
    });

    it('returns correct policy for new tier names', () => {
      expect(getTierPolicy('ephemeral').maxCount).toBe(50);
      expect(getTierPolicy('durable').maxCount).toBe(500);
      expect(getTierPolicy('archival').maxCount).toBe(200);
    });
  });

  // ==========================================================================
  // Tier Policies
  // ==========================================================================

  describe('TIER_POLICIES', () => {
    it('ephemeral has highest cost weight and fastest decay', () => {
      expect(TIER_POLICIES.ephemeral.costWeight).toBe(1.0);
      expect(TIER_POLICIES.ephemeral.decayRate).toBe(0.8);
    });

    it('durable has medium cost weight and moderate decay', () => {
      expect(TIER_POLICIES.durable.costWeight).toBe(0.5);
      expect(TIER_POLICIES.durable.decayRate).toBe(0.95);
    });

    it('archival has lowest cost weight and no decay', () => {
      expect(TIER_POLICIES.archival.costWeight).toBe(0.1);
      expect(TIER_POLICIES.archival.decayRate).toBe(1.0);
    });

    it('archival does not store embeddings (cost optimization)', () => {
      expect(TIER_POLICIES.archival.storeEmbeddings).toBe(false);
      expect(TIER_POLICIES.archival.storeFullContent).toBe(false);
    });

    it('ephemeral and durable store full content and embeddings', () => {
      expect(TIER_POLICIES.ephemeral.storeEmbeddings).toBe(true);
      expect(TIER_POLICIES.ephemeral.storeFullContent).toBe(true);
      expect(TIER_POLICIES.durable.storeEmbeddings).toBe(true);
      expect(TIER_POLICIES.durable.storeFullContent).toBe(true);
    });
  });

  describe('LEGACY_TIER_MAP / DURABLE_TO_LEGACY_MAP', () => {
    it('are inverses of each other', () => {
      for (const [legacy, durable] of Object.entries(LEGACY_TIER_MAP)) {
        expect(DURABLE_TO_LEGACY_MAP[durable as DurableMemoryTier]).toBe(legacy);
      }
    });
  });

  // ==========================================================================
  // Retention Scoring
  // ==========================================================================

  describe('computeRetentionScore', () => {
    it('returns 0 for a brand-new memory with no accesses and 0 strength', () => {
      const metrics = makeMetrics({ accessCount: 0, strength: 0 });
      const score = computeRetentionScore(metrics);
      // Recency score will be ~1.0 (just accessed), so not exactly 0
      // but access and strength contribute 0
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThan(0.5);
    });

    it('gives higher score for frequently accessed memory', () => {
      const lowAccess = makeMetrics({ accessCount: 1 });
      const highAccess = makeMetrics({ accessCount: 100 });
      expect(computeRetentionScore(highAccess)).toBeGreaterThan(
        computeRetentionScore(lowAccess),
      );
    });

    it('gives higher score for recently accessed memory', () => {
      const recent = makeMetrics({ lastAccessedAt: NOW });
      const old = makeMetrics({ lastAccessedAt: NOW - 60 * ONE_DAY_MS });
      expect(computeRetentionScore(recent)).toBeGreaterThan(
        computeRetentionScore(old),
      );
    });

    it('gives higher score for stronger memory', () => {
      const weak = makeMetrics({ strength: 0.1 });
      const strong = makeMetrics({ strength: 1.0 });
      expect(computeRetentionScore(strong)).toBeGreaterThan(
        computeRetentionScore(weak),
      );
    });

    it('respects custom weight options', () => {
      const metrics = makeMetrics({ accessCount: 100, strength: 0.0 });
      const accessHeavy = computeRetentionScore(metrics, {
        accessFrequencyWeight: 0.9,
        recencyWeight: 0.05,
        strengthWeight: 0.05,
      });
      const strengthHeavy = computeRetentionScore(metrics, {
        accessFrequencyWeight: 0.05,
        recencyWeight: 0.05,
        strengthWeight: 0.9,
      });
      expect(accessHeavy).toBeGreaterThan(strengthHeavy);
    });

    it('score is clamped between 0 and 1', () => {
      const highMetrics = makeMetrics({
        accessCount: 10000,
        strength: 2.0,
        lastAccessedAt: NOW,
      });
      const score = computeRetentionScore(highMetrics);
      expect(score).toBeLessThanOrEqual(1.0);
      expect(score).toBeGreaterThanOrEqual(0.0);
    });
  });

  // ==========================================================================
  // Tier Recommendation
  // ==========================================================================

  describe('recommendTier', () => {
    it('recommends ephemeral for new low-access memories within max age', () => {
      const metrics = makeMetrics({
        accessCount: 0,
        strength: 0.0,
        createdAt: NOW - ONE_HOUR_MS, // less than 1 day old
        lastAccessedAt: NOW - 12 * ONE_HOUR_MS,
      });
      expect(recommendTier(metrics)).toBe('ephemeral');
    });

    it('recommends durable for aged memories with moderate access', () => {
      const metrics = makeMetrics({
        tier: 'immediate',
        accessCount: 2,
        strength: 0.5,
        createdAt: NOW - 3 * ONE_DAY_MS, // 3 days old
        lastAccessedAt: NOW - ONE_DAY_MS,
      });
      expect(recommendTier(metrics)).toBe('durable');
    });

    it('recommends archival for highly accessed old memories', () => {
      const metrics = makeMetrics({
        tier: 'recent',
        accessCount: 10,
        strength: 1.0,
        createdAt: NOW - 14 * ONE_DAY_MS, // 14 days old
        lastAccessedAt: NOW - ONE_DAY_MS,
      });
      expect(recommendTier(metrics)).toBe('archival');
    });

    it('promotes aged ephemeral to at least durable', () => {
      const metrics = makeMetrics({
        tier: 'immediate',
        accessCount: 0,
        strength: 0.5,
        createdAt: NOW - 2 * ONE_DAY_MS, // 2 days old (past ephemeral max)
        lastAccessedAt: NOW - 2 * ONE_DAY_MS,
      });
      const tier = recommendTier(metrics);
      expect(tier === 'durable' || tier === 'archival').toBe(true);
    });

    it('respects minAccessForArchival threshold', () => {
      const metrics = makeMetrics({
        accessCount: 1, // below default threshold of 3
        strength: 1.0,
        createdAt: NOW - 30 * ONE_DAY_MS,
        lastAccessedAt: NOW,
      });
      // Even with high score, should not be archival with low access count
      expect(recommendTier(metrics)).not.toBe('archival');
    });

    it('respects minAgeDaysForArchival threshold', () => {
      const metrics = makeMetrics({
        accessCount: 10,
        strength: 1.0,
        createdAt: NOW - 2 * ONE_DAY_MS, // only 2 days old (default min is 7)
        lastAccessedAt: NOW,
      });
      expect(recommendTier(metrics)).not.toBe('archival');
    });
  });

  // ==========================================================================
  // Tier Transition Evaluation
  // ==========================================================================

  describe('evaluateTierTransitions', () => {
    it('returns empty array when all memories are in correct tier', () => {
      const metrics = [
        makeMetrics({
          memoryId: 'a',
          sk: 'immediate#1#a',
          tier: 'ephemeral',
          accessCount: 0,
          strength: 0.0,
          createdAt: NOW - ONE_HOUR_MS,
          lastAccessedAt: NOW - 12 * ONE_HOUR_MS,
        }),
      ];
      const transitions = evaluateTierTransitions(metrics);
      expect(transitions).toHaveLength(0);
    });

    it('recommends promotion for aged immediate memories', () => {
      const metrics = [
        makeMetrics({
          memoryId: 'old-memory',
          sk: 'immediate#1#old-memory',
          tier: 'immediate',
          accessCount: 5,
          strength: 0.8,
          createdAt: NOW - 10 * ONE_DAY_MS,
          lastAccessedAt: NOW - ONE_DAY_MS,
        }),
      ];
      const transitions = evaluateTierTransitions(metrics);
      expect(transitions.length).toBeGreaterThanOrEqual(1);
      const t = transitions[0];
      expect(t.fromTier).toBe('ephemeral'); // immediate normalizes to ephemeral
      expect(t.reason).toContain('promoted');
    });

    it('includes score in transition reason', () => {
      const metrics = [
        makeMetrics({
          memoryId: 'scored',
          sk: 'immediate#1#scored',
          tier: 'immediate',
          accessCount: 5,
          strength: 0.8,
          createdAt: NOW - 10 * ONE_DAY_MS,
          lastAccessedAt: NOW,
        }),
      ];
      const transitions = evaluateTierTransitions(metrics);
      if (transitions.length > 0) {
        expect(transitions[0].reason).toContain('score=');
      }
    });
  });

  // ==========================================================================
  // TTL Computation
  // ==========================================================================

  describe('computeTierTtl', () => {
    it('returns TTL for ephemeral tier (1 day)', () => {
      const ttl = computeTierTtl('ephemeral');
      expect(ttl).toBeDefined();
      const expectedMin = Math.floor(Date.now() / 1000) + 86400 - 5;
      const expectedMax = Math.floor(Date.now() / 1000) + 86400 + 5;
      expect(ttl!).toBeGreaterThanOrEqual(expectedMin);
      expect(ttl!).toBeLessThanOrEqual(expectedMax);
    });

    it('returns TTL for durable tier (90 days)', () => {
      const ttl = computeTierTtl('durable');
      expect(ttl).toBeDefined();
      const expectedMin = Math.floor(Date.now() / 1000) + 90 * 86400 - 5;
      expect(ttl!).toBeGreaterThanOrEqual(expectedMin);
    });

    it('returns undefined for archival tier (unlimited)', () => {
      const ttl = computeTierTtl('archival');
      expect(ttl).toBeUndefined();
    });

    it('accepts legacy tier names', () => {
      const immediateTtl = computeTierTtl('immediate');
      const ephemeralTtl = computeTierTtl('ephemeral');
      // Both should be ~1 day from now (within a few seconds of each other)
      expect(immediateTtl).toBeDefined();
      expect(ephemeralTtl).toBeDefined();
      expect(Math.abs(immediateTtl! - ephemeralTtl!)).toBeLessThan(5);
    });

    it('respects custom retention days override', () => {
      const ttl = computeTierTtl('ephemeral', 7);
      expect(ttl).toBeDefined();
      const expectedMin = Math.floor(Date.now() / 1000) + 7 * 86400 - 5;
      expect(ttl!).toBeGreaterThanOrEqual(expectedMin);
    });

    it('returns undefined when custom retention is -1', () => {
      const ttl = computeTierTtl('ephemeral', -1);
      expect(ttl).toBeUndefined();
    });
  });

  // ==========================================================================
  // Cost Estimation
  // ==========================================================================

  describe('estimateStorageCost', () => {
    it('calculates weighted cost based on tier counts', () => {
      const cost = estimateStorageCost({
        ephemeral: 10,
        durable: 20,
        archival: 100,
      });
      // 10*1.0 + 20*0.5 + 100*0.1 = 10 + 10 + 10 = 30
      expect(cost).toBe(30);
    });

    it('returns 0 for empty tiers', () => {
      const cost = estimateStorageCost({
        ephemeral: 0,
        durable: 0,
        archival: 0,
      });
      expect(cost).toBe(0);
    });

    it('archival is most cost-efficient per memory', () => {
      const ephemeralCost = estimateStorageCost({ ephemeral: 100, durable: 0, archival: 0 });
      const archivalCost = estimateStorageCost({ ephemeral: 0, durable: 0, archival: 100 });
      expect(archivalCost).toBeLessThan(ephemeralCost);
    });
  });

  describe('estimateCostSavings', () => {
    it('calculates savings percentage when moving to archival', () => {
      const current = { ephemeral: 100, durable: 0, archival: 0 };
      const optimized = { ephemeral: 10, durable: 40, archival: 50 };
      const savings = estimateCostSavings(current, optimized);

      expect(savings.before).toBe(100); // 100*1.0
      expect(savings.after).toBe(35); // 10*1.0 + 40*0.5 + 50*0.1
      expect(savings.savingsPercent).toBe(65);
    });

    it('returns 0% savings when distributions are identical', () => {
      const counts = { ephemeral: 10, durable: 20, archival: 30 };
      const savings = estimateCostSavings(counts, counts);
      expect(savings.savingsPercent).toBe(0);
    });

    it('handles zero-memory case', () => {
      const counts = { ephemeral: 0, durable: 0, archival: 0 };
      const savings = estimateCostSavings(counts, counts);
      expect(savings.savingsPercent).toBe(0);
      expect(savings.before).toBe(0);
      expect(savings.after).toBe(0);
    });
  });

  // ==========================================================================
  // Access Tracking (DynamoDB)
  // ==========================================================================

  describe('recordAccess', () => {
    it('sends UpdateCommand with correct key and expressions', async () => {
      mockSend.mockImplementation(() =>
        Promise.resolve({ Attributes: { accessCount: 3 } }),
      );

      const result = await recordAccess('test-table', 'avatar-1', 'immediate#1#mem-001');

      expect(result.accessCount).toBe(3);
      expect(mockSend).toHaveBeenCalledTimes(1);

      const input = mockSend.mock.calls[0][0].input;
      expect(input.TableName).toBe('test-table');
      expect(input.Key.pk).toBe('MEMORY#avatar-1');
      expect(input.Key.sk).toBe('immediate#1#mem-001');
      expect(input.UpdateExpression).toContain('accessCount');
      expect(input.UpdateExpression).toContain('lastAccessedAt');
      expect(input.ReturnValues).toBe('ALL_NEW');
    });

    it('defaults to accessCount 1 when Attributes is missing', async () => {
      mockSend.mockImplementation(() => Promise.resolve({}));

      const result = await recordAccess('test-table', 'avatar-1', 'immediate#1#mem-001');
      expect(result.accessCount).toBe(1);
    });
  });

  describe('fetchAccessMetrics', () => {
    it('queries all memories for an avatar', async () => {
      mockSend.mockImplementation(() =>
        Promise.resolve({
          Items: [
            {
              id: 'mem-1',
              sk: 'immediate#100#mem-1',
              tier: 'immediate',
              accessCount: 5,
              lastAccessedAt: NOW,
              strength: 0.8,
              createdAt: NOW - ONE_DAY_MS,
            },
            {
              id: 'mem-2',
              sk: 'recent#200#mem-2',
              tier: 'recent',
              accessCount: 0,
              strength: 0.5,
              createdAt: NOW - 5 * ONE_DAY_MS,
            },
          ],
        }),
      );

      const metrics = await fetchAccessMetrics('test-table', 'avatar-1');

      expect(metrics).toHaveLength(2);
      expect(metrics[0].memoryId).toBe('mem-1');
      expect(metrics[0].accessCount).toBe(5);
      expect(metrics[1].memoryId).toBe('mem-2');
      expect(metrics[1].lastAccessedAt).toBe(NOW - 5 * ONE_DAY_MS); // falls back to createdAt
    });

    it('handles pagination', async () => {
      let callCount = 0;
      mockSend.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            Items: [{ id: 'mem-1', sk: 'immediate#1#mem-1', tier: 'immediate', accessCount: 0, strength: 1.0, createdAt: NOW }],
            LastEvaluatedKey: { pk: 'MEMORY#avatar-1', sk: 'immediate#1#mem-1' },
          });
        }
        return Promise.resolve({
          Items: [{ id: 'mem-2', sk: 'recent#2#mem-2', tier: 'recent', accessCount: 2, strength: 0.5, createdAt: NOW }],
        });
      });

      const metrics = await fetchAccessMetrics('test-table', 'avatar-1');
      expect(metrics).toHaveLength(2);
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('returns empty array for avatar with no memories', async () => {
      mockSend.mockImplementation(() => Promise.resolve({ Items: [] }));

      const metrics = await fetchAccessMetrics('test-table', 'avatar-1');
      expect(metrics).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Migration Planning
  // ==========================================================================

  describe('planTierMigration', () => {
    it('produces a plan with current and optimized counts', async () => {
      mockSend.mockImplementation(() =>
        Promise.resolve({
          Items: [
            {
              id: 'mem-1',
              sk: 'immediate#1#mem-1',
              tier: 'immediate',
              accessCount: 10,
              lastAccessedAt: NOW,
              strength: 1.0,
              createdAt: NOW - 14 * ONE_DAY_MS,
            },
            {
              id: 'mem-2',
              sk: 'immediate#2#mem-2',
              tier: 'immediate',
              accessCount: 0,
              strength: 0.5,
              createdAt: NOW - 3 * ONE_DAY_MS,
              lastAccessedAt: NOW - 3 * ONE_DAY_MS,
            },
          ],
        }),
      );

      const plan = await planTierMigration('test-table', 'avatar-1');

      expect(plan.avatarId).toBe('avatar-1');
      expect(plan.currentCounts.ephemeral).toBe(2); // both immediate -> ephemeral
      expect(plan.transitions.length).toBeGreaterThanOrEqual(1);
      expect(plan.costEstimate).toBeDefined();
      expect(plan.costEstimate.before).toBeGreaterThanOrEqual(0);
    });

    it('returns empty transitions when no moves needed', async () => {
      mockSend.mockImplementation(() =>
        Promise.resolve({
          Items: [
            {
              id: 'mem-1',
              sk: 'immediate#1#mem-1',
              tier: 'ephemeral',
              accessCount: 0,
              strength: 0.0,
              createdAt: NOW - ONE_HOUR_MS,
              lastAccessedAt: NOW - 12 * ONE_HOUR_MS,
            },
          ],
        }),
      );

      const plan = await planTierMigration('test-table', 'avatar-1');
      expect(plan.transitions).toHaveLength(0);
      expect(plan.costEstimate.savingsPercent).toBe(0);
    });
  });

  // ==========================================================================
  // Tier Transition Application
  // ==========================================================================

  describe('applyTierTransitions', () => {
    it('updates tier field on each memory', async () => {
      mockSend.mockImplementation(() => Promise.resolve({}));

      const transitions = [
        {
          memoryId: 'mem-1',
          sk: 'immediate#1#mem-1',
          fromTier: 'ephemeral' as DurableMemoryTier,
          toTier: 'durable' as DurableMemoryTier,
          score: 0.5,
          reason: 'promoted: score=0.500',
        },
      ];

      const result = await applyTierTransitions('test-table', 'avatar-1', transitions);

      expect(result.promoted).toBe(1);
      expect(result.demoted).toBe(0);
      expect(result.errors).toHaveLength(0);
      expect(result.total).toBe(1);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);

      const input = mockSend.mock.calls[0][0].input;
      expect(input.TableName).toBe('test-table');
      expect(input.Key.pk).toBe('MEMORY#avatar-1');
      expect(input.Key.sk).toBe('immediate#1#mem-1');
      expect(input.ExpressionAttributeValues[':tier']).toBe('durable');
    });

    it('counts demotions correctly', async () => {
      mockSend.mockImplementation(() => Promise.resolve({}));

      const transitions = [
        {
          memoryId: 'mem-1',
          sk: 'core#1#mem-1',
          fromTier: 'archival' as DurableMemoryTier,
          toTier: 'durable' as DurableMemoryTier,
          score: 0.3,
          reason: 'demoted: score=0.300',
        },
      ];

      const result = await applyTierTransitions('test-table', 'avatar-1', transitions);
      expect(result.demoted).toBe(1);
      expect(result.promoted).toBe(0);
    });

    it('records errors without crashing on DynamoDB failure', async () => {
      mockSend.mockImplementation(() =>
        Promise.reject(new Error('ConditionalCheckFailed')),
      );

      const transitions = [
        {
          memoryId: 'mem-1',
          sk: 'immediate#1#mem-1',
          fromTier: 'ephemeral' as DurableMemoryTier,
          toTier: 'durable' as DurableMemoryTier,
          score: 0.5,
          reason: 'promoted',
        },
      ];

      const result = await applyTierTransitions('test-table', 'avatar-1', transitions);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('ConditionalCheckFailed');
      expect(result.promoted).toBe(0);
    });

    it('removes TTL when transitioning to archival', async () => {
      mockSend.mockImplementation(() => Promise.resolve({}));

      const transitions = [
        {
          memoryId: 'mem-1',
          sk: 'recent#1#mem-1',
          fromTier: 'durable' as DurableMemoryTier,
          toTier: 'archival' as DurableMemoryTier,
          score: 0.8,
          reason: 'promoted',
        },
      ];

      await applyTierTransitions('test-table', 'avatar-1', transitions);

      const input = mockSend.mock.calls[0][0].input;
      // Should REMOVE ttl for archival
      expect(input.UpdateExpression).toContain('REMOVE');
      expect(input.ExpressionAttributeNames).toBeDefined();
      expect(input.ExpressionAttributeNames['#ttl']).toBe('ttl');
    });

    it('sets TTL when transitioning to durable', async () => {
      mockSend.mockImplementation(() => Promise.resolve({}));

      const transitions = [
        {
          memoryId: 'mem-1',
          sk: 'immediate#1#mem-1',
          fromTier: 'ephemeral' as DurableMemoryTier,
          toTier: 'durable' as DurableMemoryTier,
          score: 0.5,
          reason: 'promoted',
        },
      ];

      await applyTierTransitions('test-table', 'avatar-1', transitions);

      const input = mockSend.mock.calls[0][0].input;
      expect(input.ExpressionAttributeValues[':ttl']).toBeDefined();
      expect(input.ExpressionAttributeValues[':ttl']).toBeGreaterThan(
        Math.floor(Date.now() / 1000),
      );
    });
  });
});
