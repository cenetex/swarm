/**
 * Avatar Ascension Entitlement Tests
 *
 * Verifies that ascension grants Pro-equivalent entitlements and
 * respects the plan hierarchy (no downgrade from enterprise).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PLAN_DEFAULTS, type EntitlementRecord, type PlanLimits } from '../types.js';

// ── Mock state ─────────────────────────────────────────────────────────────
let mockGetEntitlementResult: EntitlementRecord | null = null;
let mockSetEntitlementCalls: Array<Record<string, unknown>> = [];
let mockSyncCalls: Array<Record<string, unknown>> = [];

// ── Mock modules ───────────────────────────────────────────────────────────
vi.mock('./billing/entitlements.js', () => ({
  getEntitlement: async () => mockGetEntitlementResult,
  setEntitlement: async (params: Record<string, unknown>) => {
    mockSetEntitlementCalls.push(params);
    const plan = params.plan as string;
    return {
      pk: `ENTITLEMENT#${params.accountId}`,
      sk: `AVATAR#${params.avatarId}`,
      accountId: params.accountId,
      avatarId: params.avatarId,
      plan,
      limits: PLAN_DEFAULTS[plan as keyof typeof PLAN_DEFAULTS],
      status: params.status ?? 'active',
      entitlementSource: params.entitlementSource,
      createdAt: Date.now(),
      createdBy: params.actorId,
      updatedAt: Date.now(),
      updatedBy: params.actorId,
      gsi1pk: `AVATAR#${params.avatarId}`,
      gsi1sk: 'ENTITLEMENT',
    } as EntitlementRecord;
  },
}));

// IMPORTANT: bun:test mock.module is process-global and persistent.
// This mock MUST provide every named export from runtime-limits.js that
// any other test file might import, or those files will get
// "Export named '...' not found" errors.
vi.mock('./billing/runtime-limits.js', () => ({
  ORB_HOLDER_BOOST: {
    dailyMessageLimit: 100,
    dailyMediaCredits: 15,
    dailyVoiceMinutes: 5,
    maxToolCallsPerMessage: 5,
  },
  applyOrbHolderBoost: (result: { plan: string; limits: Record<string, unknown>; source: string }) => {
    if (result.plan !== 'free') return result;
    return {
      ...result,
      source: 'free+orb_boost',
      limits: {
        ...result.limits,
        dailyMessageLimit: 100,
        dailyMediaCredits: 15,
        dailyVoiceMinutes: 5,
        maxToolCallsPerMessage: 5,
      },
    };
  },
  getEffectiveLimitsForAvatar: (_avatarId: string, entitlement: EntitlementRecord | null) => {
    const entitlementStatus = entitlement?.status;
    if (!entitlement || (entitlementStatus !== 'active' && entitlementStatus !== 'trial')) {
      return {
        avatarId: _avatarId,
        plan: 'free',
        limits: PLAN_DEFAULTS.free,
        source: 'default',
        entitlementStatus,
      };
    }
    return {
      avatarId: _avatarId,
      plan: entitlement.plan,
      limits: entitlement.limits ?? PLAN_DEFAULTS[entitlement.plan],
      source: 'entitlement',
      entitlementStatus,
    };
  },
  toRuntimeLimits: (limits: PlanLimits) => ({
    memoryEnabled: limits.memoryEnabled,
    dailyMessageLimit: limits.dailyMessageLimit,
    dailyMediaCredits: limits.dailyMediaCredits,
    dailyVoiceMinutes: limits.dailyVoiceMinutes,
    maxToolCallsPerMessage: limits.maxToolCallsPerMessage,
    autonomousPostsEnabled: limits.autonomousPostsEnabled,
    priorityProcessing: limits.priorityProcessing,
  }),
  syncRuntimeLimitsToState: async (params: Record<string, unknown>) => {
    mockSyncCalls.push(params);
  },
}));

// Mock burn-stats (needed by avatar-ascend module-level imports)
vi.mock('./web3/burn-stats.js', () => ({
  getBurnStats: async () => ({ totalBurned: 0, tier: 0, tierName: 'Spark' }),
}));

// Mock @solana/web3.js Connection + PublicKey (needed by avatar-ascend module-level init).
// IMPORTANT: bun:test mock.module is process-global and persistent. This mock
// MUST provide every export that any other test file might import from
// @solana/web3.js, or those tests will break.
vi.mock('@solana/web3.js', () => ({
  Connection: class {
    constructor() {}
    async getParsedTokenAccountsByOwner() { return { value: [] }; }
  },
  PublicKey: class {
    constructor(public readonly _key: string) {}
    toString() { return this._key; }
    toBase58() { return this._key; }
  },
}));

// Mock @aws-sdk DynamoDB (needed by avatar-ascend module-level init).
// IMPORTANT: mock classes must have `send` on the prototype so that
// vi.spyOn(DynamoDBClient.prototype, 'send') in later test files still works
// (bun:test mock.module is process-global and persistent).
vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: class MockDynamoDBClient {
    constructor() {}
    async send(_command: unknown) { return {}; }
  },
}));

vi.mock('@aws-sdk/lib-dynamodb', () => {
  class MockDynamoDBDocumentClient {
    static from() { return new MockDynamoDBDocumentClient(); }
    async send(_command: unknown) { return {}; }
  }
  return {
    DynamoDBDocumentClient: MockDynamoDBDocumentClient,
    GetCommand: class { constructor(public input: unknown) {} },
    UpdateCommand: class { constructor(public input: unknown) {} },
    PutCommand: class { constructor(public input: unknown) {} },
  };
});

// IMPORTANT: bun:test mock.module is process-global and persistent. This @swarm/core
// mock MUST provide every export that any other test file might import, or those
// tests will break. We use a Proxy as the base so unknown properties return safe
// defaults instead of undefined.
const noopFn = () => {};
const noopLogger = { debug: noopFn, info: noopFn, warn: noopFn, error: noopFn, child: () => noopLogger };
const coreOverrides: Record<string, unknown> = {
  RATI_MINT: 'mock-rati-mint',
  GATE_COLLECTION: 'mock-gate-collection',
  ASCENSION_ENERGY_BOOST: { maxEnergyMultiplier: 1.5, regenRateMultiplier: 1.5 },
  getAscensionCost: () => ({ currentTier: { tier: 0, name: 'Spark' }, ratiBurnRequired: 100 }),
  getTierForBurnAmount: () => ({ tier: 0, name: 'Spark' }),
  getNextTier: () => ({ tier: 1, name: 'Ember', requiredBurn: 1000 }),
  logger: noopLogger,
  buildMediaUrl: noopFn,
  canonicalizeMediaUrl: noopFn,
  validateEnv: noopFn,
  HandlerEnvSchema: {},
  DEFAULT_AVATAR_CONFIG: {},
  DEFAULT_LLM_MODEL: 'openrouter/auto',
  extractCorrelationIdFromSqsRecord: () => undefined,
  createContentStoreService: noopFn,
  enqueuePost: noopFn,
  isPostQueueConfigured: () => false,
  getPostQueueUrl: () => '',
  enqueueMediaJob: noopFn,
  isMediaQueueConfigured: () => false,
  getMediaQueueUrl: () => '',
  // Platform adapters
  TwitterAdapter: class { constructor() {} },
  DiscordAdapter: class { constructor() {} },
};
vi.mock('@swarm/core', () => new Proxy(coreOverrides, {
  get(target, prop) {
    if (prop in target) return target[prop as string];
    // Return a no-op function for unknown exports to prevent "X is undefined" errors
    return noopFn;
  },
}));

// ── Import AFTER mocks ─────────────────────────────────────────────────────
const { grantAscensionEntitlement } = await import('./avatar-ascend.js');

// ── Helpers ─────────────────────────────────────────────────────────────────
function makeEntitlement(
  plan: 'free' | 'pro' | 'enterprise',
  status: 'active' | 'suspended' | 'cancelled' | 'trial' = 'active',
): EntitlementRecord {
  return {
    pk: `ENTITLEMENT#acc-1`,
    sk: `AVATAR#avatar-1`,
    accountId: 'acc-1',
    avatarId: 'avatar-1',
    plan,
    limits: PLAN_DEFAULTS[plan],
    status,
    createdAt: Date.now(),
    createdBy: 'test',
    updatedAt: Date.now(),
    updatedBy: 'test',
    gsi1pk: 'AVATAR#avatar-1',
    gsi1sk: 'ENTITLEMENT',
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────
describe('grantAscensionEntitlement', () => {
  beforeEach(() => {
    mockGetEntitlementResult = null;
    mockSetEntitlementCalls = [];
    mockSyncCalls = [];
  });

  it('upgrades from free to pro on ascension', async () => {
    mockGetEntitlementResult = makeEntitlement('free');

    const result = await grantAscensionEntitlement('avatar-1', 'wallet-abc');

    expect(result.upgraded).toBe(true);
    expect(result.plan).toBe('pro');
    expect(result.reason).toBe('ascension_upgrade');

    // Verify setEntitlement was called with correct params
    expect(mockSetEntitlementCalls.length).toBe(1);
    const call = mockSetEntitlementCalls[0];
    expect(call.plan).toBe('pro');
    expect(call.status).toBe('active');
    expect(call.actorId).toBe('wallet-abc');
    expect(call.entitlementSource).toBe('ascension');
    expect(call.accountId).toBe('acc-1'); // Reuses existing accountId

    // Verify runtime limits were synced
    expect(mockSyncCalls.length).toBe(1);
    expect(mockSyncCalls[0].plan).toBe('pro');
  });

  it('upgrades when no entitlement exists (new avatar)', async () => {
    mockGetEntitlementResult = null;

    const result = await grantAscensionEntitlement('avatar-1', 'wallet-abc');

    expect(result.upgraded).toBe(true);
    expect(result.plan).toBe('pro');
    expect(result.reason).toBe('ascension_upgrade');

    // When no existing entitlement, uses wallet address as accountId
    expect(mockSetEntitlementCalls.length).toBe(1);
    expect(mockSetEntitlementCalls[0].accountId).toBe('wallet-abc');
    expect(mockSetEntitlementCalls[0].entitlementSource).toBe('ascension');
  });

  it('does not downgrade enterprise to pro', async () => {
    mockGetEntitlementResult = makeEntitlement('enterprise');

    const result = await grantAscensionEntitlement('avatar-1', 'wallet-abc');

    expect(result.upgraded).toBe(false);
    expect(result.plan).toBe('enterprise');
    expect(result.reason).toBe('already_enterprise');

    // setEntitlement should NOT have been called
    expect(mockSetEntitlementCalls.length).toBe(0);
    // syncRuntimeLimitsToState should NOT have been called
    expect(mockSyncCalls.length).toBe(0);
  });

  it('does not upgrade if already pro', async () => {
    mockGetEntitlementResult = makeEntitlement('pro');

    const result = await grantAscensionEntitlement('avatar-1', 'wallet-abc');

    expect(result.upgraded).toBe(false);
    expect(result.plan).toBe('pro');
    expect(result.reason).toBe('already_pro');

    expect(mockSetEntitlementCalls.length).toBe(0);
    expect(mockSyncCalls.length).toBe(0);
  });

  it('upgrades from suspended free entitlement', async () => {
    // A suspended free entitlement should still allow upgrade since it is
    // not an active paid plan
    mockGetEntitlementResult = makeEntitlement('free', 'suspended');

    const result = await grantAscensionEntitlement('avatar-1', 'wallet-abc');

    expect(result.upgraded).toBe(true);
    expect(result.plan).toBe('pro');
    expect(result.reason).toBe('ascension_upgrade');
    expect(mockSetEntitlementCalls.length).toBe(1);
  });

  it('upgrades from suspended pro entitlement (not active)', async () => {
    // A suspended pro entitlement is not active, so the rank check won't
    // trigger the skip path. Ascension re-grants active pro.
    mockGetEntitlementResult = makeEntitlement('pro', 'suspended');

    const result = await grantAscensionEntitlement('avatar-1', 'wallet-abc');

    expect(result.upgraded).toBe(true);
    expect(result.plan).toBe('pro');
    expect(result.reason).toBe('ascension_upgrade');
    expect(mockSetEntitlementCalls.length).toBe(1);
    expect(mockSetEntitlementCalls[0].entitlementSource).toBe('ascension');
  });

  it('syncs runtime limits with pro plan values', async () => {
    mockGetEntitlementResult = null;

    await grantAscensionEntitlement('avatar-1', 'wallet-abc');

    expect(mockSyncCalls.length).toBe(1);
    const syncCall = mockSyncCalls[0];
    expect(syncCall.avatarId).toBe('avatar-1');
    expect(syncCall.plan).toBe('pro');
    expect(syncCall.source).toBe('entitlement');

    // Verify the runtime limits reflect pro-tier values
    const runtimeLimits = syncCall.runtimeLimits as Record<string, unknown>;
    expect(runtimeLimits.memoryEnabled).toBe(true);
    expect(runtimeLimits.dailyMessageLimit).toBe(500);
    expect(runtimeLimits.dailyMediaCredits).toBe(50);
    expect(runtimeLimits.autonomousPostsEnabled).toBe(true);
  });
});
