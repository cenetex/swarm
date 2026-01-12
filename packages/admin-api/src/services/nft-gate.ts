/**
 * NFT Gating Service
 * Verifies wallet holds required NFTs for access
 */

// Required collection for access (Orb NFTs)
const REQUIRED_COLLECTION = '8GCAyy5L2o2ZPdQKo3EtYAYNKYT8Y6sqGHweintLTSJ';

// Helius API for NFT queries
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const HELIUS_RPC_URL = HELIUS_API_KEY 
  ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
  : 'https://api.mainnet-beta.solana.com';

export interface NFTAsset {
  id: string;
  content: {
    metadata: {
      name: string;
      symbol?: string;
    };
    files?: Array<{ uri: string; cdn_uri?: string }>;
    links?: { image?: string };
  };
  grouping: Array<{
    group_key: string;
    group_value: string;
  }>;
  ownership: {
    owner: string;
  };
}

export interface NFTGateResult {
  allowed: boolean;
  ownedCount: number;
  requiredCollection: string;
  ownedNFTs: Array<{
    id: string;
    name: string;
    image?: string;
  }>;
  error?: string;
}

/**
 * Check if a wallet owns any NFTs from the required collection
 */
export async function checkNFTGate(walletAddress: string): Promise<NFTGateResult> {
  const result: NFTGateResult = {
    allowed: false,
    ownedCount: 0,
    requiredCollection: REQUIRED_COLLECTION,
    ownedNFTs: [],
  };

  try {
    // Use Helius DAS API to get NFTs by owner filtered by collection
    const response = await fetch(HELIUS_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'nft-gate-check',
        method: 'getAssetsByOwner',
        params: {
          ownerAddress: walletAddress,
          page: 1,
          limit: 100,
          displayOptions: {
            showCollectionMetadata: true,
          },
        },
      }),
    });

    if (!response.ok) {
      console.error('[NFTGate] Helius API error:', response.status);
      result.error = 'Failed to verify NFT ownership';
      return result;
    }

    const data = await response.json() as {
      error?: { message?: string };
      result?: { items?: NFTAsset[] };
    };
    
    if (data.error) {
      console.error('[NFTGate] RPC error:', data.error);
      result.error = data.error.message || 'RPC error';
      return result;
    }

    const assets = data.result?.items || [];

    // Filter for NFTs in the required collection
    const matchingNFTs = assets.filter((asset) => {
      const collection = asset.grouping?.find(
        (g) => g.group_key === 'collection'
      );
      return collection?.group_value === REQUIRED_COLLECTION;
    });

    result.ownedCount = matchingNFTs.length;
    result.allowed = matchingNFTs.length > 0;
    result.ownedNFTs = matchingNFTs.map((nft) => ({
      id: nft.id,
      name: nft.content?.metadata?.name || 'Unknown',
      image: nft.content?.links?.image || nft.content?.files?.[0]?.cdn_uri,
    }));

    console.log(
      `[NFTGate] Wallet ${walletAddress.slice(0, 8)}... owns ${matchingNFTs.length} Orb NFTs`
    );

    return result;
  } catch (error) {
    console.error('[NFTGate] Error checking NFT ownership:', error);
    result.error = 'Failed to verify NFT ownership';
    return result;
  }
}

/**
 * Get the required collection address
 */
export function getRequiredCollection(): string {
  return REQUIRED_COLLECTION;
}
