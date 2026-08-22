/**
 * Chat Rate Limiting Module
 * Handles public access rate limiting for the admin chat handler.
 * Uses daily limits based on Orb NFT ownership.
 */
import { GetCommand, UpdateCommand } from '@swarm/core';
import { logger } from '@swarm/core';
import { getDynamoClient } from '../services/dynamo-client.js';

// Rate limiting configuration for public access mode (daily limits)
const PUBLIC_RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const PUBLIC_RATE_LIMIT_DEFAULT = 10; // Non-Orb holders: 10 messages/day
export const PUBLIC_RATE_LIMIT_ORB_HOLDERS = 100; // Orb holders: 100 messages/day
const PUBLIC_RATE_LIMIT_TTL_SECONDS = 25 * 60 * 60; // TTL for rate limit records (25 hours)

// DynamoDB client for rate limiting
const ADMIN_TABLE = process.env.ADMIN_TABLE || 'SwarmAdminTable';
const rateLimitDynamoClient = getDynamoClient();

export interface PublicRateLimitResult {
  limited: boolean;
  retryAfter?: number;
  remaining: number;
  limit: number;
  isOrbHolder: boolean;
}

/**
 * Check if user is rate limited (for public access mode)
 * Uses daily limits based on Orb ownership (10/day default, 100/day for Orb holders)
 */
export async function checkPublicRateLimit(
  walletAddress: string,
  avatarId: string,
  hasOrb: boolean
): Promise<PublicRateLimitResult> {
  const now = Date.now();
  const windowStart = now - PUBLIC_RATE_LIMIT_WINDOW_MS;
  const rateLimitKey = `RATE_LIMIT#${avatarId}#${walletAddress}`;
  const maxMessages = hasOrb ? PUBLIC_RATE_LIMIT_ORB_HOLDERS : PUBLIC_RATE_LIMIT_DEFAULT;

  try {
    const result = await rateLimitDynamoClient.send(new GetCommand({
      TableName: ADMIN_TABLE,
      Key: {
        pk: rateLimitKey,
        sk: 'CHAT_MESSAGES_DAILY',
      },
    }));

    if (!result.Item) {
      return { limited: false, remaining: maxMessages, limit: maxMessages, isOrbHolder: hasOrb };
    }

    const timestamps: number[] = result.Item.timestamps || [];
    const recentTimestamps = timestamps.filter(ts => ts > windowStart);
    const remaining = Math.max(0, maxMessages - recentTimestamps.length);

    if (recentTimestamps.length >= maxMessages) {
      // Calculate when the oldest message in the window will expire
      const oldestInWindow = Math.min(...recentTimestamps);
      const retryAfter = Math.ceil((oldestInWindow + PUBLIC_RATE_LIMIT_WINDOW_MS - now) / 1000);
      return {
        limited: true,
        retryAfter: Math.max(1, retryAfter),
        remaining: 0,
        limit: maxMessages,
        isOrbHolder: hasOrb,
      };
    }

    return { limited: false, remaining, limit: maxMessages, isOrbHolder: hasOrb };
  } catch (error) {
    // On error, allow the request (fail open for rate limiting)
    logger.warn('Rate limit check failed, allowing request', {
      subsystem: 'chat',
      avatarId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { limited: false, remaining: maxMessages, limit: maxMessages, isOrbHolder: hasOrb };
  }
}

/**
 * Record a message for rate limiting (for public access mode)
 */
export async function recordPublicRateLimit(
  walletAddress: string,
  avatarId: string
): Promise<void> {
  const now = Date.now();
  const windowStart = now - PUBLIC_RATE_LIMIT_WINDOW_MS;
  const rateLimitKey = `RATE_LIMIT#${avatarId}#${walletAddress}`;
  const ttl = Math.floor((now + PUBLIC_RATE_LIMIT_TTL_SECONDS * 1000) / 1000);

  try {
    // Get existing timestamps
    const result = await rateLimitDynamoClient.send(new GetCommand({
      TableName: ADMIN_TABLE,
      Key: {
        pk: rateLimitKey,
        sk: 'CHAT_MESSAGES_DAILY',
      },
    }));

    const existingTimestamps: number[] = result.Item?.timestamps || [];
    // Keep only recent timestamps + new one
    const timestamps = [...existingTimestamps.filter(ts => ts > windowStart), now];

    await rateLimitDynamoClient.send(new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: {
        pk: rateLimitKey,
        sk: 'CHAT_MESSAGES_DAILY',
      },
      UpdateExpression: 'SET timestamps = :timestamps, #ttl = :ttl',
      ExpressionAttributeNames: {
        '#ttl': 'ttl',
      },
      ExpressionAttributeValues: {
        ':timestamps': timestamps,
        ':ttl': ttl,
      },
    }));
  } catch (error) {
    // Non-critical, just log
    logger.warn('Failed to record message for rate limit', {
      subsystem: 'chat',
      avatarId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
