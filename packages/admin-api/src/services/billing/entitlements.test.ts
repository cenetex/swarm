/**
 * Entitlements Service Tests
 */
import { describe, it, expect } from 'vitest';
import {
  PLAN_DEFAULTS,
  type PlanType,
  type PlanLimits,
} from '../../types.js';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Re-implement computeEffectiveLimits for testing (avoid DynamoDB dependencies)
function testComputeEffectiveLimits(
  plan: PlanType,
  overrides?: Partial<PlanLimits>
): PlanLimits {
  const defaults = PLAN_DEFAULTS[plan];
  if (!overrides) return { ...defaults };
  return { ...defaults, ...overrides };
}

describe('Entitlements', () => {
  describe('PLAN_DEFAULTS', () => {
    it('should have free tier with memory disabled', () => {
      const free = PLAN_DEFAULTS.free;
      expect(free.memoryEnabled).toBe(false);
      expect(free.memoryRetentionDays).toBe(0);
      expect(free.dailyMessageLimit).toBe(50);
      expect(free.dailyMediaCredits).toBe(5);
    });

    it('should have pro tier with memory enabled', () => {
      const pro = PLAN_DEFAULTS.pro;
      expect(pro.memoryEnabled).toBe(true);
      expect(pro.memoryRetentionDays).toBe(30);
      expect(pro.dailyMessageLimit).toBe(500);
      expect(pro.dailyMediaCredits).toBe(50);
    });

    it('should have enterprise tier with high-volume limits', () => {
      const enterprise = PLAN_DEFAULTS.enterprise;
      expect(enterprise.memoryEnabled).toBe(true);
      expect(enterprise.memoryRetentionDays).toBe(365);
      expect(enterprise.dailyMessageLimit).toBe(5000);
      expect(enterprise.dailyMediaCredits).toBe(500);
      expect(enterprise.maxPlatforms).toBe(10);
      expect(enterprise.maxChannels).toBe(50);
      expect(enterprise.priorityProcessing).toBe(true);
    });
  });

  describe('computeEffectiveLimits', () => {
    it('should return plan defaults when no overrides', () => {
      const limits = testComputeEffectiveLimits('free');
      expect(limits).toEqual(PLAN_DEFAULTS.free);
    });

    it('should merge overrides with plan defaults', () => {
      const limits = testComputeEffectiveLimits('free', {
        dailyMessageLimit: 100,
        dailyMediaCredits: 10,
      });

      expect(limits.dailyMessageLimit).toBe(100);
      expect(limits.dailyMediaCredits).toBe(10);
      // Other defaults should remain
      expect(limits.memoryEnabled).toBe(false);
      expect(limits.maxToolCallsPerMessage).toBe(3);
    });

    it('should allow enabling memory on free tier via override', () => {
      const limits = testComputeEffectiveLimits('free', {
        memoryEnabled: true,
        memoryRetentionDays: 7,
      });

      expect(limits.memoryEnabled).toBe(true);
      expect(limits.memoryRetentionDays).toBe(7);
    });

    it('should allow downgrading pro limits via override', () => {
      const limits = testComputeEffectiveLimits('pro', {
        dailyMessageLimit: 100, // Lower than default 500
      });

      expect(limits.dailyMessageLimit).toBe(100);
      expect(limits.memoryEnabled).toBe(true); // Still pro default
    });
  });

  describe('PlanLimits schema', () => {
    it('should have all required fields in free tier', () => {
      const free = PLAN_DEFAULTS.free;
      expect(typeof free.memoryEnabled).toBe('boolean');
      expect(typeof free.memoryRetentionDays).toBe('number');
      expect(typeof free.maxMemoriesPerTier).toBe('number');
      expect(typeof free.dailyMessageLimit).toBe('number');
      expect(typeof free.dailyMediaCredits).toBe('number');
      expect(typeof free.dailyVoiceMinutes).toBe('number');
      expect(typeof free.maxToolCallsPerMessage).toBe('number');
      expect(typeof free.maxPlatforms).toBe('number');
      expect(typeof free.maxChannels).toBe('number');
      expect(typeof free.autonomousPostsEnabled).toBe('boolean');
      expect(typeof free.customModelEnabled).toBe('boolean');
      expect(typeof free.priorityProcessing).toBe('boolean');
    });
  });
});

describe('MemoryConfig', () => {
  it('should derive memory config from free tier', () => {
    const limits = PLAN_DEFAULTS.free;
    const memoryConfig = {
      enabled: limits.memoryEnabled,
      retentionDays: limits.memoryRetentionDays,
      consolidationEnabled: limits.memoryEnabled,
      semanticSearchEnabled: limits.memoryEnabled,
    };

    expect(memoryConfig.enabled).toBe(false);
    expect(memoryConfig.retentionDays).toBe(0);
    expect(memoryConfig.consolidationEnabled).toBe(false);
    expect(memoryConfig.semanticSearchEnabled).toBe(false);
  });

  it('should derive memory config from pro tier', () => {
    const limits = PLAN_DEFAULTS.pro;
    const memoryConfig = {
      enabled: limits.memoryEnabled,
      retentionDays: limits.memoryRetentionDays,
      consolidationEnabled: limits.memoryEnabled,
      semanticSearchEnabled: limits.memoryEnabled,
    };

    expect(memoryConfig.enabled).toBe(true);
    expect(memoryConfig.retentionDays).toBe(30);
    expect(memoryConfig.consolidationEnabled).toBe(true);
    expect(memoryConfig.semanticSearchEnabled).toBe(true);
  });
});

// ============================================================================
// GSI1 Query Key Schema Tests (issue #168)
//
// The getEntitlement() function queries GSI1 which is an inverted index
// (partition key = sk, sort key = pk). The old code incorrectly used
// 'gsi1pk'/'gsi1sk' as key condition attributes, which caused
// "Query condition missed key schema element: sk" in production.
//
// These tests verify the source code directly to ensure the query uses
// the correct key attribute names matching the deployed GSI1 schema.
// ============================================================================

describe('getEntitlement - GSI1 key schema (issue #168)', () => {
  // Read the actual entitlements.ts source to verify the query structure.
  // This avoids module-mock interference from other test files (bun mock persistence).
  const src = readFileSync(resolve(__dirname, 'entitlements.ts'), 'utf-8');

  it('should use IndexName GSI1', () => {
    expect(src).toContain("IndexName: 'GSI1'");
  });

  it('should query using sk (GSI1 partition key) not gsi1pk', () => {
    // The key condition must reference 'sk' -- the actual GSI1 partition key
    expect(src).toContain("'sk = :sk AND begins_with(pk, :pkPrefix)'");
  });

  it('should NOT use gsi1pk or gsi1sk as key condition attributes', () => {
    // Extract only the getEntitlement function body to check key expressions
    const fnMatch = src.match(/export async function getEntitlement[\s\S]*?^}/m);
    expect(fnMatch).not.toBeNull();

    const fnBody = fnMatch![0];
    // The KeyConditionExpression should not reference gsi1pk or gsi1sk
    expect(fnBody).not.toMatch(/KeyConditionExpression.*gsi1pk/);
    expect(fnBody).not.toMatch(/KeyConditionExpression.*gsi1sk/);
  });

  it('should set :sk to AVATAR#<avatarId>', () => {
    // Verify the expression attribute value binds correctly
    expect(src).toContain("':sk': `AVATAR#${avatarId}`");
  });

  it('should set :pkPrefix to ENTITLEMENT#', () => {
    expect(src).toContain("':pkPrefix': 'ENTITLEMENT#'");
  });
});

// ============================================================================
// findEntitlementByStripeSubscriptionId - GSI query (issue #418)
//
// Replaced the O(table-size) Scan with a Query on the sparse
// StripeSubscriptionIndex GSI keyed on stripeSubscriptionId.
// ============================================================================

describe('findEntitlementByStripeSubscriptionId - GSI query (issue #418)', () => {
  const src = readFileSync(resolve(__dirname, 'entitlements.ts'), 'utf-8');

  // Extract only the findEntitlementByStripeSubscriptionId function body
  const fnMatch = src.match(
    /export async function findEntitlementByStripeSubscriptionId[\s\S]*?^}/m
  );
  const fnBody = fnMatch?.[0] ?? '';

  it('should exist', () => {
    expect(fnMatch).not.toBeNull();
  });

  it('should use QueryCommand instead of ScanCommand', () => {
    expect(fnBody).toContain('QueryCommand');
    expect(fnBody).not.toContain('ScanCommand');
  });

  it('should query the StripeSubscriptionIndex GSI', () => {
    expect(fnBody).toContain("IndexName: 'StripeSubscriptionIndex'");
  });

  it('should use stripeSubscriptionId as key condition', () => {
    expect(fnBody).toContain(
      "KeyConditionExpression: 'stripeSubscriptionId = :subscriptionId'"
    );
  });

  it('should bind the subscription ID parameter', () => {
    expect(fnBody).toContain("':subscriptionId': stripeSubscriptionId");
  });

  it('should limit results to 1', () => {
    expect(fnBody).toContain('Limit: 1');
  });

  it('should not import ScanCommand', () => {
    // Verify ScanCommand is no longer imported since it is no longer used
    const importBlock = src.match(
      /import \{[\s\S]*?\} from ['"]@aws-sdk\/lib-dynamodb['"]/
    );
    expect(importBlock).not.toBeNull();
    expect(importBlock![0]).not.toContain('ScanCommand');
  });

  it('should not perform paginated scanning', () => {
    // The old implementation used lastEvaluatedKey for pagination
    expect(fnBody).not.toContain('lastEvaluatedKey');
    expect(fnBody).not.toContain('LastEvaluatedKey');
    expect(fnBody).not.toContain('ExclusiveStartKey');
  });

  it('should return null when no items match', () => {
    // Verify the null return path exists
    expect(fnBody).toContain('return null');
  });

  it('should return the first matching item as EntitlementRecord', () => {
    expect(fnBody).toContain('result.Items[0] as EntitlementRecord');
  });
});

describe('checkLimit - graceful error handling (issue #168)', () => {
  // Verify that checkLimit wraps getEntitlement in a try/catch so that
  // DynamoDB errors degrade gracefully to free-tier defaults.
  const src = readFileSync(resolve(__dirname, 'entitlements.ts'), 'utf-8');

  it('should wrap getEntitlement in try/catch', () => {
    // The checkLimit function should have a try/catch around getEntitlement
    const fnMatch = src.match(/export async function checkLimit[\s\S]*?^}/m);
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch![0];

    expect(fnBody).toContain('try {');
    expect(fnBody).toContain('catch (err)');
    expect(fnBody).toContain('getEntitlement(avatarId)');
  });

  it('should log the error with avatarId context', () => {
    const fnMatch = src.match(/export async function checkLimit[\s\S]*?^}/m);
    const fnBody = fnMatch![0];

    expect(fnBody).toContain('console.error');
    expect(fnBody).toContain('falling back to free tier');
  });

  it('should fall back to free tier limits after error', () => {
    const fnMatch = src.match(/export async function checkLimit[\s\S]*?^}/m);
    const fnBody = fnMatch![0];

    // After the try/catch, entitlement may be null, and the code should
    // use PLAN_DEFAULTS.free as fallback
    expect(fnBody).toContain('entitlement?.limits || PLAN_DEFAULTS.free');
  });

  it('should emit an EntitlementFallback EMF metric on failure (issue #232)', () => {
    const fnMatch = src.match(/export async function checkLimit[\s\S]*?^}/m);
    const fnBody = fnMatch![0];

    // The catch block should call emitMetric to publish a CloudWatch metric
    expect(fnBody).toContain("emitMetric('Entitlements', 'EntitlementFallback', 1, 'Count')");
  });
});
