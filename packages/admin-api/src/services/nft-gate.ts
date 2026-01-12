/**
 * NFT Gating Service
 * Verifies wallet holds required NFTs for access and creation gating
 *
 * Gate NFT serves two purposes:
 * 1. HOLDING = Permission to create agents (1 NFT held = 1 creation slot)
 * 2. BURNING = Permission to abandon an inhabited agent
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';

// Required collection for access (Orb/Gate NFTs)
const GATE_COLLECTION = '8GCAyy5L2o2ZPdQKo3EtYAYNKYT8Y6sqGHweintLTSJ';

// Helius API for NFT queries
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const HELIUS_RPC_URL = HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
  : 'https://api.mainnet-beta.solana.com';

const ADMIN_TABLE = process.env.ADMIN_TABLE!;
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

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
 * Full gate status for creation/abandonment gating
 */
export interface GateStatus {
  nftsHeld: number;
  agentsCreated: number;
  availableSlots: number;
  canCreate: boolean;
  canAbandon: boolean;
  ownedNFTs: Array<{
    id: string;
    name: string;
    image?: string;
  }>;
}

/**
 * Check if a wallet owns any NFTs from the Gate collection
 */
export async function checkNFTGate(walletAddress: string): Promise<NFTGateResult> {
  const result: NFTGateResult = {
    allowed: false,
    ownedCount: 0,
    requiredCollection: GATE_COLLECTION,
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

    // Filter for NFTs in the Gate collection
    const matchingNFTs = assets.filter((asset) => {
      const collection = asset.grouping?.find(
        (g) => g.group_key === 'collection'
      );
      return collection?.group_value === GATE_COLLECTION;
    });

    result.ownedCount = matchingNFTs.length;
    result.allowed = matchingNFTs.length > 0;
    result.ownedNFTs = matchingNFTs.map((nft) => ({
      id: nft.id,
      name: nft.content?.metadata?.name || 'Unknown',
      image: nft.content?.links?.image || nft.content?.files?.[0]?.cdn_uri,
    }));

    console.log(
      `[NFTGate] Wallet ${walletAddress.slice(0, 8)}... owns ${matchingNFTs.length} Gate NFTs`
    );

    return result;
  } catch (error) {
    console.error('[NFTGate] Error checking NFT ownership:', error);
    result.error = 'Failed to verify NFT ownership';
    return result;
  }
}

/**
 * Count agents created by a wallet
 */
export async function countAgentsCreatedBy(walletAddress: string): Promise<number> {
  try {
    const result = await dynamoClient.send(new ScanCommand({
      TableName: ADMIN_TABLE,
      FilterExpression: 'sk = :sk AND creatorWallet = :wallet AND #status <> :deleted',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':sk': 'CONFIG',
        ':wallet': walletAddress,
        ':deleted': 'deleted',
      },
      Select: 'COUNT',
    }));

    return result.Count || 0;
  } catch (error) {
    console.error('[NFTGate] Error counting agents:', error);
    return 0;
  }
}

/**
 * Get full gate status for a wallet
 * Used for creation gating and abandonment checks
 */
export async function getGateStatus(walletAddress: string): Promise<GateStatus> {
  // Get NFT count from on-chain
  const nftResult = await checkNFTGate(walletAddress);
  const nftsHeld = nftResult.ownedCount;

  // Get agents created by this wallet from DynamoDB
  const agentsCreated = await countAgentsCreatedBy(walletAddress);

  const availableSlots = Math.max(0, nftsHeld - agentsCreated);

  return {
    nftsHeld,
    agentsCreated,
    availableSlots,
    canCreate: availableSlots > 0,
    canAbandon: nftsHeld >= 1,
    ownedNFTs: nftResult.ownedNFTs,
  };
}

/**
 * Get the Gate collection address
 */
export function getGateCollection(): string {
  return GATE_COLLECTION;
}

/**
 * @deprecated Use getGateCollection instead
 */
export function getRequiredCollection(): string {
  return GATE_COLLECTION;
}
