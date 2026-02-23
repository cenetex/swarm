/* eslint-disable no-console -- TODO: migrate to structured logger */
/**
 * Public Profile API Handler
 *
 * Serves public avatar profile data for profile pages.
 * No authentication required - all data is public.
 *
 * GET /api/profile/{avatarId}
 */
import type { APIGatewayProxyHandler, APIGatewayProxyResult } from 'aws-lambda';
import { getAvatar } from '../services/avatars.js';
import {
  getBurnStatsWithProgress,
  getBurnHistory,
  getAvatarRank,
} from '../services/burn-stats.js';
import { getEnergyStatus } from '../services/energy.js';

// =============================================================================
// Types
// =============================================================================

export interface AvatarPublicProfile {
  avatarId: string;
  name: string;
  profileImage?: string;
  description?: string;

  // Burn stats (public)
  burnStats: {
    totalBurned: number;
    tier: number;
    tierName: string;
    tierEmoji: string;
    maxEnergy: number;
    regenPerHour: number;
    features: readonly string[];
    burnCount: number;
    lastBurnAt?: number;
    // Progress
    nextTierName: string | null;
    nextTierAt: number | null;
    progressPercent: number;
    // Rank
    rank: number | null;
    totalAvatars: number | null;
  };

  // Energy (public)
  energy: {
    current: number;
    max: number;
    regenPerHour: number;
    nextRefillIn: number;
  };

  // Token (if launched)
  token?: {
    mint: string;
    symbol: string;
    name: string;
    launchUrl: string;
    launchedAt: number;
  };

  // Social links
  links: {
    twitter?: string;
    telegram?: string;
    website?: string;
  };

  // Wallet (public key only)
  wallet?: {
    address: string;
    solscanUrl: string;
  };

  // Burn history (recent)
  burnHistory: Array<{
    signature: string;
    amount: number;
    timestamp: number;
    solscanUrl: string;
  }>;
}

// =============================================================================
// Helper Functions
// =============================================================================

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };
}

function success(data: unknown): APIGatewayProxyResult {
  return {
    statusCode: 200,
    headers: corsHeaders(),
    body: JSON.stringify(data),
  };
}

function notFound(message: string): APIGatewayProxyResult {
  return {
    statusCode: 404,
    headers: corsHeaders(),
    body: JSON.stringify({ error: message }),
  };
}

function serverError(message: string): APIGatewayProxyResult {
  return {
    statusCode: 500,
    headers: corsHeaders(),
    body: JSON.stringify({ error: message }),
  };
}

// =============================================================================
// Handler
// =============================================================================

export const handler: APIGatewayProxyHandler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: '',
    };
  }

  const avatarId = event.pathParameters?.avatarId;
  if (!avatarId) {
    return notFound('Avatar ID required');
  }

  try {
    // Fetch avatar data
    const avatar = await getAvatar(avatarId);
    if (!avatar) {
      return notFound(`Avatar not found: ${avatarId}`);
    }
    if (avatar.status !== 'active') {
      return notFound('Avatar not found');
    }

    // Fetch burn stats, energy, and history in parallel
    const [burnStats, energyStatus, burnHistory, rankInfo] = await Promise.all([
      getBurnStatsWithProgress(avatarId),
      getEnergyStatus(avatarId).catch(() => null),
      getBurnHistory(avatarId, 10),
      getAvatarRank(avatarId),
    ]);

    // Build profile response
    const profile: AvatarPublicProfile = {
      avatarId: avatar.avatarId,
      name: avatar.name,
      profileImage: typeof avatar.profileImage === 'string'
        ? avatar.profileImage
        : avatar.profileImage?.url,
      description: avatar.description || undefined,

      burnStats: {
        totalBurned: burnStats.totalBurned,
        tier: burnStats.tier,
        tierName: burnStats.tierName,
        tierEmoji: burnStats.tierEmoji,
        maxEnergy: burnStats.maxEnergy,
        regenPerHour: burnStats.regenPerHour,
        features: burnStats.features,
        burnCount: burnStats.burnCount,
        lastBurnAt: burnStats.lastBurnAt,
        nextTierName: burnStats.nextTier?.name ?? null,
        nextTierAt: burnStats.nextTierAt,
        progressPercent: Math.round(burnStats.progressPercent),
        rank: rankInfo?.rank ?? null,
        totalAvatars: rankInfo?.totalAvatars ?? null,
      },

      energy: energyStatus ? {
        current: energyStatus.current,
        max: energyStatus.max,
        regenPerHour: energyStatus.refillPerHour,
        nextRefillIn: energyStatus.nextRefillIn,
      } : {
        current: burnStats.maxEnergy,
        max: burnStats.maxEnergy,
        regenPerHour: burnStats.regenPerHour,
        nextRefillIn: 0,
      },

      links: {
        twitter: avatar.platforms?.twitter?.username
          ? `https://twitter.com/${avatar.platforms.twitter.username}`
          : undefined,
        telegram: avatar.platforms?.telegram?.botUsername
          ? `https://t.me/${avatar.platforms.telegram.botUsername}`
          : undefined,
        website: undefined, // Add if we track this
      },

      // Wallet info would require fetching from wallets service
      // Skip for now - can add later with listWallets(avatarId)
      wallet: undefined,

      burnHistory: burnHistory.map(burn => ({
        signature: burn.signature,
        amount: burn.amount,
        timestamp: burn.timestamp,
        solscanUrl: `https://solscan.io/tx/${burn.signature}`,
      })),
    };

    // Add token info if launched
    if (avatar.tokenLaunch) {
      const token = avatar.tokenLaunch as {
        mint: string;
        symbol: string;
        name: string;
        launchUrl: string;
        launchedAt: number;
      };
      profile.token = {
        mint: token.mint,
        symbol: token.symbol,
        name: token.name,
        launchUrl: token.launchUrl,
        launchedAt: token.launchedAt,
      };
    }

    return success(profile);
  } catch (error) {
    console.error('[PublicProfile] Error:', error instanceof Error ? error.message : String(error));
    return serverError('Failed to fetch profile');
  }
};

/**
 * Get burn leaderboard
 * GET /api/leaderboard
 */
export const leaderboardHandler: APIGatewayProxyHandler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: '',
    };
  }

  try {
    const { getBurnLeaderboard } = await import('../services/burn-stats.js');
    const limit = parseInt(event.queryStringParameters?.limit || '100', 10);
    const leaderboard = await getBurnLeaderboard(Math.min(limit, 100));

    return success({
      leaderboard,
      totalBurned: leaderboard.reduce((sum, entry) => sum + entry.totalBurned, 0),
      totalAvatars: leaderboard.length,
    });
  } catch (error) {
    console.error('[Leaderboard] Error:', error instanceof Error ? error.message : String(error));
    return serverError('Failed to fetch leaderboard');
  }
};
