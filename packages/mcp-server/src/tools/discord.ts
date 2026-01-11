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
  mode: 'webhook' | 'bot' | 'hybrid' | 'none';
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
   * Get Discord connection status for current agent
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
  ];
}
