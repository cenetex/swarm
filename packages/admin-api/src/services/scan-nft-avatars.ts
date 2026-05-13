/**
 * Bulk scan wallet-owned collection NFTs and create draft avatars.
 */
import type { AvatarRecord } from '../types.js';
import {
  createAvatarFromNFT,
  type CreateAvatarFromNFTResult,
} from './avatars.js';
import {
  getClaimableNFTs,
  type ClaimableNFT,
} from './web3/nft-gate.js';

export interface NftAvatarSummary {
  avatarId: string;
  name: string;
  status: AvatarRecord['status'];
  profileImage?: AvatarRecord['profileImage'];
  nftMint?: string;
  nftCollection?: string;
}

export interface ScanNftAvatarsResult {
  created: NftAvatarSummary[];
  skippedAlreadyClaimed: number;
  available: number;
  capped: boolean;
}

export interface ScanNftAvatarsDeps {
  getClaimableNFTs?: (walletAddress: string) => Promise<ClaimableNFT[]>;
  createAvatarFromNFT?: (
    nft: ClaimableNFT,
    walletAddress: string,
    options: { reserveCreatorSlot: false },
  ) => Promise<CreateAvatarFromNFTResult>;
}

const MAX_CREATED_PER_SCAN = 3;

function summarizeAvatar(avatar: AvatarRecord): NftAvatarSummary {
  return {
    avatarId: avatar.avatarId,
    name: avatar.name,
    status: avatar.status,
    profileImage: avatar.profileImage,
    nftMint: avatar.nftMint,
    nftCollection: avatar.nftCollection,
  };
}

export async function scanNftAvatarsForWallet(
  walletAddress: string,
  deps: ScanNftAvatarsDeps = {},
): Promise<ScanNftAvatarsResult> {
  const listClaimable = deps.getClaimableNFTs ?? getClaimableNFTs;
  const createFromNft = deps.createAvatarFromNFT ?? createAvatarFromNFT;

  const claimableNfts = await listClaimable(walletAddress);
  const available = claimableNfts.length;
  const capped = available > MAX_CREATED_PER_SCAN;
  const nftsToCreate = claimableNfts.slice(0, MAX_CREATED_PER_SCAN);

  const created: NftAvatarSummary[] = [];
  let skippedAlreadyClaimed = 0;

  for (const nft of nftsToCreate) {
    const result = await createFromNft(nft, walletAddress, {
      reserveCreatorSlot: false,
    });

    if (result.success && result.avatar) {
      created.push(summarizeAvatar(result.avatar));
      continue;
    }

    if (result.error === 'nft_already_claimed') {
      skippedAlreadyClaimed += 1;
      continue;
    }

    throw new Error(`Failed to create NFT avatar for ${nft.mint}: ${result.error || 'unknown_error'}`);
  }

  return {
    created,
    skippedAlreadyClaimed,
    available,
    capped,
  };
}
