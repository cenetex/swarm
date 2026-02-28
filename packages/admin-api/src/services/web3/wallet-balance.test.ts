import { describe, expect, it } from 'vitest';
import { getOwnerWallets, type WalletBalanceDeps } from './wallet-balance.js';
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
