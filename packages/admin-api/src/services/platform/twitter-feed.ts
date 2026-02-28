/**
 * Twitter Feed Service
 *
 * Wraps the ContentStoreService for use in admin-api endpoints.
 * Provides Twitter feed data including pending posts, recent posts,
 * and simulated feed for admin UI.
 */
import {
  createContentStoreService,
  enqueuePost,
  logger,
  type ContentStoreService,
  type ContentStorePost,
  type ModerationConfig,
} from '@swarm/core';
import * as avatarService from '../avatars.js';

// Use STATE_TABLE for content store (same table with different SK patterns)
const STATE_TABLE = process.env.STATE_TABLE;
const POST_QUEUE_URL = process.env.POST_QUEUE_URL || '';

let contentStoreService: ContentStoreService | null = null;

function getContentStoreService(): ContentStoreService {
  if (!contentStoreService) {
    if (!STATE_TABLE) {
      throw new Error('STATE_TABLE is required for twitter feed service');
    }
    contentStoreService = createContentStoreService(STATE_TABLE);
  }
  return contentStoreService;
}

/**
 * Response type for the Twitter feed endpoint
 */
export interface TwitterFeedResponse {
  pendingPosts: ContentStorePost[];
  recentPosts: ContentStorePost[];
  simulatedFeed: ContentStorePost[];
  moderationStats: ModerationStats;
  isSimulationMode: boolean;
  isConnected: boolean;
}

/**
 * Moderation statistics
 */
export interface ModerationStats {
  pendingCount: number;
  approvedCount: number;
  rejectedCount: number;
  moderationMode: 'pre' | 'post' | 'none';
  hasGraduated: boolean;
  approvedPostCount: number;
  autoGraduateAfter: number;
}

/**
 * Get Twitter feed data for an avatar
 */
export async function getTwitterFeed(avatarId: string): Promise<TwitterFeedResponse> {
  const service = getContentStoreService();
  const avatar = await avatarService.getAvatar(avatarId);

  // Determine if avatar has Twitter connected and if it's in simulation mode
  const isConnected = Boolean(avatar?.platforms?.twitter?.enabled);
  // We treat simulation mode as always-on in the admin UI so every avatar can
  // use the simulated feed view even without Twitter linked.
  const isSimulationMode = true;

  // Fetch posts in parallel
  const [pendingPosts, recentPosts, simulatedFeed, moderationConfig] = await Promise.all([
    service.listPostsByStatus(avatarId, 'pending_review', 50),
    service.listRecentPosts(avatarId, 50),
    service.getSimulatedFeed(avatarId, 50),
    service.getModerationConfig(avatarId),
  ]);

  // Calculate stats
  const approvedPosts = await service.listPostsByStatus(avatarId, 'approved', 100);
  const rejectedPosts = await service.listPostsByStatus(avatarId, 'rejected', 100);

  const moderationStats: ModerationStats = {
    pendingCount: pendingPosts.length,
    approvedCount: approvedPosts.length,
    rejectedCount: rejectedPosts.length,
    moderationMode: moderationConfig.mode,
    hasGraduated: moderationConfig.hasGraduated,
    approvedPostCount: moderationConfig.approvedPostCount,
    autoGraduateAfter: moderationConfig.autoGraduateAfter,
  };

  return {
    pendingPosts,
    recentPosts,
    simulatedFeed,
    moderationStats,
    isSimulationMode,
    isConnected,
  };
}

/**
 * Approve a pending post
 *
 * For non-simulation posts, this will also enqueue the post to POST_QUEUE
 * for the tweet-sender to process.
 */
export async function approvePost(
  avatarId: string,
  postId: string,
  reviewerId: string
): Promise<ContentStorePost | null> {
  const service = getContentStoreService();

  // Get the post first to check its source
  const existingPost = await service.getPost(avatarId, postId);
  if (!existingPost) {
    return null;
  }

  const post = await service.approve(avatarId, postId, reviewerId);

  if (post) {
    // Increment approved post count for graduation tracking
    await service.incrementApprovedPostCount(avatarId);

    // Enqueue non-simulation posts for Twitter posting
    if (post.source !== 'simulation' && POST_QUEUE_URL) {
      try {
        await enqueuePost(POST_QUEUE_URL, avatarId, postId, post.scheduledAt);
        logger.info('Post enqueued for Twitter posting', {
          event: 'post_enqueued',
          avatarId,
          postId,
          source: post.source,
        });
      } catch (error) {
        logger.error('Failed to enqueue post', {
          event: 'post_enqueue_failed',
          avatarId,
          postId,
          error,
        });
        // Don't fail the approval - the post is still approved, just not enqueued
        // It can be manually retried later
      }
    }
  }

  return post;
}

/**
 * Reject a pending post
 */
export async function rejectPost(
  avatarId: string,
  postId: string,
  reviewerId: string,
  reason: string
): Promise<ContentStorePost | null> {
  const service = getContentStoreService();
  return service.reject(avatarId, postId, reviewerId, reason);
}

/**
 * Cancel/delete a pending post (by marking as rejected with system reason)
 */
export async function cancelPost(
  avatarId: string,
  postId: string,
  reviewerId: string
): Promise<ContentStorePost | null> {
  const service = getContentStoreService();
  return service.reject(avatarId, postId, reviewerId, 'Cancelled by user');
}

/**
 * Get moderation config
 */
export async function getModerationConfig(avatarId: string): Promise<ModerationConfig> {
  const service = getContentStoreService();
  return service.getModerationConfig(avatarId);
}

/**
 * Set moderation mode
 */
export async function setModerationMode(
  avatarId: string,
  mode: 'pre' | 'post' | 'none'
): Promise<ModerationConfig> {
  const service = getContentStoreService();

  // Check if avatar has graduated - can't set to 'none' unless graduated
  const current = await service.getModerationConfig(avatarId);
  if (!current.hasGraduated && mode === 'none') {
    throw new Error('Cannot disable moderation until avatar has graduated');
  }

  return service.setModerationConfig(avatarId, { mode });
}

/**
 * Downrank a post (reduce quality score)
 */
export async function downrankPost(
  avatarId: string,
  postId: string,
  amount: number = 25
): Promise<ContentStorePost | null> {
  const service = getContentStoreService();
  return service.updateQualityScore(avatarId, postId, -Math.abs(amount));
}

/**
 * Get a single post
 */
export async function getPost(avatarId: string, postId: string): Promise<ContentStorePost | null> {
  const service = getContentStoreService();
  return service.getPost(avatarId, postId);
}

// Re-export types for convenience
export type { ContentStorePost, ModerationConfig };
