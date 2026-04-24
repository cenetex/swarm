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
  AvatarConfig,
  SwarmEnvelope,
  ResponseAction,
  SenderInfo,
  MessageContent,
  DiscordConfig,
  Mention,
} from '../types/index.js';
import { fetchWithRetry } from '../utils/fetch-retry.js';
import { PlatformError } from '../errors/errors.js';
import { SwarmErrorCode } from '../errors/codes.js';
import { logger } from '../utils/logger.js';
import type { DiscordWebhookManager } from './discord-webhook-manager.js';

// Discord API types (minimal, to avoid dependency on discord.js in core)
export interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  member?: {
    roles?: string[];
  };
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
  webhook_id?: string;
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
  /** Global bot token (used when mode === 'global') */
  globalBotToken?: string;
  /** Webhook manager for global mode — sends via per-channel webhooks */
  webhookManager?: DiscordWebhookManager;
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

  constructor(avatarConfig: AvatarConfig, credentials: DiscordCredentials) {
    super(avatarConfig);
    this.config = avatarConfig.platforms.discord!;
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
      case 'global':
        return !!(this.credentials.globalBotToken && this.credentials.webhookManager);
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
      logger.error('Failed to verify Discord signature', error, { subsystem: 'platform', platform: 'discord' });
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
    if (this.avatarConfig.behavior.ignoreBots && message.author.bot) {
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

    if (this.config.allowedRoleIds?.length) {
      const senderRoleIds = message.member?.roles || [];
      if (!senderRoleIds.some(roleId => this.config.allowedRoleIds!.includes(roleId))) {
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
          await this.sendMedia(conversationId, action.mediaType, action.url, action.caption, replyToMessageId);
          break;

        case 'send_sticker':
          // Discord has no native sticker-by-emoji API — downgrade to text
          logger.info('Discord sticker downgrade: sending emoji as text', {
            subsystem: 'platform',
            platform: 'discord',
            event: 'media_downgrade',
            mediaType: 'sticker',
            emoji: action.emoji,
            channelId: conversationId,
          });
          await this.sendMessage(conversationId, action.emoji, undefined, replyToMessageId);
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
          logger.warn('Unknown action type', { subsystem: 'platform', platform: 'discord', actionType: (action as ResponseAction).type });
      }

      return true;
    } catch (error) {
      logger.error('Failed to execute Discord action', error, { subsystem: 'platform', platform: 'discord' });
      return false;
    }
  }

  /**
   * Send typing indicator to a channel
   */
  async sendTypingIndicator(conversationId: string): Promise<void> {
    const token = this.credentials.botToken || this.credentials.globalBotToken;
    if (!token) return;

    try {
      const typingToken = this.credentials.botToken || this.credentials.globalBotToken;
      await fetch(`https://discord.com/api/v10/channels/${conversationId}/typing`, {
        method: 'POST',
        headers: {
          'Authorization': `Bot ${typingToken}`,
        },
      });
    } catch (error) {
      logger.warn('Failed to send typing indicator', { subsystem: 'platform', platform: 'discord', error: error instanceof Error ? error.message : String(error) });
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
    // Global mode: send via per-channel webhook with avatar identity
    if (this.config.mode === 'global' && this.credentials.webhookManager) {
      await this.sendViaGlobalWebhook(channelId, text, media);
      return;
    }

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
   * Send message via global webhook manager with avatar's name and profile image
   */
  private async sendViaGlobalWebhook(
    channelId: string,
    content: string,
    media?: Array<{ type: string; url: string }>
  ): Promise<void> {
    if (!this.credentials.webhookManager) {
      throw new PlatformError('No webhook manager configured for global mode', {
        code: SwarmErrorCode.PLATFORM_NOT_INITIALIZED,
        platform: 'discord',
      });
    }

    const embeds = media?.length
      ? media
          .filter(m => m.type === 'image')
          .map(m => ({ image: { url: m.url } }))
      : undefined;

    await this.credentials.webhookManager.send(channelId, {
      content,
      username: this.avatarConfig.name,
      avatar_url: this.avatarConfig.profileImage?.url,
      embeds,
    });
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
      throw new PlatformError('No webhook URL configured', {
      code: SwarmErrorCode.PLATFORM_WEBHOOK_ERROR,
      platform: 'discord',
    });
    }

    const payload: DiscordWebhookPayload = {
      content,
      username: this.avatarConfig.name,
      avatar_url: this.avatarConfig.profileImage?.url,
    };

    // Add embeds for media
    if (media && media.length > 0) {
      payload.embeds = media.map(m => ({
        image: m.type === 'image' ? { url: m.url } : undefined,
      })).filter(e => e.image);
    }

    const response = await fetchWithRetry(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, { maxRetries: 2, timeoutMs: 15_000 });

    if (!response.ok) {
      const error = await response.text();
      throw new PlatformError(`Webhook request failed: ${error}`, {
      code: SwarmErrorCode.PLATFORM_API_ERROR,
      platform: 'discord',
      retryable: true,
    });
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
      throw new PlatformError('No bot token configured', {
      code: SwarmErrorCode.PLATFORM_NOT_INITIALIZED,
      platform: 'discord',
    });
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

    const response = await fetchWithRetry(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bot ${this.credentials.botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    }, { maxRetries: 2, timeoutMs: 15_000 });

    if (!response.ok) {
      const error = await response.text();
      throw new PlatformError(`Bot API request failed: ${error}`, {
      code: SwarmErrorCode.PLATFORM_API_ERROR,
      platform: 'discord',
      retryable: true,
    });
    }
  }

  /**
   * Send media to a channel.
   *
   * - **image**: fetches the bytes and uploads as a Discord attachment for
   *   reliability (signed/redirecting URLs often fail as embeds). Falls back to
   *   an embed if the byte-upload fails.
   * - **video**: posted as an embed link — Discord will render a player for
   *   most common formats. Logged for observability.
   * - **animation** (sticker/GIF): downgraded to an image embed with a log
   *   entry because Discord has no first-class animation-upload API outside
   *   of Nitro stickers.
   */
  private async sendMedia(
    channelId: string,
    mediaType: string,
    url: string,
    caption?: string,
    replyToMessageId?: string,
  ): Promise<void> {
    if (mediaType === 'image') {
      await this.sendImageAttachment(channelId, url, caption, replyToMessageId);
      return;
    }

    if (mediaType === 'video') {
      logger.info('Discord video delivery via embed link', {
        subsystem: 'platform',
        platform: 'discord',
        event: 'media_delivery',
        mediaType: 'video',
        channelId,
      });
      // Videos are best delivered as a URL — Discord renders an inline player
      // for supported formats (mp4, webm).
      await this.sendMessage(channelId, caption ? `${caption}\n${url}` : url, undefined, replyToMessageId);
      return;
    }

    if (mediaType === 'animation') {
      logger.info('Discord animation downgrade: delivering as image embed', {
        subsystem: 'platform',
        platform: 'discord',
        event: 'media_downgrade',
        mediaType: 'animation',
        channelId,
      });
      // Fall back to image embed — Discord will auto-play GIFs in embeds.
      const media = [{ type: 'image', url }];
      await this.sendMessage(channelId, caption || '', media, replyToMessageId);
      return;
    }

    // Unknown media type — log and fall through to embed
    logger.warn('Discord unrecognised media type, attempting embed fallback', {
      subsystem: 'platform',
      platform: 'discord',
      event: 'media_fallback',
      mediaType,
      channelId,
    });
    const media = [{ type: mediaType, url }];
    await this.sendMessage(channelId, caption || '', media, replyToMessageId);
  }

  /**
   * Upload an image as a Discord attachment (multipart/form-data).
   * Falls back to an embed if byte-fetch fails.
   */
  private async sendImageAttachment(
    channelId: string,
    url: string,
    caption?: string,
    replyToMessageId?: string,
  ): Promise<void> {
    // Global mode: attachments aren't supported through webhooks in the same
    // way, so use the embed path (which already works for images).
    if (this.config.mode === 'global' || this.config.mode === 'webhook' || this.config.mode === 'hybrid') {
      const media = [{ type: 'image', url }];
      await this.sendMessage(channelId, caption || '', media, replyToMessageId);
      return;
    }

    const token = this.credentials.botToken;
    if (!token) {
      // No bot token — fall back to embed
      const media = [{ type: 'image', url }];
      await this.sendMessage(channelId, caption || '', media, replyToMessageId);
      return;
    }

    try {
      // Fetch image bytes
      const imgRes = await fetch(url);
      if (!imgRes.ok) {
        throw new Error(`Image fetch failed: ${imgRes.status}`);
      }
      const blob = await imgRes.blob();

      // Determine filename from Content-Type or URL
      const contentType = imgRes.headers.get('content-type') || 'image/png';
      const ext = contentType.includes('jpeg') || contentType.includes('jpg') ? 'jpg'
        : contentType.includes('gif') ? 'gif'
        : contentType.includes('webp') ? 'webp'
        : 'png';
      const filename = `image.${ext}`;

      // Build multipart form
      const form = new FormData();
      const payload: Record<string, unknown> = {
        content: caption || '',
        attachments: [{ id: 0, filename }],
      };
      if (replyToMessageId) {
        payload.message_reference = { message_id: replyToMessageId };
      }
      form.append('payload_json', JSON.stringify(payload));
      form.append('files[0]', blob, filename);

      const res = await fetchWithRetry(
        `https://discord.com/api/v10/channels/${channelId}/messages`,
        {
          method: 'POST',
          headers: { 'Authorization': `Bot ${token}` },
          body: form,
        },
        { maxRetries: 2, timeoutMs: 30_000 },
      );

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Discord attachment upload failed: ${errText}`);
      }

      logger.info('Discord image delivered via attachment upload', {
        subsystem: 'platform',
        platform: 'discord',
        event: 'media_delivery',
        mediaType: 'image',
        channelId,
      });
    } catch (err) {
      logger.warn('Discord image attachment upload failed, falling back to embed', {
        subsystem: 'platform',
        platform: 'discord',
        event: 'media_fallback',
        mediaType: 'image',
        channelId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Fall back to embed
      const media = [{ type: 'image', url }];
      await this.sendMessage(channelId, caption || '', media, replyToMessageId);
    }
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
      throw new PlatformError('Cannot add reactions without bot token', {
      code: SwarmErrorCode.PLATFORM_NOT_INITIALIZED,
      platform: 'discord',
    });
    }

    // URL encode the emoji
    const encodedEmoji = encodeURIComponent(emoji);

    const response = await fetchWithRetry(
      `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}/reactions/${encodedEmoji}/@me`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bot ${this.credentials.botToken}`,
        },
      },
      { maxRetries: 1, timeoutMs: 10_000 }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new PlatformError(`Failed to add reaction: ${error}`, {
      code: SwarmErrorCode.PLATFORM_API_ERROR,
      platform: 'discord',
    });
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
    const response = await fetchWithRetry(
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
      },
      { maxRetries: 1, timeoutMs: 10_000 }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new PlatformError(`Failed to respond to interaction: ${error}`, {
      code: SwarmErrorCode.PLATFORM_API_ERROR,
      platform: 'discord',
    });
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
    const response = await fetchWithRetry(
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
      },
      { maxRetries: 1, timeoutMs: 10_000 }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new PlatformError(`Failed to defer interaction: ${error}`, {
      code: SwarmErrorCode.PLATFORM_API_ERROR,
      platform: 'discord',
    });
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
    const response = await fetchWithRetry(
      `https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}/messages/@original`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      },
      { maxRetries: 1, timeoutMs: 10_000 }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new PlatformError(`Failed to edit interaction response: ${error}`, {
      code: SwarmErrorCode.PLATFORM_API_ERROR,
      platform: 'discord',
    });
    }
  }
}

/**
 * Build a SwarmEnvelope from a Discord gateway message event
 */
export function buildDiscordEnvelope(
  message: DiscordMessage,
  config: {
    avatarId: string;
    botUserId?: string;
    allowedGuilds?: string[];
    allowedChannels?: string[];
    allowedRoleIds?: string[];
    ignoreBots?: boolean;
  }
): SwarmEnvelope | null {
  // Own-message filter: drop if author is the avatar's own bot account (prevents self-reply loops)
  if (config.botUserId && message.author.id === config.botUserId) {
    return null;
  }

  // Skip bot messages if configured (default true to prevent bot ping-pong)
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

  if (config.allowedRoleIds?.length) {
    const senderRoleIds = message.member?.roles || [];
    if (!senderRoleIds.some(roleId => config.allowedRoleIds!.includes(roleId))) {
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
    avatarId: config.avatarId,
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
      idempotencyKey: `discord:${config.avatarId}:${message.id}`,
      isMention,
      isReplyToBot,
      chatType: message.guild_id ? 'group' : 'private',
      guildId: message.guild_id,
    },
  };

  return envelope;
}
