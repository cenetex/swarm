/**
 * MCP NFT Services
 *
 * Service implementations for NFT ownership, inhabitation,
 * lineage, ascension, and collection management.
 */
import type { NFTServices } from '@swarm/mcp-server';
import type { ServiceContainer } from '../service-container.js';

/**
 * Create NFT services for ownership and lineage.
 */
export function createNFTServices(svc: ServiceContainer): NFTServices {
  const { avatars, avatarOwnership: avatarwnership, nftGate, lineageNft } = svc;
  return {
    // Gate NFT operations
    getGateStatus: async (walletAddress: string) => {
      return nftGate.getGateStatus(walletAddress);
    },

    getGateCollectionAddress: () => {
      return nftGate.getGateCollection();
    },

    // Legacy ownership operations
    getInhabitationInfo: async (walletAddress: string) => {
      return avatarwnership.getInhabitationInfo(walletAddress);
    },

    listUnclaimedAvatars: async () => {
      const allAgents = await avatars.listAvatars();
      return allAgents
        .filter((avatar) => !avatar.inhabitantWallet)
        .map((avatar) => ({
          avatarId: avatar.avatarId,
          name: avatar.name,
          description: avatar.description,
          avatarUrl: avatar.profileImage?.url,
          era: avatar.currentEra || 0,
        }));
    },

    inhabitAvatar: async (walletAddress: string, avatarId: string) => {
      return avatarwnership.inhabitAvatar(walletAddress, avatarId);
    },

    canAbandon: async (walletAddress: string) => {
      const result = await avatarwnership.canAbandon(walletAddress);
      return {
        canAbandon: result.canAbandon,
        gateStatus: result.gateStatus,
        inhabitedAvatarId: result.inhabitedAvatar?.avatarId,
        inhabitedAvatarName: result.inhabitedAvatar?.name,
      };
    },

    abandonAvatar: async (walletAddress: string, burnTxSignature: string) => {
      return avatarwnership.abandonAvatar(walletAddress, burnTxSignature);
    },

    // Burn verification
    verifyGateBurn: async (walletAddress: string, signature: string) => {
      return lineageNft.verifyGateBurn(walletAddress, signature);
    },

    // Lineage NFT operations
    getLineageCollection: async (avatarId: string) => {
      return lineageNft.getLineageCollection(avatarId);
    },

    prepareLineageMint: async (avatarId: string, walletAddress: string) => {
      return lineageNft.prepareLineageMint(avatarId, walletAddress);
    },

    recordLineageMint: async (
      avatarId: string,
      walletAddress: string,
      nftMint: string,
      era: number,
      burnSignature?: string
    ) => {
      return lineageNft.recordLineageMint(avatarId, walletAddress, nftMint, era, burnSignature);
    },

    generateLineageMetadata: (metadata) => {
      return lineageNft.generateLineageMetadataJson(metadata);
    },

    // Avatar self-awareness (what avatars can actually use)
    getAvatarInhabitationStatus: async (avatarId: string) => {
      const avatar = await avatars.getAvatar(avatarId);
      if (!avatar) {
        return {
          isInhabited: false,
          currentEra: 0,
          totalEras: 0,
        };
      }

      return {
        isInhabited: !!avatar.inhabitantWallet,
        inhabitantWallet: avatar.inhabitantWallet,
        inhabitedAt: avatar.inhabitedAt,
        currentEra: avatar.currentEra || 0,
        totalEras: avatar.currentEra || 0,
      };
    },

    getInhabitationUrl: (avatarId: string) => {
      const baseUrl = process.env.ADMIN_UI_URL || 'https://swarm.rati.chat';
      return `${baseUrl}/avatars/${avatarId}`;
    },

    getAvatarAscensionStatus: async (avatarId: string) => {
      const avatar = await avatars.getAvatar(avatarId);
      if (!avatar || !avatar.isAscended) {
        return { isAscended: false };
      }

      const { ASCENSION_ENERGY_BOOST } = await import('@swarm/core');

      return {
        isAscended: true,
        ascendedAt: avatar.ascendedAt,
        ascendedNftMint: avatar.ascendedNftMint,
        ascendedByWallet: avatar.ascendedByWallet,
        energyBoost: {
          maxEnergyMultiplier: ASCENSION_ENERGY_BOOST.maxEnergyMultiplier,
          regenRateMultiplier: ASCENSION_ENERGY_BOOST.regenRateMultiplier,
        },
      };
    },

    // NFT Collection Avatar operations
    getClaimableNFTs: async (walletAddress: string) => {
      return nftGate.getClaimableNFTs(walletAddress);
    },

    claimNFTAsAvatar: async (walletAddress: string, mintAddress: string) => {
      const claimableNFTs = await nftGate.getClaimableNFTs(walletAddress);
      const nft = claimableNFTs.find((n) => n.mint === mintAddress);

      if (!nft) {
        const isOwned = await nftGate.verifyNFTOwnership(walletAddress, mintAddress);
        if (!isOwned) {
          return { success: false, error: 'nft_not_owned' };
        }
        if (await nftGate.isNFTClaimed(mintAddress)) {
          return { success: false, error: 'nft_already_claimed' };
        }
        return { success: false, error: 'nft_not_in_collection' };
      }

      const result = await avatars.createAvatarFromNFT(nft, walletAddress);

      if (!result.success) {
        return {
          success: false,
          error: result.error,
        };
      }

      return {
        success: true,
        avatarId: result.avatar?.avatarId,
        avatarName: result.avatar?.name,
        avatarImage: result.avatar?.profileImage?.url,
      };
    },

    getWhitelistedCollections: () => {
      return nftGate.getWhitelistedCollections();
    },
  };
}
