/**
 * Burn Stats Service
 *
 * Tracks RATI burn statistics per avatar for the tier system.
 * Burns are recorded on-chain (Solana) and cached in DynamoDB for fast access.
 */
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  BURN_TIERS,
  getTierForBurnAmount,
  getNextTier,
  getProgressToNextTier,
  type BurnTier,
} from '@swarm/core';
import { getDynamoClient } from '../dynamo-client.js';

const ADMIN_TABLE = process.env.ADMIN_TABLE!;

const dynamoClient = getDynamoClient();

// =============================================================================
// Types
// =============================================================================

export interface BurnStats {
  avatarId: string;
  totalBurned: number;
  tier: number;
  tierName: string;
  tierEmoji: string;
  maxEnergy: number;
  regenPerHour: number;
  features: readonly string[];
  burnCount: number;
  lastBurnAt?: number;
  lastVerifiedAt: number;
}

export interface BurnRecord {
  avatarId: string;
  signature: string;
  amount: number;
  timestamp: number;
  walletAddress: string;
}

export interface BurnStatsWithProgress extends BurnStats {
  nextTier: BurnTier | null;
  nextTierAt: number | null;
  progressPercent: number;
  rank?: number;
  totalAvatars?: number;
}

export interface LeaderboardEntry {
  avatarId: string;
  totalBurned: number;
  tier: number;
  tierName: string;
  tierEmoji: string;
  rank: number;
}

// =============================================================================
// Core Functions
// =============================================================================

/**
 * Get burn stats for an avatar
 */
export async function getBurnStats(avatarId: string): Promise<BurnStats> {
  const pk = `AVATAR#${avatarId}`;
  const sk = 'BURN_STATS';

  const result = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: { pk, sk },
  }));

  if (result.Item) {
    const item = result.Item;
    const tier = getTierForBurnAmount(item.totalBurned || 0);
    return {
      avatarId,
      totalBurned: item.totalBurned || 0,
      tier: tier.tier,
      tierName: tier.name,
      tierEmoji: tier.emoji,
      maxEnergy: tier.maxEnergy,
      regenPerHour: tier.regenPerHour,
      features: tier.features,
      burnCount: item.burnCount || 0,
      lastBurnAt: item.lastBurnAt,
      lastVerifiedAt: item.lastVerifiedAt || Date.now(),
    };
  }

  // Return default (tier 0) for avatars with no burns
  const tier = BURN_TIERS[0];
  return {
    avatarId,
    totalBurned: 0,
    tier: tier.tier,
    tierName: tier.name,
    tierEmoji: tier.emoji,
    maxEnergy: tier.maxEnergy,
    regenPerHour: tier.regenPerHour,
    features: tier.features,
    burnCount: 0,
    lastVerifiedAt: Date.now(),
  };
}

/**
 * Get burn stats with progress info
 */
export async function getBurnStatsWithProgress(avatarId: string): Promise<BurnStatsWithProgress> {
  const stats = await getBurnStats(avatarId);
  const nextTier = getNextTier(stats.tier);
  const progressPercent = getProgressToNextTier(stats.totalBurned);

  return {
    ...stats,
    nextTier,
    nextTierAt: nextTier?.minBurned ?? null,
    progressPercent,
  };
}

/**
 * Record a burn transaction and update stats
 */
export async function recordBurn(params: {
  avatarId: string;
  signature: string;
  amount: number;
  walletAddress: string;
}): Promise<BurnStats> {
  const { avatarId, signature, amount, walletAddress } = params;
  const now = Date.now();
  const pk = `AVATAR#${avatarId}`;

  // Record the individual burn transaction
  const burnRecordSk = `BURN#${now}#${signature}`;
  try {
    await dynamoClient.send(new PutCommand({
      TableName: ADMIN_TABLE,
      Item: {
        pk,
        sk: burnRecordSk,
        avatarId,
        signature,
        amount,
        walletAddress,
        timestamp: now,
        // Keep burn records for 2 years
        ttl: Math.floor(now / 1000) + (60 * 60 * 24 * 365 * 2),
      },
      // Idempotent - don't overwrite if already recorded
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
  } catch (err: unknown) {
    // Ignore conditional check failures (duplicate burn)
    const error = err as { name?: string };
    if (error.name !== 'ConditionalCheckFailedException') {
      throw err;
    }
  }

  // Update aggregate burn stats
  const result = await dynamoClient.send(new UpdateCommand({
    TableName: ADMIN_TABLE,
    Key: { pk, sk: 'BURN_STATS' },
    UpdateExpression: `
      SET totalBurned = if_not_exists(totalBurned, :zero) + :amount,
          burnCount = if_not_exists(burnCount, :zero) + :one,
          lastBurnAt = :now,
          lastVerifiedAt = :now,
          avatarId = :avatarId
    `,
    ExpressionAttributeValues: {
      ':zero': 0,
      ':one': 1,
      ':amount': amount,
      ':now': now,
      ':avatarId': avatarId,
    },
    ReturnValues: 'ALL_NEW',
  }));

  const totalBurned = result.Attributes?.totalBurned || amount;
  const tier = getTierForBurnAmount(totalBurned);

  // Update leaderboard entry
  await updateLeaderboardEntry(avatarId, totalBurned, tier);

  return {
    avatarId,
    totalBurned,
    tier: tier.tier,
    tierName: tier.name,
    tierEmoji: tier.emoji,
    maxEnergy: tier.maxEnergy,
    regenPerHour: tier.regenPerHour,
    features: tier.features,
    burnCount: result.Attributes?.burnCount || 1,
    lastBurnAt: now,
    lastVerifiedAt: now,
  };
}

/**
 * Get burn history for an avatar
 */
export async function getBurnHistory(
  avatarId: string,
  limit: number = 20
): Promise<BurnRecord[]> {
  const pk = `AVATAR#${avatarId}`;

  const result = await dynamoClient.send(new QueryCommand({
    TableName: ADMIN_TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: {
      ':pk': pk,
      ':prefix': 'BURN#',
    },
    ScanIndexForward: false, // Newest first
    Limit: limit,
  }));

  return (result.Items || []).map(item => ({
    avatarId: item.avatarId,
    signature: item.signature,
    amount: item.amount,
    timestamp: item.timestamp,
    walletAddress: item.walletAddress,
  }));
}

// =============================================================================
// Leaderboard Functions
// =============================================================================

/**
 * Update leaderboard entry for an avatar
 */
async function updateLeaderboardEntry(
  avatarId: string,
  totalBurned: number,
  tier: BurnTier
): Promise<void> {
  // Zero-pad totalBurned for proper string sorting (up to 100B)
  const paddedBurned = totalBurned.toString().padStart(15, '0');

  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: {
      pk: `AVATAR#${avatarId}`,
      sk: 'LEADERBOARD_ENTRY',
      avatarId,
      totalBurned,
      tier: tier.tier,
      tierName: tier.name,
      tierEmoji: tier.emoji,
      // GSI for leaderboard queries
      gsi1pk: 'BURN_LEADERBOARD',
      gsi1sk: `BURNED#${paddedBurned}#${avatarId}`,
      updatedAt: Date.now(),
    },
  }));
}

/**
 * Get burn leaderboard (top burners)
 */
export async function getBurnLeaderboard(limit: number = 100): Promise<LeaderboardEntry[]> {
  const result = await dynamoClient.send(new QueryCommand({
    TableName: ADMIN_TABLE,
    IndexName: 'GSI1',
    KeyConditionExpression: 'gsi1pk = :pk',
    ExpressionAttributeValues: {
      ':pk': 'BURN_LEADERBOARD',
    },
    ScanIndexForward: false, // Highest burns first
    Limit: limit,
  }));

  return (result.Items || []).map((item, index) => ({
    avatarId: item.avatarId,
    totalBurned: item.totalBurned,
    tier: item.tier,
    tierName: item.tierName,
    tierEmoji: item.tierEmoji,
    rank: index + 1,
  }));
}

/**
 * Get rank for a specific avatar
 */
export async function getAvatarRank(avatarId: string): Promise<{ rank: number; totalAvatars: number } | null> {
  const leaderboard = await getBurnLeaderboard(1000); // Get top 1000
  const totalAvatars = leaderboard.length;

  const rank = leaderboard.findIndex(entry => entry.avatarId === avatarId);
  if (rank === -1) {
    return null; // Not on leaderboard (no burns)
  }

  return {
    rank: rank + 1,
    totalAvatars,
  };
}

// =============================================================================
// Tier Requirement Checks
// =============================================================================

/**
 * Check if avatar has required tier for a feature
 */
export async function hasFeatureAccess(
  avatarId: string,
  feature: string
): Promise<{ allowed: boolean; currentTier: number; requiredTier: number; error?: string }> {
  const stats = await getBurnStats(avatarId);

  if (stats.features.includes(feature)) {
    return {
      allowed: true,
      currentTier: stats.tier,
      requiredTier: stats.tier,
    };
  }

  // Find the minimum tier that has this feature
  const requiredTierData = BURN_TIERS.find((t: BurnTier) => t.features.includes(feature));
  if (!requiredTierData) {
    return {
      allowed: false,
      currentTier: stats.tier,
      requiredTier: -1,
      error: `Unknown feature: ${feature}`,
    };
  }

  const burnNeeded = requiredTierData.minBurned - stats.totalBurned;

  return {
    allowed: false,
    currentTier: stats.tier,
    requiredTier: requiredTierData.tier,
    error: `Requires Tier ${requiredTierData.tier} (${requiredTierData.name}). ` +
           `Burn ${burnNeeded.toLocaleString()} more RATI to unlock.`,
  };
}

/**
 * Check if avatar can launch a token (requires tier 3+)
 */
export async function canLaunchToken(avatarId: string): Promise<{
  allowed: boolean;
  tier: number;
  burnNeeded: number;
  error?: string;
}> {
  const result = await hasFeatureAccess(avatarId, 'launch');

  if (result.allowed) {
    return {
      allowed: true,
      tier: result.currentTier,
      burnNeeded: 0,
    };
  }

  const requiredTier = BURN_TIERS.find((t: BurnTier) => t.features.includes('launch'))!;
  const stats = await getBurnStats(avatarId);
  const burnNeeded = requiredTier.minBurned - stats.totalBurned;

  return {
    allowed: false,
    tier: result.currentTier,
    burnNeeded,
    error: `Token launch requires Tier ${requiredTier.tier} (${requiredTier.name}). ` +
           `Burn ${burnNeeded.toLocaleString()} more RATI to unlock.`,
  };
}
