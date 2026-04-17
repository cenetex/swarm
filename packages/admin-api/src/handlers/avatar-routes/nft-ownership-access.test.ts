/**
 * Enforcement regression test for #1385.
 *
 * NFT-backed avatars must re-verify on-chain ownership on every access.
 * The enforcement lives in `services/avatars.ts::assertAvatarOwnership`,
 * which `handlers/avatar-routes/crud.ts` now calls on the non-admin
 * branch of GET /avatars/{id} and PUT /avatars/{id}.
 *
 * These tests stub out `assertAvatarOwnership` so we can reproduce each
 * outcome (success, stale-ownership revocation, verification outage)
 * without needing a live Helius mock at this layer — the cache's own
 * behavior is covered by `services/nft-ownership-cache.test.ts`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock state ──────────────────────────────────────────────────────────────
let getAvatarResult: unknown = null;
let assertOwnershipBehavior: (() => Promise<unknown>) | null = null;

class MockAvatarOwnershipError extends Error {
  code: 'not_found' | 'not_owner' | 'nft_revoked' | 'verification_unavailable';
  constructor(params: {
    code: 'not_found' | 'not_owner' | 'nft_revoked' | 'verification_unavailable';
    message?: string;
  }) {
    super(params.message ?? params.code);
    this.name = 'AvatarOwnershipError';
    this.code = params.code;
  }
}

vi.mock('../../services/avatars.js', () => ({
  getAvatar: async () => getAvatarResult,
  listAvatars: async () => [],
  listAvatarsByWallet: async () => [],
  createAvatar: async () => ({}),
  createAvatarWithWallet: async () => ({ success: true, avatar: {} }),
  createAvatarWithWalletLegacy: async () => ({ success: true, avatar: {} }),
  createAvatarWithWalletV2: async () => ({ success: true, avatar: {} }),
  updateAvatar: async () => ({}),
  deleteAvatar: async () => {},
  reassignAvatar: async () => ({}),
  AvatarOwnershipError: MockAvatarOwnershipError,
  assertAvatarOwnership: async () => {
    if (!assertOwnershipBehavior) {
      throw new Error('Test must set assertOwnershipBehavior before invoking handler');
    }
    return assertOwnershipBehavior();
  },
}));

vi.mock('../../services/gallery.js', () => ({
  getLatestProfileImageFromGallery: async () => null,
}));

vi.mock('../../services/integrations.js', () => ({
  getAllIntegrationStatuses: async () => [],
}));

vi.mock('../../services/onboarding-rollout.js', () => ({
  resolveOnboardingRoutingDecision: async () => ({
    onboardingVersion: 'v1',
    reason: 'disabled',
    cohortBucket: 0,
    assignmentKeyHash: 'test',
    assignmentKeySource: 'anonymous',
    matchedAvatarAllowlist: false,
    flags: { enabled: false, rolloutPercent: 0, avatarAllowlist: [], forceLegacy: false, source: 'env', readAt: 0 },
  }),
}));

vi.mock('../../services/audit-log.js', () => ({
  recordAuditEvent: async () => ({ id: 'audit-mock', timestamp: Date.now() }),
}));

vi.mock('@swarm/core', () => ({
  ...RealSwarmCore,
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, setContext: () => {} },
}));

// ── Import handler AFTER mocks ──────────────────────────────────────────────
import { handleCrudRoutes } from './crud.js';
import { makeCtx, MOCK_AVATAR } from './test-helpers.js';

// Bypass mocks below to access real @swarm/core for spreading into the factory.
import * as RealSwarmCore from '../../../../core/src/index.js';

const NFT_BACKED_AVATAR = {
  ...MOCK_AVATAR,
  avatarId: 'nft-avatar-1',
  name: 'NFT Avatar',
  status: 'active' as const,
  nftMint: 'NFTmint123abc',
  nftCollection: 'collection-1',
  creatorWallet: 'original-owner-wallet',
};

describe('NFT-backed avatar access enforcement (#1385)', () => {
  beforeEach(() => {
    getAvatarResult = null;
    assertOwnershipBehavior = null;
  });

  it('GET /avatars/:id returns 200 when caller still owns the NFT', async () => {
    // assertAvatarOwnership resolves to the avatar record — mimicking a
    // cache hit where the current on-chain owner is the caller.
    getAvatarResult = { ...NFT_BACKED_AVATAR };
    assertOwnershipBehavior = async () => ({ ...NFT_BACKED_AVATAR });

    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars/nft-avatar-1',
      walletAddress: 'original-owner-wallet',
      effectiveIsAdmin: false,
    });

    const result = await handleCrudRoutes(ctx);
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(200);

    const body = JSON.parse(result!.body as string);
    expect(body.avatarId).toBe('nft-avatar-1');
    expect(body.nftMint).toBe('NFTmint123abc');
  });

  it('GET /avatars/:id returns 404 when the NFT has been transferred away', async () => {
    // assertAvatarOwnership throws `nft_revoked` — this is the new behavior
    // that was missing pre-#1385. Before, `creatorWallet === walletAddress`
    // would have matched and the route would have served a 200.
    getAvatarResult = { ...NFT_BACKED_AVATAR };
    assertOwnershipBehavior = async () => {
      throw new MockAvatarOwnershipError({ code: 'nft_revoked' });
    };

    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars/nft-avatar-1',
      walletAddress: 'original-owner-wallet', // matches creatorWallet but no longer on-chain owner
      effectiveIsAdmin: false,
    });

    const result = await handleCrudRoutes(ctx);
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(404);
    const body = JSON.parse(result!.body as string);
    expect(body.error).toBe('Avatar not found');
  });

  it('GET /avatars/:id still denies a wallet that never owned the avatar', async () => {
    getAvatarResult = { ...NFT_BACKED_AVATAR };
    assertOwnershipBehavior = async () => {
      throw new MockAvatarOwnershipError({ code: 'not_owner' });
    };

    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars/nft-avatar-1',
      walletAddress: 'different-wallet',
      effectiveIsAdmin: false,
    });

    const result = await handleCrudRoutes(ctx);
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(404);
  });

  it('GET /avatars/:id returns 503 when Helius is unreachable (fail-closed)', async () => {
    getAvatarResult = { ...NFT_BACKED_AVATAR };
    assertOwnershipBehavior = async () => {
      throw new MockAvatarOwnershipError({ code: 'verification_unavailable' });
    };

    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars/nft-avatar-1',
      walletAddress: 'original-owner-wallet',
      effectiveIsAdmin: false,
    });

    const result = await handleCrudRoutes(ctx);
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(503);
    const body = JSON.parse(result!.body as string);
    expect(body.code).toBe('verification_unavailable');
  });
});
