/**
 * Twitter/X Integration Tools
 *
 * Tools for managing Twitter/X account connection and interactions.
 * Agents can request Twitter integration when they want to post tweets.
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
 * Services required by Twitter tools
 */
export interface TwitterServices {
  /**
   * Get Twitter connection status for current agent
   */
  getConnectionStatus: () => Promise<TwitterConnectionStatus>;

  /**
   * Start OAuth flow - returns authorization URL
   * Returns null if OAuth is not configured
   */
  startOAuthFlow: () => Promise<{ authorizationUrl: string } | null>;

  /**
   * Post a tweet (if connected)
   */
  postTweet?: (text: string, mediaUrls?: string[]) => Promise<{ tweetId: string; url: string } | null>;

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
   */
  reply?: (tweetId: string, text: string, mediaUrls?: string[]) => Promise<{ tweetId: string; url: string } | null>;

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
   */
  quoteTweet?: (tweetId: string, text: string, mediaUrls?: string[]) => Promise<{ tweetId: string; url: string } | null>;

  /**
   * Get a specific tweet by ID
   */
  getTweet?: (tweetId: string) => Promise<Tweet | null>;
}

/**
 * Create Twitter tools
 */
export function createTwitterTools(services: TwitterServices) {
  return [
    defineTool({
      name: 'twitter_status',
      description: 'Check if Twitter/X is connected for this agent. Returns connection status and username if connected.',
      category: 'readonly',
      toolset: 'twitter',
      inputSchema: z.object({}),
      execute: async (_input, _context): Promise<ToolResult> => {
        const status = await services.getConnectionStatus();
        
        if (status.connected) {
          return {
            success: true,
            data: {
              connected: true,
              username: status.username,
              message: `Twitter connected as @${status.username}`,
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
      description: 'Request Twitter/X integration for this agent. If not already connected, this will provide a link for the admin to authorize the Twitter account. Use this when you want to start posting tweets but Twitter is not yet connected.',
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
      description: 'Post a tweet to Twitter/X. Twitter must be connected first (check with twitter_status). Tweets are limited to 280 characters.',
      category: 'media',
      toolset: 'twitter',
      inputSchema: z.object({
        text: z.string().max(280).describe('The tweet text (max 280 characters)'),
        mediaUrls: z.array(z.string()).max(4).optional().describe('Optional array of media URLs to attach (up to 4 images)'),
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
        
        // Post the tweet
        const result = await services.postTweet(input.text, input.mediaUrls);
        
        if (!result) {
          return {
            success: false,
            error: 'Failed to post tweet. Please try again.',
          };
        }
        
        return {
          success: true,
          data: {
            tweetId: result.tweetId,
            url: result.url,
            message: `Tweet posted successfully! ${result.url}`,
          },
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
      description: 'Reply to a specific tweet. The reply will be threaded under the original tweet.',
      category: 'media',
      toolset: 'twitter',
      inputSchema: z.object({
        tweetId: z.string().describe('The ID of the tweet to reply to'),
        text: z.string().max(280).describe('The reply text (max 280 characters)'),
        mediaUrls: z.array(z.string()).max(4).optional().describe('Optional media URLs to attach'),
      }),
      execute: async (input, _context): Promise<ToolResult> => {
        const status = await services.getConnectionStatus();
        if (!status.connected) {
          return { success: false, error: 'Twitter is not connected.' };
        }

        if (!services.reply) {
          return { success: false, error: 'Reply service is not available.' };
        }

        const result = await services.reply(input.tweetId, input.text, input.mediaUrls);
        if (!result) {
          return { success: false, error: 'Failed to post reply.' };
        }

        return {
          success: true,
          data: {
            tweetId: result.tweetId,
            url: result.url,
            message: `Reply posted! ${result.url}`,
          },
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
      description: 'Quote tweet - share a tweet with my own commentary.',
      category: 'media',
      toolset: 'twitter',
      inputSchema: z.object({
        tweetId: z.string().describe('The ID of the tweet to quote'),
        text: z.string().max(280).describe('Your commentary (max 280 characters)'),
        mediaUrls: z.array(z.string()).max(4).optional().describe('Optional media URLs to attach'),
      }),
      execute: async (input, _context): Promise<ToolResult> => {
        const status = await services.getConnectionStatus();
        if (!status.connected) {
          return { success: false, error: 'Twitter is not connected.' };
        }

        if (!services.quoteTweet) {
          return { success: false, error: 'Quote tweet service is not available.' };
        }

        const result = await services.quoteTweet(input.tweetId, input.text, input.mediaUrls);
        if (!result) {
          return { success: false, error: 'Failed to post quote tweet.' };
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
  ];
}
