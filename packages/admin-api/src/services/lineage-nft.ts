/**
 * Lineage NFT Service
 *
 * Manages the minting of lineage NFTs when users abandon agents.
 * Each agent has its own NFT collection (lineage) with eras.
 *
 * Flow:
 * 1. User initiates abandon
 * 2. Backend verifies they hold a Gate NFT
 * 3. Backend prepares lineage metadata (era, snapshot)
 * 4. Client burns Gate NFT
 * 5. Client or backend mints Lineage NFT
 * 6. Backend updates agent state
 */
import { Connection } from '@solana/web3.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { AgentRecord } from '../types.js';

const TABLE_NAME = process.env.ADMIN_TABLE || 'SwarmAdminTable';
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const RPC_URL = HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
  : 'https://api.mainnet-beta.solana.com';

const connection = new Connection(RPC_URL, 'confirmed');
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

// Gate NFT collection for burn verification
const GATE_COLLECTION = '8GCAyy5L2o2ZPdQKo3EtYAYNKYT8Y6sqGHweintLTSJ';

export interface LineageMetadata {
  agentId: string;
  agentName: string;
  era: number;
  isGenesis: boolean;
  abandonedAt: number;
  inhabitantWallet: string;
  avatarUrl?: string;
  snapshotUrl?: string;
}

export interface LineageCollection {
  agentId: string;
  collectionMint: string;
  createdAt: number;
  totalMinted: number;
}

export interface BurnVerification {
  verified: boolean;
  signature?: string;
  burnedMint?: string;
  error?: string;
}

export interface MintPreparation {
  success: boolean;
  metadata?: LineageMetadata;
  collectionMint?: string;
  error?: string;
}

/**
 * Verify a Gate NFT burn transaction
 */
export async function verifyGateBurn(
  walletAddress: string,
  signature: string
): Promise<BurnVerification> {
  try {
    const tx = await connection.getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
    });

    if (!tx) {
      return { verified: false, error: 'Transaction not found' };
    }

    // Check if transaction is confirmed
    if (!tx.meta || tx.meta.err) {
      return { verified: false, error: 'Transaction failed or not confirmed' };
    }

    // Parse the transaction to find the burn instruction
    // For Metaplex Core NFTs, look for the burn instruction
    // This is a simplified check - in production, verify the exact instruction
    const accountKeys = tx.transaction.message.getAccountKeys();
    const accounts = accountKeys.staticAccountKeys.map(k => k.toBase58());

    // Check if the wallet was involved
    if (!accounts.includes(walletAddress)) {
      return { verified: false, error: 'Wallet not involved in transaction' };
    }

    // For now, we trust that if the wallet submitted a burn tx that succeeded, it's valid
    // In production, parse the instruction data to verify it's a burn from the Gate collection
    console.log(`[LineageNFT] Verified burn tx ${signature} for wallet ${walletAddress.slice(0, 8)}...`);

    return {
      verified: true,
      signature,
    };
  } catch (error) {
    console.error('[LineageNFT] Error verifying burn:', error);
    return { verified: false, error: 'Failed to verify burn transaction' };
  }
}

/**
 * Get or create a lineage collection for an agent
 * On first abandon, we'll need to create the collection
 */
export async function getLineageCollection(agentId: string): Promise<LineageCollection | null> {
  const result = await dynamoClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: `AGENT#${agentId}`,
      sk: 'LINEAGE_COLLECTION',
    },
  }));

  return result.Item as LineageCollection | null;
}

/**
 * Record a newly created lineage collection
 */
export async function recordLineageCollection(
  agentId: string,
  collectionMint: string
): Promise<void> {
  const now = Date.now();

  // Store collection info
  await dynamoClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: `AGENT#${agentId}`,
      sk: 'LINEAGE_COLLECTION',
    },
    UpdateExpression: 'SET collectionMint = :mint, createdAt = :now, totalMinted = :zero, agentId = :agentId',
    ExpressionAttributeValues: {
      ':mint': collectionMint,
      ':now': now,
      ':zero': 0,
      ':agentId': agentId,
    },
  }));

  // Also update the agent record with the collection mint
  await dynamoClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: `AGENT#${agentId}`,
      sk: 'CONFIG',
    },
    UpdateExpression: 'SET nftCollectionMint = :mint, updatedAt = :now',
    ExpressionAttributeValues: {
      ':mint': collectionMint,
      ':now': now,
    },
  }));

  console.log(`[LineageNFT] Recorded collection ${collectionMint} for agent ${agentId}`);
}

/**
 * Increment the minted count for a lineage collection
 */
export async function incrementMintedCount(agentId: string): Promise<number> {
  const result = await dynamoClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: `AGENT#${agentId}`,
      sk: 'LINEAGE_COLLECTION',
    },
    UpdateExpression: 'SET totalMinted = if_not_exists(totalMinted, :zero) + :one',
    ExpressionAttributeValues: {
      ':zero': 0,
      ':one': 1,
    },
    ReturnValues: 'UPDATED_NEW',
  }));

  return (result.Attributes?.totalMinted as number) || 1;
}

/**
 * Prepare metadata for a lineage NFT mint
 */
export async function prepareLineageMint(
  agentId: string,
  walletAddress: string
): Promise<MintPreparation> {
  // Get the agent
  const agentResult = await dynamoClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: `AGENT#${agentId}`,
      sk: 'CONFIG',
    },
  }));

  if (!agentResult.Item) {
    return { success: false, error: 'Agent not found' };
  }

  const agent = agentResult.Item as AgentRecord;

  // Verify this wallet is the inhabitant
  if (agent.inhabitantWallet !== walletAddress && agent.ownerWallet !== walletAddress) {
    return { success: false, error: 'You do not inhabit this agent' };
  }

  const era = (agent.currentEra || 0) + 1;
  const isGenesis = era === 1;

  const metadata: LineageMetadata = {
    agentId,
    agentName: agent.name,
    era,
    isGenesis,
    abandonedAt: Date.now(),
    inhabitantWallet: walletAddress,
    avatarUrl: agent.profileImage?.url,
  };

  return {
    success: true,
    metadata,
    collectionMint: agent.nftCollectionMint,
  };
}

/**
 * Record a lineage NFT mint in the database
 */
export async function recordLineageMint(
  agentId: string,
  walletAddress: string,
  nftMint: string,
  era: number,
  burnSignature?: string
): Promise<void> {
  const now = Date.now();

  // Store the mint record
  await dynamoClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: `LINEAGE#${agentId}`,
      sk: `ERA#${era}`,
    },
    UpdateExpression: `
      SET nftMint = :mint,
          walletAddress = :wallet,
          mintedAt = :now,
          agentId = :agentId,
          era = :era
          ${burnSignature ? ', gateBurnSignature = :burnSig' : ''}
    `,
    ExpressionAttributeValues: {
      ':mint': nftMint,
      ':wallet': walletAddress,
      ':now': now,
      ':agentId': agentId,
      ':era': era,
      ...(burnSignature ? { ':burnSig': burnSignature } : {}),
    },
  }));

  // Increment collection count
  await incrementMintedCount(agentId);

  console.log(`[LineageNFT] Recorded mint for agent ${agentId} era ${era}: ${nftMint}`);
}

/**
 * Get lineage history for an agent
 */
export async function getLineageHistory(_agentId: string): Promise<Array<{
  era: number;
  walletAddress: string;
  nftMint: string;
  mintedAt: number;
}>> {
  // TODO: Implement proper query when needed
  // Would query all LINEAGE#{agentId} ERA#{n} records
  return [];
}

/**
 * Generate Metaplex metadata JSON for a lineage NFT
 */
export function generateLineageMetadataJson(metadata: LineageMetadata): object {
  return {
    name: `${metadata.agentName} - Era ${metadata.era}`,
    symbol: 'SWARM',
    description: `Lineage NFT for ${metadata.agentName}. Era ${metadata.era}${metadata.isGenesis ? ' (Genesis)' : ''}.`,
    image: metadata.avatarUrl || metadata.snapshotUrl,
    external_url: `https://swarm.rati.chat/agent/${metadata.agentId}`,
    attributes: [
      { trait_type: 'Agent', value: metadata.agentName },
      { trait_type: 'Era', value: metadata.era },
      { trait_type: 'Genesis', value: metadata.isGenesis },
      { trait_type: 'Abandoned At', value: new Date(metadata.abandonedAt).toISOString() },
    ],
    properties: {
      category: 'image',
      creators: [
        { address: metadata.inhabitantWallet, share: 100 },
      ],
    },
  };
}

/**
 * Get the Gate collection address
 */
export function getGateCollectionAddress(): string {
  return GATE_COLLECTION;
}
