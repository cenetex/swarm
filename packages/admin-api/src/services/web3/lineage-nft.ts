/* eslint-disable no-console -- TODO: migrate to structured logger */
/**
 * Lineage NFT Service
 *
 * Manages the minting of lineage NFTs when users abandon avatars.
 * Each avatar has its own NFT collection (lineage) with eras.
 *
 * Flow:
 * 1. User initiates abandon
 * 2. Backend verifies they hold a Gate NFT
 * 3. Backend prepares lineage metadata (era, snapshot)
 * 4. Client burns Gate NFT
 * 5. Client or backend mints Lineage NFT
 * 6. Backend updates avatar state
 */
import { Connection, type VersionedTransactionResponse } from '@solana/web3.js';
import { UpdateCommand, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { AvatarRecord } from '../../types.js';
import { getDynamoClient } from '../dynamo-client.js';

const TABLE_NAME = process.env.ADMIN_TABLE || 'SwarmAdminTable';
const HELIUS_API_KEY = process.env.HELIUS_API_KEY;
const HELIUS_RPC_URL = HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`
  : 'https://api.mainnet-beta.solana.com';
const HELIUS_TX_URL = HELIUS_API_KEY
  ? `https://api.helius.xyz/v0/transactions/?api-key=${HELIUS_API_KEY}`
  : null;

const connection = new Connection(HELIUS_RPC_URL, 'confirmed');
const dynamoClient = getDynamoClient();

// Gate NFT collection for burn verification
const GATE_COLLECTION = '8GCAyy5L2o2ZPdQKo3EtYAYNKYT8Y6sqGHweintLTSJ';

type HeliusParsedTransaction = {
  type?: string;
  description?: string;
  events?: {
    nft?: Record<string, unknown>;
  };
  tokenTransfers?: Array<{
    mint?: string;
  }>;
};

function isZeroTokenAmount(amount?: { amount?: string; uiAmount?: number | null }): boolean {
  if (!amount) return true;
  if (typeof amount.uiAmount === 'number') {
    return amount.uiAmount === 0;
  }
  return amount.amount === '0';
}

function extractBurnedMints(tx: VersionedTransactionResponse): string[] {
  const meta = tx.meta;
  if (!meta) return [];

  const preBalances = meta.preTokenBalances || [];
  const postBalances = meta.postTokenBalances || [];
  const postByMint = new Map<string, Array<typeof postBalances[number]>>();

  for (const balance of postBalances) {
    if (!balance.mint) continue;
    const existing = postByMint.get(balance.mint) || [];
    existing.push(balance);
    postByMint.set(balance.mint, existing);
  }

  const burnedMints = new Set<string>();

  for (const balance of preBalances) {
    if (!balance.mint) continue;
    const postForMint = postByMint.get(balance.mint) || [];
    if (postForMint.length === 0) {
      burnedMints.add(balance.mint);
      continue;
    }

    const hasNonZero = postForMint.some((post) => !isZeroTokenAmount(post.uiTokenAmount));
    if (!hasNonZero) {
      burnedMints.add(balance.mint);
    }
  }

  return [...burnedMints];
}

function extractHeliusMintCandidates(parsedTx: HeliusParsedTransaction | null): string[] {
  if (!parsedTx) return [];
  const mints = new Set<string>();
  const addMint = (value: unknown) => {
    if (typeof value === 'string' && value.length >= 32) {
      mints.add(value);
    }
  };

  const nftEvent = parsedTx.events?.nft;
  if (nftEvent && typeof nftEvent === 'object') {
    addMint((nftEvent as { mint?: string }).mint);
    const metadata = (nftEvent as { metadata?: { mint?: string } }).metadata;
    if (metadata) {
      addMint(metadata.mint);
    }
    const nestedNft = (nftEvent as { nft?: { mint?: string } }).nft;
    if (nestedNft) {
      addMint(nestedNft.mint);
    }
  }

  if (Array.isArray(parsedTx.tokenTransfers)) {
    for (const transfer of parsedTx.tokenTransfers) {
      addMint(transfer.mint);
    }
  }

  return [...mints];
}

function extractHeliusCollection(parsedTx: HeliusParsedTransaction | null): string | null {
  if (!parsedTx) return null;
  const nftEvent = parsedTx.events?.nft;
  if (!nftEvent || typeof nftEvent !== 'object') return null;

  const rawCollection = (nftEvent as Record<string, unknown>).collection;
  if (typeof rawCollection === 'string') {
    return rawCollection;
  }

  if (rawCollection && typeof rawCollection === 'object') {
    const collectionObj = rawCollection as { mint?: string; address?: string; id?: string };
    return collectionObj.mint || collectionObj.address || collectionObj.id || null;
  }

  const directCollection = (nftEvent as { collectionMint?: string; collectionAddress?: string }).collectionMint
    || (nftEvent as { collectionMint?: string; collectionAddress?: string }).collectionAddress;

  return directCollection || null;
}

function isBurnTransaction(parsedTx: HeliusParsedTransaction | null, logs?: string[] | null): boolean {
  const heliusType = parsedTx?.type;
  if (typeof heliusType === 'string' && heliusType.toLowerCase().includes('burn')) {
    return true;
  }

  const nftEventType = parsedTx?.events?.nft && (parsedTx.events.nft as { type?: string }).type;
  if (typeof nftEventType === 'string' && nftEventType.toLowerCase().includes('burn')) {
    return true;
  }

  const description = parsedTx?.description;
  if (typeof description === 'string' && description.toLowerCase().includes('burn')) {
    return true;
  }

  if (Array.isArray(logs)) {
    return logs.some((log) => log.toLowerCase().includes('burn'));
  }

  return false;
}

async function fetchHeliusParsedTransaction(signature: string): Promise<HeliusParsedTransaction | null> {
  if (!HELIUS_TX_URL) return null;

  try {
    const response = await fetch(HELIUS_TX_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactions: [signature] }),
    });

    if (!response.ok) {
      console.warn(`[LineageNFT] Helius transaction parse failed: ${response.status}`);
      return null;
    }

    const data = await response.json() as unknown;
    if (Array.isArray(data)) {
      return (data[0] as HeliusParsedTransaction) || null;
    }

    if (data && typeof data === 'object' && 'result' in data) {
      const result = (data as { result?: unknown }).result;
      if (Array.isArray(result)) {
        return (result[0] as HeliusParsedTransaction) || null;
      }
    }

    return null;
  } catch (error) {
    console.warn('[LineageNFT] Helius transaction parse error:', error instanceof Error ? error.message : String(error));
    return null;
  }
}

async function getAssetCollection(mint: string): Promise<string | null> {
  if (!HELIUS_API_KEY) return null;

  try {
    const response = await fetch(HELIUS_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'lineage-get-asset',
        method: 'getAsset',
        params: { id: mint },
      }),
    });

    if (!response.ok) {
      console.warn(`[LineageNFT] Helius getAsset failed: ${response.status}`);
      return null;
    }

    const data = await response.json() as {
      error?: { message?: string };
      result?: { grouping?: Array<{ group_key: string; group_value: string }> };
    };

    if (data.error) {
      console.warn('[LineageNFT] Helius getAsset error:', data.error.message || data.error);
      return null;
    }

    const grouping = data.result?.grouping || [];
    const collection = grouping.find((group) => group.group_key === 'collection');
    return collection?.group_value || null;
  } catch (error) {
    console.warn('[LineageNFT] Helius getAsset error:', error instanceof Error ? error.message : String(error));
    return null;
  }
}

export interface LineageMetadata {
  avatarId: string;
  avatarName: string;
  era: number;
  isGenesis: boolean;
  abandonedAt: number;
  inhabitantWallet: string;
  avatarUrl?: string;
  snapshotUrl?: string;
}

export interface LineageCollection {
  avatarId: string;
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
    if (!HELIUS_API_KEY) {
      return { verified: false, error: 'HELIUS_API_KEY not configured for burn verification' };
    }

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

    const accountKeys = tx.transaction.message.getAccountKeys();
    const accounts = accountKeys.staticAccountKeys.map(k => k.toBase58());

    // Check if the wallet was involved
    if (!accounts.includes(walletAddress)) {
      return { verified: false, error: 'Wallet not involved in transaction' };
    }

    const [heliusParsedTx, burnedMints] = await Promise.all([
      fetchHeliusParsedTransaction(signature),
      Promise.resolve(extractBurnedMints(tx)),
    ]);

    const heliusMints = extractHeliusMintCandidates(heliusParsedTx);
    const candidateMints = Array.from(new Set([...burnedMints, ...heliusMints]));
    const burnDetected = burnedMints.length > 0 || isBurnTransaction(heliusParsedTx, tx.meta?.logMessages);

    if (!burnDetected) {
      return { verified: false, error: 'Transaction does not appear to burn an NFT' };
    }

    const heliusCollection = extractHeliusCollection(heliusParsedTx);
    if (heliusCollection === GATE_COLLECTION) {
      console.log(`[LineageNFT] Verified Gate burn (collection match) for ${walletAddress.slice(0, 8)}...`);
      return {
        verified: true,
        signature,
        burnedMint: candidateMints.length === 1 ? candidateMints[0] : undefined,
      };
    }

    if (candidateMints.length === 0) {
      return { verified: false, error: 'Unable to identify burned NFT mint' };
    }

    for (const mint of candidateMints) {
      const collection = await getAssetCollection(mint);
      if (collection === GATE_COLLECTION) {
        console.log(`[LineageNFT] Verified Gate burn mint ${mint} for ${walletAddress.slice(0, 8)}...`);
        return {
          verified: true,
          signature,
          burnedMint: mint,
        };
      }
    }

    return { verified: false, error: 'Burned NFT is not from the Gate collection' };

  } catch (error) {
    console.error('[LineageNFT] Error verifying burn:', error instanceof Error ? error.message : String(error));
    return { verified: false, error: 'Failed to verify burn transaction' };
  }
}

/**
 * Get or create a lineage collection for an avatar
 * On first abandon, we'll need to create the collection
 */
export async function getLineageCollection(avatarId: string): Promise<LineageCollection | null> {
  const result = await dynamoClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: `AVATAR#${avatarId}`,
      sk: 'LINEAGE_COLLECTION',
    },
  }));

  return result.Item as LineageCollection | null;
}

/**
 * Record a newly created lineage collection
 */
export async function recordLineageCollection(
  avatarId: string,
  collectionMint: string
): Promise<void> {
  const now = Date.now();

  // Store collection info
  await dynamoClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: `AVATAR#${avatarId}`,
      sk: 'LINEAGE_COLLECTION',
    },
    UpdateExpression: 'SET collectionMint = :mint, createdAt = :now, totalMinted = :zero, avatarId = :avatarId',
    ExpressionAttributeValues: {
      ':mint': collectionMint,
      ':now': now,
      ':zero': 0,
      ':avatarId': avatarId,
    },
  }));

  // Also update the avatar record with the collection mint
  await dynamoClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: `AVATAR#${avatarId}`,
      sk: 'CONFIG',
    },
    UpdateExpression: 'SET nftCollectionMint = :mint, updatedAt = :now',
    ExpressionAttributeValues: {
      ':mint': collectionMint,
      ':now': now,
    },
  }));

  console.log(`[LineageNFT] Recorded collection ${collectionMint} for avatar ${avatarId}`);
}

/**
 * Increment the minted count for a lineage collection
 */
export async function incrementMintedCount(avatarId: string): Promise<number> {
  const result = await dynamoClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: `AVATAR#${avatarId}`,
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
  avatarId: string,
  walletAddress: string
): Promise<MintPreparation> {
  // Get the avatar
  const avatarResult = await dynamoClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: `AVATAR#${avatarId}`,
      sk: 'CONFIG',
    },
  }));

  if (!avatarResult.Item) {
    return { success: false, error: 'Avatar not found' };
  }

  const avatar = avatarResult.Item as AvatarRecord;

  // Verify this wallet is the inhabitant
  if (avatar.inhabitantWallet !== walletAddress && avatar.ownerWallet !== walletAddress) {
    return { success: false, error: 'You do not inhabit this avatar' };
  }

  const era = (avatar.currentEra || 0) + 1;
  const isGenesis = era === 1;

  const metadata: LineageMetadata = {
    avatarId,
    avatarName: avatar.name,
    era,
    isGenesis,
    abandonedAt: Date.now(),
    inhabitantWallet: walletAddress,
    avatarUrl: avatar.profileImage?.url,
  };

  return {
    success: true,
    metadata,
    collectionMint: avatar.nftCollectionMint,
  };
}

/**
 * Record a lineage NFT mint in the database
 */
export async function recordLineageMint(
  avatarId: string,
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
      pk: `LINEAGE#${avatarId}`,
      sk: `ERA#${era}`,
    },
    UpdateExpression: `
      SET nftMint = :mint,
          walletAddress = :wallet,
          mintedAt = :now,
          avatarId = :avatarId,
          era = :era
          ${burnSignature ? ', gateBurnSignature = :burnSig' : ''}
    `,
    ExpressionAttributeValues: {
      ':mint': nftMint,
      ':wallet': walletAddress,
      ':now': now,
      ':avatarId': avatarId,
      ':era': era,
      ...(burnSignature ? { ':burnSig': burnSignature } : {}),
    },
  }));

  // Increment collection count
  await incrementMintedCount(avatarId);

  console.log(`[LineageNFT] Recorded mint for avatar ${avatarId} era ${era}: ${nftMint}`);
}

/**
 * Get lineage history for an avatar
 */
export async function getLineageHistory(avatarId: string): Promise<Array<{
  era: number;
  walletAddress: string;
  nftMint: string;
  mintedAt: number;
}>> {
  const result = await dynamoClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :eraPrefix)',
    ExpressionAttributeValues: {
      ':pk': `LINEAGE#${avatarId}`,
      ':eraPrefix': 'ERA#',
    },
    ScanIndexForward: false, // newest era first
  }));

  return (result.Items ?? []).map((item) => ({
    era: Number(item.era ?? String(item.sk).replace('ERA#', '')),
    walletAddress: String(item.walletAddress ?? ''),
    nftMint: String(item.nftMint ?? ''),
    mintedAt: Number(item.mintedAt ?? 0),
  })).filter((item) => Boolean(item.walletAddress && item.nftMint));
}

/**
 * Generate Metaplex metadata JSON for a lineage NFT
 */
export function generateLineageMetadataJson(metadata: LineageMetadata): object {
  return {
    name: `${metadata.avatarName} - Era ${metadata.era}`,
    symbol: 'SWARM',
    description: `Lineage NFT for ${metadata.avatarName}. Era ${metadata.era}${metadata.isGenesis ? ' (Genesis)' : ''}.`,
    image: metadata.avatarUrl || metadata.snapshotUrl,
    external_url: `https://swarm.rati.chat/avatar/${metadata.avatarId}`,
    attributes: [
      { trait_type: 'Avatar', value: metadata.avatarName },
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
