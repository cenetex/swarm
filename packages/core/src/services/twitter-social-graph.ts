/**
 * Twitter Social Graph Service
 *
 * Manages per-avatar follow/unfollow/block state and shared global blocklist.
 * Blocklist auto-promotes to global when ≥2 avatars block the same account.
 */
import type { CompositeKey, QueryOptions } from './dynamo-repository.js';
import { DynamoRepository } from './dynamo-repository.js';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// ============================================================================
// Types
// ============================================================================

export interface SocialGraphRecord {
  pk: string;                    // Format: "avatar#{avatarId}#social"
  sk: string;                    // Format: "follows#{userId}" or "blocks#{userId}"
  userId: string;                // Twitter user ID
  username?: string;             // Twitter username (cached for convenience)
  accountAge?: number;           // Account age in days (for heuristics)
  mutualCount?: number;          // Number of mutual followers (for heuristics)
  createdAt: number;             // Timestamp when this relationship was created
  source?: 'agent' | 'curator';  // 'agent' = agent called follow, 'curator' = background job
  lastActivityAt?: number;       // Last seen activity timestamp
}

export interface GlobalBlockRecord {
  pk: string;                    // Format: "global#blocklist"
  sk: string;                    // Format: "blocked#{userId}"
  userId: string;                // Twitter user ID
  username?: string;             // Twitter username (cached)
  blockCount: number;            // Number of avatars that blocked this user
  blockedAt: number;             // When it was promoted to global
  blockingAvatars: string[];     // List of avatarIds that triggered promotion
}

export interface CanReplyResult {
  eligible: boolean;
  reason: 'followed' | 'heuristic_pass' | 'heuristic_fail' | 'globally_blocked' | 'locally_blocked' | 'unknown';
  heuristicScore?: number;       // 0-1 score for heuristic eligibility
}

// ============================================================================
// Heuristics Library
// ============================================================================

export interface HeuristicContext {
  accountAge?: number;           // Days since account creation
  mutualCount?: number;          // Number of mutual followers
  hasCryptoTickers?: boolean;    // Bio contains token tickers
  verificationStatus?: string;   // 'none', 'blue', 'business', 'government'
}

/**
 * Score non-followed mentions on likelihood of being genuine engagement
 * vs. spam/crypto scams. Returns score 0-1 where 1 is highest confidence.
 */
export function scoreHeuristic(context: HeuristicContext): number {
  let score = 0.5; // Start at neutral

  // Account age (newer = more spam risk)
  if ((context.accountAge ?? 0) >= 365) {
    score += 0.2; // 1+ years old
  } else if ((context.accountAge ?? 0) >= 90) {
    score += 0.1; // 3+ months old
  } else if ((context.accountAge ?? 0) >= 30) {
    score += 0.05; // 1+ month old
  }
  // Very new accounts get score reduction (handled by neutral start)

  // Mutual followers
  if ((context.mutualCount ?? 0) >= 100) {
    score += 0.2; // Many mutuals = more trusted
  } else if ((context.mutualCount ?? 0) >= 20) {
    score += 0.1;
  } else if ((context.mutualCount ?? 0) >= 5) {
    score += 0.05;
  }

  // Verification status
  if (context.verificationStatus === 'blue' || context.verificationStatus === 'business' || context.verificationStatus === 'government') {
    score += 0.15;
  }

  // Crypto spam signals
  if (context.hasCryptoTickers) {
    score -= 0.3; // Large penalty for obvious spam signals
  }

  return Math.max(0, Math.min(1, score));
}

/**
 * Check if heuristic score passes the threshold for reply eligibility
 */
export function passesHeuristicThreshold(score: number, threshold = 0.6): boolean {
  return score >= threshold;
}

// ============================================================================
// Service
// ============================================================================

export class TwitterSocialGraphService extends DynamoRepository {
  constructor(docClient: DynamoDBDocumentClient, tableName: string) {
    super(docClient, tableName);
  }

  // =========================================================================
  // Per-Avatar Follow/Block Management
  // =========================================================================

  /**
   * Record that an avatar is following a user
   */
  async addFollow(avatarId: string, userId: string, metadata?: {
    username?: string;
    accountAge?: number;
    mutualCount?: number;
    source?: 'agent' | 'curator';
  }): Promise<void> {
    const now = Date.now();
    const record: SocialGraphRecord = {
      pk: `avatar#${avatarId}#social`,
      sk: `follows#${userId}`,
      userId,
      username: metadata?.username,
      accountAge: metadata?.accountAge,
      mutualCount: metadata?.mutualCount,
      source: metadata?.source ?? 'agent',
      createdAt: now,
      lastActivityAt: now,
    };
    await this.put(record);
  }

  /**
   * Record that an avatar is unfollowing a user
   */
  async removeFollow(avatarId: string, userId: string): Promise<void> {
    const key: CompositeKey = {
      pk: `avatar#${avatarId}#social`,
      sk: `follows#${userId}`,
    };
    await this.delete(key);
  }

  /**
   * Record that an avatar is blocking a user
   */
  async addBlock(avatarId: string, userId: string, metadata?: {
    username?: string;
    source?: 'agent' | 'curator';
  }): Promise<void> {
    const now = Date.now();
    const record: SocialGraphRecord = {
      pk: `avatar#${avatarId}#social`,
      sk: `blocks#${userId}`,
      userId,
      username: metadata?.username,
      source: metadata?.source ?? 'agent',
      createdAt: now,
      lastActivityAt: now,
    };
    await this.put(record);

    // Check if we should promote to global blocklist
    await this.maybePromoteToGlobalBlocklist(userId, avatarId);
  }

  /**
   * Record that an avatar is unblocking a user
   */
  async removeBlock(avatarId: string, userId: string): Promise<void> {
    const key: CompositeKey = {
      pk: `avatar#${avatarId}#social`,
      sk: `blocks#${userId}`,
    };
    await this.delete(key);
  }

  /**
   * Check if avatar is following a user
   */
  async isFollowing(avatarId: string, userId: string): Promise<boolean> {
    const key: CompositeKey = {
      pk: `avatar#${avatarId}#social`,
      sk: `follows#${userId}`,
    };
    const record = await this.get<SocialGraphRecord>(key);
    return !!record;
  }

  /**
   * Check if avatar is blocking a user (locally)
   */
  async isBlockedLocally(avatarId: string, userId: string): Promise<boolean> {
    const key: CompositeKey = {
      pk: `avatar#${avatarId}#social`,
      sk: `blocks#${userId}`,
    };
    const record = await this.get<SocialGraphRecord>(key);
    return !!record;
  }

  /**
   * Get all users an avatar is following
   */
  async getFollows(avatarId: string, limit = 100): Promise<SocialGraphRecord[]> {
    const options: QueryOptions = {
      skCondition: { type: 'begins_with', value: 'follows#' },
      limit,
    };
    const result = await this.query<SocialGraphRecord>(
      `avatar#${avatarId}#social`,
      options
    );
    return result.items;
  }

  /**
   * Get all users an avatar is blocking (locally)
   */
  async getLocalBlocks(avatarId: string, limit = 100): Promise<SocialGraphRecord[]> {
    const options: QueryOptions = {
      skCondition: { type: 'begins_with', value: 'blocks#' },
      limit,
    };
    const result = await this.query<SocialGraphRecord>(
      `avatar#${avatarId}#social`,
      options
    );
    return result.items;
  }

  // =========================================================================
  // Global Blocklist Management
  // =========================================================================

  /**
   * Check if a user is on the global blocklist
   */
  async isGloballyBlocked(userId: string): Promise<boolean> {
    const key: CompositeKey = {
      pk: 'global#blocklist',
      sk: `blocked#${userId}`,
    };
    const record = await this.get<GlobalBlockRecord>(key);
    return !!record;
  }

  /**
   * Get global block record
   */
  async getGlobalBlock(userId: string): Promise<GlobalBlockRecord | null> {
    const key: CompositeKey = {
      pk: 'global#blocklist',
      sk: `blocked#${userId}`,
    };
    return await this.get<GlobalBlockRecord>(key);
  }

  /**
   * Check if we should promote a local block to global
   * Returns true if promoted
   */
  private async maybePromoteToGlobalBlocklist(userId: string, newBlockingAvatarId: string): Promise<boolean> {
    const globalKey: CompositeKey = {
      pk: 'global#blocklist',
      sk: `blocked#${userId}`,
    };

    // Get current global block record if it exists
    let globalRecord = await this.get<GlobalBlockRecord>(globalKey);

    if (!globalRecord) {
      // Count how many avatars are blocking this user
      const blockingAvatars = await this.findAvatarsBlockingUser(userId);

      // Only promote if ≥2 avatars are blocking
      if (blockingAvatars.length >= 2) {
        globalRecord = {
          pk: 'global#blocklist',
          sk: `blocked#${userId}`,
          userId,
          blockCount: blockingAvatars.length,
          blockedAt: Date.now(),
          blockingAvatars,
        };
        await this.put(globalRecord);
        return true;
      }
    }

    return false;
  }

  /**
   * Find all avatars blocking a specific user (expensive, use sparingly)
   */
  private async findAvatarsBlockingUser(userId: string): Promise<string[]> {
    const avatars: string[] = [];

    // Scan for all block records for this user
    // This is a full table scan but filtered. In production, you might want a GSI.
    const params = {
      FilterExpression: `attribute_exists(#pk) AND contains(#sk, :userId)`,
      ExpressionAttributeNames: {
        '#pk': 'pk',
        '#sk': 'sk',
      },
      ExpressionAttributeValues: {
        ':userId': userId,
      },
    };

    const result = await this.docClient.send(
      new ScanCommand({
        TableName: this.tableName,
        ...params,
      })
    );

    if (result.Items) {
      for (const item of result.Items) {
        const record = item as SocialGraphRecord;
        if (record.pk?.startsWith('avatar#') && record.sk === `blocks#${userId}`) {
          const avatarId = record.pk.split('#')[1];
          if (avatarId) avatars.push(avatarId);
        }
      }
    }

    return avatars;
  }

  /**
   * Manually add/update a global block
   */
  async addGlobalBlock(userId: string, username?: string): Promise<void> {
    const key: CompositeKey = {
      pk: 'global#blocklist',
      sk: `blocked#${userId}`,
    };

    const existing = await this.get<GlobalBlockRecord>(key);
    const blockCount = existing ? existing.blockCount + 1 : 1;

    const record: GlobalBlockRecord = {
      pk: 'global#blocklist',
      sk: `blocked#${userId}`,
      userId,
      username,
      blockCount,
      blockedAt: existing?.blockedAt ?? Date.now(),
      blockingAvatars: existing?.blockingAvatars ?? [],
    };

    await this.put(record);
  }

  /**
   * Remove a user from global blocklist
   */
  async removeGlobalBlock(userId: string): Promise<void> {
    const key: CompositeKey = {
      pk: 'global#blocklist',
      sk: `blocked#${userId}`,
    };
    await this.delete(key);
  }

  /**
   * Get all globally blocked users
   */
  async getGlobalBlocks(limit = 100): Promise<GlobalBlockRecord[]> {
    const options: QueryOptions = {
      skCondition: { type: 'begins_with', value: 'blocked#' },
      limit,
    };
    const result = await this.query<GlobalBlockRecord>(
      'global#blocklist',
      options
    );
    return result.items;
  }

  // =========================================================================
  // Reply Gate Evaluation
  // =========================================================================

  /**
   * Determine if an avatar can reply to a mention from a user
   */
  async canReply(
    avatarId: string,
    userId: string,
    heuristicContext?: HeuristicContext,
    heuristicThreshold = 0.6
  ): Promise<CanReplyResult> {
    // Check global blocklist first
    const globallyBlocked = await this.isGloballyBlocked(userId);
    if (globallyBlocked) {
      return {
        eligible: false,
        reason: 'globally_blocked',
      };
    }

    // Check local block
    const locallyBlocked = await this.isBlockedLocally(avatarId, userId);
    if (locallyBlocked) {
      return {
        eligible: false,
        reason: 'locally_blocked',
      };
    }

    // Followed accounts always eligible
    const followed = await this.isFollowing(avatarId, userId);
    if (followed) {
      return {
        eligible: true,
        reason: 'followed',
      };
    }

    // Non-followed mentions: check heuristics
    if (heuristicContext) {
      const score = scoreHeuristic(heuristicContext);
      const passes = passesHeuristicThreshold(score, heuristicThreshold);
      return {
        eligible: passes,
        reason: passes ? 'heuristic_pass' : 'heuristic_fail',
        heuristicScore: score,
      };
    }

    // No heuristic context provided; use conservative default (deny)
    return {
      eligible: false,
      reason: 'unknown',
    };
  }
}
