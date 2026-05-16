import { describe, expect, it, vi } from 'vitest';
import { scanNftAvatarsForWallet } from './scan-nft-avatars.js';
import type { ClaimableNFT } from './web3/nft-gate.js';

function makeNft(index: number): ClaimableNFT {
  return {
    mint: `mint-${index}`,
    name: `Proxim8 ${index}`,
    image: `https://example.com/${index}.png`,
    collection: '5QBfYxnihn5De4UEV3U1To4sWuWoWwHYJsxpd3hPamaf',
  };
}

describe('scanNftAvatarsForWallet', () => {
  it('creates at most three NFT avatars per scan and bypasses creator slots', async () => {
    const claimable = [1, 2, 3, 4].map(makeNft);
    const createAvatarFromNFT = vi.fn(async (nft: ClaimableNFT) => ({
      success: true,
      avatar: {
        pk: `AVATAR#${nft.mint}`,
        sk: 'CONFIG',
        avatarId: `avatar-${nft.mint}`,
        name: nft.name,
        status: 'draft' as const,
        platforms: {},
        voiceConfig: { enabled: true, ttsProvider: 'voice-clone' as const, format: 'ogg' as const },
        llmConfig: {
          provider: 'openrouter' as const,
          model: 'test-model',
          temperature: 0.8,
          maxTokens: 1024,
          useGlobalKey: true,
        },
        createdAt: 1,
        createdBy: 'wallet-1',
        updatedAt: 1,
        updatedBy: 'wallet-1',
        nftMint: nft.mint,
        nftCollection: nft.collection,
      },
    }));

    const result = await scanNftAvatarsForWallet('wallet-1', {
      getClaimableNFTs: async () => claimable,
      createAvatarFromNFT,
    });

    expect(result.created).toHaveLength(3);
    expect(result.available).toBe(4);
    expect(result.capped).toBe(true);
    expect(createAvatarFromNFT).toHaveBeenCalledTimes(3);
    expect(createAvatarFromNFT).toHaveBeenCalledWith(
      claimable[0],
      'wallet-1',
      { reserveCreatorSlot: false },
    );
  });

  it('counts race-condition duplicate claims without failing the scan', async () => {
    const claimable = [makeNft(1), makeNft(2)];
    const result = await scanNftAvatarsForWallet('wallet-1', {
      getClaimableNFTs: async () => claimable,
      createAvatarFromNFT: vi.fn(async (nft: ClaimableNFT) => (
        nft.mint === 'mint-1'
          ? { success: false, error: 'nft_already_claimed' as const }
          : {
              success: true,
              avatar: {
                pk: 'AVATAR#mint-2',
                sk: 'CONFIG',
                avatarId: 'avatar-mint-2',
                name: nft.name,
                status: 'draft' as const,
                platforms: {},
                voiceConfig: { enabled: true, ttsProvider: 'voice-clone' as const, format: 'ogg' as const },
                llmConfig: {
                  provider: 'openrouter' as const,
                  model: 'test-model',
                  temperature: 0.8,
                  maxTokens: 1024,
                  useGlobalKey: true,
                },
                createdAt: 1,
                createdBy: 'wallet-1',
                updatedAt: 1,
                updatedBy: 'wallet-1',
                nftMint: nft.mint,
                nftCollection: nft.collection,
              },
            }
      )),
    });

    expect(result.created.map((avatar) => avatar.avatarId)).toEqual(['avatar-mint-2']);
    expect(result.skippedAlreadyClaimed).toBe(1);
    expect(result.capped).toBe(false);
  });
});
