/* eslint-disable no-console -- TODO: migrate to structured logger */
/**
 * NFT Gating Service
 * Verifies wallet holds required NFTs for access and creation gating
 *
 * Gate NFT serves two purposes:
 * 1. HOLDING = Permission to create avatars (1 NFT held = 1 creation slot)
 * 2. BURNING = Permission to abandon an inhabited avatar
 */
import { GetCommand, PutCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { getDynamoClient } from '../dynamo-client.js';
import { fetchAllAssetsByOwner } from './helius-pagination.js';

// Required collection for access (Orb/Gate NFTs)
const GATE_COLLECTION = '8GCAyy5L2o2ZPdQKo3EtYAYNKYT8Y6sqGHweintLTSJ';

// Whitelisted NFT collections whose NFTs can be claimed as avatars
// Comma-separated list of collection addresses
const WHITELISTED_NFT_COLLECTIONS = (process.env.WHITELISTED_NFT_COLLECTIONS || '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);

// Helius API key - can come from env var or Secrets Manager
let HELIUS_API_KEY_ARN = process.env.HELIUS_API_KEY_ARN;
let heliusApiKey: string | null = process.env.HELIUS_API_KEY || null;
let heliusApiKeyFetched = false;

/**
 * Reset cached Helius state - ONLY for testing
 * Re-reads HELIUS_API_KEY and HELIUS_API_KEY_ARN from process.env.
 * @internal
 */
export function _resetNftGateForTesting(): void {
  HELIUS_API_KEY_ARN = process.env.HELIUS_API_KEY_ARN;
  heliusApiKey = process.env.HELIUS_API_KEY || null;
  heliusApiKeyFetched = false;
}

const secretsClient = new SecretsManagerClient({});

async function getHeliusApiKey(): Promise<string | null> {
  // If we already have it from env, use it
  if (heliusApiKey) return heliusApiKey;
  
  // If we've already tried fetching, don't retry
  if (heliusApiKeyFetched) return null;
  heliusApiKeyFetched = true;
  
  // Try to fetch from Secrets Manager
  if (HELIUS_API_KEY_ARN) {
    try {
      const response = await secretsClient.send(new GetSecretValueCommand({
        SecretId: HELIUS_API_KEY_ARN,
      }));
      heliusApiKey = response.SecretString || null;
      return heliusApiKey;
    } catch (error) {
      console.error('[NFTGate] Failed to fetch Helius API key from Secrets Manager:', error instanceof Error ? error.message : String(error));
    }
  }
  
  return null;
}

export async function getHeliusRpcUrl(): Promise<string | null> {
  const apiKey = await getHeliusApiKey();
  // DAS API methods like getAssetsByOwner only work with Helius, not public RPC
  return apiKey
    ? `https://mainnet.helius-rpc.com/?api-key=${apiKey}`
    : null;
}

const ADMIN_TABLE = process.env.ADMIN_TABLE!;
const CREATOR_STATS_SK = 'STATS';
const dynamoClient = getDynamoClient();

function creatorStatsKey(walletAddress: string): { pk: string; sk: string } {
  return {
    pk: `CREATOR#${walletAddress}`,
    sk: CREATOR_STATS_SK,
  };
}

export interface ReserveCreatorSlotDeps {
  dynamoClient?: Pick<typeof dynamoClient, 'send'>;
  tableName?: string;
  now?: () => number;
}

export interface ReserveCreatorSlotResult {
  reserved: boolean;
  previousCreated: number;
}

/**
 * Atomically reserve a creator slot.
 *
 * This prevents race conditions where concurrent avatar creations can exceed
 * the wallet's available slots.
 */
export async function reserveCreatorSlot(
  walletAddress: string,
  totalSlots: number,
  deps?: ReserveCreatorSlotDeps
): Promise<ReserveCreatorSlotResult> {
  const resolvedClient = deps?.dynamoClient ?? dynamoClient;
  const resolvedTable = deps?.tableName ?? ADMIN_TABLE;
  const now = deps?.now?.() ?? Date.now();

  async function attempt(): Promise<ReserveCreatorSlotResult> {
    try {
      const result = await resolvedClient.send(
        new UpdateCommand({
          TableName: resolvedTable,
          Key: creatorStatsKey(walletAddress),
          UpdateExpression:
            'SET avatarsCreated = if_not_exists(avatarsCreated, :zero) + :one, updatedAt = :now',
          ConditionExpression:
            'attribute_not_exists(avatarsCreated) OR avatarsCreated < :totalSlots',
          ExpressionAttributeValues: {
            ':zero': 0,
            ':one': 1,
            ':now': now,
            ':totalSlots': totalSlots,
          },
          ReturnValues: 'UPDATED_OLD',
        })
      );

      const previousCreated =
        typeof (result.Attributes as { avatarsCreated?: unknown } | undefined)?.avatarsCreated === 'number'
          ? ((result.Attributes as { avatarsCreated: number }).avatarsCreated)
          : 0;

      return { reserved: true, previousCreated };
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
        return { reserved: false, previousCreated: 0 };
      }
      throw err;
    }
  }

  // First attempt; if stats are stale, recalculate once and retry.
  const first = await attempt();
  if (first.reserved) return first;

  await recalculateCreatorCount(walletAddress);
  return attempt();
}

async function recalculateCreatorCount(walletAddress: string): Promise<number> {
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

  const count = result.Count || 0;

  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: {
      ...creatorStatsKey(walletAddress),
      avatarsCreated: count,
      updatedAt: Date.now(),
    },
  }));

  return count;
}

export async function incrementCreatorCount(walletAddress: string): Promise<void> {
  try {
    await dynamoClient.send(new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: creatorStatsKey(walletAddress),
      UpdateExpression: 'SET avatarsCreated = if_not_exists(avatarsCreated, :zero) + :one, updatedAt = :now',
      ExpressionAttributeValues: {
        ':zero': 0,
        ':one': 1,
        ':now': Date.now(),
      },
    }));
  } catch (error) {
    console.warn('[NFTGate] Failed to increment creator count, recalculating', error instanceof Error ? error.message : String(error));
    await recalculateCreatorCount(walletAddress).catch((recalcError) => {
      console.error('[NFTGate] Failed to recalculate creator count', recalcError instanceof Error ? recalcError.message : String(recalcError));
    });
  }
}

export async function decrementCreatorCount(walletAddress: string): Promise<void> {
  try {
    const stats = await dynamoClient.send(new GetCommand({
      TableName: ADMIN_TABLE,
      Key: creatorStatsKey(walletAddress),
    }));

    const current = typeof stats.Item?.avatarsCreated === 'number'
      ? stats.Item.avatarsCreated as number
      : null;

    if (current === null) {
      await recalculateCreatorCount(walletAddress);
      return;
    }

    const nextCount = Math.max(0, current - 1);
    await dynamoClient.send(new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: creatorStatsKey(walletAddress),
      UpdateExpression: 'SET avatarsCreated = :next, updatedAt = :now',
      ExpressionAttributeValues: {
        ':next': nextCount,
        ':now': Date.now(),
      },
    }));
  } catch (error) {
    console.warn('[NFTGate] Failed to decrement creator count, recalculating', error instanceof Error ? error.message : String(error));
    await recalculateCreatorCount(walletAddress).catch((recalcError) => {
      console.error('[NFTGate] Failed to recalculate creator count', recalcError instanceof Error ? recalcError.message : String(recalcError));
    });
  }
}

export interface NFTAsset {
  id: string;
  content: {
    metadata: {
      name: string;
      symbol?: string;
      description?: string;
      attributes?: Array<{
        trait_type: string;
        value: string;
      }>;
    };
    json_uri?: string;  // URI to off-chain metadata
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

/**
 * Full off-chain NFT metadata (fetched from json_uri)
 */
export interface NFTMetadata {
  name: string;
  description?: string;
  image?: string;
  attributes?: Array<{
    trait_type: string;
    value: string;
  }>;
  // Additional fields specific to collections
  [key: string]: unknown;
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
  avatarsCreated: number;
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

  const environment = (process.env.ENVIRONMENT || '').trim().toLowerCase();
  const gatingDisabled = (process.env.DISABLE_NFT_GATE || '').trim().toLowerCase() === 'true';
  const isDevLikeEnv = !environment || ['dev', 'local', 'test'].includes(environment);
  const shouldBypassGate = gatingDisabled || isDevLikeEnv;

  try {
    // Use Helius DAS API to get NFTs by owner filtered by collection
    const heliusRpcUrl = await getHeliusRpcUrl();
    
    // If no Helius API key, we cannot verify holdings.
    // In prod-like environments, fail closed (treat as 0 Orbs).
    // In dev-like environments (or when explicitly disabled), allow all users.
    if (!heliusRpcUrl) {
      if (shouldBypassGate) {
        console.log('[NFTGate] No Helius API key configured, NFT gating bypassed - allowing access');
        result.allowed = true;
        result.ownedCount = 999; // Grant unlimited slots when gating is bypassed
        return result;
      }

      console.error('[NFTGate] No Helius API key configured in a prod-like environment; treating as 0 Orbs');
      result.error = 'Helius API key not configured';
      return result;
    }
    
    const assets = await fetchAllAssetsByOwner(heliusRpcUrl, walletAddress, {
      displayOptions: { showCollectionMetadata: true },
    }) as NFTAsset[];

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
    console.error('[NFTGate] Error checking NFT ownership:', error instanceof Error ? error.message : String(error));
    result.error = 'Failed to verify NFT ownership';
    return result;
  }
}

/**
 * Count avatars created by a wallet
 */
export async function countAvatarsCreatedBy(walletAddress: string): Promise<number> {
  try {
    const stats = await dynamoClient.send(new GetCommand({
      TableName: ADMIN_TABLE,
      Key: creatorStatsKey(walletAddress),
    }));

    if (typeof stats.Item?.avatarsCreated === 'number') {
      return stats.Item.avatarsCreated as number;
    }
  } catch (error) {
    console.warn('[NFTGate] Failed to read creator stats, recalculating', error instanceof Error ? error.message : String(error));
  }

  try {
    return await recalculateCreatorCount(walletAddress);
  } catch (scanError) {
    console.error('[NFTGate] Error counting avatars:', scanError);
    return 0;
  }
}

/**
 * Get full gate status for a wallet
 * Used for creation gating and abandonment checks
 * 
 * Every wallet gets 1 free avatar slot. Additional slots require holding Orb NFTs.
 * Formula: availableSlots = (1 + nftsHeld) - avatarsCreated
 */
export async function getGateStatus(walletAddress: string): Promise<GateStatus> {
  // Get NFT count from on-chain
  const nftResult = await checkNFTGate(walletAddress);
  const nftsHeld = nftResult.ownedCount;

  // Get avatars created by this wallet from DynamoDB
  const avatarsCreated = await countAvatarsCreatedBy(walletAddress);

  // Every wallet gets 1 free slot + 1 slot per NFT held
  const FREE_SLOTS = 1;
  const totalSlots = FREE_SLOTS + nftsHeld;
  const availableSlots = Math.max(0, totalSlots - avatarsCreated);

  return {
    nftsHeld,
    avatarsCreated,
    availableSlots,
    canCreate: availableSlots > 0,
    // Can abandon if holding at least 1 NFT (to receive lineage NFT)
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

// =============================================================================
// NFT Collection Avatar Support
// =============================================================================

/**
 * An NFT from a whitelisted collection that can be claimed as an avatar
 */
export interface ClaimableNFT {
  mint: string;              // Solana mint address
  name: string;              // NFT name from metadata
  image: string;             // Image URL
  collection: string;        // Collection address
  collectionName?: string;   // Collection name if available
  // Rich metadata from off-chain JSON
  description?: string;      // Character description/backstory
  personality?: string;      // Personality trait (for avatar persona)
  attributes?: Array<{       // All NFT attributes
    trait_type: string;
    value: string;
  }>;
}

/**
 * Get list of whitelisted NFT collections
 */
export function getWhitelistedCollections(): string[] {
  return [...WHITELISTED_NFT_COLLECTIONS];
}

/**
 * Check if a collection is whitelisted for avatar claiming
 */
export function isCollectionWhitelisted(collection: string): boolean {
  return WHITELISTED_NFT_COLLECTIONS.includes(collection);
}

/**
 * Fetch off-chain metadata from a JSON URI
 * Handles IPFS and HTTP URIs
 */
async function fetchNFTMetadata(jsonUri: string): Promise<NFTMetadata | null> {
  try {
    // Convert IPFS URIs to HTTP gateway
    let url = jsonUri;
    if (url.startsWith('ipfs://')) {
      url = `https://nftstorage.link/ipfs/${url.slice(7)}`;
    }

    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000), // 5 second timeout
    });

    if (!response.ok) {
      return null;
    }

    const metadata = await response.json() as NFTMetadata;
    return metadata;
  } catch {
    // Silently fail - metadata is optional enrichment
    return null;
  }
}

/**
 * Get NFTs from whitelisted collections that can be claimed as avatars
 * Filters out NFTs that have already been claimed
 */
export async function getClaimableNFTs(walletAddress: string): Promise<ClaimableNFT[]> {
  // If no whitelisted collections, return empty
  if (WHITELISTED_NFT_COLLECTIONS.length === 0) {
    console.log('[NFTGate] No whitelisted collections configured');
    return [];
  }

  const heliusRpcUrl = await getHeliusRpcUrl();
  if (!heliusRpcUrl) {
    console.log('[NFTGate] No Helius API key configured, cannot fetch NFTs');
    return [];
  }

  try {
    // 1. Get all NFTs owned by wallet (paginated)
    const assets = await fetchAllAssetsByOwner(heliusRpcUrl, walletAddress, {
      displayOptions: { showCollectionMetadata: true },
    }) as NFTAsset[];

    // 2. Filter for NFTs in whitelisted collections
    const whitelistedNFTs = assets.filter((asset) => {
      const collection = asset.grouping?.find((g) => g.group_key === 'collection');
      return collection && WHITELISTED_NFT_COLLECTIONS.includes(collection.group_value);
    });

    if (whitelistedNFTs.length === 0) {
      console.log(`[NFTGate] Wallet ${walletAddress.slice(0, 8)}... owns no NFTs from whitelisted collections`);
      return [];
    }

    // 3. Get already-claimed NFT mints from DynamoDB
    const claimedMints = await getClaimedNFTMints();

    // 4. Filter out already-claimed NFTs and fetch full metadata
    const unclaimedNFTs = whitelistedNFTs.filter((nft) => !claimedMints.has(nft.id));

    // 5. Fetch off-chain metadata for each NFT (in parallel, with limit)
    const claimableNFTs: ClaimableNFT[] = await Promise.all(
      unclaimedNFTs.map(async (nft) => {
        const collection = nft.grouping?.find((g) => g.group_key === 'collection');
        const baseNFT: ClaimableNFT = {
          mint: nft.id,
          name: nft.content?.metadata?.name || 'Unknown',
          image: nft.content?.links?.image || nft.content?.files?.[0]?.cdn_uri || '',
          collection: collection?.group_value || '',
          collectionName: undefined,
          description: nft.content?.metadata?.description,
          attributes: nft.content?.metadata?.attributes,
        };

        // Try to fetch off-chain metadata for richer data
        const jsonUri = nft.content?.json_uri;
        if (jsonUri) {
          try {
            const metadata = await fetchNFTMetadata(jsonUri);
            if (metadata) {
              // Use off-chain metadata if richer
              baseNFT.name = metadata.name || baseNFT.name;
              baseNFT.description = metadata.description || baseNFT.description;
              baseNFT.image = metadata.image || baseNFT.image;
              baseNFT.attributes = metadata.attributes || baseNFT.attributes;

              // Extract personality from attributes
              const personalityAttr = metadata.attributes?.find(
                (attr) => attr.trait_type?.toLowerCase() === 'personality'
              );
              if (personalityAttr) {
                baseNFT.personality = personalityAttr.value;
              }
            }
          } catch (err) {
            console.warn(`[NFTGate] Failed to fetch metadata for ${nft.id}:`, err instanceof Error ? err.message : String(err));
          }
        }

        return baseNFT;
      })
    );

    console.log(
      `[NFTGate] Wallet ${walletAddress.slice(0, 8)}... has ${claimableNFTs.length} claimable NFTs from ${whitelistedNFTs.length} whitelisted`
    );

    return claimableNFTs;
  } catch (error) {
    console.error('[NFTGate] Error fetching claimable NFTs:', error instanceof Error ? error.message : String(error));
    return [];
  }
}

/**
 * Get all NFT mints that have already been claimed as avatars
 */
async function getClaimedNFTMints(): Promise<Set<string>> {
  try {
    const result = await dynamoClient.send(new ScanCommand({
      TableName: ADMIN_TABLE,
      FilterExpression: 'sk = :sk AND attribute_exists(nftMint) AND #status <> :deleted',
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':sk': 'CONFIG',
        ':deleted': 'deleted',
      },
      ProjectionExpression: 'nftMint',
    }));

    const mints = new Set<string>();
    for (const item of result.Items || []) {
      if (item.nftMint) {
        mints.add(item.nftMint as string);
      }
    }
    return mints;
  } catch (error) {
    console.error('[NFTGate] Error fetching claimed NFT mints:', error instanceof Error ? error.message : String(error));
    return new Set();
  }
}

/**
 * Verify that a wallet currently owns a specific NFT.
 * Used to check ownership before allowing access to NFT-backed avatars.
 *
 * NOTE: This performs an unconditional Helius RPC call. For request-path
 * checks (chat, avatar GET/PUT, OpenAI-compat completions) use
 * `services/nft-ownership-cache.ts::getCachedNFTOwner` instead — it adds a
 * short-TTL cache so we don't hit Helius on every access. This raw helper
 * is retained for claim-time verification, where a cold check is required.
 * See #1385 for the enforcement wiring.
 */
export async function verifyNFTOwnership(
  walletAddress: string,
  mintAddress: string
): Promise<boolean> {
  const heliusRpcUrl = await getHeliusRpcUrl();
  if (!heliusRpcUrl) {
    console.log('[NFTGate] No Helius API key configured, cannot verify NFT ownership');
    return false;
  }

  try {
    // Use getAsset to get current owner
    const response = await fetch(heliusRpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'verify-nft-owner',
        method: 'getAsset',
        params: {
          id: mintAddress,
        },
      }),
    });

    if (!response.ok) {
      console.error(`[NFTGate] Helius API error verifying NFT ownership: ${response.status}`);
      return false;
    }

    const data = await response.json() as {
      error?: { message?: string };
      result?: NFTAsset;
    };

    if (data.error) {
      console.error('[NFTGate] RPC error:', data.error);
      return false;
    }

    const asset = data.result;
    if (!asset) {
      console.log(`[NFTGate] NFT ${mintAddress} not found`);
      return false;
    }

    const currentOwner = asset.ownership?.owner;
    const isOwner = currentOwner === walletAddress;

    console.log(
      `[NFTGate] NFT ${mintAddress.slice(0, 8)}... ownership check: expected=${walletAddress.slice(0, 8)}..., actual=${currentOwner?.slice(0, 8)}..., match=${isOwner}`
    );

    return isOwner;
  } catch (error) {
    console.error('[NFTGate] Error verifying NFT ownership:', error instanceof Error ? error.message : String(error));
    return false;
  }
}

/**
 * Check if an NFT mint has already been claimed as an avatar
 */
export async function isNFTClaimed(mintAddress: string): Promise<boolean> {
  const claimedMints = await getClaimedNFTMints();
  return claimedMints.has(mintAddress);
}
