/**
 * Discord Service
 *
 * Handles Discord integration for avatars including:
 * - Bot token management
 * - Webhook configuration
 * - Message sending
 * - Channel/guild operations
 * - Gateway runtime health checks
 */
import * as secrets from './secrets.js';
import { ECSClient, DescribeServicesCommand } from '@aws-sdk/client-ecs';

const DISCORD_API_BASE = 'https://discord.com/api/v10';

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
  /** Warning when gateway is required but unavailable */
  gatewayWarning?: string;
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
 * Get bot token for an avatar
 */
async function getBotToken(avatarId: string): Promise<string | null> {
  try {
    return await secrets._getSecretValueInternal(avatarId, 'discord_bot_token', 'default');
  } catch {
    return null;
  }
}

/**
 * Get webhook URL for an avatar
 */
async function getWebhookUrl(avatarId: string): Promise<string | null> {
  try {
    return await secrets._getSecretValueInternal(avatarId, 'discord_webhook_url', 'default');
  } catch {
    return null;
  }
}

/**
 * Map Discord channel type number to string
 */
function mapChannelType(type: number): DiscordChannel['type'] {
  const types: Record<number, DiscordChannel['type']> = {
    0: 'text',
    2: 'voice',
    4: 'category',
    5: 'announcement',
    10: 'thread',
    11: 'thread',
    12: 'thread',
    13: 'thread',
    15: 'forum',
    1: 'dm',
    3: 'group_dm',
  };
  return types[type] || 'text';
}

/**
 * Get Discord connection status for an avatar
 */
export async function getConnectionStatus(avatarId: string): Promise<DiscordConnectionStatus> {
  const [botToken, webhookUrl] = await Promise.all([
    getBotToken(avatarId),
    getWebhookUrl(avatarId),
  ]);

  const hasBotToken = !!botToken;
  const hasWebhook = !!webhookUrl;

  if (!hasBotToken && !hasWebhook) {
    return {
      connected: false,
      mode: 'none',
    };
  }

  let mode: DiscordConnectionStatus['mode'] = 'none';
  if (hasBotToken && hasWebhook) {
    mode = 'hybrid';
  } else if (hasBotToken) {
    mode = 'bot';
  } else if (hasWebhook) {
    mode = 'webhook';
  }

  const result: DiscordConnectionStatus = {
    connected: true,
    mode,
    webhookConfigured: hasWebhook,
  };

  // If we have a bot token, fetch bot info and guilds
  if (botToken) {
    try {
      // Get bot user info
      const meResponse = await fetch(`${DISCORD_API_BASE}/users/@me`, {
        headers: { Authorization: `Bot ${botToken}` },
      });

      if (meResponse.ok) {
        const me = (await meResponse.json()) as { id: string; username: string };
        result.botId = me.id;
        result.botUsername = me.username;
      }

      // Get guilds
      const guildsResponse = await fetch(`${DISCORD_API_BASE}/users/@me/guilds`, {
        headers: { Authorization: `Bot ${botToken}` },
      });

      if (guildsResponse.ok) {
        const guilds = (await guildsResponse.json()) as Array<{
          id: string;
          name: string;
          approximate_member_count?: number;
        }>;

        result.guilds = guilds.map((g) => ({
          id: g.id,
          name: g.name,
          memberCount: g.approximate_member_count,
        }));
      }
    } catch (error) {
      console.error('Failed to fetch Discord bot info:', error instanceof Error ? error.message : String(error));
    }
  }

  // Check gateway availability for bot/hybrid modes
  if (modeRequiresGateway(mode)) {
    const gatewayEnabled = process.env.DISCORD_GATEWAY_ENABLED === 'true';
    if (!gatewayEnabled) {
      result.gatewayWarning =
        `Discord ${mode} mode requires the gateway runtime to receive inbound messages. ` +
        'The gateway is not deployed in this environment. Outbound operations will work, ' +
        'but the bot will not receive new messages from Discord channels.';
    }
  }

  return result;
}

/**
 * Send a message to a Discord channel via bot
 */
export async function sendMessage(
  avatarId: string,
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
): Promise<{ messageId: string } | null> {
  const botToken = await getBotToken(avatarId);
  if (!botToken) {
    return null;
  }

  const payload: Record<string, unknown> = { content };

  if (options?.replyTo) {
    payload.message_reference = { message_id: options.replyTo };
  }

  if (options?.embeds) {
    payload.embeds = options.embeds;
  }

  try {
    const response = await fetch(`${DISCORD_API_BASE}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Discord send message failed:', errorText);
      return null;
    }

    const message = (await response.json()) as { id: string };
    return { messageId: message.id };
  } catch (error) {
    console.error('Discord send message error:', error instanceof Error ? error.message : String(error));
    return null;
  }
}

/**
 * Send a message via Discord webhook
 */
export async function sendWebhookMessage(
  avatarId: string,
  content: string,
  options?: {
    username?: string;
    avatarUrl?: string;
    embeds?: Array<Record<string, unknown>>;
  }
): Promise<{ messageId?: string } | null> {
  const webhookUrl = await getWebhookUrl(avatarId);
  if (!webhookUrl) {
    return null;
  }

  const payload: Record<string, unknown> = {
    content,
    username: options?.username,
    avatar_url: options?.avatarUrl,
  };

  if (options?.embeds) {
    payload.embeds = options.embeds;
  }

  try {
    // Add ?wait=true to get the message ID back
    const url = webhookUrl.includes('?') ? `${webhookUrl}&wait=true` : `${webhookUrl}?wait=true`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Discord webhook message failed:', errorText);
      return null;
    }

    const message = (await response.json()) as { id?: string };
    return { messageId: message.id };
  } catch (error) {
    console.error('Discord webhook message error:', error instanceof Error ? error.message : String(error));
    return null;
  }
}

/**
 * Get a specific channel
 */
export async function getChannel(avatarId: string, channelId: string): Promise<DiscordChannel | null> {
  const botToken = await getBotToken(avatarId);
  if (!botToken) {
    return null;
  }

  try {
    const response = await fetch(`${DISCORD_API_BASE}/channels/${channelId}`, {
      headers: { Authorization: `Bot ${botToken}` },
    });

    if (!response.ok) {
      return null;
    }

    const channel = (await response.json()) as {
      id: string;
      name: string;
      type: number;
      guild_id?: string;
      parent_id?: string;
    };

    return {
      id: channel.id,
      name: channel.name,
      type: mapChannelType(channel.type),
      guildId: channel.guild_id,
      parentId: channel.parent_id,
    };
  } catch (error) {
    console.error('Discord get channel error:', error instanceof Error ? error.message : String(error));
    return null;
  }
}

/**
 * List channels in a guild
 */
export async function listChannels(avatarId: string, guildId: string): Promise<DiscordChannel[]> {
  const botToken = await getBotToken(avatarId);
  if (!botToken) {
    return [];
  }

  try {
    const response = await fetch(`${DISCORD_API_BASE}/guilds/${guildId}/channels`, {
      headers: { Authorization: `Bot ${botToken}` },
    });

    if (!response.ok) {
      return [];
    }

    const channels = (await response.json()) as Array<{
      id: string;
      name: string;
      type: number;
      parent_id?: string;
    }>;

    return channels.map((c) => ({
      id: c.id,
      name: c.name,
      type: mapChannelType(c.type),
      guildId,
      parentId: c.parent_id,
    }));
  } catch (error) {
    console.error('Discord list channels error:', error instanceof Error ? error.message : String(error));
    return [];
  }
}

/**
 * List guilds the bot is in
 */
export async function listGuilds(avatarId: string): Promise<DiscordGuild[]> {
  const botToken = await getBotToken(avatarId);
  if (!botToken) {
    return [];
  }

  try {
    const response = await fetch(`${DISCORD_API_BASE}/users/@me/guilds`, {
      headers: { Authorization: `Bot ${botToken}` },
    });

    if (!response.ok) {
      return [];
    }

    const guilds = (await response.json()) as Array<{
      id: string;
      name: string;
      icon?: string;
      approximate_member_count?: number;
    }>;

    return guilds.map((g) => ({
      id: g.id,
      name: g.name,
      icon: g.icon,
      memberCount: g.approximate_member_count,
    }));
  } catch (error) {
    console.error('Discord list guilds error:', error instanceof Error ? error.message : String(error));
    return [];
  }
}

/**
 * Get recent messages from a channel
 */
export async function getMessages(
  avatarId: string,
  channelId: string,
  limit = 20
): Promise<DiscordMessageInfo[]> {
  const botToken = await getBotToken(avatarId);
  if (!botToken) {
    return [];
  }

  try {
    const response = await fetch(
      `${DISCORD_API_BASE}/channels/${channelId}/messages?limit=${limit}`,
      {
        headers: { Authorization: `Bot ${botToken}` },
      }
    );

    if (!response.ok) {
      return [];
    }

    const messages = (await response.json()) as Array<{
      id: string;
      channel_id: string;
      content: string;
      author: { id: string; username: string };
      timestamp: string;
      attachments?: Array<{ url: string; content_type?: string }>;
    }>;

    return messages.map((m) => ({
      id: m.id,
      channelId: m.channel_id,
      content: m.content,
      authorId: m.author.id,
      authorUsername: m.author.username,
      createdAt: m.timestamp,
      attachments: m.attachments?.map((a) => ({
        url: a.url,
        type: a.content_type || 'unknown',
      })),
    }));
  } catch (error) {
    console.error('Discord get messages error:', error instanceof Error ? error.message : String(error));
    return [];
  }
}

/**
 * Add a reaction to a message
 */
export async function addReaction(
  avatarId: string,
  channelId: string,
  messageId: string,
  emoji: string
): Promise<boolean> {
  const botToken = await getBotToken(avatarId);
  if (!botToken) {
    return false;
  }

  try {
    const encodedEmoji = encodeURIComponent(emoji);
    const response = await fetch(
      `${DISCORD_API_BASE}/channels/${channelId}/messages/${messageId}/reactions/${encodedEmoji}/@me`,
      {
        method: 'PUT',
        headers: { Authorization: `Bot ${botToken}` },
      }
    );

    return response.ok;
  } catch (error) {
    console.error('Discord add reaction error:', error instanceof Error ? error.message : String(error));
    return false;
  }
}

/**
 * Remove a reaction from a message
 */
export async function removeReaction(
  avatarId: string,
  channelId: string,
  messageId: string,
  emoji: string
): Promise<boolean> {
  const botToken = await getBotToken(avatarId);
  if (!botToken) {
    return false;
  }

  try {
    const encodedEmoji = encodeURIComponent(emoji);
    const response = await fetch(
      `${DISCORD_API_BASE}/channels/${channelId}/messages/${messageId}/reactions/${encodedEmoji}/@me`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bot ${botToken}` },
      }
    );

    return response.ok;
  } catch (error) {
    console.error('Discord remove reaction error:', error instanceof Error ? error.message : String(error));
    return false;
  }
}

/**
 * Validate a Discord bot token
 */
export async function validateBotToken(token: string): Promise<{
  valid: boolean;
  error?: string;
  botInfo?: { id: string; username: string };
}> {
  try {
    const response = await fetch(`${DISCORD_API_BASE}/users/@me`, {
      headers: { Authorization: `Bot ${token}` },
    });

    if (!response.ok) {
      return { valid: false, error: 'Invalid bot token' };
    }

    const me = (await response.json()) as { id: string; username: string };
    return {
      valid: true,
      botInfo: { id: me.id, username: me.username },
    };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Validate a Discord webhook URL
 */
export async function validateWebhookUrl(url: string): Promise<{
  valid: boolean;
  error?: string;
  webhookInfo?: { id: string; name: string; guildId?: string; channelId?: string };
}> {
  try {
    const response = await fetch(url);

    if (!response.ok) {
      return { valid: false, error: 'Invalid webhook URL' };
    }

    const webhook = (await response.json()) as {
      id: string;
      name: string;
      guild_id?: string;
      channel_id?: string;
    };

    return {
      valid: true,
      webhookInfo: {
        id: webhook.id,
        name: webhook.name,
        guildId: webhook.guild_id,
        channelId: webhook.channel_id,
      },
    };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// =============================================================================
// Gateway Runtime Health
// =============================================================================

/**
 * Discord gateway runtime status
 */
export interface DiscordGatewayStatus {
  /** Whether the gateway infrastructure is deployed for this environment */
  deployed: boolean;
  /** Whether the gateway ECS service has running tasks */
  running: boolean;
  /** Number of running tasks (0 if not deployed or unavailable) */
  runningCount: number;
  /** Desired task count from the ECS service */
  desiredCount: number;
  /** Human-readable status message */
  message: string;
}

/**
 * Check the Discord gateway runtime status.
 *
 * Uses two signals:
 * 1. The DISCORD_GATEWAY_ENABLED env var (set by CDK) to check if gateway
 *    was deployed as part of the stack.
 * 2. An optional ECS DescribeServices call to check live running task count.
 *
 * For the ECS check, the service ARN must be available via the
 * DISCORD_GATEWAY_SERVICE_ARN environment variable.
 */
export async function getGatewayStatus(): Promise<DiscordGatewayStatus> {
  const gatewayEnabled = process.env.DISCORD_GATEWAY_ENABLED === 'true';

  if (!gatewayEnabled) {
    return {
      deployed: false,
      running: false,
      runningCount: 0,
      desiredCount: 0,
      message: 'Discord gateway is not deployed in this environment (enableDiscordGateway=false).',
    };
  }

  const serviceArn = process.env.DISCORD_GATEWAY_SERVICE_ARN;
  const clusterArn = process.env.DISCORD_GATEWAY_CLUSTER_ARN;

  if (!serviceArn || !clusterArn) {
    return {
      deployed: true,
      running: false,
      runningCount: 0,
      desiredCount: 0,
      message:
        'Discord gateway is marked as deployed, but service/cluster ARN ' +
        'environment variables are not configured. Cannot verify running status.',
    };
  }

  try {
    const ecs = new ECSClient({});
    const response = await ecs.send(
      new DescribeServicesCommand({
        cluster: clusterArn,
        services: [serviceArn],
      })
    );

    const service = response.services?.[0];
    if (!service) {
      return {
        deployed: true,
        running: false,
        runningCount: 0,
        desiredCount: 0,
        message: 'Discord gateway ECS service not found. It may have been deleted.',
      };
    }

    const runningCount = service.runningCount ?? 0;
    const desiredCount = service.desiredCount ?? 0;
    const running = runningCount > 0;

    if (running) {
      return {
        deployed: true,
        running: true,
        runningCount,
        desiredCount,
        message: `Discord gateway is running (${runningCount}/${desiredCount} tasks).`,
      };
    }

    return {
      deployed: true,
      running: false,
      runningCount: 0,
      desiredCount,
      message:
        `Discord gateway has zero running tasks (desired: ${desiredCount}). ` +
        'Bot/hybrid mode avatars will not receive inbound Discord messages.',
    };
  } catch (error) {
    return {
      deployed: true,
      running: false,
      runningCount: 0,
      desiredCount: 0,
      message: `Failed to query gateway status: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

/**
 * Check if a specific Discord mode requires the gateway runtime.
 */
export function modeRequiresGateway(mode: 'webhook' | 'bot' | 'hybrid' | 'none'): boolean {
  return mode === 'bot' || mode === 'hybrid';
}

/**
 * Get a human-readable warning for Discord operations that require the gateway.
 * Returns null if the gateway is available or not needed for the given mode.
 */
export async function getGatewayGuardrailWarning(
  mode: 'webhook' | 'bot' | 'hybrid' | 'none'
): Promise<string | null> {
  if (!modeRequiresGateway(mode)) {
    return null;
  }

  const status = await getGatewayStatus();

  if (status.deployed && status.running) {
    return null;
  }

  if (!status.deployed) {
    return (
      `Discord ${mode} mode requires the gateway runtime, but it is not deployed ` +
      'in this environment. Inbound Discord messages will not be received. ' +
      'Contact your infrastructure team to enable the Discord gateway ' +
      '(set enableDiscordGateway=true in CDK context).'
    );
  }

  return (
    `Discord ${mode} mode requires the gateway runtime. The gateway is deployed ` +
    `but has zero running tasks. ${status.message}`
  );
}
