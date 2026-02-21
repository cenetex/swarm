/**
 * Cross-Platform Presence Tools
 *
 * Unified tools for cross-platform awareness and posting.
 * Provides a single interface for the AI to:
 * - See all connected platforms and channels
 * - Post to any channel on any platform
 * - Check rate limits across platforms
 */
import { z } from 'zod';
import { defineTool, type ToolResult } from '../registry.js';

// =============================================================================
// TYPES
// =============================================================================

export interface PlatformStatus {
  platform: 'telegram' | 'discord' | 'twitter' | 'web';
  connected: boolean;
  botUsername?: string;
  channelCount?: number;
  lastActivityAt?: number;
}

export interface ChannelOverview {
  channelId: string;
  platform: 'telegram' | 'discord' | 'twitter' | 'web';
  title?: string;
  type?: string;
  lastActivityAt?: number;
  summary?: string;
}

export interface RateLimitInfo {
  allowed: boolean;
  remaining: number;
  maxPosts: number;
  windowEndAt: number;
}

// =============================================================================
// SERVICE INTERFACE
// =============================================================================

export interface PresenceServices {
  /**
   * Get all connected platforms for this avatar
   */
  getConnectedPlatforms: () => Promise<PlatformStatus[]>;

  /**
   * Get all channels across all platforms
   */
  getAllChannels: () => Promise<ChannelOverview[]>;

  /**
   * Get channels for a specific platform
   */
  getChannelsForPlatform: (platform: string) => Promise<ChannelOverview[]>;

  /**
   * Build presence context string for system prompt
   */
  buildPresenceContext: () => Promise<string>;

  /**
   * Check global rate limit for cross-platform posting
   */
  checkRateLimit: () => Promise<RateLimitInfo>;

  /**
   * Record a post (for rate limiting)
   */
  recordPost: (platform: string, channelId: string) => Promise<void>;

  /**
   * Post to any channel (universal posting)
   */
  postToChannel?: (
    platform: string,
    channelId: string,
    message: string,
    options?: { parseMode?: string; embed?: Record<string, unknown> }
  ) => Promise<{ success: boolean; messageId?: string; error?: string }>;

  /**
   * Get channel with summary
   */
  getChannelSummary?: (platform: string, channelId: string) => Promise<string | null>;
}

// =============================================================================
// TOOL DEFINITIONS
// =============================================================================

export function createPresenceTools(services: PresenceServices) {
  return [
    defineTool({
      name: 'get_presence_overview',
      description: `Get a complete overview of my presence across all connected platforms. Shows which platforms I'm connected to, active channels, recent activity summaries, and rate limit status. Use this to understand where I can post and what's happening across my platforms.`,
      category: 'readonly',
      toolset: 'core',
      platforms: ['telegram', 'discord', 'twitter', 'admin-ui', 'api', 'mcp'],
      inputSchema: z.object({}),
      execute: async (_input, _context): Promise<ToolResult> => {
        try {
          const [platforms, channels, rateLimit, presenceText] = await Promise.all([
            services.getConnectedPlatforms(),
            services.getAllChannels(),
            services.checkRateLimit(),
            services.buildPresenceContext(),
          ]);

          const connectedPlatforms = platforms.filter(p => p.connected);

          return {
            success: true,
            data: {
              platforms: platforms.map(p => ({
                platform: p.platform,
                connected: p.connected,
                botUsername: p.botUsername,
                channelCount: p.channelCount,
              })),
              totalChannels: channels.length,
              connectedPlatformCount: connectedPlatforms.length,
              rateLimit: {
                canPost: rateLimit.allowed,
                remaining: rateLimit.remaining,
                maxPerHour: rateLimit.maxPosts,
              },
              presenceContext: presenceText,
            },
          };
        } catch (err) {
          return { success: false, error: String(err) };
        }
      },
    }),

    defineTool({
      name: 'list_all_channels',
      description: 'List all channels across all connected platforms. Optionally filter by platform.',
      category: 'readonly',
      toolset: 'core',
      platforms: ['telegram', 'discord', 'twitter', 'admin-ui', 'api', 'mcp'],
      inputSchema: z.object({
        platform: z.enum(['telegram', 'discord', 'twitter', 'web', 'all']).optional()
          .default('all')
          .describe('Filter channels by platform, or "all" for all platforms'),
        limit: z.number().min(1).max(100).optional().default(20)
          .describe('Maximum number of channels to return'),
      }),
      execute: async (input, _context): Promise<ToolResult> => {
        try {
          let channels: ChannelOverview[];

          if (input.platform === 'all') {
            channels = await services.getAllChannels();
          } else {
            channels = await services.getChannelsForPlatform(input.platform);
          }

          // Sort by last activity
          channels.sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));

          // Apply limit
          const limited = channels.slice(0, input.limit);

          return {
            success: true,
            data: {
              total: channels.length,
              showing: limited.length,
              channels: limited.map(c => ({
                platform: c.platform,
                channelId: c.channelId,
                title: c.title,
                type: c.type,
                lastActive: c.lastActivityAt
                  ? new Date(c.lastActivityAt).toISOString()
                  : undefined,
                summary: c.summary,
              })),
            },
          };
        } catch (err) {
          return { success: false, error: String(err) };
        }
      },
    }),

    defineTool({
      name: 'check_post_rate_limit',
      description: 'Check if I can post to channels and how many posts I have remaining in the rate limit window.',
      category: 'readonly',
      toolset: 'core',
      platforms: ['telegram', 'discord', 'twitter', 'admin-ui', 'api', 'mcp'],
      inputSchema: z.object({}),
      execute: async (_input, _context): Promise<ToolResult> => {
        try {
          const rateLimit = await services.checkRateLimit();

          return {
            success: true,
            data: {
              canPost: rateLimit.allowed,
              remaining: rateLimit.remaining,
              maxPerHour: rateLimit.maxPosts,
              windowEndsAt: new Date(rateLimit.windowEndAt).toISOString(),
              message: rateLimit.allowed
                ? `You can post. ${rateLimit.remaining} posts remaining this hour.`
                : `Rate limit reached. Try again after ${new Date(rateLimit.windowEndAt).toLocaleTimeString()}.`,
            },
          };
        } catch (err) {
          return { success: false, error: String(err) };
        }
      },
    }),

    defineTool({
      name: 'post_to_channel',
      description: `Post a message to any channel on any connected platform. This is the universal cross-platform posting tool. Checks rate limits before posting.`,
      category: 'media',
      toolset: 'core',
      platforms: ['telegram', 'discord', 'twitter', 'admin-ui', 'api', 'mcp'],
      inputSchema: z.object({
        platform: z.enum(['telegram', 'discord', 'twitter']).describe('Target platform'),
        channelId: z.string().describe('Channel/chat ID to post to'),
        message: z.string().min(1).max(4096).describe('Message text to post'),
        options: z.object({
          parseMode: z.string().optional().describe('Parse mode (HTML, Markdown) for Telegram'),
          embed: z.record(z.string(), z.unknown()).optional().describe('Embed data for Discord'),
        }).optional(),
      }),
      execute: async (input, _context): Promise<ToolResult> => {
        if (!services.postToChannel) {
          return {
            success: false,
            error: 'Universal posting is not available. Use platform-specific tools instead.',
          };
        }

        try {
          // Check rate limit first
          const rateLimit = await services.checkRateLimit();
          if (!rateLimit.allowed) {
            return {
              success: false,
              error: `Rate limit exceeded. ${rateLimit.remaining} posts remaining. Try again after ${new Date(rateLimit.windowEndAt).toLocaleTimeString()}.`,
            };
          }

          // Post the message
          const result = await services.postToChannel(
            input.platform,
            input.channelId,
            input.message,
            input.options
          );

          if (!result.success) {
            return { success: false, error: result.error || 'Failed to post message' };
          }

          // Record the post for rate limiting
          await services.recordPost(input.platform, input.channelId);

          return {
            success: true,
            data: {
              messageId: result.messageId,
              platform: input.platform,
              channelId: input.channelId,
              rateLimitRemaining: rateLimit.remaining - 1,
              message: 'Message posted successfully!',
            },
          };
        } catch (err) {
          return { success: false, error: String(err) };
        }
      },
    }),

    defineTool({
      name: 'get_channel_summary',
      description: 'Get an LLM-generated summary of recent activity in a specific channel.',
      category: 'readonly',
      toolset: 'core',
      platforms: ['telegram', 'discord', 'admin-ui', 'api', 'mcp'],
      inputSchema: z.object({
        platform: z.enum(['telegram', 'discord']).describe('Platform the channel is on'),
        channelId: z.string().describe('Channel/chat ID'),
      }),
      execute: async (input, _context): Promise<ToolResult> => {
        if (!services.getChannelSummary) {
          return {
            success: false,
            error: 'Channel summary is not available.',
          };
        }

        try {
          const summary = await services.getChannelSummary(input.platform, input.channelId);

          if (!summary) {
            return {
              success: true,
              data: {
                platform: input.platform,
                channelId: input.channelId,
                summary: 'No recent activity to summarize',
              },
            };
          }

          return {
            success: true,
            data: {
              platform: input.platform,
              channelId: input.channelId,
              summary,
            },
          };
        } catch (err) {
          return { success: false, error: String(err) };
        }
      },
    }),
  ];
}
