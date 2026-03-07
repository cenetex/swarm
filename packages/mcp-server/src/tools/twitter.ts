/**
 * Twitter/X Integration Tools
 *
 * Tools for managing Twitter/X account connection and interactions.
 * Avatars can request Twitter integration when they want to post tweets.
 */
import { z } from 'zod';
import { defineTool, type ToolResult } from '../registry.js';

/**
 * Twitter connection status
 */
export interface TwitterConnectionStatus {
  connected: boolean;
  username?: string;
  userId?: string;
  connectedAt?: number;
  /** Character limit for tweets - 280 for free accounts, 10000 for Premium/Blue */
  charLimit?: number;
  /** Verified type from Twitter API - 'blue', 'business', 'government', or undefined */
  verifiedType?: string;
}

/**
 * Tweet data structure
 */
export interface Tweet {
  id: string;
  text: string;
  authorId: string;
  authorUsername?: string;
  authorName?: string;
  createdAt: string;
  conversationId?: string;
  inReplyToUserId?: string;
  referencedTweets?: Array<{ type: 'replied_to' | 'quoted' | 'retweeted'; id: string }>;
  metrics?: {
    replyCount?: number;
    retweetCount?: number;
    likeCount?: number;
    quoteCount?: number;
  };
}

/**
 * Post in the content store (for review/moderation)
 */
export interface ContentStorePost {
  postId: string;
  avatarId: string;
  text: string;
  media?: Array<{ type: string; url: string }>;
  source: 'ingested' | 'generated' | 'simulation';
  status: 'pending_review' | 'approved' | 'rejected' | 'queued' | 'posted' | 'failed';
  qualityScore: number;
  twitterId?: string;
  communityId?: string;
  communityName?: string;
  createdAt: number;
  reviewerId?: string;
  reviewReason?: string;
}

/**
 * Moderation configuration
 */
export interface ModerationConfig {
  mode: 'pre' | 'post' | 'none';
  autoGraduateAfter: number;
  requireApprovalFor: ('tweets' | 'replies' | 'media')[];
  approvedPostCount: number;
  hasGraduated: boolean;
}

/**
 * Services required by Twitter tools
 */
export interface TwitterServices {
  /**
   * Get Twitter connection status for current avatar
   */
  getConnectionStatus: () => Promise<TwitterConnectionStatus>;

  /**
   * Start OAuth flow - returns authorization URL
   * Returns null if OAuth is not configured
   */
  startOAuthFlow: () => Promise<{ authorizationUrl: string } | null>;

  /**
   * Post a tweet (if connected)
   * @param text Tweet text
   * @param mediaUrls Optional URLs to attach (legacy, prefer mediaIds)
   * @param mediaIds Optional gallery item IDs to attach (preferred)
   * @returns Success: { tweetId, url }, Queued: { queued, postId }, Error: { error }, or null if unavailable
   */
  postTweet?: (text: string, mediaUrls?: string[], mediaIds?: string[]) => Promise<
    | { tweetId: string; url: string }
    | { queued: true; postId: string; message?: string; url?: string }
    | { error: string }
    | null
  >;

  /**
   * Get home timeline tweets
   */
  getTimeline?: (count?: number) => Promise<Tweet[]>;

  /**
   * Get mentions of this account
   */
  getMentions?: (sinceId?: string, count?: number) => Promise<Tweet[]>;

  /**
   * Reply to a tweet
   * @param mediaIds Optional gallery item IDs to attach (preferred)
   * @param mediaUrls Optional URLs to attach (legacy)
   * @returns Success: { tweetId, url }, Queued: { queued, postId }, Error: { error }, or null if unavailable
   */
  reply?: (tweetId: string, text: string, mediaUrls?: string[], mediaIds?: string[]) => Promise<
    | { tweetId: string; url: string }
    | { queued: true; postId: string; message?: string; url?: string }
    | { error: string }
    | null
  >;

  /**
   * Like a tweet
   */
  like?: (tweetId: string) => Promise<boolean>;

  /**
   * Unlike a tweet
   */
  unlike?: (tweetId: string) => Promise<boolean>;

  /**
   * Retweet a tweet
   */
  retweet?: (tweetId: string) => Promise<boolean>;

  /**
   * Undo a retweet
   */
  unretweet?: (tweetId: string) => Promise<boolean>;

  /**
   * Quote tweet
   * @param mediaIds Optional gallery item IDs to attach (preferred)
   * @param mediaUrls Optional URLs to attach (legacy)
   * @returns Success: { tweetId, url }, Error: { error }, or null if unavailable
   */
  quoteTweet?: (tweetId: string, text: string, mediaUrls?: string[], mediaIds?: string[]) => Promise<{ tweetId: string; url: string } | { error: string } | null>;

  /**
   * Get a specific tweet by ID
   */
  getTweet?: (tweetId: string) => Promise<Tweet | null>;

  /**
   * Get activity summary for cross-platform awareness
   */
  getActivitySummary?: () => Promise<{
    pendingMentions: number;
    lastMentionAt?: string;
    lastPostAt?: string;
    recentTopics?: string[];
    summary?: string;
  } | null>;

  // =========================================================================
  // Content Store / Post Review Services
  // =========================================================================

  /**
   * List posts pending review
   */
  listPendingPosts?: (limit?: number) => Promise<ContentStorePost[]>;

  /**
   * Approve a post for publishing
   */
  approvePost?: (postId: string, reviewerId: string) => Promise<ContentStorePost | null>;

  /**
   * Reject a post
   */
  rejectPost?: (postId: string, reviewerId: string, reason: string) => Promise<ContentStorePost | null>;

  /**
   * Downrank a post (reduce quality score)
   */
  downrankPost?: (postId: string, amount: number) => Promise<ContentStorePost | null>;

  /**
   * Get moderation configuration
   */
  getModerationConfig?: () => Promise<ModerationConfig>;

  /**
   * Set moderation mode
   */
  setModerationMode?: (mode: 'pre' | 'post' | 'none') => Promise<ModerationConfig>;

  /**
   * Get moderation statistics
   */
  getModerationStats?: () => Promise<{
    pendingCount: number;
    approvedCount: number;
    rejectedCount: number;
    moderationMode: 'pre' | 'post' | 'none';
    hasGraduated: boolean;
    approvedPostCount: number;
    autoGraduateAfter: number;
  }>;

  /**
   * Get simulated feed (for simulation mode)
   */
  getSimulatedFeed?: (limit?: number) => Promise<ContentStorePost[]>;
}

/**
 * Create Twitter tools
 */
export function createTwitterTools(services: TwitterServices) {
  return [
    defineTool({
      name: 'twitter_status',
      description: 'Check if Twitter/X is connected for this avatar. Returns connection status and username if connected.',
      category: 'readonly',
      toolset: 'twitter',
      inputSchema: z.object({}),
      execute: async (_input, _context): Promise<ToolResult> => {
        const status = await services.getConnectionStatus();

        if (status.connected) {
          const charLimit = status.charLimit ?? 280;
          const isPremium = charLimit > 280;
          return {
            success: true,
            data: {
              connected: true,
              username: status.username,
              charLimit,
              verifiedType: status.verifiedType,
              isPremium,
              message: `Twitter connected as @${status.username}. Character limit: ${charLimit}${isPremium ? ' (Premium account)' : ''}.`,
            },
          };
        }

        return {
          success: true,
          data: {
            connected: false,
            message: 'Twitter is not connected. Use twitter_request_integration to request connection.',
          },
        };
      },
    }),
    
    defineTool({
      name: 'twitter_request_integration',
      description: 'Request Twitter/X integration for this avatar. If not already connected, this will provide a link for the admin to authorize the Twitter account. Use this when you want to start posting tweets but Twitter is not yet connected.',
      category: 'config',
      toolset: 'twitter',
      inputSchema: z.object({
        reason: z.string().optional().describe('Why you want Twitter integration (helps admin understand the request)'),
      }),
      execute: async (input, _context): Promise<ToolResult> => {
        // First check if already connected
        const status = await services.getConnectionStatus();
        
        if (status.connected) {
          return {
            success: true,
            data: {
              alreadyConnected: true,
              username: status.username,
              message: `Twitter is already connected as @${status.username}. You can post tweets!`,
            },
          };
        }
        
        // Try to start OAuth flow
        const result = await services.startOAuthFlow();
        
        if (!result) {
          return {
            success: false,
            error: 'Twitter OAuth is not configured on this server. Please ask your administrator to configure Twitter app credentials.',
          };
        }
        
        // Return the authorization URL for the admin to use
        return {
          success: true,
          data: {
            pending: true,
            authorizationUrl: result.authorizationUrl,
            reason: input.reason,
            message: 'Twitter integration requested! An admin needs to click the authorization link to connect a Twitter account.',
            instructions: 'Share this link with your admin or open it yourself if you have admin access.',
          },
        };
      },
    }),

    defineTool({
      name: 'twitter_post',
      description: 'Post a tweet to Twitter/X. Twitter must be connected first (check with twitter_status to see your character limit). Standard accounts: 280 chars, Premium/Blue accounts: 10,000 chars. You can attach images using gallery IDs from generate_image or list_gallery.',
      category: 'media',
      toolset: 'twitter',
      inputSchema: z.object({
        text: z.string().max(10000).describe('The tweet text (280 chars for standard accounts, 10,000 for Premium)'),
        mediaIds: z.array(z.string()).max(4).optional().describe('Gallery item IDs to attach (up to 4). Use the exact "id" value from generate_image response or list_gallery. Format: "1234567890123_abc123xyz" (timestamp_randomId). Do NOT use URLs or Twitter media IDs.'),
        mediaUrls: z.array(z.string().url()).max(4).optional().describe('DEPRECATED: Use mediaIds instead. Raw URLs may fail to upload.'),
      }),
      execute: async (input, _context): Promise<ToolResult> => {
        // Check connection first
        const status = await services.getConnectionStatus();
        
        if (!status.connected) {
          return {
            success: false,
            error: 'Twitter is not connected. Use twitter_request_integration to request Twitter connection first.',
          };
        }
        
        // Check if post function is available
        if (!services.postTweet) {
          return {
            success: false,
            error: 'Tweet posting service is not available.',
          };
        }
        
        // Post the tweet - pass both mediaIds and mediaUrls, service will resolve
        const result = await services.postTweet(input.text, input.mediaUrls, input.mediaIds);

        if (!result) {
          return {
            success: false,
            error: 'Failed to post tweet. Please try again.',
          };
        }

        // Check if result is an error
        if ('error' in result) {
          return {
            success: false,
            error: result.error,
          };
        }

        // Check if result is queued (async posting)
        if ('queued' in result && result.queued) {
          return {
            success: true,
            data: {
              queued: true,
              postId: result.postId,
              message: result.message || 'Tweet queued for posting',
              url: result.url,
            },
          };
        }

        // Result has tweetId (synchronous posting)
        if ('tweetId' in result && result.tweetId) {
          return {
            success: true,
            data: {
              tweetId: result.tweetId,
              url: result.url,
              message: `Tweet posted successfully! ${result.url}`,
            },
          };
        }

        // Fallback - shouldn't happen but satisfies TypeScript
        return {
          success: false,
          error: 'Unexpected response from Twitter service',
        };
      },
    }),

    // =========================================================================
    // Timeline & Mentions
    // =========================================================================

    defineTool({
      name: 'twitter_get_timeline',
      description: 'Get recent tweets from my home timeline. Useful for understanding current conversations and trends I follow.',
      category: 'readonly',
      toolset: 'twitter',
      inputSchema: z.object({
        count: z.number().min(1).max(100).optional().default(20).describe('Number of tweets to fetch (1-100, default 20)'),
      }),
      execute: async (input, _context): Promise<ToolResult> => {
        const status = await services.getConnectionStatus();
        if (!status.connected) {
          return { success: false, error: 'Twitter is not connected.' };
        }

        if (!services.getTimeline) {
          return { success: false, error: 'Timeline service is not available.' };
        }

        const tweets = await services.getTimeline(input.count);
        return {
          success: true,
          data: {
            count: tweets.length,
            tweets: tweets.map(t => ({
              id: t.id,
              text: t.text,
              author: t.authorUsername ? `@${t.authorUsername}` : t.authorId,
              authorName: t.authorName,
              createdAt: t.createdAt,
              metrics: t.metrics,
            })),
          },
        };
      },
    }),

    defineTool({
      name: 'twitter_get_mentions',
      description: 'Get recent mentions of my Twitter account. Use this to see who is talking to me.',
      category: 'readonly',
      toolset: 'twitter',
      inputSchema: z.object({
        count: z.number().min(1).max(100).optional().default(20).describe('Number of mentions to fetch (1-100, default 20)'),
        sinceId: z.string().optional().describe('Only get mentions after this tweet ID'),
      }),
      execute: async (input, _context): Promise<ToolResult> => {
        const status = await services.getConnectionStatus();
        if (!status.connected) {
          return { success: false, error: 'Twitter is not connected.' };
        }

        if (!services.getMentions) {
          return { success: false, error: 'Mentions service is not available.' };
        }

        const mentions = await services.getMentions(input.sinceId, input.count);
        return {
          success: true,
          data: {
            count: mentions.length,
            mentions: mentions.map(t => ({
              id: t.id,
              text: t.text,
              author: t.authorUsername ? `@${t.authorUsername}` : t.authorId,
              authorName: t.authorName,
              createdAt: t.createdAt,
              conversationId: t.conversationId,
              inReplyToUserId: t.inReplyToUserId,
            })),
          },
        };
      },
    }),

    defineTool({
      name: 'twitter_get_tweet',
      description: 'Get a specific tweet by its ID. Useful for reading context before replying.',
      category: 'readonly',
      toolset: 'twitter',
      inputSchema: z.object({
        tweetId: z.string().describe('The ID of the tweet to fetch'),
      }),
      execute: async (input, _context): Promise<ToolResult> => {
        const status = await services.getConnectionStatus();
        if (!status.connected) {
          return { success: false, error: 'Twitter is not connected.' };
        }

        if (!services.getTweet) {
          return { success: false, error: 'Tweet lookup service is not available.' };
        }

        const tweet = await services.getTweet(input.tweetId);
        if (!tweet) {
          return { success: false, error: 'Tweet not found.' };
        }

        return {
          success: true,
          data: {
            id: tweet.id,
            text: tweet.text,
            author: tweet.authorUsername ? `@${tweet.authorUsername}` : tweet.authorId,
            authorName: tweet.authorName,
            createdAt: tweet.createdAt,
            conversationId: tweet.conversationId,
            metrics: tweet.metrics,
            referencedTweets: tweet.referencedTweets,
          },
        };
      },
    }),

    // =========================================================================
    // Interactions
    // =========================================================================

    defineTool({
      name: 'twitter_reply',
      description: 'Reply to a specific tweet. The reply will be threaded under the original tweet. Check twitter_status for your character limit.',
      category: 'media',
      toolset: 'twitter',
      inputSchema: z.object({
        tweetId: z.string().describe('The ID of the tweet to reply to'),
        text: z.string().max(10000).describe('The reply text (280 chars for standard, 10,000 for Premium)'),
        mediaIds: z.array(z.string()).max(4).optional().describe('Gallery item IDs to attach. Use exact "id" from generate_image or list_gallery. Format: "timestamp_randomId" (e.g., "1770228770932_abc123")'),
        mediaUrls: z.array(z.string().url()).max(4).optional().describe('DEPRECATED: Use mediaIds instead'),
      }),
      execute: async (input, _context): Promise<ToolResult> => {
        const status = await services.getConnectionStatus();
        if (!status.connected) {
          return { success: false, error: 'Twitter is not connected.' };
        }

        if (!services.reply) {
          return { success: false, error: 'Reply service is not available.' };
        }

        const result = await services.reply(input.tweetId, input.text, input.mediaUrls, input.mediaIds);
        if (!result) {
          return { success: false, error: 'Failed to post reply.' };
        }

        // Check if result is an error
        if ('error' in result) {
          return { success: false, error: result.error };
        }

        // Check if result is queued (async posting)
        if ('queued' in result && result.queued) {
          return {
            success: true,
            data: {
              queued: true,
              postId: result.postId,
              message: result.message || 'Reply queued for posting',
              url: result.url,
            },
          };
        }

        // Result has tweetId (synchronous posting)
        if ('tweetId' in result && result.tweetId) {
          return {
            success: true,
            data: {
              tweetId: result.tweetId,
              url: result.url,
              message: `Reply posted! ${result.url}`,
            },
          };
        }

        // Fallback - shouldn't happen but satisfies TypeScript
        return {
          success: false,
          error: 'Unexpected response from Twitter service',
        };
      },
    }),

    defineTool({
      name: 'twitter_like',
      description: 'Like a tweet. Shows appreciation for content.',
      category: 'media',
      toolset: 'twitter',
      inputSchema: z.object({
        tweetId: z.string().describe('The ID of the tweet to like'),
      }),
      execute: async (input, _context): Promise<ToolResult> => {
        const status = await services.getConnectionStatus();
        if (!status.connected) {
          return { success: false, error: 'Twitter is not connected.' };
        }

        if (!services.like) {
          return { success: false, error: 'Like service is not available.' };
        }

        const success = await services.like(input.tweetId);
        if (!success) {
          return { success: false, error: 'Failed to like tweet.' };
        }

        return {
          success: true,
          data: { message: 'Tweet liked!' },
        };
      },
    }),

    defineTool({
      name: 'twitter_unlike',
      description: 'Remove a like from a tweet.',
      category: 'media',
      toolset: 'twitter',
      inputSchema: z.object({
        tweetId: z.string().describe('The ID of the tweet to unlike'),
      }),
      execute: async (input, _context): Promise<ToolResult> => {
        const status = await services.getConnectionStatus();
        if (!status.connected) {
          return { success: false, error: 'Twitter is not connected.' };
        }

        if (!services.unlike) {
          return { success: false, error: 'Unlike service is not available.' };
        }

        const success = await services.unlike(input.tweetId);
        if (!success) {
          return { success: false, error: 'Failed to unlike tweet.' };
        }

        return {
          success: true,
          data: { message: 'Like removed.' },
        };
      },
    }),

    defineTool({
      name: 'twitter_retweet',
      description: 'Retweet a tweet to share it with my followers.',
      category: 'media',
      toolset: 'twitter',
      inputSchema: z.object({
        tweetId: z.string().describe('The ID of the tweet to retweet'),
      }),
      execute: async (input, _context): Promise<ToolResult> => {
        const status = await services.getConnectionStatus();
        if (!status.connected) {
          return { success: false, error: 'Twitter is not connected.' };
        }

        if (!services.retweet) {
          return { success: false, error: 'Retweet service is not available.' };
        }

        const success = await services.retweet(input.tweetId);
        if (!success) {
          return { success: false, error: 'Failed to retweet.' };
        }

        return {
          success: true,
          data: { message: 'Retweeted!' },
        };
      },
    }),

    defineTool({
      name: 'twitter_unretweet',
      description: 'Undo a retweet.',
      category: 'media',
      toolset: 'twitter',
      inputSchema: z.object({
        tweetId: z.string().describe('The ID of the tweet to unretweet'),
      }),
      execute: async (input, _context): Promise<ToolResult> => {
        const status = await services.getConnectionStatus();
        if (!status.connected) {
          return { success: false, error: 'Twitter is not connected.' };
        }

        if (!services.unretweet) {
          return { success: false, error: 'Unretweet service is not available.' };
        }

        const success = await services.unretweet(input.tweetId);
        if (!success) {
          return { success: false, error: 'Failed to unretweet.' };
        }

        return {
          success: true,
          data: { message: 'Retweet removed.' },
        };
      },
    }),

    defineTool({
      name: 'twitter_quote',
      description: 'Quote tweet - share a tweet with my own commentary. Check twitter_status for your character limit.',
      category: 'media',
      toolset: 'twitter',
      inputSchema: z.object({
        tweetId: z.string().describe('The ID of the tweet to quote'),
        text: z.string().max(10000).describe('Your commentary (280 chars for standard, 10,000 for Premium)'),
        mediaIds: z.array(z.string()).max(4).optional().describe('Gallery item IDs to attach. Use exact "id" from generate_image or list_gallery. Format: "timestamp_randomId" (e.g., "1770228770932_abc123")'),
        mediaUrls: z.array(z.string().url()).max(4).optional().describe('DEPRECATED: Use mediaIds instead'),
      }),
      execute: async (input, _context): Promise<ToolResult> => {
        const status = await services.getConnectionStatus();
        if (!status.connected) {
          return { success: false, error: 'Twitter is not connected.' };
        }

        if (!services.quoteTweet) {
          return { success: false, error: 'Quote tweet service is not available.' };
        }

        const result = await services.quoteTweet(input.tweetId, input.text, input.mediaUrls, input.mediaIds);
        if (!result) {
          return { success: false, error: 'Failed to post quote tweet.' };
        }

        // Check if result is an error
        if ('error' in result) {
          return { success: false, error: result.error };
        }

        return {
          success: true,
          data: {
            tweetId: result.tweetId,
            url: result.url,
            message: `Quote tweet posted! ${result.url}`,
          },
        };
      },
    }),

    // =========================================================================
    // Cross-Platform Awareness
    // =========================================================================

    defineTool({
      name: 'twitter_get_activity_summary',
      description: 'Get a summary of recent Twitter activity for cross-platform awareness. Shows pending mentions, recent posts, and activity overview.',
      category: 'readonly',
      toolset: 'twitter',
      platforms: ['admin-ui', 'api', 'mcp', 'telegram', 'discord'],
      inputSchema: z.object({}),
      execute: async (_input, _context): Promise<ToolResult> => {
        const status = await services.getConnectionStatus();
        if (!status.connected) {
          return { success: false, error: 'Twitter is not connected.' };
        }

        // If we have a dedicated activity summary method, use it
        if (services.getActivitySummary) {
          const summary = await services.getActivitySummary();
          if (!summary) {
            return { success: true, data: { summary: 'No recent activity' } };
          }
          return { success: true, data: summary };
        }

        // Fall back to building summary from mentions
        let pendingMentions = 0;
        let lastMentionAt: string | undefined;

        if (services.getMentions) {
          const mentions = await services.getMentions(undefined, 10);
          pendingMentions = mentions.length;
          if (mentions.length > 0) {
            lastMentionAt = mentions[0].createdAt;
          }
        }

        return {
          success: true,
          data: {
            connected: true,
            username: status.username,
            pendingMentions,
            lastMentionAt,
            charLimit: status.charLimit ?? 280,
            summary: pendingMentions > 0
              ? `${pendingMentions} pending mention(s) to review`
              : 'No pending mentions',
          },
        };
      },
    }),

    // =========================================================================
    // Content Store / Post Review Tools
    // =========================================================================

    defineTool({
      name: 'twitter_list_pending_posts',
      description: 'List posts that are pending review before being published to Twitter. Use this to see what content needs approval.',
      category: 'readonly',
      toolset: 'twitter',
      inputSchema: z.object({
        limit: z.number().min(1).max(50).optional().default(10).describe('Maximum number of posts to return'),
      }),
      shouldShow: async (_context) => !!services.listPendingPosts,
      execute: async (input, _context): Promise<ToolResult> => {
        if (!services.listPendingPosts) {
          return { success: false, error: 'Post review service is not available.' };
        }

        const posts = await services.listPendingPosts(input.limit);
        return {
          success: true,
          data: {
            count: posts.length,
            posts: posts.map(p => ({
              postId: p.postId,
              text: p.text,
              source: p.source,
              qualityScore: p.qualityScore,
              communityName: p.communityName,
              hasMedia: (p.media?.length ?? 0) > 0,
              createdAt: new Date(p.createdAt).toISOString(),
            })),
          },
        };
      },
    }),

    defineTool({
      name: 'twitter_approve_post',
      description: 'Approve a pending post for publishing to Twitter. The post will be queued for delivery.',
      category: 'config',
      toolset: 'twitter',
      inputSchema: z.object({
        postId: z.string().describe('The ID of the post to approve'),
      }),
      shouldShow: async (_context) => !!services.approvePost,
      execute: async (input, context): Promise<ToolResult> => {
        if (!services.approvePost) {
          return { success: false, error: 'Post approval service is not available.' };
        }

        const reviewerId = context.userId || 'unknown';
        const post = await services.approvePost(input.postId, reviewerId);

        if (!post) {
          return { success: false, error: 'Post not found or could not be approved.' };
        }

        return {
          success: true,
          data: {
            postId: post.postId,
            status: post.status,
            message: `Post approved and queued for publishing.`,
          },
        };
      },
    }),

    defineTool({
      name: 'twitter_reject_post',
      description: 'Reject a pending post. It will not be published to Twitter.',
      category: 'config',
      toolset: 'twitter',
      inputSchema: z.object({
        postId: z.string().describe('The ID of the post to reject'),
        reason: z.string().describe('Reason for rejection (helps improve future content)'),
      }),
      shouldShow: async (_context) => !!services.rejectPost,
      execute: async (input, context): Promise<ToolResult> => {
        if (!services.rejectPost) {
          return { success: false, error: 'Post rejection service is not available.' };
        }

        const reviewerId = context.userId || 'unknown';
        const post = await services.rejectPost(input.postId, reviewerId, input.reason);

        if (!post) {
          return { success: false, error: 'Post not found or could not be rejected.' };
        }

        return {
          success: true,
          data: {
            postId: post.postId,
            status: post.status,
            message: `Post rejected: ${input.reason}`,
          },
        };
      },
    }),

    defineTool({
      name: 'twitter_downrank_post',
      description: 'Reduce the quality score of a post. Posts below score 50 are excluded from feeds. Use this to gradually downrank low-quality content.',
      category: 'config',
      toolset: 'twitter',
      inputSchema: z.object({
        postId: z.string().describe('The ID of the post to downrank'),
        amount: z.number().min(1).max(100).default(10).describe('Amount to reduce quality score by (1-100)'),
      }),
      shouldShow: async (_context) => !!services.downrankPost,
      execute: async (input, _context): Promise<ToolResult> => {
        if (!services.downrankPost) {
          return { success: false, error: 'Post downranking service is not available.' };
        }

        const post = await services.downrankPost(input.postId, -input.amount);

        if (!post) {
          return { success: false, error: 'Post not found or could not be downranked.' };
        }

        return {
          success: true,
          data: {
            postId: post.postId,
            newQualityScore: post.qualityScore,
            message: `Quality score reduced to ${post.qualityScore}.`,
          },
        };
      },
    }),

    defineTool({
      name: 'twitter_set_moderation_mode',
      description: 'Set the moderation mode for this avatar. Pre-moderation requires approval before posting, post-moderation reviews after posting, none disables moderation.',
      category: 'config',
      toolset: 'twitter',
      inputSchema: z.object({
        mode: z.enum(['pre', 'post', 'none']).describe('Moderation mode: pre (approve before posting), post (review after), none (no moderation)'),
      }),
      shouldShow: async (_context) => !!services.setModerationMode,
      execute: async (input, _context): Promise<ToolResult> => {
        if (!services.setModerationMode) {
          return { success: false, error: 'Moderation configuration service is not available.' };
        }

        const config = await services.setModerationMode(input.mode);

        return {
          success: true,
          data: {
            mode: config.mode,
            hasGraduated: config.hasGraduated,
            approvedPostCount: config.approvedPostCount,
            message: `Moderation mode set to "${input.mode}".`,
          },
        };
      },
    }),

    defineTool({
      name: 'twitter_get_moderation_stats',
      description: 'Get moderation statistics for this avatar, including pending posts count and moderation settings.',
      category: 'readonly',
      toolset: 'twitter',
      inputSchema: z.object({}),
      shouldShow: async (_context) => !!services.getModerationStats,
      execute: async (_input, _context): Promise<ToolResult> => {
        if (!services.getModerationStats) {
          return { success: false, error: 'Moderation stats service is not available.' };
        }

        const stats = await services.getModerationStats();

        return {
          success: true,
          data: {
            ...stats,
            graduationProgress: stats.hasGraduated
              ? 'Graduated'
              : `${stats.approvedPostCount}/${stats.autoGraduateAfter} posts approved`,
          },
        };
      },
    }),

    defineTool({
      name: 'twitter_get_simulated_feed',
      description: 'Get the simulated feed for this avatar (only visible in simulation mode). Shows posts that would have been published to Twitter.',
      category: 'readonly',
      toolset: 'twitter',
      inputSchema: z.object({
        limit: z.number().min(1).max(50).optional().default(20).describe('Maximum number of posts to return'),
      }),
      shouldShow: async (_context) => !!services.getSimulatedFeed,
      execute: async (input, _context): Promise<ToolResult> => {
        if (!services.getSimulatedFeed) {
          return { success: false, error: 'Simulated feed service is not available.' };
        }

        const posts = await services.getSimulatedFeed(input.limit);

        return {
          success: true,
          data: {
            count: posts.length,
            posts: posts.map(p => ({
              postId: p.postId,
              text: p.text,
              source: p.source,
              status: p.status,
              qualityScore: p.qualityScore,
              communityName: p.communityName,
              hasMedia: (p.media?.length ?? 0) > 0,
              createdAt: new Date(p.createdAt).toISOString(),
            })),
          },
        };
      },
    }),
  ];
}
