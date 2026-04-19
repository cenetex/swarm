import { describe, expect, it } from 'bun:test';
import {
  assertAvatarStillOwnedByClaimer,
  HandlerOwnershipError,
} from './assert-avatar-ownership.js';

describe('assertAvatarStillOwnedByClaimer', () => {
  const nonNftAvatar = { avatarId: 'a1' };
  const ownedAvatar = {
    avatarId: 'a2',
    nftMint: 'MINT_1',
    creatorWallet: 'WALLET_A',
  };

  it('non-NFT avatar passes without calling the cache', async () => {
    let called = false;
    await assertAvatarStillOwnedByClaimer(nonNftAvatar, {
      getCachedNFTOwner: async () => {
        called = true;
        return 'never';
      },
    });
    expect(called).toBe(false);
  });

  it('missing creatorWallet passes without calling the cache', async () => {
    let called = false;
    await assertAvatarStillOwnedByClaimer(
      { avatarId: 'a3', nftMint: 'MINT_1' },
      {
        getCachedNFTOwner: async () => {
          called = true;
          return 'never';
        },
      },
    );
    expect(called).toBe(false);
  });

  it('current owner still matches claimer → passes', async () => {
    await expect(
      assertAvatarStillOwnedByClaimer(ownedAvatar, {
        getCachedNFTOwner: async () => 'WALLET_A',
      }),
    ).resolves.toBeUndefined();
  });

  it('current owner differs from claimer → throws nft_revoked', async () => {
    const err = await assertAvatarStillOwnedByClaimer(ownedAvatar, {
      getCachedNFTOwner: async () => 'WALLET_B',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HandlerOwnershipError);
    expect((err as HandlerOwnershipError).code).toBe('nft_revoked');
  });

  it('null owner (burned/unindexed) differs from claimer → throws nft_revoked', async () => {
    const err = await assertAvatarStillOwnedByClaimer(ownedAvatar, {
      getCachedNFTOwner: async () => null,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HandlerOwnershipError);
    expect((err as HandlerOwnershipError).code).toBe('nft_revoked');
  });

  it('cache throws (helius unavailable) → throws verification_unavailable', async () => {
    const err = await assertAvatarStillOwnedByClaimer(ownedAvatar, {
      getCachedNFTOwner: async () => {
        throw new Error('helius down');
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HandlerOwnershipError);
    expect((err as HandlerOwnershipError).code).toBe('verification_unavailable');
  });
});
