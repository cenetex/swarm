import { DynamoDBDocumentClient } from '@swarm/core';
/**
 * Avatar Ascension Entitlement Tests
 *
 * Verifies that ascension grants Pro-equivalent entitlements and
 * respects the plan hierarchy (no downgrade from enterprise).
 *
 * NOTE: This test uses spyOn + DI instead of vi.mock() to avoid
 * bun:test's process-global mock bleed (see issue #876).
 */
import { describe, it, expect, beforeEach, afterEach, spyOn, afterAll, mock } from 'bun:test';
import { PLAN_DEFAULTS, type EntitlementRecord } from '../types.js';
import * as entitlements from './billing/entitlements.js';
import * as runtimeLimits from './billing/runtime-limits.js';
import { _setDynamoClient } from './dynamo-client.js';

// ── Mock state ─────────────────────────────────────────────────────────────
let mockGetEntitlementResult: EntitlementRecord | null = null;
let mockSetEntitlementCalls: Array<Record<string, unknown>> = [];
let mockSyncCalls: Array<Record<string, unknown>> = [];

const prevHeliusApiKey = process.env.HELIUS_API_KEY;
process.env.HELIUS_API_KEY = 'test-helius-key';

// ── Import AFTER env setup ──────────────────────────────────────────────────
const avatarService = await import('./avatars.js');
const avatarAscendModule = await import('./avatar-ascend.js');
const { executeAscension, grantAscensionEntitlement, preflightAscend } = avatarAscendModule;

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
  let getEntitlementSpy: ReturnType<typeof spyOn>;
  let setEntitlementSpy: ReturnType<typeof spyOn>;
  let syncRuntimeLimitsSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    mockGetEntitlementResult = null;
    mockSetEntitlementCalls = [];
    mockSyncCalls = [];

    getEntitlementSpy = spyOn(entitlements, 'getEntitlement').mockImplementation(
      async () => mockGetEntitlementResult
    );
    setEntitlementSpy = spyOn(entitlements, 'setEntitlement').mockImplementation(
      async (params: Record<string, unknown>) => {
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
      }
    );
    syncRuntimeLimitsSpy = spyOn(runtimeLimits, 'syncRuntimeLimitsToState').mockImplementation(
      async (params: Record<string, unknown>) => {
        mockSyncCalls.push(params);
      }
    );
  });

  afterEach(() => {
    getEntitlementSpy.mockRestore();
    setEntitlementSpy.mockRestore();
    syncRuntimeLimitsSpy.mockRestore();
  });

  it('upgrades from free to pro on ascension', async () => {
    mockGetEntitlementResult = makeEntitlement('free');

    const result = await grantAscensionEntitlement('avatar-1', 'wallet-abc');

    expect(result.upgraded).toBe(true);
    expect(result.plan).toBe('pro');
    expect(result.reason).toBe('ascension_upgrade');

    expect(mockSetEntitlementCalls.length).toBe(1);
    const call = mockSetEntitlementCalls[0];
    expect(call.plan).toBe('pro');
    expect(call.status).toBe('active');
    expect(call.actorId).toBe('wallet-abc');
    expect(call.entitlementSource).toBe('ascension');
    expect(call.accountId).toBe('acc-1');

    expect(mockSyncCalls.length).toBe(1);
    expect(mockSyncCalls[0].plan).toBe('pro');
  });

  it('upgrades when no entitlement exists (new avatar)', async () => {
    mockGetEntitlementResult = null;

    const result = await grantAscensionEntitlement('avatar-1', 'wallet-abc');

    expect(result.upgraded).toBe(true);
    expect(result.plan).toBe('pro');
    expect(result.reason).toBe('ascension_upgrade');

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

    expect(mockSetEntitlementCalls.length).toBe(0);
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
    mockGetEntitlementResult = makeEntitlement('free', 'suspended');

    const result = await grantAscensionEntitlement('avatar-1', 'wallet-abc');

    expect(result.upgraded).toBe(true);
    expect(result.plan).toBe('pro');
    expect(result.reason).toBe('ascension_upgrade');
    expect(mockSetEntitlementCalls.length).toBe(1);
  });

  it('upgrades from suspended pro entitlement (not active)', async () => {
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

    const runtimeLimitsVal = syncCall.runtimeLimits as Record<string, unknown>;
    expect(runtimeLimitsVal.memoryEnabled).toBe(true);
    expect(runtimeLimitsVal.dailyMessageLimit).toBe(500);
    expect(runtimeLimitsVal.dailyMediaCredits).toBe(50);
    expect(runtimeLimitsVal.autonomousPostsEnabled).toBe(true);
  });
});

describe('ascension avatar ownership enforcement', () => {
  let dynamoSendMock: ReturnType<typeof spyOn>;
  let assertOwnershipSpy: ReturnType<typeof spyOn> | null = null;

  beforeEach(() => {
    const mockClient = { send: async () => ({}) };
    dynamoSendMock = spyOn(mockClient, 'send');
    _setDynamoClient(mockClient as unknown as DynamoDBDocumentClient);
    dynamoSendMock.mockResolvedValue({
      Item: {
        avatarId: 'avatar-1',
        name: 'Avatar One',
        creatorWallet: 'old-owner',
        nftMint: 'mint-1',
      },
    });
  });

  afterEach(() => {
    _setDynamoClient(null);
    if (assertOwnershipSpy) assertOwnershipSpy.mockRestore();
    assertOwnershipSpy = null;
  });

  it('preflight denies NFT-backed avatars after ownership is revoked', async () => {
    assertOwnershipSpy = spyOn(avatarService, 'assertAvatarOwnership').mockRejectedValue(
      new avatarService.AvatarOwnershipError({ code: 'nft_revoked' }),
    );

    const result = await preflightAscend('avatar-1', 'old-owner');

    expect(result.canAscend).toBe(false);
    expect(result.errorCode).toBe('NOT_INHABITANT');
    expect(result.error).toBe('Only the current avatar owner can ascend this avatar');
  });

  it('executeAscension checks avatar ownership before mutating state', async () => {
    assertOwnershipSpy = spyOn(avatarService, 'assertAvatarOwnership').mockRejectedValue(
      new avatarService.AvatarOwnershipError({ code: 'nft_revoked' }),
    );

    const result = await executeAscension(
      'avatar-1',
      'old-owner',
      'ascension-mint',
      'orb-sig',
      'rati-sig',
      100,
    );

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('NOT_INHABITANT');
    expect(dynamoSendMock).not.toHaveBeenCalled();
  });
});

// ── Ascension NFT validation tests ──────────────────────────────────────────
describe('validateAscensionNftMint', () => {
  let dynamoSendMock: ReturnType<typeof spyOn>;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    const mockClient = { send: async () => ({}) };
    dynamoSendMock = spyOn(mockClient, 'send');
    _setDynamoClient(mockClient as unknown as DynamoDBDocumentClient);

    dynamoSendMock.mockResolvedValue({
      Item: {
        avatarId: 'avatar-1',
        name: 'Avatar One',
      },
    });
  });

  afterEach(() => {
    _setDynamoClient(null);
    if (fetchSpy) fetchSpy.mockRestore();
  });

  it('accepts an NFT whose owner and metadata match the ascended avatar', async () => {
    let fetchCallCount = 0;
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => {
      fetchCallCount++;
      if (fetchCallCount === 1) {
        return {
          ok: true,
          json: async () => ({
            result: {
              ownership: { owner: 'wallet-abc' },
              content: {
                metadata: { name: 'Avatar One (Ascended)', symbol: 'ASCEND' },
                json_uri: 'https://example.com/ascension.json',
              },
            },
          }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          external_url: 'https://rati.chat/avatar/avatar-1',
          attributes: [{ trait_type: 'Avatar ID', value: 'avatar-1' }],
          properties: { creators: [{ address: 'wallet-abc', share: 100 }] },
        }),
      } as Response;
    });

    const result = await avatarAscendModule.validateAscensionNftMint('avatar-1', 'wallet-abc', 'mint-1');
    expect(result).toEqual({ valid: true, owner: 'wallet-abc' });
  });

  it('rejects an owned NFT whose metadata is not linked to the avatar', async () => {
    let fetchCallCount = 0;
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => {
      fetchCallCount++;
      if (fetchCallCount === 1) {
        return {
          ok: true,
          json: async () => ({
            result: {
              ownership: { owner: 'wallet-abc' },
              content: {
                metadata: { name: 'Avatar One (Ascended)', symbol: 'ASCEND' },
                json_uri: 'https://example.com/unrelated.json',
              },
            },
          }),
        } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          external_url: 'https://rati.chat/avatar/other-avatar',
          attributes: [{ trait_type: 'Avatar ID', value: 'other-avatar' }],
          properties: { creators: [{ address: 'wallet-abc', share: 100 }] },
        }),
      } as Response;
    });

    const result = await avatarAscendModule.validateAscensionNftMint('avatar-1', 'wallet-abc', 'mint-2');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('Ascension NFT metadata is not linked to this avatar');
  });

  it('rejects a mint owned by a different wallet', async () => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        result: {
          ownership: { owner: 'other-wallet' },
          content: {
            metadata: { name: 'Avatar One (Ascended)', symbol: 'ASCEND' },
            json_uri: 'https://example.com/ascension.json',
          },
        },
      }),
    } as never);

    const result = await avatarAscendModule.validateAscensionNftMint('avatar-1', 'wallet-abc', 'mint-3');
    expect(result.valid).toBe(false);
    expect(result.owner).toBe('other-wallet');
    expect(result.error).toBe('Ascension NFT is not owned by your wallet');
  });
});

process.on('exit', () => {
  if (prevHeliusApiKey === undefined) {
    delete process.env.HELIUS_API_KEY;
  } else {
    process.env.HELIUS_API_KEY = prevHeliusApiKey;
  }
});

afterAll(() => { mock.restore(); });
