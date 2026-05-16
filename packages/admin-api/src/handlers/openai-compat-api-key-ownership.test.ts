import { beforeEach, describe, expect, mock, test } from 'bun:test';

process.env.ADMIN_TABLE = process.env.ADMIN_TABLE || 'TestAdminTable';

let getAvatarResult: Record<string, unknown> | null = null;
let assertOwnershipCalls: Array<[string, string, { isAdmin?: boolean } | undefined]> = [];
let assertOwnershipError: Error | null = null;

class MockAvatarOwnershipError extends Error {
  code: string;
  constructor(params: { code: string; message?: string }) {
    super(params.message ?? params.code);
    this.name = 'AvatarOwnershipError';
    this.code = params.code;
  }
}

mock.module('../services/avatars.js', () => ({
  getAvatar: async () => getAvatarResult,
  AvatarOwnershipError: MockAvatarOwnershipError,
  assertAvatarOwnership: async (
    avatarId: string,
    walletAddress: string,
    opts?: { isAdmin?: boolean },
  ) => {
    assertOwnershipCalls.push([avatarId, walletAddress, opts]);
    if (assertOwnershipError) throw assertOwnershipError;
    return getAvatarResult;
  },
}));

const { resolveApiKeyAvatarAccess } = await import('./openai-compat.js');

describe('OpenAI-compatible API key NFT ownership access', () => {
  beforeEach(() => {
    getAvatarResult = null;
    assertOwnershipCalls = [];
    assertOwnershipError = null;
  });

  test('allows non-NFT avatars without key owner wallet metadata', async () => {
    getAvatarResult = {
      avatarId: 'plain-avatar',
      creatorWallet: 'creator-wallet',
    };

    const result = await resolveApiKeyAvatarAccess('plain-avatar', {
      valid: true,
      avatarId: 'plain-avatar',
    });

    expect(result.ok).toBe(true);
    expect(assertOwnershipCalls).toEqual([]);
  });

  test('denies NFT-backed avatars when a scoped key has no creator wallet metadata', async () => {
    getAvatarResult = {
      avatarId: 'nft-avatar',
      creatorWallet: 'old-owner',
      nftMint: 'mint-1',
    };

    const result = await resolveApiKeyAvatarAccess('nft-avatar', {
      valid: true,
      avatarId: 'nft-avatar',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.statusCode).toBe(403);
      expect(result.code).toBe('api_key_owner_wallet_required');
    }
    expect(assertOwnershipCalls).toEqual([]);
  });

  test('authorizes NFT-backed avatars through current ownership of the key creator wallet', async () => {
    getAvatarResult = {
      avatarId: 'nft-avatar',
      creatorWallet: 'old-owner',
      nftMint: 'mint-1',
    };

    const result = await resolveApiKeyAvatarAccess('nft-avatar', {
      valid: true,
      avatarId: 'nft-avatar',
      createdByWallet: 'current-owner',
    });

    expect(result.ok).toBe(true);
    expect(assertOwnershipCalls).toEqual([
      ['nft-avatar', 'current-owner', { isAdmin: false }],
    ]);
  });

  test('denies NFT-backed avatars after key creator wallet loses ownership', async () => {
    getAvatarResult = {
      avatarId: 'nft-avatar',
      creatorWallet: 'old-owner',
      nftMint: 'mint-1',
    };
    const error = new Error('revoked') as Error & { code: string };
    error.code = 'nft_revoked';
    assertOwnershipError = error;

    const result = await resolveApiKeyAvatarAccess('nft-avatar', {
      valid: true,
      avatarId: 'nft-avatar',
      createdByWallet: 'old-owner',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.statusCode).toBe(403);
      expect(result.code).toBe('nft_revoked');
    }
  });
});
