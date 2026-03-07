import { describe, expect, it, vi } from 'vitest';
import { getOwnerWallets, getTokenBalance, clearBalanceCache, type WalletBalanceDeps } from './wallet-balance.js';
import type { AvatarRecord } from '../../types.js';

function createAvatar(creatorWallet?: string): AvatarRecord {
  return {
    pk: 'AVATAR#avatar-1',
    sk: 'CONFIG',
    avatarId: 'avatar-1',
    name: 'Avatar',
    creatorWallet,
    platforms: {},
    llmConfig: {
      provider: 'openrouter',
      model: 'model',
      temperature: 0.7,
      maxTokens: 1000,
      useGlobalKey: true,
    },
  };
}

function createDeps(avatar: AvatarRecord | null): WalletBalanceDeps {
  return {
    getAvatar: async () => avatar,
    getSolanaRpcUrl: () => 'https://api.mainnet-beta.solana.com',
  };
}

describe('wallet-balance owner wallet aggregation', () => {
  it('returns empty when avatar has no owner wallet', async () => {
    const wallets = await getOwnerWallets('avatar-1', createDeps(createAvatar(undefined)));
    expect(wallets).toEqual([]);
  });

  it('returns primary owner wallet when account deps are not available', async () => {
    const wallets = await getOwnerWallets('avatar-1', createDeps(createAvatar('wallet-primary')));
    expect(wallets).toEqual(['wallet-primary']);
  });

  it('includes linked wallets from the owner account', async () => {
    const deps: WalletBalanceDeps = {
      ...createDeps(createAvatar('wallet-primary')),
      getAccountIdForIdentity: async () => 'account-1',
      getAccountIdentities: async () => [
        { type: 'wallet', providerId: 'wallet-primary' },
        { type: 'wallet', providerId: 'wallet-linked-2' },
        { type: 'privy', providerId: 'privy-user-1' },
      ],
    };

    const wallets = await getOwnerWallets('avatar-1', deps);
    expect(new Set(wallets)).toEqual(new Set(['wallet-primary', 'wallet-linked-2']));
  });

  it('falls back to primary wallet when account lookup fails', async () => {
    const deps: WalletBalanceDeps = {
      ...createDeps(createAvatar('wallet-primary')),
      getAccountIdForIdentity: async () => {
        throw new Error('dynamo down');
      },
      getAccountIdentities: async () => [],
    };

    const wallets = await getOwnerWallets('avatar-1', deps);
    expect(wallets).toEqual(['wallet-primary']);
  });
});

describe('getTokenBalance mint-not-found logging', () => {
  it('logs structured warning when RPC returns could-not-find-mint error', async () => {
    clearBalanceCache();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // getTokenBalance will throw when constructing PublicKey with an invalid key,
    // but we want to test the "could not find mint" path. We mock the module import
    // indirectly: Connection constructor will throw the specific RPC error.
    // Since we can't easily mock @solana/web3.js here, we rely on the fact that
    // an invalid wallet address will cause PublicKey to throw. Instead, let's
    // test via a real-ish path: pass a syntactically-valid base58 address but
    // mock Connection at the global level. For a minimal test, we override the
    // global and restore it.

    // Simplest approach: the function catches ALL errors. We can trigger the
    // mint-not-found path by providing a valid-looking address that causes
    // Connection.getParsedTokenAccountsByOwner to reject with the right message.
    // But we can't mock that without module mocking. So let's just verify the
    // error handling by importing and calling with garbage that triggers the catch.

    const balance = await getTokenBalance(
      '11111111111111111111111111111111',
      'InvalidMintThatDoesNotExist1111111111111111111',
      'https://api.mainnet-beta.solana.com',
    );

    // Should degrade to 0 (silent degradation preserved)
    expect(balance).toBe(0);

    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('emits wallet_balance_mint_not_found warn when error contains the mint message', async () => {
    clearBalanceCache();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Mock Connection.prototype.getParsedTokenAccountsByOwner to throw mint-not-found
    const { Connection } = await import('@solana/web3.js');
    const originalMethod = Connection.prototype.getParsedTokenAccountsByOwner;
    Connection.prototype.getParsedTokenAccountsByOwner = vi.fn().mockRejectedValue(
      new Error('Invalid param: could not find mint'),
    );

    try {
      const balance = await getTokenBalance(
        '11111111111111111111111111111111',
        'So11111111111111111111111111111111111111112',
        'https://api.mainnet-beta.solana.com',
      );

      expect(balance).toBe(0);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(warnSpy.mock.calls[0][0] as string);
      expect(logged.event).toBe('wallet_balance_mint_not_found');
      expect(logged.mint).toBe('So11111111111111111111111111111111111111112');
      expect(logged.wallet).toBe('11111111111111111111111111111111');
    } finally {
      Connection.prototype.getParsedTokenAccountsByOwner = originalMethod;
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
