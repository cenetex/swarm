/**
 * Documents current behavior: NFT-backed avatars remain accessible
 * even after the backing NFT is transferred to another wallet.
 *
 * The normal avatar access path (GET /avatars/:id, chat routes, tool execution)
 * uses getAvatar(), which does a simple DynamoDB lookup with no on-chain
 * ownership verification. getAvatarWithOwnershipCheck() exists in
 * services/avatars.ts but is not wired into any request path.
 *
 * See #857 for future enforcement.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock state ──────────────────────────────────────────────────────────────
let getAvatarResult: unknown = null;

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
  // NOTE: getAvatarWithOwnershipCheck is NOT imported by crud.ts — it is
  // defined in avatars.ts but never referenced by any route handler.
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
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, setContext: () => {} },
  createSqsOffloadServiceFromEnv: () => null,
  createCircuitBreaker: () => ({ canExecute: () => true, recordSuccess: () => {}, recordFailure: () => {}, state: () => 'closed' }),
  LLMError: class LLMError extends Error { constructor(message: string) { super(message); this.name = 'LLMError'; } },
  SwarmErrorCode: {
    UNKNOWN: 'UNKNOWN',
    PLATFORM_NOT_INITIALIZED: 'PLATFORM_NOT_INITIALIZED',
    PLATFORM_RATE_LIMITED: 'PLATFORM_RATE_LIMITED',
    PLATFORM_API_ERROR: 'PLATFORM_API_ERROR',
    PLATFORM_WEBHOOK_ERROR: 'PLATFORM_WEBHOOK_ERROR',
    PLATFORM_MEDIA_UPLOAD_ERROR: 'PLATFORM_MEDIA_UPLOAD_ERROR',
    PLATFORM_UNSUPPORTED_MEDIA: 'PLATFORM_UNSUPPORTED_MEDIA',
    LLM_MISSING_API_KEY: 'LLM_MISSING_API_KEY',
    LLM_CIRCUIT_OPEN: 'LLM_CIRCUIT_OPEN',
    LLM_API_ERROR: 'LLM_API_ERROR',
    LLM_EMPTY_RESPONSE: 'LLM_EMPTY_RESPONSE',
    LLM_TIMEOUT: 'LLM_TIMEOUT',
    CONFIG_NOT_FOUND: 'CONFIG_NOT_FOUND',
    CONFIG_VALIDATION_ERROR: 'CONFIG_VALIDATION_ERROR',
    CONFIG_MISSING_SECRET: 'CONFIG_MISSING_SECRET',
    STATE_READ_ERROR: 'STATE_READ_ERROR',
    STATE_WRITE_ERROR: 'STATE_WRITE_ERROR',
    MEDIA_GENERATION_ERROR: 'MEDIA_GENERATION_ERROR',
    MEDIA_FETCH_ERROR: 'MEDIA_FETCH_ERROR',
    MEDIA_LIMIT_REACHED: 'MEDIA_LIMIT_REACHED',
    AUTH_INVALID_TOKEN: 'AUTH_INVALID_TOKEN',
    AUTH_FORBIDDEN: 'AUTH_FORBIDDEN',
    AUTH_ACCESS_DENIED: 'AUTH_ACCESS_DENIED',
    QUEUE_SEND_ERROR: 'QUEUE_SEND_ERROR',
    QUEUE_PARSE_ERROR: 'QUEUE_PARSE_ERROR',
    NETWORK_FETCH_ERROR: 'NETWORK_FETCH_ERROR',
    NETWORK_TIMEOUT: 'NETWORK_TIMEOUT',
  },
}));

// ── Import handler AFTER mocks ──────────────────────────────────────────────
import { handleCrudRoutes } from './crud.js';
import { makeCtx, MOCK_AVATAR } from './test-helpers.js';

const NFT_BACKED_AVATAR = {
  ...MOCK_AVATAR,
  avatarId: 'nft-avatar-1',
  name: 'NFT Avatar',
  status: 'active' as const,
  nftMint: 'NFTmint123abc',
  nftCollection: 'collection-1',
  creatorWallet: 'original-owner-wallet',
};

describe('NFT-backed avatar access after ownership transfer (#857)', () => {
  beforeEach(() => {
    getAvatarResult = null;
  });

  it('GET /avatars/:id returns NFT-backed avatar without on-chain ownership check', async () => {
    // Simulate an NFT-backed avatar in the database.
    // Even though the backing NFT may have been transferred to a different
    // wallet, getAvatar() (used by the route) performs no on-chain check.
    getAvatarResult = { ...NFT_BACKED_AVATAR };

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
    // The route handler does NOT call verifyNFTOwnership or
    // getAvatarWithOwnershipCheck — it uses plain getAvatar().
  });

  it('GET /avatars/:id uses creatorWallet match, not NFT ownership, for access control', async () => {
    // A different wallet cannot access this avatar — but the check is
    // creatorWallet-based, not on-chain NFT ownership verification.
    getAvatarResult = { ...NFT_BACKED_AVATAR };

    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars/nft-avatar-1',
      walletAddress: 'different-wallet',
      effectiveIsAdmin: false,
    });

    const result = await handleCrudRoutes(ctx);
    expect(result).not.toBeNull();
    // Returns 404 because creatorWallet doesn't match — but this is
    // wallet-address matching, NOT NFT ownership verification.
    expect(result!.statusCode).toBe(404);
  });
});
