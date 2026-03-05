/**
 * Discord Integration Tools
 *
 * Tools for managing Discord bot/webhook integration.
 * Supports webhook mode (outbound avatar), bot mode (full functionality),
 * and hybrid mode (both).
 */
import { z } from 'zod';
import { defineTool, type ToolResult } from '../registry.js';

/**
 * Discord connection status
 */
export interface DiscordConnectionStatus {
  connected: boolean;
  mode: 'webhook' | 'bot' | 'hybrid' | 'global' | 'none';
  botUsername?: string;
  botId?: string;
  webhookConfigured?: boolean;
  guilds?: Array<{
    id: string;
    name: string;
    memberCount?: number;
  }>;
}

/**
 * Discord channel info
 */
export interface DiscordChannel {
  id: string;
  name: string;
  type: 'text' | 'voice' | 'category' | 'announcement' | 'forum' | 'thread' | 'dm' | 'group_dm';
  guildId?: string;
  guildName?: string;
  parentId?: string;
}

/**
 * Discord guild info
 */
export interface DiscordGuild {
  id: string;
  name: string;
  icon?: string;
  memberCount?: number;
  channels?: DiscordChannel[];
}

/**
 * Discord message info
 */
export interface DiscordMessageInfo {
  id: string;
  channelId: string;
  content: string;
  authorId: string;
  authorUsername: string;
  createdAt: string;
  attachments?: Array<{ url: string; type: string }>;
}

/**
 * Services required by Discord tools
 */
export interface DiscordServices {
  /**
   * Get Discord connection status for current avatar
   */
  getConnectionStatus: () => Promise<DiscordConnectionStatus>;

  /**
   * Send a message to a Discord channel
   */
  sendMessage: (
    channelId: string,
    content: string,
    options?: {
      embeds?: Array<{
        title?: string;
        description?: string;
        color?: number;
        image?: { url: string };
        fields?: Array<{ name: string; value: string; inline?: boolean }>;
      }>;
      replyTo?: string;
    }
  ) => Promise<{ messageId: string } | null>;

  /**
   * Send a message via webhook (custom avatar)
   */
  sendWebhookMessage?: (
    content: string,
    options?: {
      username?: string;
      avatarUrl?: string;
      embeds?: Array<Record<string, unknown>>;
    }
  ) => Promise<{ messageId?: string } | null>;

  /**
   * Get a specific channel
   */
  getChannel?: (channelId: string) => Promise<DiscordChannel | null>;

  /**
   * List channels in a guild
   */
  listChannels?: (guildId: string) => Promise<DiscordChannel[]>;

  /**
   * List guilds the bot is in
   */
  listGuilds?: () => Promise<DiscordGuild[]>;

  /**
   * Get recent messages from a channel
   */
  getMessages?: (channelId: string, limit?: number) => Promise<DiscordMessageInfo[]>;

  /**
   * Add a reaction to a message
   */
  addReaction?: (channelId: string, messageId: string, emoji: string) => Promise<boolean>;

  /**
   * Remove a reaction from a message
   */
  removeReaction?: (channelId: string, messageId: string, emoji: string) => Promise<boolean>;

  /**
   * Set the bot's status/presence
   */
  setPresence?: (status: 'online' | 'idle' | 'dnd' | 'invisible', activity?: string) => Promise<boolean>;

  /**
   * Get LLM-generated summary for a channel
   */
  getChannelSummary?: (channelId: string) => Promise<string | null>;

  /**
   * List all channels the bot can see (across all guilds) for cross-platform awareness
   */
  listAllChannels?: () => Promise<DiscordChannel[]>;

  // ── Global bot management ───────────────────────────────────────────

  /**
   * Set up the global Discord bot token (validates via /users/@me, stores at global secret path)
   */
  setupGlobalBot?: (token: string) => Promise<{
    success: boolean;
    botId?: string;
    botUsername?: string;
    error?: string;
  }>;

  /**
   * Set an avatar to global Discord mode
   */
  setAvatarGlobalMode?: (
    avatarId: string,
    config: { allowedChannels?: string[]; allowedGuilds?: string[] }
  ) => Promise<{ success: boolean; error?: string }>;

  /**
   * Get global bot status — is it configured, how many avatars use it
   */
  getGlobalBotStatus?: () => Promise<{
    configured: boolean;
    botId?: string;
    botUsername?: string;
    globalAvatarCount: number;
  }>;
}

/**
 * Create Discord tools
 */
export function createDiscordTools(services: DiscordServices) {
  return [
    // =========================================================================
    // Status & Connection
    // =========================================================================

    defineTool({
      name: 'discord_status',
      description: 'Check Discord connection status. Shows mode (webhook/bot/hybrid), connected guilds, and bot info.',
      category: 'readonly',
      toolset: 'discord',
      inputSchema: z.object({}),
      execute: async (_input, _context): Promise<ToolResult> => {
        const status = await services.getConnectionStatus();

        if (!status.connected) {
          return {
            success: true,
            data: {
              connected: false,
              mode: 'none',
              message: 'Discord is not configured. Set up a webhook URL or bot token to enable Discord.',
            },
          };
        }

        return {
          success: true,
          data: {
            connected: true,
            mode: status.mode,
            botUsername: status.botUsername,
            webhookConfigured: status.webhookConfigured,
            guilds: status.guilds?.map(g => ({
              id: g.id,
              name: g.name,
              members: g.memberCount,
            })),
            message: `Discord connected in ${status.mode} mode${status.botUsername ? ` as ${status.botUsername}` : ''}`,
          },
        };
      },
    }),

    // =========================================================================
    // Messaging
    // =========================================================================

    defineTool({
      name: 'discord_send',
      description: 'Send a message to a Discord channel. Requires bot mode or hybrid mode.',
      category: 'media',
      toolset: 'discord',
      inputSchema: z.object({
        channelId: z.string().describe('The Discord channel ID to send to'),
        content: z.string().describe('The message content'),
        replyTo: z.string().optional().describe('Message ID to reply to'),
        embed: z
          .object({
            title: z.string().optional(),
            description: z.string().optional(),
            color: z.number().optional().describe('Embed color as integer (e.g., 0x00ff00 for green)'),
            imageUrl: z.string().optional(),
          })
          .optional()
          .describe('Optional embed to include'),
      }),
      execute: async (input, _context): Promise<ToolResult> => {
        const status = await services.getConnectionStatus();
        if (!status.connected || status.mode === 'webhook') {
          return {
            success: false,
            error: 'Discord bot is not connected. Channel messaging requires bot mode.',
          };
        }

        const options: Parameters<typeof services.sendMessage>[2] = {};
        if (input.replyTo) {
          options.replyTo = input.replyTo;
        }
        if (input.embed) {
          options.embeds = [
            {
              title: input.embed.title,
              description: input.embed.description,
              color: input.embed.color,
              image: input.embed.imageUrl ? { url: input.embed.imageUrl } : undefined,
            },
          ];
        }

        const result = await services.sendMessage(input.channelId, input.content, options);
        if (!result) {
          return { success: false, error: 'Failed to send message.' };
        }

        return {
          success: true,
          data: {
            messageId: result.messageId,
            message: 'Message sent!',
          },
        };
      },
    }),

    defineTool({
      name: 'discord_webhook_send',
      description: 'Send a message via Discord webhook. Allows custom username and avatar. Works in webhook or hybrid mode.',
      category: 'media',
      toolset: 'discord',
      inputSchema: z.object({
        content: z.string().describe('The message content'),
        username: z.string().optional().describe('Custom username for this message'),
        avatarUrl: z.string().optional().describe('Custom avatar URL for this message'),
        embed: z
          .object({
            title: z.string().optional(),
            description: z.string().optional(),
            color: z.number().optional(),
            imageUrl: z.string().optional(),
          })
          .optional(),
      }),
      execute: async (input, _context): Promise<ToolResult> => {
        const status = await services.getConnectionStatus();
        if (!status.connected || !status.webhookConfigured) {
          return {
            success: false,
            error: 'Discord webhook is not configured.',
          };
        }

        if (!services.sendWebhookMessage) {
          return { success: false, error: 'Webhook service is not available.' };
        }

        const embeds = input.embed
          ? [
              {
                title: input.embed.title,
                description: input.embed.description,
                color: input.embed.color,
                image: input.embed.imageUrl ? { url: input.embed.imageUrl } : undefined,
              },
            ]
          : undefined;

        const result = await services.sendWebhookMessage(input.content, {
          username: input.username,
          avatarUrl: input.avatarUrl,
          embeds,
        });

        if (!result) {
          return { success: false, error: 'Failed to send webhook message.' };
        }

        return {
          success: true,
          data: {
            messageId: result.messageId,
            message: 'Webhook message sent!',
          },
        };
      },
    }),

    // =========================================================================
    // Channel & Guild Info
    // =========================================================================

    defineTool({
      name: 'discord_list_guilds',
      description: 'List Discord servers (guilds) the bot is a member of.',
      category: 'readonly',
      toolset: 'discord',
      inputSchema: z.object({}),
      execute: async (_input, _context): Promise<ToolResult> => {
        const status = await services.getConnectionStatus();
        if (!status.connected || status.mode === 'webhook') {
          return {
            success: false,
            error: 'Discord bot is not connected.',
          };
        }

        if (!services.listGuilds) {
          return { success: false, error: 'Guild listing is not available.' };
        }

        const guilds = await services.listGuilds();
        return {
          success: true,
          data: {
            count: guilds.length,
            guilds: guilds.map(g => ({
              id: g.id,
              name: g.name,
              memberCount: g.memberCount,
              icon: g.icon,
            })),
          },
        };
      },
    }),

    defineTool({
      name: 'discord_list_channels',
      description: 'List channels in a Discord server.',
      category: 'readonly',
      toolset: 'discord',
      inputSchema: z.object({
        guildId: z.string().describe('The guild ID to list channels for'),
        type: z.enum(['text', 'voice', 'all']).optional().default('text').describe('Filter by channel type'),
      }),
      execute: async (input, _context): Promise<ToolResult> => {
        const status = await services.getConnectionStatus();
        if (!status.connected || status.mode === 'webhook') {
          return {
            success: false,
            error: 'Discord bot is not connected.',
          };
        }

        if (!services.listChannels) {
          return { success: false, error: 'Channel listing is not available.' };
        }

        let channels = await services.listChannels(input.guildId);

        if (input.type === 'text') {
          channels = channels.filter(c => c.type === 'text' || c.type === 'announcement');
        } else if (input.type === 'voice') {
          channels = channels.filter(c => c.type === 'voice');
        }

        return {
          success: true,
          data: {
            guildId: input.guildId,
            count: channels.length,
            channels: channels.map(c => ({
              id: c.id,
              name: c.name,
              type: c.type,
              parentId: c.parentId,
            })),
          },
        };
      },
    }),

    defineTool({
      name: 'discord_get_channel',
      description: 'Get information about a specific Discord channel.',
      category: 'readonly',
      toolset: 'discord',
      inputSchema: z.object({
        channelId: z.string().describe('The channel ID to get info for'),
      }),
      execute: async (input, _context): Promise<ToolResult> => {
        const status = await services.getConnectionStatus();
        if (!status.connected || status.mode === 'webhook') {
          return {
            success: false,
            error: 'Discord bot is not connected.',
          };
        }

        if (!services.getChannel) {
          return { success: false, error: 'Channel lookup is not available.' };
        }

        const channel = await services.getChannel(input.channelId);
        if (!channel) {
          return { success: false, error: 'Channel not found.' };
        }

        return {
          success: true,
          data: {
            id: channel.id,
            name: channel.name,
            type: channel.type,
            guildId: channel.guildId,
            guildName: channel.guildName,
          },
        };
      },
    }),

    // =========================================================================
    // Message Reading
    // =========================================================================

    defineTool({
      name: 'discord_get_messages',
      description: 'Get recent messages from a Discord channel. Useful for reading context.',
      category: 'readonly',
      toolset: 'discord',
      inputSchema: z.object({
        channelId: z.string().describe('The channel ID to read from'),
        limit: z.number().min(1).max(100).optional().default(20).describe('Number of messages to fetch'),
      }),
      execute: async (input, _context): Promise<ToolResult> => {
        const status = await services.getConnectionStatus();
        if (!status.connected || status.mode === 'webhook') {
          return {
            success: false,
            error: 'Discord bot is not connected.',
          };
        }

        if (!services.getMessages) {
          return { success: false, error: 'Message reading is not available.' };
        }

        const messages = await services.getMessages(input.channelId, input.limit);
        return {
          success: true,
          data: {
            channelId: input.channelId,
            count: messages.length,
            messages: messages.map(m => ({
              id: m.id,
              content: m.content,
              author: m.authorUsername,
              createdAt: m.createdAt,
              hasAttachments: (m.attachments?.length || 0) > 0,
            })),
          },
        };
      },
    }),

    // =========================================================================
    // Reactions
    // =========================================================================

    defineTool({
      name: 'discord_react',
      description: 'Add an emoji reaction to a Discord message.',
      category: 'media',
      toolset: 'discord',
      inputSchema: z.object({
        channelId: z.string().describe('The channel ID'),
        messageId: z.string().describe('The message ID to react to'),
        emoji: z.string().describe('The emoji to react with (e.g., "👍", "🎉", or custom emoji ID)'),
      }),
      execute: async (input, _context): Promise<ToolResult> => {
        const status = await services.getConnectionStatus();
        if (!status.connected || status.mode === 'webhook') {
          return {
            success: false,
            error: 'Discord bot is not connected.',
          };
        }

        if (!services.addReaction) {
          return { success: false, error: 'Reactions are not available.' };
        }

        const success = await services.addReaction(input.channelId, input.messageId, input.emoji);
        if (!success) {
          return { success: false, error: 'Failed to add reaction.' };
        }

        return {
          success: true,
          data: { message: `Reacted with ${input.emoji}` },
        };
      },
    }),

    defineTool({
      name: 'discord_unreact',
      description: 'Remove an emoji reaction from a Discord message.',
      category: 'media',
      toolset: 'discord',
      inputSchema: z.object({
        channelId: z.string().describe('The channel ID'),
        messageId: z.string().describe('The message ID'),
        emoji: z.string().describe('The emoji to remove'),
      }),
      execute: async (input, _context): Promise<ToolResult> => {
        const status = await services.getConnectionStatus();
        if (!status.connected || status.mode === 'webhook') {
          return {
            success: false,
            error: 'Discord bot is not connected.',
          };
        }

        if (!services.removeReaction) {
          return { success: false, error: 'Reactions are not available.' };
        }

        const success = await services.removeReaction(input.channelId, input.messageId, input.emoji);
        if (!success) {
          return { success: false, error: 'Failed to remove reaction.' };
        }

        return {
          success: true,
          data: { message: 'Reaction removed.' },
        };
      },
    }),

    // =========================================================================
    // Presence
    // =========================================================================

    defineTool({
      name: 'discord_set_status',
      description: 'Set the bot\'s online status and activity message.',
      category: 'config',
      toolset: 'discord',
      inputSchema: z.object({
        status: z.enum(['online', 'idle', 'dnd', 'invisible']).describe('Online status'),
        activity: z.string().optional().describe('Activity message (e.g., "Playing a game")'),
      }),
      execute: async (input, _context): Promise<ToolResult> => {
        const status = await services.getConnectionStatus();
        if (!status.connected || status.mode === 'webhook') {
          return {
            success: false,
            error: 'Discord bot is not connected.',
          };
        }

        if (!services.setPresence) {
          return { success: false, error: 'Presence setting is not available.' };
        }

        const success = await services.setPresence(input.status, input.activity);
        if (!success) {
          return { success: false, error: 'Failed to set status.' };
        }

        return {
          success: true,
          data: {
            status: input.status,
            activity: input.activity,
            message: `Status set to ${input.status}${input.activity ? ` - ${input.activity}` : ''}`,
          },
        };
      },
    }),

    // =========================================================================
    // Cross-Platform Awareness
    // =========================================================================

    defineTool({
      name: 'discord_get_channel_summary',
      description: 'Get an LLM-generated summary of recent activity in a Discord channel.',
      category: 'readonly',
      toolset: 'discord',
      inputSchema: z.object({
        channelId: z.string().describe('The channel ID to summarize'),
      }),
      execute: async (input, _context): Promise<ToolResult> => {
        const status = await services.getConnectionStatus();
        if (!status.connected || status.mode === 'webhook') {
          return {
            success: false,
            error: 'Discord bot is not connected.',
          };
        }

        if (!services.getChannelSummary) {
          // Fall back to getting messages and returning a simple summary
          if (services.getMessages) {
            const messages = await services.getMessages(input.channelId, 10);
            if (messages.length === 0) {
              return {
                success: true,
                data: { summary: 'No recent activity' },
              };
            }
            const summary = `${messages.length} recent messages from ${new Set(messages.map(m => m.authorUsername)).size} participants`;
            return { success: true, data: { summary } };
          }
          return { success: false, error: 'Channel summary is not available.' };
        }

        const summary = await services.getChannelSummary(input.channelId);
        if (!summary) {
          return { success: true, data: { summary: 'No activity to summarize' } };
        }

        return {
          success: true,
          data: {
            channelId: input.channelId,
            summary,
          },
        };
      },
    }),

    defineTool({
      name: 'discord_list_all_channels',
      description: 'List all Discord channels the bot can access across all servers. Useful for cross-platform awareness.',
      category: 'readonly',
      toolset: 'discord',
      platforms: ['admin-ui', 'api', 'mcp'],
      inputSchema: z.object({
        type: z.enum(['text', 'voice', 'all']).optional().default('text').describe('Filter by channel type'),
      }),
      execute: async (input, _context): Promise<ToolResult> => {
        const status = await services.getConnectionStatus();
        if (!status.connected || status.mode === 'webhook') {
          return {
            success: false,
            error: 'Discord bot is not connected.',
          };
        }

        if (!services.listAllChannels) {
          // Fall back to listing guilds then channels for each
          if (services.listGuilds && services.listChannels) {
            const guilds = await services.listGuilds();
            const allChannels: DiscordChannel[] = [];

            for (const guild of guilds.slice(0, 10)) { // Limit to 10 guilds
              const channels = await services.listChannels(guild.id);
              allChannels.push(...channels.map(c => ({ ...c, guildName: guild.name })));
            }

            let filtered = allChannels;
            if (input.type === 'text') {
              filtered = allChannels.filter(c => c.type === 'text' || c.type === 'announcement');
            } else if (input.type === 'voice') {
              filtered = allChannels.filter(c => c.type === 'voice');
            }

            return {
              success: true,
              data: {
                count: filtered.length,
                channels: filtered.slice(0, 50).map(c => ({
                  id: c.id,
                  name: c.name,
                  type: c.type,
                  guildId: c.guildId,
                  guildName: c.guildName,
                })),
              },
            };
          }
          return { success: false, error: 'Channel listing is not available.' };
        }

        let channels = await services.listAllChannels();

        if (input.type === 'text') {
          channels = channels.filter(c => c.type === 'text' || c.type === 'announcement');
        } else if (input.type === 'voice') {
          channels = channels.filter(c => c.type === 'voice');
        }

        return {
          success: true,
          data: {
            count: channels.length,
            channels: channels.slice(0, 50).map(c => ({
              id: c.id,
              name: c.name,
              type: c.type,
              guildId: c.guildId,
              guildName: c.guildName,
            })),
          },
        };
      },
    }),

    // =========================================================================
    // Global Bot Management (Two-Tier Architecture)
    // =========================================================================

    defineTool({
      name: 'discord_setup_global_bot',
      description: 'Set up the shared global Discord bot token. Validates the token and stores it at the global secret path. All avatars in "global" mode will share this bot.',
      category: 'config',
      toolset: 'discord',
      inputSchema: z.object({
        token: z.string().describe('The Discord bot token to use as the global shared bot'),
      }),
      execute: async (input, _context): Promise<ToolResult> => {
        if (!services.setupGlobalBot) {
          return { success: false, error: 'Global bot setup is not available.' };
        }

        const result = await services.setupGlobalBot(input.token);
        if (!result.success) {
          return { success: false, error: result.error || 'Failed to set up global bot.' };
        }

        return {
          success: true,
          data: {
            botId: result.botId,
            botUsername: result.botUsername,
            message: `Global Discord bot configured as ${result.botUsername} (${result.botId}). Avatars can now use mode: "global" to share this bot.`,
          },
        };
      },
    }),

    defineTool({
      name: 'discord_set_avatar_global_mode',
      description: 'Configure an avatar to use the shared global Discord bot. The avatar will post via webhooks with its own name and profile image.',
      category: 'config',
      toolset: 'discord',
      inputSchema: z.object({
        avatarId: z.string().describe('The avatar ID to configure'),
        allowedChannels: z.array(z.string()).optional().describe('Channel IDs the avatar responds in (empty = all channels in allowed guilds)'),
        allowedGuilds: z.array(z.string()).optional().describe('Guild IDs the avatar operates in (empty = all guilds)'),
      }),
      execute: async (input, _context): Promise<ToolResult> => {
        if (!services.setAvatarGlobalMode) {
          return { success: false, error: 'Global mode configuration is not available.' };
        }

        const result = await services.setAvatarGlobalMode(input.avatarId, {
          allowedChannels: input.allowedChannels,
          allowedGuilds: input.allowedGuilds,
        });

        if (!result.success) {
          return { success: false, error: result.error || 'Failed to set avatar to global mode.' };
        }

        return {
          success: true,
          data: {
            avatarId: input.avatarId,
            mode: 'global',
            allowedChannels: input.allowedChannels,
            allowedGuilds: input.allowedGuilds,
            message: `Avatar ${input.avatarId} is now in global Discord mode. It will use the shared bot and post via webhooks.`,
          },
        };
      },
    }),

    defineTool({
      name: 'discord_global_bot_status',
      description: 'Check if the global Discord bot is configured and how many avatars use it.',
      category: 'readonly',
      toolset: 'discord',
      inputSchema: z.object({}),
      execute: async (_input, _context): Promise<ToolResult> => {
        if (!services.getGlobalBotStatus) {
          return { success: false, error: 'Global bot status is not available.' };
        }

        const status = await services.getGlobalBotStatus();

        if (!status.configured) {
          return {
            success: true,
            data: {
              configured: false,
              message: 'No global Discord bot is configured. Use discord_setup_global_bot to set one up.',
            },
          };
        }

        return {
          success: true,
          data: {
            configured: true,
            botId: status.botId,
            botUsername: status.botUsername,
            globalAvatarCount: status.globalAvatarCount,
            message: `Global bot: ${status.botUsername} (${status.botId}) — ${status.globalAvatarCount} avatar(s) using global mode.`,
          },
        };
      },
    }),
  ];
}
