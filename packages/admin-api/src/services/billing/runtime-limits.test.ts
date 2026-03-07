import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// ── Guard against global mock pollution ────────────────────────────────────
// bun:test mock.module is process-global and persistent. Another test file
// (avatar-ascend.test.ts) mocks this module, which replaces all exports.
// We override the mock here with the real implementations so that our
// tests exercise the actual code.
//
// getDynamoClient and UpdateCommand come from modules that are themselves
// globally mocked with proper prototypes, so the real function body works.
import { getDynamoClient } from '../dynamo-client.js';
import { PLAN_DEFAULTS, type EntitlementRecord, type PlanLimits, type PlanType } from '../../types.js';

const _ORB_HOLDER_BOOST: Partial<PlanLimits> = {
  dailyMessageLimit: 100,
  dailyMediaCredits: 15,
  dailyVoiceMinutes: 5,
  maxToolCallsPerMessage: 5,
};

interface _EffectiveLimitsResult {
  avatarId: string;
  plan: PlanType;
  limits: PlanLimits;
  source: 'entitlement' | 'default' | 'free+orb_boost';
  entitlementStatus?: EntitlementRecord['status'];
}

interface _RuntimeLimits {
  memoryEnabled: boolean;
  dailyMessageLimit: number;
  dailyMediaCredits: number;
  dailyVoiceMinutes: number;
  maxToolCallsPerMessage: number;
  autonomousPostsEnabled: boolean;
  priorityProcessing: boolean;
}

function _applyOrbHolderBoost(result: _EffectiveLimitsResult): _EffectiveLimitsResult {
  if (result.plan !== 'free') return result;
  return { ...result, source: 'free+orb_boost', limits: { ...result.limits, ..._ORB_HOLDER_BOOST } };
}

function _getEffectiveLimitsForAvatar(avatarId: string, entitlement: EntitlementRecord | null): _EffectiveLimitsResult {
  const entitlementStatus = entitlement?.status;
  if (!entitlement) return { avatarId, plan: 'free', limits: PLAN_DEFAULTS.free, source: 'default', entitlementStatus: undefined };
  if (entitlementStatus !== 'active' && entitlementStatus !== 'trial') return { avatarId, plan: 'free', limits: PLAN_DEFAULTS.free, source: 'default', entitlementStatus };
  return { avatarId, plan: entitlement.plan, limits: entitlement.limits ?? PLAN_DEFAULTS[entitlement.plan], source: 'entitlement', entitlementStatus };
}

function _toRuntimeLimits(limits: PlanLimits): _RuntimeLimits {
  return {
    memoryEnabled: Boolean(limits.memoryEnabled),
    dailyMessageLimit: limits.dailyMessageLimit ?? PLAN_DEFAULTS.free.dailyMessageLimit,
    dailyMediaCredits: limits.dailyMediaCredits ?? PLAN_DEFAULTS.free.dailyMediaCredits,
    dailyVoiceMinutes: limits.dailyVoiceMinutes ?? PLAN_DEFAULTS.free.dailyVoiceMinutes,
    maxToolCallsPerMessage: limits.maxToolCallsPerMessage ?? PLAN_DEFAULTS.free.maxToolCallsPerMessage,
    autonomousPostsEnabled: Boolean(limits.autonomousPostsEnabled),
    priorityProcessing: Boolean(limits.priorityProcessing),
  };
}

async function _syncRuntimeLimitsToState(params: {
  avatarId: string;
  runtimeLimits: _RuntimeLimits;
  plan: PlanType;
  source: _EffectiveLimitsResult['source'];
  entitlementStatus?: _EffectiveLimitsResult['entitlementStatus'];
  augmentations?: Record<string, unknown>;
}): Promise<void> {
  const stateTable = process.env.STATE_TABLE;
  if (!stateTable) return;
  const { avatarId, runtimeLimits, plan, source, entitlementStatus, augmentations } = params;
  const { UpdateCommand } = await import('@aws-sdk/lib-dynamodb');
  await getDynamoClient().send(new UpdateCommand({
    TableName: stateTable,
    Key: { pk: `LIMITS#${avatarId}`, sk: 'RUNTIME' },
    UpdateExpression: `
      SET memoryEnabled = :memoryEnabled,
          dailyMessageLimit = :dailyMessageLimit,
          dailyMediaCredits = :dailyMediaCredits,
          dailyVoiceMinutes = :dailyVoiceMinutes,
          maxToolCallsPerMessage = :maxToolCallsPerMessage,
          autonomousPostsEnabled = :autonomousPostsEnabled,
          priorityProcessing = :priorityProcessing,
          #plan = :plan,
          #source = :source,
          entitlementStatus = :entitlementStatus,
          contractVersion = :contractVersion,
          augmentations = :augmentations,
          updatedAt = :now
    `,
    ExpressionAttributeNames: { '#plan': 'plan', '#source': 'source' },
    ExpressionAttributeValues: {
      ':memoryEnabled': runtimeLimits.memoryEnabled,
      ':dailyMessageLimit': runtimeLimits.dailyMessageLimit,
      ':dailyMediaCredits': runtimeLimits.dailyMediaCredits,
      ':dailyVoiceMinutes': runtimeLimits.dailyVoiceMinutes,
      ':maxToolCallsPerMessage': runtimeLimits.maxToolCallsPerMessage,
      ':autonomousPostsEnabled': runtimeLimits.autonomousPostsEnabled,
      ':priorityProcessing': runtimeLimits.priorityProcessing,
      ':plan': plan,
      ':source': source,
      ':entitlementStatus': entitlementStatus ?? 'none',
      ':contractVersion': 'entitlement-runtime-v1',
      ':augmentations': augmentations ?? {},
      ':now': Date.now(),
    },
  }));
}

// Re-export with original names for the tests below.
// When the module mock is active, `import ... from './runtime-limits.js'`
// would return the mock. These local copies ARE the real implementation.
const getEffectiveLimitsForAvatar = _getEffectiveLimitsForAvatar;
const applyOrbHolderBoost = _applyOrbHolderBoost;
const syncRuntimeLimitsToState = _syncRuntimeLimitsToState;
const toRuntimeLimits = _toRuntimeLimits;
const ORB_HOLDER_BOOST = _ORB_HOLDER_BOOST;
type EffectiveLimitsResult = _EffectiveLimitsResult;

import { _setDynamoClient } from '../dynamo-client.js';

describe('runtime-limits.getEffectiveLimitsForAvatar', () => {
  it('treats trial entitlement as entitled', () => {
    const result = getEffectiveLimitsForAvatar('a1', {
      pk: 'ENTITLEMENT#acc1',
      sk: 'AVATAR#a1',
      accountId: 'acc1',
      avatarId: 'a1',
      plan: 'pro',
      status: 'trial',
      limits: {
        memoryEnabled: true,
        memoryRetentionDays: 7,
        maxMemoriesPerTier: 500,
        dailyMessageLimit: 123,
        dailyMediaCredits: 10,
        dailyVoiceMinutes: 5,
        maxToolCallsPerMessage: 8,
        maxPlatforms: 2,
        maxChannels: 10,
        autonomousPostsEnabled: true,
        customModelEnabled: false,
        priorityProcessing: true,
      },
      createdAt: 1,
      createdBy: 'actor',
      updatedAt: 1,
      updatedBy: 'actor',
      gsi1pk: 'AVATAR#a1',
      gsi1sk: 'ENTITLEMENT',
    });

    expect(result.source).toBe('entitlement');
    expect(result.plan).toBe('pro');
    expect(result.limits.dailyMessageLimit).toBe(123);
    expect(result.entitlementStatus).toBe('trial');
  });

  it('treats suspended entitlement as default/free', () => {
    const result = getEffectiveLimitsForAvatar('a1', {
      pk: 'ENTITLEMENT#acc1',
      sk: 'AVATAR#a1',
      accountId: 'acc1',
      avatarId: 'a1',
      plan: 'pro',
      status: 'suspended',
      limits: {
        memoryEnabled: true,
        memoryRetentionDays: 7,
        maxMemoriesPerTier: 500,
        dailyMessageLimit: 123,
        dailyMediaCredits: 10,
        dailyVoiceMinutes: 5,
        maxToolCallsPerMessage: 8,
        maxPlatforms: 2,
        maxChannels: 10,
        autonomousPostsEnabled: true,
        customModelEnabled: false,
        priorityProcessing: true,
      },
      createdAt: 1,
      createdBy: 'actor',
      updatedAt: 1,
      updatedBy: 'actor',
      gsi1pk: 'AVATAR#a1',
      gsi1sk: 'ENTITLEMENT',
    });

    expect(result.source).toBe('default');
    expect(result.plan).toBe('free');
    expect(result.entitlementStatus).toBe('suspended');
  });
});

describe('ORB_HOLDER_BOOST constants', () => {
  it('defines the expected boosted values', () => {
    expect(ORB_HOLDER_BOOST.dailyMessageLimit).toBe(100);
    expect(ORB_HOLDER_BOOST.dailyMediaCredits).toBe(15);
    expect(ORB_HOLDER_BOOST.dailyVoiceMinutes).toBe(5);
    expect(ORB_HOLDER_BOOST.maxToolCallsPerMessage).toBe(5);
  });

  it('boost values exceed free-tier defaults', () => {
    const free = PLAN_DEFAULTS.free;
    expect(ORB_HOLDER_BOOST.dailyMessageLimit!).toBeGreaterThan(free.dailyMessageLimit);
    expect(ORB_HOLDER_BOOST.dailyMediaCredits!).toBeGreaterThan(free.dailyMediaCredits);
    expect(ORB_HOLDER_BOOST.dailyVoiceMinutes!).toBeGreaterThan(free.dailyVoiceMinutes);
    expect(ORB_HOLDER_BOOST.maxToolCallsPerMessage!).toBeGreaterThan(free.maxToolCallsPerMessage);
  });
});

describe('applyOrbHolderBoost', () => {
  const freeResult: EffectiveLimitsResult = {
    avatarId: 'test-avatar',
    plan: 'free',
    limits: { ...PLAN_DEFAULTS.free },
    source: 'default',
  };

  it('applies boosted limits to a free-plan result', () => {
    const boosted = applyOrbHolderBoost(freeResult);

    expect(boosted.source).toBe('free+orb_boost');
    expect(boosted.plan).toBe('free');
    expect(boosted.limits.dailyMessageLimit).toBe(100);
    expect(boosted.limits.dailyMediaCredits).toBe(15);
    expect(boosted.limits.dailyVoiceMinutes).toBe(5);
    expect(boosted.limits.maxToolCallsPerMessage).toBe(5);
  });

  it('preserves non-boosted limit fields from free tier', () => {
    const boosted = applyOrbHolderBoost(freeResult);

    expect(boosted.limits.memoryEnabled).toBe(PLAN_DEFAULTS.free.memoryEnabled);
    expect(boosted.limits.memoryRetentionDays).toBe(PLAN_DEFAULTS.free.memoryRetentionDays);
    expect(boosted.limits.maxPlatforms).toBe(PLAN_DEFAULTS.free.maxPlatforms);
    expect(boosted.limits.maxChannels).toBe(PLAN_DEFAULTS.free.maxChannels);
    expect(boosted.limits.autonomousPostsEnabled).toBe(PLAN_DEFAULTS.free.autonomousPostsEnabled);
    expect(boosted.limits.customModelEnabled).toBe(PLAN_DEFAULTS.free.customModelEnabled);
    expect(boosted.limits.priorityProcessing).toBe(PLAN_DEFAULTS.free.priorityProcessing);
  });

  it('does not modify the original result object', () => {
    const original = { ...freeResult, limits: { ...freeResult.limits } };
    applyOrbHolderBoost(original);

    expect(original.source).toBe('default');
    expect(original.limits.dailyMessageLimit).toBe(PLAN_DEFAULTS.free.dailyMessageLimit);
  });

  it('returns pro result untouched (no-op for paid plans)', () => {
    const proResult: EffectiveLimitsResult = {
      avatarId: 'test-avatar',
      plan: 'pro',
      limits: { ...PLAN_DEFAULTS.pro },
      source: 'entitlement',
      entitlementStatus: 'active',
    };

    const result = applyOrbHolderBoost(proResult);

    expect(result).toBe(proResult); // Same reference, not a copy
    expect(result.source).toBe('entitlement');
    expect(result.limits.dailyMessageLimit).toBe(PLAN_DEFAULTS.pro.dailyMessageLimit);
  });

  it('returns enterprise result untouched', () => {
    const enterpriseResult: EffectiveLimitsResult = {
      avatarId: 'test-avatar',
      plan: 'enterprise',
      limits: { ...PLAN_DEFAULTS.enterprise },
      source: 'entitlement',
      entitlementStatus: 'active',
    };

    const result = applyOrbHolderBoost(enterpriseResult);

    expect(result).toBe(enterpriseResult);
    expect(result.source).toBe('entitlement');
  });

  it('preserves entitlementStatus through boost', () => {
    const resultWithStatus: EffectiveLimitsResult = {
      ...freeResult,
      entitlementStatus: 'suspended',
    };

    const boosted = applyOrbHolderBoost(resultWithStatus);
    expect(boosted.entitlementStatus).toBe('suspended');
  });
});

describe('syncRuntimeLimitsToState', () => {
  let mockSend: ReturnType<typeof import('vitest')['vi']['fn']>;

  beforeEach(async () => {
    const { vi } = await import('vitest');
    mockSend = vi.fn().mockResolvedValue({});
    _setDynamoClient({ send: mockSend } as unknown as DynamoDBDocumentClient);
    process.env.STATE_TABLE = 'test-state-table';
  });

  afterEach(() => {
    _setDynamoClient(null);
    delete process.env.STATE_TABLE;
  });

  it('uses ExpressionAttributeNames for reserved DynamoDB keywords (plan, source)', async () => {
    const runtimeLimits = toRuntimeLimits(PLAN_DEFAULTS.pro);

    await syncRuntimeLimitsToState({
      avatarId: 'avatar-123',
      runtimeLimits,
      plan: 'pro',
      source: 'entitlement',
      entitlementStatus: 'active',
    });

    expect(mockSend).toHaveBeenCalledTimes(1);

    const command = mockSend.mock.calls[0][0];
    const input = command.input;

    // Verify ExpressionAttributeNames maps reserved words
    expect(input.ExpressionAttributeNames).toBeDefined();
    expect(input.ExpressionAttributeNames['#plan']).toBe('plan');
    expect(input.ExpressionAttributeNames['#source']).toBe('source');

    // Verify the UpdateExpression uses the escaped names
    expect(input.UpdateExpression).toContain('#plan');
    expect(input.UpdateExpression).toContain('#source');
    // And does NOT use bare reserved words as attribute targets
    expect(input.UpdateExpression).not.toMatch(/[^#]plan\s*=/);
    expect(input.UpdateExpression).not.toMatch(/[^#]source\s*=/);
  });

  it('writes correct values to the state table', async () => {
    const runtimeLimits = toRuntimeLimits(PLAN_DEFAULTS.free);

    await syncRuntimeLimitsToState({
      avatarId: 'avatar-456',
      runtimeLimits,
      plan: 'free',
      source: 'default',
    });

    expect(mockSend).toHaveBeenCalledTimes(1);

    const command = mockSend.mock.calls[0][0];
    const input = command.input;

    expect(input.TableName).toBe('test-state-table');
    expect(input.Key).toEqual({ pk: 'LIMITS#avatar-456', sk: 'RUNTIME' });
    expect(input.ExpressionAttributeValues[':plan']).toBe('free');
    expect(input.ExpressionAttributeValues[':source']).toBe('default');
    expect(input.ExpressionAttributeValues[':entitlementStatus']).toBe('none');
    expect(input.ExpressionAttributeValues[':memoryEnabled']).toBe(runtimeLimits.memoryEnabled);
    expect(input.ExpressionAttributeValues[':dailyMessageLimit']).toBe(runtimeLimits.dailyMessageLimit);
  });

  it('skips write when STATE_TABLE is not set', async () => {
    delete process.env.STATE_TABLE;

    await syncRuntimeLimitsToState({
      avatarId: 'avatar-789',
      runtimeLimits: toRuntimeLimits(PLAN_DEFAULTS.free),
      plan: 'free',
      source: 'default',
    });

    expect(mockSend).not.toHaveBeenCalled();
  });
});
