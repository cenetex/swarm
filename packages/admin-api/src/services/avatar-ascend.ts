/**
 * Avatar Ascension Service
 *
 * Enables avatars to be permanently "ascended" by burning an Orb NFT + RATI tokens.
 * Ascended avatars:
 * - Have their persona and profile image permanently locked
 * - Are owned by whoever holds the Ascension NFT (tradeable identity)
 * - Gain +50% max energy and +50% regen rate
 *
 * Flow:
 * 1. User calls preflight to check requirements and get burn amounts
 * 2. User burns Orb NFT and RATI tokens on-chain (client-side)
 * 3. User submits burn signatures to backend
 * 4. Backend verifies both burns on-chain
 * 5. Backend prepares NFT metadata for client to mint
 * 6. Client mints Ascension NFT using Metaplex
 * 7. Client submits NFT mint address to finalize ascension
 */
import { Connection, type VersionedTransactionResponse } from '@solana/web3.js';
import {
  GetCommand,
  UpdateCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  RATI_MINT,
  GATE_COLLECTION,
  ASCENSION_ENERGY_BOOST,
  getAscensionCost,
  getTierForBurnAmount,
} from '@swarm/core';
import type { AvatarRecord, PlanType } from '../types.js';
import { getBurnStats } from './web3/burn-stats.js';
import { getEntitlement, setEntitlement } from './billing/entitlements.js';
import {
  getEffectiveLimitsForAvatar,
  toRuntimeLimits,
  syncRuntimeLimitsToState,
} from './billing/runtime-limits.js';
import { getDynamoClient } from './dynamo-client.js';
import { fetchAllAssetsByOwner } from './web3/helius-pagination.js';
import { createSystemLogger } from './structured-logger.js';

const log = createSystemLogger('avatar-ascend');

const TABLE_NAME = process.env.ADMIN_TABLE || 'SwarmAdminTable';

function getHeliusApiKey(): string | undefined {
  return process.env.HELIUS_API_KEY;
}

function getHeliusRpcUrl(): string {
  const key = getHeliusApiKey();
  return key
    ? `https://mainnet.helius-rpc.com/?api-key=${key}`
    : 'https://api.mainnet-beta.solana.com';
}

function getHeliusTxUrl(): string | null {
  const key = getHeliusApiKey();
  return key
    ? `https://api.helius.xyz/v0/transactions/?api-key=${key}`
    : null;
}

let _connection: Connection | null = null;
function getConnection(): Connection {
  if (!_connection) {
    _connection = new Connection(getHeliusRpcUrl(), 'confirmed');
  }
  return _connection;
}

// =============================================================================
// Types
// =============================================================================

export interface AscensionPreflightResult {
  canAscend: boolean;
  avatarId: string;
  avatarName: string;
  isInhabitant: boolean;
  isAlreadyAscended: boolean;
  currentTier: number;
  currentTierName: string;
  requiredRatiBurn: number;
  hasOrb: boolean;
  profileImageUrl?: string;
  error?: string;
  errorCode?: 'NOT_INHABITANT' | 'ALREADY_ASCENDED' | 'NO_ORB' | 'AVATAR_NOT_FOUND';
}

export interface BurnVerificationResult {
  verified: boolean;
  signature?: string;
  burnedMint?: string;
  burnedAmount?: number;
  error?: string;
}

export interface AscensionExecutionResult {
  success: boolean;
  avatarId?: string;
  avatarName?: string;
  ascendedNftMint?: string;
  ascendedAt?: number;
  error?: string;
  errorCode?: string;
}

export interface AscensionMetadata {
  name: string;
  symbol: string;
  description: string;
  image: string;
  external_url: string;
  attributes: Array<{
    trait_type: string;
    value: string | number | boolean;
  }>;
  properties: {
    category: string;
    creators: Array<{
      address: string;
      share: number;
    }>;
  };
}

// =============================================================================
// Helper Functions
// =============================================================================

type HeliusParsedTransaction = {
  type?: string;
  description?: string;
  events?: {
    nft?: Record<string, unknown>;
  };
  tokenTransfers?: Array<{
    mint?: string;
    fromTokenAccount?: string;
    toTokenAccount?: string;
    tokenAmount?: number;
  }>;
};

type HeliusAsset = {
  ownership?: { owner?: string };
  content?: {
    metadata?: {
      name?: string;
      symbol?: string;
    };
    json_uri?: string;
  };
  grouping?: Array<{
    group_key: string;
    group_value: string;
  }>;
};

type OffchainAscensionMetadata = {
  external_url?: string;
  attributes?: Array<{
    trait_type?: string;
    value?: string | number | boolean;
  }>;
  properties?: {
    creators?: Array<{
      address?: string;
      share?: number;
    }>;
  };
};

async function fetchHeliusParsedTransaction(signature: string): Promise<HeliusParsedTransaction | null> {
  if (!getHeliusTxUrl()) return null;

  try {
    const response = await fetch(getHeliusTxUrl()!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactions: [signature] }),
    });

    if (!response.ok) {
      log.warn('helius', 'transaction_parse_failed', { status: response.status });
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
    log.warn('helius', 'transaction_parse_error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function getAsset(mint: string): Promise<HeliusAsset | null> {
  if (!getHeliusApiKey()) return null;

  try {
    const response = await fetch(getHeliusRpcUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'ascend-get-asset',
        method: 'getAsset',
        params: { id: mint },
      }),
    });

    if (!response.ok) {
      log.warn('helius', 'get_asset_failed', { status: response.status });
      return null;
    }

    const data = await response.json() as {
      error?: { message?: string };
      result?: HeliusAsset;
    };

    if (data.error) {
      log.warn('helius', 'get_asset_error', {
        error: data.error.message || data.error,
      });
      return null;
    }

    return data.result || null;
  } catch (error) {
    log.warn('helius', 'get_asset_error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function getAssetCollection(mint: string): Promise<string | null> {
  const asset = await getAsset(mint);
  if (!asset) return null;

  try {
    const grouping = asset.grouping || [];
    const collection = grouping.find((group) => group.group_key === 'collection');
    return collection?.group_value || null;
  } catch (error) {
    log.warn('helius', 'get_asset_error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Get the current owner of an NFT
 */
export async function getNftOwner(mint: string): Promise<string | null> {
  const asset = await getAsset(mint);
  return asset?.ownership?.owner || null;
}

async function getAscensionAvatar(avatarId: string): Promise<AvatarRecord | null> {
  const result = await getDynamoClient().send(new GetCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: `AVATAR#${avatarId}`,
      sk: 'CONFIG',
    },
  }));

  return (result.Item as AvatarRecord) || null;
}

async function fetchOffchainAscensionMetadata(jsonUri: string): Promise<OffchainAscensionMetadata | null> {
  try {
    const response = await fetch(jsonUri);
    if (!response.ok) {
      log.warn('metadata', 'fetch_offchain_failed', { status: response.status });
      return null;
    }
    return await response.json() as OffchainAscensionMetadata;
  } catch (error) {
    log.warn('metadata', 'fetch_offchain_error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function validateAscensionNftMint(
  avatarId: string,
  walletAddress: string,
  nftMint: string
): Promise<{ valid: boolean; owner?: string | null; error?: string }> {
  const avatar = await getAscensionAvatar(avatarId);
  if (!avatar) {
    return { valid: false, error: 'Avatar not found' };
  }

  const asset = await getAsset(nftMint);
  if (!asset) {
    return { valid: false, error: 'Ascension NFT mint not found on-chain' };
  }

  const owner = asset.ownership?.owner || null;
  if (owner !== walletAddress) {
    return { valid: false, owner, error: 'Ascension NFT is not owned by your wallet' };
  }

  const expectedName = `${avatar.name} (Ascended)`;
  const assetName = asset.content?.metadata?.name;
  if (assetName !== expectedName) {
    return { valid: false, owner, error: 'Ascension NFT metadata does not match avatar' };
  }

  const assetSymbol = asset.content?.metadata?.symbol;
  if (assetSymbol && assetSymbol !== 'ASCEND') {
    return { valid: false, owner, error: 'Ascension NFT metadata does not match avatar' };
  }

  const jsonUri = asset.content?.json_uri;
  if (!jsonUri) {
    return { valid: false, owner, error: 'Ascension NFT metadata is missing avatar linkage' };
  }

  const metadata = await fetchOffchainAscensionMetadata(jsonUri);
  if (!metadata) {
    return { valid: false, owner, error: 'Ascension NFT metadata is missing avatar linkage' };
  }

  const avatarIdAttribute = metadata.attributes?.find((attribute) =>
    attribute.trait_type?.toLowerCase() === 'avatar id'
  );
  const externalUrlMatches = metadata.external_url === `https://rati.chat/avatar/${avatar.avatarId}`;
  const avatarIdMatches = String(avatarIdAttribute?.value ?? '') === avatar.avatarId;
  const creatorMatches = metadata.properties?.creators?.some((creator) => creator.address === walletAddress) ?? false;

  if (!externalUrlMatches || !avatarIdMatches || !creatorMatches) {
    return { valid: false, owner, error: 'Ascension NFT metadata is not linked to this avatar' };
  }

  return { valid: true, owner };
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

    const hasNonZero = postForMint.some((post) => {
      const amount = post.uiTokenAmount;
      if (typeof amount?.uiAmount === 'number') {
        return amount.uiAmount > 0;
      }
      return amount?.amount !== '0';
    });
    if (!hasNonZero) {
      burnedMints.add(balance.mint);
    }
  }

  return [...burnedMints];
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

  return null;
}

// =============================================================================
// Check Orb Ownership
// =============================================================================

async function checkOrbOwnership(walletAddress: string): Promise<{
  hasOrb: boolean;
  ownedOrbs: Array<{ id: string; name: string }>;
}> {
  if (!getHeliusApiKey()) {
    return { hasOrb: false, ownedOrbs: [] };
  }

  try {
    const assets = await fetchAllAssetsByOwner(getHeliusRpcUrl(), walletAddress);

    const orbs = assets.filter((asset) => {
      const collection = asset.grouping?.find((g) => g.group_key === 'collection');
      return collection?.group_value === GATE_COLLECTION;
    });

    return {
      hasOrb: orbs.length > 0,
      ownedOrbs: orbs.map((o) => ({
        id: o.id,
        name: o.content?.metadata?.name || 'Unknown Orb',
      })),
    };
  } catch (error) {
    log.warn('orb', 'check_ownership_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { hasOrb: false, ownedOrbs: [] };
  }
}

// =============================================================================
// Preflight Check
// =============================================================================

/**
 * Check if an avatar can be ascended and calculate requirements
 */
export async function preflightAscend(
  avatarId: string,
  walletAddress: string
): Promise<AscensionPreflightResult> {
  // Get the avatar
  const avatarResult = await getDynamoClient().send(new GetCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: `AVATAR#${avatarId}`,
      sk: 'CONFIG',
    },
  }));

  if (!avatarResult.Item) {
    return {
      canAscend: false,
      avatarId,
      avatarName: '',
      isInhabitant: false,
      isAlreadyAscended: false,
      currentTier: 0,
      currentTierName: 'Spark',
      requiredRatiBurn: 0,
      hasOrb: false,
      error: 'Avatar not found',
      errorCode: 'AVATAR_NOT_FOUND',
    };
  }

  const avatar = avatarResult.Item as AvatarRecord;

  // Check if already ascended
  if (avatar.isAscended) {
    return {
      canAscend: false,
      avatarId,
      avatarName: avatar.name,
      isInhabitant: avatar.creatorWallet === walletAddress,
      isAlreadyAscended: true,
      currentTier: 0,
      currentTierName: '',
      requiredRatiBurn: 0,
      hasOrb: false,
      profileImageUrl: avatar.profileImage?.url,
      error: 'Avatar is already ascended',
      errorCode: 'ALREADY_ASCENDED',
    };
  }

  // Check if wallet is the creator
  const isInhabitant = avatar.creatorWallet === walletAddress;
  if (!isInhabitant) {
    return {
      canAscend: false,
      avatarId,
      avatarName: avatar.name,
      isInhabitant: false,
      isAlreadyAscended: false,
      currentTier: 0,
      currentTierName: '',
      requiredRatiBurn: 0,
      hasOrb: false,
      profileImageUrl: avatar.profileImage?.url,
      error: 'Only the avatar creator can ascend this avatar',
      errorCode: 'NOT_INHABITANT',
    };
  }

  // Check orb ownership
  const orbStatus = await checkOrbOwnership(walletAddress);
  if (!orbStatus.hasOrb) {
    return {
      canAscend: false,
      avatarId,
      avatarName: avatar.name,
      isInhabitant: true,
      isAlreadyAscended: false,
      currentTier: 0,
      currentTierName: '',
      requiredRatiBurn: 0,
      hasOrb: false,
      profileImageUrl: avatar.profileImage?.url,
      error: 'You need to hold an Orb NFT to ascend. Burn 1 Orb as part of the ascension.',
      errorCode: 'NO_ORB',
    };
  }

  // Get burn stats to calculate tier and required burn
  const burnStats = await getBurnStats(avatarId);
  const ascensionCost = getAscensionCost(burnStats.totalBurned);

  return {
    canAscend: true,
    avatarId,
    avatarName: avatar.name,
    isInhabitant: true,
    isAlreadyAscended: false,
    currentTier: ascensionCost.currentTier.tier,
    currentTierName: ascensionCost.currentTier.name,
    requiredRatiBurn: ascensionCost.ratiBurnRequired,
    hasOrb: true,
    profileImageUrl: avatar.profileImage?.url,
  };
}

// =============================================================================
// Burn Verification
// =============================================================================

/**
 * Verify an Orb NFT burn transaction
 */
export async function verifyOrbBurn(
  walletAddress: string,
  signature: string
): Promise<BurnVerificationResult> {
  try {
    if (!getHeliusApiKey()) {
      return { verified: false, error: 'HELIUS_API_KEY not configured for burn verification' };
    }

    const tx = await getConnection().getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
    });

    if (!tx) {
      return { verified: false, error: 'Transaction not found' };
    }

    if (!tx.meta || tx.meta.err) {
      return { verified: false, error: 'Transaction failed or not confirmed' };
    }

    const accountKeys = tx.transaction.message.getAccountKeys();
    const accounts = accountKeys.staticAccountKeys.map((k) => k.toBase58());

    if (!accounts.includes(walletAddress)) {
      return { verified: false, error: 'Wallet not involved in transaction' };
    }

    const [heliusParsedTx, burnedMints] = await Promise.all([
      fetchHeliusParsedTransaction(signature),
      Promise.resolve(extractBurnedMints(tx)),
    ]);

    if (burnedMints.length === 0) {
      return { verified: false, error: 'No NFT burn detected in transaction' };
    }

    // Check if any burned mint is from the Gate collection
    const heliusCollection = extractHeliusCollection(heliusParsedTx);
    if (heliusCollection === GATE_COLLECTION) {
      log.info('burn', 'orb_burn_verified_by_collection', {
        walletPrefix: walletAddress.slice(0, 8),
      });
      return {
        verified: true,
        signature,
        burnedMint: burnedMints[0],
      };
    }

    // Fall back to checking each mint's collection
    for (const mint of burnedMints) {
      const collection = await getAssetCollection(mint);
      if (collection === GATE_COLLECTION) {
        log.info('burn', 'orb_burn_verified_by_mint', {
          mint,
          walletPrefix: walletAddress.slice(0, 8),
        });
        return {
          verified: true,
          signature,
          burnedMint: mint,
        };
      }
    }

    return { verified: false, error: 'Burned NFT is not from the Orb/Gate collection' };
  } catch (error) {
    log.error('burn', 'orb_burn_verification_error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { verified: false, error: 'Failed to verify orb burn transaction' };
  }
}

/**
 * Verify a RATI token burn transaction
 */
export async function verifyRatiBurn(
  walletAddress: string,
  signature: string,
  expectedAmount: number
): Promise<BurnVerificationResult> {
  try {
    const tx = await getConnection().getTransaction(signature, {
      maxSupportedTransactionVersion: 0,
    });

    if (!tx) {
      return { verified: false, error: 'Transaction not found' };
    }

    if (!tx.meta || tx.meta.err) {
      return { verified: false, error: 'Transaction failed or not confirmed' };
    }

    const accountKeys = tx.transaction.message.getAccountKeys();
    const accounts = accountKeys.staticAccountKeys.map((k) => k.toBase58());

    if (!accounts.includes(walletAddress)) {
      return { verified: false, error: 'Wallet not involved in transaction' };
    }

    const logMessages = tx.meta.logMessages || [];
    const hasBurnInstruction = logMessages.some((msg) =>
      msg.includes('Instruction: Burn') || msg.includes('Instruction: BurnChecked')
    );
    if (!hasBurnInstruction) {
      return { verified: false, error: 'No SPL token burn instruction detected in transaction' };
    }

    // Extract token balances
    const preBalances = tx.meta.preTokenBalances || [];
    const postBalances = tx.meta.postTokenBalances || [];

    let decimals: number | null = null;
    let totalPreRaw = 0n;
    let totalPostRaw = 0n;

    for (const balance of preBalances) {
      if (balance.mint !== RATI_MINT) continue;
      if (balance.owner !== walletAddress) continue;
      const amountRaw = balance.uiTokenAmount?.amount;
      if (typeof amountRaw !== 'string') continue;
      totalPreRaw += BigInt(amountRaw);
      if (typeof balance.uiTokenAmount?.decimals === 'number' && decimals === null) {
        decimals = balance.uiTokenAmount.decimals;
      }
    }

    for (const balance of postBalances) {
      if (balance.mint !== RATI_MINT) continue;
      if (balance.owner !== walletAddress) continue;
      const amountRaw = balance.uiTokenAmount?.amount;
      if (typeof amountRaw !== 'string') continue;
      totalPostRaw += BigInt(amountRaw);
      if (typeof balance.uiTokenAmount?.decimals === 'number' && decimals === null) {
        decimals = balance.uiTokenAmount.decimals;
      }
    }

    if (decimals === null) {
      return { verified: false, error: 'Unable to determine RATI token decimals for verification' };
    }

    const burnedRaw = totalPreRaw - totalPostRaw;
    if (burnedRaw <= 0n) {
      return { verified: false, error: 'No RATI burn detected for wallet in transaction' };
    }

    const unit = 10 ** decimals;
    const burnedAmount = Number(burnedRaw) / unit;
    const expectedRaw = BigInt(Math.round(expectedAmount * unit));

    if (burnedRaw < expectedRaw) {
      return {
        verified: false,
        error: `Insufficient RATI burned: ${burnedAmount.toLocaleString()} burned, ${expectedAmount.toLocaleString()} required`,
      };
    }

    log.info('burn', 'rati_burn_verified', {
      burnedAmount,
      walletPrefix: walletAddress.slice(0, 8),
    });
    return {
      verified: true,
      signature,
      burnedMint: RATI_MINT,
      burnedAmount,
    };
  } catch (error) {
    log.error('burn', 'rati_burn_verification_error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { verified: false, error: 'Failed to verify RATI burn transaction' };
  }
}

/**
 * Verify both burns required for ascension
 */
export async function verifyAscensionBurns(
  walletAddress: string,
  orbBurnSignature: string,
  ratiBurnSignature: string,
  expectedRatiAmount: number
): Promise<{
  verified: boolean;
  orbResult: BurnVerificationResult;
  ratiResult: BurnVerificationResult;
  error?: string;
}> {
  const [orbResult, ratiResult] = await Promise.all([
    verifyOrbBurn(walletAddress, orbBurnSignature),
    verifyRatiBurn(walletAddress, ratiBurnSignature, expectedRatiAmount),
  ]);

  const verified = orbResult.verified && ratiResult.verified;
  let error: string | undefined;

  if (!orbResult.verified) {
    error = `Orb burn verification failed: ${orbResult.error}`;
  } else if (!ratiResult.verified) {
    error = `RATI burn verification failed: ${ratiResult.error}`;
  }

  return { verified, orbResult, ratiResult, error };
}

// =============================================================================
// Ascension Entitlement Upgrade
// =============================================================================

/**
 * Plan tier hierarchy for comparison.
 * Higher number = higher tier. Used to prevent downgrading.
 */
const PLAN_TIER_RANK: Record<PlanType, number> = {
  free: 0,
  pro: 1,
  enterprise: 2,
  team: 3,
};

/**
 * Grant Pro-equivalent entitlement limits to an ascended avatar.
 *
 * Ascension is the web3 equivalent of "buying Pro" -- burning an Orb NFT +
 * RATI tokens permanently grants Pro-tier limits.
 *
 * Downgrade protection: if the avatar already has an enterprise entitlement,
 * this is a no-op. Only upgrades from 'free' (or no entitlement) to 'pro'.
 *
 * @returns The entitlement record that was created/updated, or null if
 *          the avatar already had a higher-tier entitlement.
 */
export async function grantAscensionEntitlement(
  avatarId: string,
  walletAddress: string,
): Promise<{ upgraded: boolean; plan: PlanType; reason: string }> {
  const existing = await getEntitlement(avatarId);

  // If the avatar already has an active entitlement at or above 'pro', skip.
  if (existing && (existing.status === 'active' || existing.status === 'trial')) {
    const currentRank = PLAN_TIER_RANK[existing.plan] ?? 0;
    const proRank = PLAN_TIER_RANK.pro;

    if (currentRank >= proRank) {
      log.info('entitlement', 'ascension_upgrade_skipped', {
        avatarId,
        plan: existing.plan,
      });
      return { upgraded: false, plan: existing.plan, reason: `already_${existing.plan}` };
    }
  }

  // Use the wallet address as the accountId for ascension-granted entitlements.
  // This keeps the entitlement tied to the wallet that performed the ascension.
  const accountId = existing?.accountId ?? walletAddress;

  const entitlement = await setEntitlement({
    accountId,
    avatarId,
    plan: 'pro',
    status: 'active',
    actorId: walletAddress,
    entitlementSource: 'ascension',
  });

  // Push the new limits to STATE_TABLE so Lambda handlers pick them up immediately
  const effective = getEffectiveLimitsForAvatar(avatarId, entitlement);
  await syncRuntimeLimitsToState({
    avatarId,
    runtimeLimits: toRuntimeLimits(effective.limits),
    plan: effective.plan,
    source: effective.source,
    entitlementStatus: effective.entitlementStatus,
  });

  log.info('entitlement', 'ascension_entitlement_granted', {
    avatarId,
    plan: 'pro',
    walletPrefix: walletAddress.slice(0, 8),
  });

  return { upgraded: true, plan: 'pro', reason: 'ascension_upgrade' };
}

// =============================================================================
// Execute Ascension
// =============================================================================

/**
 * Execute the ascension after burns are verified
 */
export async function executeAscension(
  avatarId: string,
  walletAddress: string,
  nftMint: string,
  orbBurnSignature: string,
  ratiBurnSignature: string,
  ratiBurnAmount: number
): Promise<AscensionExecutionResult> {
  const now = Date.now();

  try {
    // Update avatar record to mark as ascended
    await getDynamoClient().send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `AVATAR#${avatarId}`,
        sk: 'CONFIG',
      },
      UpdateExpression: `
        SET isAscended = :true,
            ascendedAt = :now,
            ascendedByWallet = :wallet,
            ascendedNftMint = :nftMint,
            ascensionOrbBurnSignature = :orbSig,
            ascensionRatiBurnSignature = :ratiSig,
            ascensionRatiBurnAmount = :ratiAmount,
            updatedAt = :now
      `,
      ConditionExpression: 'attribute_not_exists(isAscended) OR isAscended = :false',
      ExpressionAttributeValues: {
        ':true': true,
        ':false': false,
        ':now': now,
        ':wallet': walletAddress,
        ':nftMint': nftMint,
        ':orbSig': orbBurnSignature,
        ':ratiSig': ratiBurnSignature,
        ':ratiAmount': ratiBurnAmount,
      },
    }));

    // Create ascension NFT mapping for lookup
    await getDynamoClient().send(new PutCommand({
      TableName: TABLE_NAME,
      Item: {
        pk: `ASCENSION_NFT#${nftMint}`,
        sk: 'AVATAR',
        avatarId,
        ascendedAt: now,
        ascendedByWallet: walletAddress,
      },
    }));

    // Get updated avatar for response
    const avatarResult = await getDynamoClient().send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: `AVATAR#${avatarId}`,
        sk: 'CONFIG',
      },
    }));

    const avatar = avatarResult.Item as AvatarRecord;

    // Grant Pro-equivalent entitlement limits (ascension = web3 "buy Pro").
    // Non-fatal: if entitlement grant fails the ascension itself still succeeded.
    try {
      const entitlementResult = await grantAscensionEntitlement(avatarId, walletAddress);
      log.info('ascension', 'entitlement_result', {
        avatarId,
        reason: entitlementResult.reason,
        plan: entitlementResult.plan,
      });
    } catch (entitlementError) {
      log.error('ascension', 'entitlement_grant_failed', {
        avatarId,
        error: entitlementError instanceof Error ? entitlementError.message : String(entitlementError),
      });
    }

    log.info('ascension', 'avatar_ascended', {
      avatarId,
      avatarName: avatar.name,
      walletPrefix: walletAddress.slice(0, 8),
    });

    return {
      success: true,
      avatarId,
      avatarName: avatar.name,
      ascendedNftMint: nftMint,
      ascendedAt: now,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      return {
        success: false,
        error: 'Avatar has already been ascended',
        errorCode: 'ALREADY_ASCENDED',
      };
    }
    log.error('ascension', 'execution_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      error: 'Failed to execute ascension',
      errorCode: 'EXECUTION_FAILED',
    };
  }
}

// =============================================================================
// Metadata Generation
// =============================================================================

/**
 * Generate Metaplex-compatible metadata for the Ascension NFT
 */
export function generateAscensionMetadata(avatar: AvatarRecord): AscensionMetadata {
  const tier = getTierForBurnAmount(avatar.ascensionRatiBurnAmount || 0);

  return {
    name: `${avatar.name} (Ascended)`,
    symbol: 'ASCEND',
    description: `Ascended Avatar NFT for ${avatar.name}. ` +
      `This NFT grants ownership of the avatar - the holder can control this avatar. ` +
      `Persona and profile image are permanently locked.`,
    image: avatar.profileImage?.url || '',
    external_url: `https://rati.chat/avatar/${avatar.avatarId}`,
    attributes: [
      { trait_type: 'Avatar ID', value: avatar.avatarId },
      { trait_type: 'Avatar Name', value: avatar.name },
      { trait_type: 'Ascended At', value: new Date(avatar.ascendedAt || 0).toISOString() },
      { trait_type: 'Ascension Tier', value: tier.name },
      { trait_type: 'RATI Burned', value: avatar.ascensionRatiBurnAmount || 0 },
      { trait_type: 'Energy Boost', value: `+${(ASCENSION_ENERGY_BOOST.maxEnergyMultiplier - 1) * 100}%` },
      { trait_type: 'Persona Locked', value: true },
    ],
    properties: {
      category: 'image',
      creators: [
        { address: avatar.ascendedByWallet || '', share: 100 },
      ],
    },
  };
}

// =============================================================================
// Lookup Functions
// =============================================================================

/**
 * Get an ascended avatar by its NFT mint address
 */
export async function getAscendedAvatarByNft(nftMint: string): Promise<AvatarRecord | null> {
  // First, look up the mapping
  const mappingResult = await getDynamoClient().send(new GetCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: `ASCENSION_NFT#${nftMint}`,
      sk: 'AVATAR',
    },
  }));

  if (!mappingResult.Item) {
    return null;
  }

  const avatarId = mappingResult.Item.avatarId as string;

  // Fetch the avatar
  const avatarResult = await getDynamoClient().send(new GetCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: `AVATAR#${avatarId}`,
      sk: 'CONFIG',
    },
  }));

  return (avatarResult.Item as AvatarRecord) || null;
}

/**
 * Check if a wallet can control an ascended avatar (must hold the NFT)
 */
export async function canInhabitAscendedAvatar(
  avatar: AvatarRecord,
  walletAddress: string
): Promise<{ allowed: boolean; error?: string }> {
  if (!avatar.isAscended || !avatar.ascendedNftMint) {
    // Not ascended, use normal ownership rules
    return { allowed: true };
  }

  const nftOwner = await getNftOwner(avatar.ascendedNftMint);

  if (!nftOwner) {
    return {
      allowed: false,
      error: 'Could not verify Ascension NFT ownership',
    };
  }

  if (nftOwner !== walletAddress) {
    return {
      allowed: false,
      error: `Only the Ascension NFT holder can control this avatar. Current holder: ${nftOwner.slice(0, 8)}...`,
    };
  }

  return { allowed: true };
}

/**
 * Get ascension status for an avatar (for MCP tool)
 */
export async function getAvatarAscensionStatus(avatarId: string): Promise<{
  isAscended: boolean;
  ascendedAt?: number;
  ascendedNftMint?: string;
  ascendedByWallet?: string;
  energyBoost?: {
    maxMultiplier: number;
    regenMultiplier: number;
  };
}> {
  const result = await getDynamoClient().send(new GetCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: `AVATAR#${avatarId}`,
      sk: 'CONFIG',
    },
  }));

  if (!result.Item) {
    return { isAscended: false };
  }

  const avatar = result.Item as AvatarRecord;

  if (!avatar.isAscended) {
    return { isAscended: false };
  }

  return {
    isAscended: true,
    ascendedAt: avatar.ascendedAt,
    ascendedNftMint: avatar.ascendedNftMint,
    ascendedByWallet: avatar.ascendedByWallet,
    energyBoost: {
      maxMultiplier: ASCENSION_ENERGY_BOOST.maxEnergyMultiplier,
      regenMultiplier: ASCENSION_ENERGY_BOOST.regenRateMultiplier,
    },
  };
}
