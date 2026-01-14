/**
 * Discord Platform Adapter
 *
 * Supports three modes:
 * - 'webhook': Outbound only via Discord webhook (for custom avatar appearance)
 * - 'bot': Full bot functionality with gateway/interaction handling
 * - 'hybrid': Webhook for posting + bot for reading/responding
 */
import { PlatformAdapter } from './base.js';
import type {
  AgentConfig,
  SwarmEnvelope,
  ResponseAction,
  SenderInfo,
  MessageContent,
  DiscordConfig,
  Mention,
} from '../types/index.js';

// Discord API types (minimal, to avoid dependency on discord.js in core)
export interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: {
    id: string;
    username: string;
    discriminator?: string;
    global_name?: string;
    bot?: boolean;
    avatar?: string;
  };
  content: string;
  timestamp: string;
  edited_timestamp?: string;
  tts: boolean;
  mention_everyone: boolean;
  mentions: Array<{
    id: string;
    username: string;
    global_name?: string;
  }>;
  attachments: Array<{
    id: string;
    filename: string;
    content_type?: string;
    size: number;
    url: string;
    proxy_url: string;
    width?: number;
    height?: number;
  }>;
  embeds: Array<Record<string, unknown>>;
  reactions?: Array<{
    count: number;
    me: boolean;
    emoji: { id?: string; name: string };
  }>;
  referenced_message?: DiscordMessage;
  type: number;
}

export interface DiscordInteraction {
  id: string;
  application_id: string;
  type: number; // 1=PING, 2=APPLICATION_COMMAND, 3=MESSAGE_COMPONENT, etc.
  guild_id?: string;
  channel_id?: string;
  member?: {
    user: {
      id: string;
      username: string;
      global_name?: string;
      bot?: boolean;
    };
    roles: string[];
    permissions: string;
  };
  user?: {
    id: string;
    username: string;
    global_name?: string;
    bot?: boolean;
  };
  token: string;
  message?: DiscordMessage;
  data?: {
    id: string;
    name: string;
    type: number;
    options?: Array<{ name: string; type: number; value: unknown }>;
  };
}

export interface DiscordCredentials {
  webhookUrl?: string;
  webhookId?: string;
  webhookToken?: string;
  botToken?: string;
  applicationId?: string;
  publicKey?: string;
}

export interface DiscordWebhookPayload {
  content?: string;
  username?: string;
  avatar_url?: string;
  embeds?: Array<{
    title?: string;
    description?: string;
    url?: string;
    color?: number;
    image?: { url: string };
    thumbnail?: { url: string };
    footer?: { text: string; icon_url?: string };
    fields?: Array<{ name: string; value: string; inline?: boolean }>;
  }>;
  allowed_mentions?: {
    parse?: ('roles' | 'users' | 'everyone')[];
    users?: string[];
    roles?: string[];
  };
}

/**
 * Discord Platform Adapter
 */
export class DiscordAdapter extends PlatformAdapter {
  readonly platform = 'discord' as const;
  private config: DiscordConfig;
  private credentials: DiscordCredentials;
  private botUserId?: string;

  constructor(agentConfig: AgentConfig, credentials: DiscordCredentials) {
    super(agentConfig);
    this.config = agentConfig.platforms.discord!;
    this.credentials = credentials;
  }

  isConfigured(): boolean {
    if (!this.config?.enabled) return false;

    switch (this.config.mode) {
      case 'webhook':
        return !!(this.credentials.webhookUrl || (this.credentials.webhookId && this.credentials.webhookToken));
      case 'bot':
        return !!this.credentials.botToken;
      case 'hybrid':
        return !!(
          (this.credentials.webhookUrl || (this.credentials.webhookId && this.credentials.webhookToken)) &&
          this.credentials.botToken
        );
      default:
        return false;
    }
  }

  getDisplayName(): string {
    return `Discord (${this.config.mode} mode)`;
  }

  /**
   * Set the bot's user ID (useful when retrieved from /users/@me after construction)
   */
  setBotUserId(userId: string): void {
    this.botUserId = userId;
  }

  /**
   * Verify Discord interaction request using Ed25519 signature
   */
  async verifyRequest(body: Buffer, headers: Record<string, string>): Promise<boolean> {
    const signature = headers['x-signature-ed25519'];
    const timestamp = headers['x-signature-timestamp'];

    if (!signature || !timestamp || !this.credentials.publicKey) {
      return false;
    }

    try {
      // Dynamic import to avoid loading crypto in all contexts
      const { webcrypto } = await import('crypto');

      // Convert hex public key to bytes
      const publicKeyBytes = Buffer.from(this.credentials.publicKey, 'hex');

      // Import the public key
      const key = await webcrypto.subtle.importKey(
        'raw',
        publicKeyBytes,
        { name: 'Ed25519', namedCurve: 'Ed25519' },
        false,
        ['verify']
      );

      // Prepare the message (timestamp + body)
      const message = Buffer.concat([Buffer.from(timestamp), body]);

      // Verify the signature
      const signatureBytes = Buffer.from(signature, 'hex');
      const isValid = await webcrypto.subtle.verify('Ed25519', key, signatureBytes, message);

      return isValid;
    } catch (error) {
      console.error('Failed to verify Discord signature:', error);
      return false;
    }
  }

  /**
   * Parse Discord message or interaction into SwarmEnvelope
   */
  async parseMessage(body: unknown): Promise<SwarmEnvelope | null> {
    // Check if it's an interaction
    if (this.isInteraction(body)) {
      return this.parseInteraction(body as DiscordInteraction);
    }

    // Otherwise treat as a message event
    return this.parseMessageEvent(body as DiscordMessage);
  }

  private isInteraction(body: unknown): boolean {
    const obj = body as Record<string, unknown>;
    return typeof obj.type === 'number' && typeof obj.token === 'string';
  }

  private parseInteraction(interaction: DiscordInteraction): SwarmEnvelope | null {
    // Handle PING (type 1) - return null, handled separately
    if (interaction.type === 1) {
      return null;
    }

    const user = interaction.member?.user || interaction.user;
    if (!user) return null;

    const sender = this.extractSenderFromUser(user);
    const content = this.extractContentFromInteraction(interaction);

    // Detect if bot was mentioned
    const isMention = this.config.respondToMentions !== false;

    const envelope = this.createBaseEnvelope({
      messageId: interaction.id,
      conversationId: interaction.channel_id || interaction.id,
      timestamp: Date.now(),
      sender,
      content,
      raw: interaction,
    });

    envelope.metadata.isMention = isMention;
    envelope.metadata.chatType = interaction.guild_id ? 'group' : 'private';
    envelope.metadata.guildId = interaction.guild_id;

    return envelope;
  }

  private parseMessageEvent(message: DiscordMessage): SwarmEnvelope | null {
    // Skip bot messages if configured
    if (this.agentConfig.behavior.ignoreBots && message.author.bot) {
      return null;
    }

    // Check guild/channel filters
    if (this.config.allowedGuilds?.length && message.guild_id) {
      if (!this.config.allowedGuilds.includes(message.guild_id)) {
        return null;
      }
    }

    if (this.config.allowedChannels?.length) {
      if (!this.config.allowedChannels.includes(message.channel_id)) {
        return null;
      }
    }

    const sender = this.extractSenderFromUser(message.author);
    const content = this.extractContentFromMessage(message);
    const mentions = this.extractMentions(message);

    // Check if bot was mentioned
    const isMention = this.botUserId
      ? message.mentions.some(m => m.id === this.botUserId)
      : false;

    // Check if replying to bot
    const isReplyToBot = !!(
      message.referenced_message &&
      message.referenced_message.author.id === this.botUserId
    );

    const envelope = this.createBaseEnvelope({
      messageId: message.id,
      conversationId: message.channel_id,
      timestamp: new Date(message.timestamp).getTime(),
      sender,
      content,
      raw: message,
    });

    envelope.mentions = mentions;
    envelope.replyTo = message.referenced_message?.id;
    envelope.metadata.isMention = isMention;
    envelope.metadata.isReplyToBot = isReplyToBot;
    envelope.metadata.chatType = message.guild_id ? 'group' : 'private';
    envelope.metadata.guildId = message.guild_id;
    envelope.metadata.priority = (isMention || isReplyToBot) ? 'high' : 'normal';

    return envelope;
  }

  private extractSenderFromUser(user: { id: string; username: string; global_name?: string; bot?: boolean }): SenderInfo {
    return {
      id: user.id,
      username: user.username,
      displayName: user.global_name || user.username,
      isBot: user.bot || false,
      platform: 'discord',
      platformUserId: user.id,
    };
  }

  private extractContentFromMessage(message: DiscordMessage): MessageContent {
    const content: MessageContent = {
      text: message.content,
    };

    // Extract attachments as media
    if (message.attachments.length > 0) {
      content.media = message.attachments.map(att => ({
        type: att.content_type?.startsWith('video/') ? 'video' as const
          : att.content_type?.startsWith('image/') ? 'photo' as const
          : 'document' as const,
        url: att.url,
        mimeType: att.content_type,
        size: att.size,
      }));
    }

    return content;
  }

  private extractContentFromInteraction(interaction: DiscordInteraction): MessageContent {
    // For slash commands, extract command name and options
    if (interaction.data) {
      const args = interaction.data.options?.map(o => `${o.name}:${o.value}`).join(' ') || '';
      return {
        text: `/${interaction.data.name} ${args}`.trim(),
        command: {
          command: interaction.data.name,
          args: interaction.data.options?.map(o => String(o.value)) || [],
          raw: `/${interaction.data.name} ${args}`.trim(),
        },
      };
    }

    // For message components, use the message content
    if (interaction.message) {
      return this.extractContentFromMessage(interaction.message);
    }

    return { text: '' };
  }

  private extractMentions(message: DiscordMessage): Mention[] {
    return message.mentions.map(m => ({
      userId: m.id,
      username: m.username,
      offset: message.content.indexOf(`<@${m.id}>`),
      length: `<@${m.id}>`.length,
    }));
  }

  /**
   * Execute a response action on Discord
   */
  async executeAction(
    action: ResponseAction,
    conversationId: string,
    replyToMessageId?: string
  ): Promise<boolean> {
    try {
      switch (action.type) {
        case 'send_message':
          await this.sendMessage(conversationId, action.text, action.media, replyToMessageId);
          break;

        case 'send_media':
          await this.sendMedia(conversationId, action.mediaType, action.url, action.caption);
          break;

        case 'send_voice': {
          const message = action.caption ? `${action.caption}\n${action.url}` : action.url;
          await this.sendMessage(conversationId, message);
          break;
        }

        case 'react':
          await this.addReaction(conversationId, action.messageId, action.emoji);
          break;

        case 'wait':
          await new Promise(resolve => setTimeout(resolve, action.durationMs));
          break;

        case 'ignore':
          break;

        default:
          console.warn(`Unknown Discord action type: ${(action as ResponseAction).type}`);
      }

      return true;
    } catch (error) {
      console.error('Failed to execute Discord action:', error);
      return false;
    }
  }

  /**
   * Send typing indicator to a channel
   */
  async sendTypingIndicator(conversationId: string): Promise<void> {
    if (!this.credentials.botToken) return;

    try {
      await fetch(`https://discord.com/api/v10/channels/${conversationId}/typing`, {
        method: 'POST',
        headers: {
          'Authorization': `Bot ${this.credentials.botToken}`,
        },
      });
    } catch (error) {
      console.warn('Failed to send Discord typing indicator:', error);
    }
  }

  /**
   * Send a message via webhook or bot
   */
  private async sendMessage(
    channelId: string,
    text: string,
    media?: Array<{ type: string; url: string }>,
    replyToMessageId?: string
  ): Promise<void> {
    // Prefer webhook for sending (custom avatar)
    if (this.config.mode === 'webhook' || this.config.mode === 'hybrid') {
      await this.sendViaWebhook(text, media);
      return;
    }

    // Fall back to bot API
    if (this.credentials.botToken) {
      await this.sendViaBot(channelId, text, media, replyToMessageId);
    }
  }

  /**
   * Send message via Discord webhook
   */
  private async sendViaWebhook(
    content: string,
    media?: Array<{ type: string; url: string }>
  ): Promise<void> {
    const webhookUrl = this.getWebhookUrl();
    if (!webhookUrl) {
      throw new Error('No webhook URL configured');
    }

    const payload: DiscordWebhookPayload = {
      content,
      username: this.agentConfig.name,
      avatar_url: this.agentConfig.profileImage?.url,
    };

    // Add embeds for media
    if (media && media.length > 0) {
      payload.embeds = media.map(m => ({
        image: m.type === 'image' ? { url: m.url } : undefined,
      })).filter(e => e.image);
    }

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Webhook request failed: ${error}`);
    }
  }

  /**
   * Send message via Discord Bot API
   */
  private async sendViaBot(
    channelId: string,
    content: string,
    media?: Array<{ type: string; url: string }>,
    replyToMessageId?: string
  ): Promise<void> {
    if (!this.credentials.botToken) {
      throw new Error('No bot token configured');
    }

    const payload: Record<string, unknown> = { content };

    if (replyToMessageId) {
      payload.message_reference = { message_id: replyToMessageId };
    }

    // Add embeds for media
    if (media && media.length > 0) {
      payload.embeds = media.map(m => ({
        image: m.type === 'image' ? { url: m.url } : undefined,
      })).filter((e: Record<string, unknown>) => e.image);
    }

    const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${this.credentials.botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Bot API request failed: ${error}`);
    }
  }

  /**
   * Send media to a channel
   */
  private async sendMedia(
    channelId: string,
    mediaType: string,
    url: string,
    caption?: string
  ): Promise<void> {
    const media = [{ type: mediaType, url }];
    await this.sendMessage(channelId, caption || '', media);
  }

  /**
   * Add a reaction to a message
   */
  private async addReaction(
    channelId: string,
    messageId: string,
    emoji: string
  ): Promise<void> {
    if (!this.credentials.botToken) {
      throw new Error('Cannot add reactions without bot token');
    }

    // URL encode the emoji
    const encodedEmoji = encodeURIComponent(emoji);

    const response = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}/reactions/${encodedEmoji}/@me`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bot ${this.credentials.botToken}`,
        },
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to add reaction: ${error}`);
    }
  }

  /**
   * Get the webhook URL from config or credentials
   */
  private getWebhookUrl(): string | null {
    if (this.credentials.webhookUrl) {
      return this.credentials.webhookUrl;
    }

    if (this.credentials.webhookId && this.credentials.webhookToken) {
      return `https://discord.com/api/webhooks/${this.credentials.webhookId}/${this.credentials.webhookToken}`;
    }

    return null;
  }

  /**
   * Respond to a Discord interaction (for slash commands)
   */
  async respondToInteraction(
    interactionId: string,
    interactionToken: string,
    content: string,
    ephemeral = false
  ): Promise<void> {
    const response = await fetch(
      `https://discord.com/api/v10/interactions/${interactionId}/${interactionToken}/callback`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 4, // CHANNEL_MESSAGE_WITH_SOURCE
          data: {
            content,
            flags: ephemeral ? 64 : 0, // EPHEMERAL flag
          },
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to respond to interaction: ${error}`);
    }
  }

  /**
   * Defer a Discord interaction response (for long-running operations)
   */
  async deferInteraction(
    interactionId: string,
    interactionToken: string,
    ephemeral = false
  ): Promise<void> {
    const response = await fetch(
      `https://discord.com/api/v10/interactions/${interactionId}/${interactionToken}/callback`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 5, // DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE
          data: {
            flags: ephemeral ? 64 : 0,
          },
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to defer interaction: ${error}`);
    }
  }

  /**
   * Edit a deferred interaction response
   */
  async editInteractionResponse(
    applicationId: string,
    interactionToken: string,
    content: string
  ): Promise<void> {
    const response = await fetch(
      `https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}/messages/@original`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to edit interaction response: ${error}`);
    }
  }
}

/**
 * Build a SwarmEnvelope from a Discord gateway message event
 */
export function buildDiscordEnvelope(
  message: DiscordMessage,
  config: {
    agentId: string;
    botUserId?: string;
    allowedGuilds?: string[];
    allowedChannels?: string[];
    ignoreBots?: boolean;
  }
): SwarmEnvelope | null {
  // Skip bot messages if configured
  if (config.ignoreBots && message.author.bot) {
    return null;
  }

  // Check guild/channel filters
  if (config.allowedGuilds?.length && message.guild_id) {
    if (!config.allowedGuilds.includes(message.guild_id)) {
      return null;
    }
  }

  if (config.allowedChannels?.length) {
    if (!config.allowedChannels.includes(message.channel_id)) {
      return null;
    }
  }

  const sender: SenderInfo = {
    id: message.author.id,
    username: message.author.username,
    displayName: message.author.global_name || message.author.username,
    isBot: message.author.bot || false,
    platform: 'discord',
    platformUserId: message.author.id,
  };

  const content: MessageContent = {
    text: message.content,
  };

  if (message.attachments.length > 0) {
    content.media = message.attachments.map(att => ({
      type: att.content_type?.startsWith('video/') ? 'video' as const
        : att.content_type?.startsWith('image/') ? 'photo' as const
        : 'document' as const,
      url: att.url,
      mimeType: att.content_type,
      size: att.size,
    }));
  }

  const mentions: Mention[] = message.mentions.map(m => ({
    userId: m.id,
    username: m.username,
    offset: message.content.indexOf(`<@${m.id}>`),
    length: `<@${m.id}>`.length,
  }));

  const isMention = config.botUserId
    ? message.mentions.some(m => m.id === config.botUserId)
    : false;

  const isReplyToBot = !!(
    message.referenced_message &&
    message.referenced_message.author.id === config.botUserId
  );

  const envelope: SwarmEnvelope = {
    agentId: config.agentId,
    platform: 'discord',
    messageId: message.id,
    conversationId: message.channel_id,
    timestamp: new Date(message.timestamp).getTime(),
    sender,
    content,
    mentions,
    replyTo: message.referenced_message?.id,
    raw: message,
    metadata: {
      receivedAt: Date.now(),
      priority: (isMention || isReplyToBot) ? 'high' : 'normal',
      idempotencyKey: `discord:${config.agentId}:${message.id}`,
      isMention,
      isReplyToBot,
      chatType: message.guild_id ? 'group' : 'private',
      guildId: message.guild_id,
    },
  };

  return envelope;
}
