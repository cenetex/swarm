/**
 * Telegram Platform Adapter
 * Handles Telegram Bot API webhooks and message sending
 */
import { Bot, webhookCallback } from 'grammy';
import type { Message, Update } from 'grammy/types';
import { PlatformAdapter } from './base.js';
import type {
  AgentConfig,
  SwarmEnvelope,
  ResponseAction,
  SenderInfo,
  MessageContent,
  MediaAttachment,
  TelegramConfig,
  Mention,
} from '../types/index.js';

// =============================================================================
// SHARED TELEGRAM ENVELOPE BUILDER
// =============================================================================

/**
 * Configuration for building a Telegram envelope
 */
export interface TelegramEnvelopeConfig {
  agentId: string;
  botUsername?: string;
  botId?: number;
  allowedChatTypes?: ('private' | 'group' | 'supergroup' | 'channel')[];
}

/**
 * Build a SwarmEnvelope from a raw Telegram Update
 *
 * This is a shared utility function that can be used by both:
 * - packages/handlers/src/telegram-webhook.ts (core pipeline)
 * - packages/admin-api/src/handlers/telegram-webhook.ts (admin agent)
 *
 * It handles:
 * - Extracting sender, content, mentions from the update
 * - Detecting direct engagement (isMention, isReplyToBot)
 * - Preserving chat type and title for channel state
 * - Generating idempotency keys
 */
export function buildTelegramEnvelope(
  update: Update,
  config: TelegramEnvelopeConfig
): SwarmEnvelope | null {
  // Handle different update types
  const message = update.message || update.edited_message || update.channel_post;
  if (!message) {
    return null;
  }

  // Check if chat type is allowed
  if (config.allowedChatTypes) {
    const chatType = message.chat.type as 'private' | 'group' | 'supergroup' | 'channel';
    if (!config.allowedChatTypes.includes(chatType)) {
      return null;
    }
  }

  const sender = extractSenderInfo(message);
  const content = extractMessageContent(message);
  const mentions = extractMentions(message);

  // Detect direct engagement
  const text = message.text || message.caption || '';
  const isMention = config.botUsername
    ? new RegExp(`@${config.botUsername}\\b`, 'i').test(text)
    : false;

  const isReplyToBot = !!(
    (config.botId && message.reply_to_message?.from?.id === config.botId) ||
    (config.botUsername && message.reply_to_message?.from?.username?.toLowerCase() === config.botUsername.toLowerCase())
  );

  // Build the envelope
  const envelope: SwarmEnvelope = {
    agentId: config.agentId,
    platform: 'telegram',
    messageId: message.message_id.toString(),
    conversationId: message.chat.id.toString(),
    timestamp: message.date * 1000,
    sender,
    content,
    mentions,
    replyTo: message.reply_to_message?.message_id?.toString(),
    raw: update,
    metadata: {
      receivedAt: Date.now(),
      priority: (isMention || isReplyToBot) ? 'high' : 'normal',
      idempotencyKey: `telegram:${config.agentId}:${message.message_id}`,

      // Direct engagement detection
      isMention,
      isReplyToBot,

      // Chat context
      chatType: message.chat.type as 'private' | 'group' | 'supergroup' | 'channel',
      chatTitle: 'title' in message.chat ? message.chat.title : undefined,

      // Platform update ID for deduplication
      platformUpdateId: update.update_id,
    },
  };

  return envelope;
}

/**
 * Extract sender information from Telegram message
 */
function extractSenderInfo(message: Message): SenderInfo {
  const from = message.from;

  return {
    id: from?.id.toString() || 'unknown',
    username: from?.username,
    displayName: from?.first_name + (from?.last_name ? ` ${from.last_name}` : ''),
    isBot: from?.is_bot || false,
    platform: 'telegram',
    platformUserId: from?.id.toString() || 'unknown',
  };
}

/**
 * Extract message content from Telegram message
 */
function extractMessageContent(message: Message): MessageContent {
  const content: MessageContent = {};

  // Text content
  content.text = message.text || message.caption || '';

  // Check for command
  if (message.entities) {
    const commandEntity = message.entities.find(e => e.type === 'bot_command' && e.offset === 0);
    if (commandEntity && content.text) {
      const fullCommand = content.text.slice(commandEntity.offset, commandEntity.offset + commandEntity.length);
      const [command] = fullCommand.split('@'); // Remove @botname suffix
      const args = content.text.slice(commandEntity.offset + commandEntity.length).trim().split(/\s+/).filter(Boolean);

      content.command = {
        command: command.slice(1), // Remove leading /
        args,
        raw: content.text,
      };
    }
  }

  // Media attachments
  const mediaAttachments: MediaAttachment[] = [];

  if (message.photo) {
    // Get highest resolution photo
    const photo = message.photo[message.photo.length - 1];
    mediaAttachments.push({
      type: 'photo',
      fileId: photo.file_id,
      size: photo.file_size,
    });
  }

  if (message.video) {
    mediaAttachments.push({
      type: 'video',
      fileId: message.video.file_id,
      mimeType: message.video.mime_type,
      size: message.video.file_size,
    });
  }

  if (message.animation) {
    mediaAttachments.push({
      type: 'animation',
      fileId: message.animation.file_id,
      mimeType: message.animation.mime_type,
      size: message.animation.file_size,
    });
  }

  if (message.document) {
    mediaAttachments.push({
      type: 'document',
      fileId: message.document.file_id,
      mimeType: message.document.mime_type,
      size: message.document.file_size,
    });
  }

  if (mediaAttachments.length > 0) {
    content.media = mediaAttachments;
  }

  // Sticker
  if (message.sticker) {
    content.sticker = {
      fileId: message.sticker.file_id,
      emoji: message.sticker.emoji,
      setName: message.sticker.set_name,
      isAnimated: message.sticker.is_animated || false,
    };
  }

  return content;
}

/**
 * Extract mentions from Telegram message
 */
function extractMentions(message: Message): Mention[] {
  const mentions: Mention[] = [];

  if (!message.entities || !message.text) {
    return mentions;
  }

  for (const entity of message.entities) {
    if (entity.type === 'mention') {
      const username = message.text.slice(entity.offset + 1, entity.offset + entity.length);
      mentions.push({
        userId: username, // We don't have the user ID for @mentions
        username,
        offset: entity.offset,
        length: entity.length,
      });
    } else if (entity.type === 'text_mention' && entity.user) {
      mentions.push({
        userId: entity.user.id.toString(),
        username: entity.user.username,
        offset: entity.offset,
        length: entity.length,
      });
    }
  }

  return mentions;
}

/**
 * Convert a SwarmEnvelope back to a BufferedMessage for channel state
 * Useful when migrating to unified channel state
 */
export interface BufferedMessageCompat {
  messageId: number;
  userId: number;
  userName: string;
  username?: string;
  text: string;
  timestamp: number;
  replyToMessageId?: number;
  replyToUserId?: number;
  isMention?: boolean;
  isReplyToBot?: boolean;
}

export function envelopeToBufferedMessage(envelope: SwarmEnvelope): BufferedMessageCompat {
  const raw = envelope.raw as Update;
  const message = raw.message || raw.edited_message || raw.channel_post;

  return {
    messageId: parseInt(envelope.messageId),
    userId: parseInt(envelope.sender.platformUserId) || 0,
    userName: envelope.sender.displayName || envelope.sender.username || 'Unknown',
    username: envelope.sender.username,
    text: envelope.content.text || '',
    timestamp: envelope.timestamp,
    replyToMessageId: envelope.replyTo ? parseInt(envelope.replyTo) : undefined,
    replyToUserId: message?.reply_to_message?.from?.id,
    isMention: envelope.metadata.isMention,
    isReplyToBot: envelope.metadata.isReplyToBot,
  };
}

// =============================================================================
// TELEGRAM ADAPTER CLASS
// =============================================================================

export class TelegramAdapter extends PlatformAdapter {
  readonly platform = 'telegram' as const;
  private bot: Bot | null = null;
  private config: TelegramConfig;
  private botId?: number;

  constructor(agentConfig: AgentConfig, private readonly botToken: string, botId?: number) {
    super(agentConfig);
    this.config = agentConfig.platforms.telegram!;
    this.botId = botId;

    if (this.isConfigured()) {
      this.bot = new Bot(botToken);
    }
  }

  isConfigured(): boolean {
    return !!(this.config?.enabled && this.botToken);
  }

  getDisplayName(): string {
    return `Telegram @${this.config.botUsername}`;
  }

  /**
   * Set the bot ID (useful when retrieved from getMe() after construction)
   */
  setBotId(botId: number): void {
    this.botId = botId;
  }

  async verifyRequest(body: Buffer, headers: Record<string, string>): Promise<boolean> {
    // Grammy handles verification internally via secret_token
    // For additional security, you can verify the X-Telegram-Bot-Api-Secret-Token header
    const secretToken = headers['x-telegram-bot-api-secret-token'];

    // If we're using a secret token, verify it matches
    // This should be set when registering the webhook
    if (secretToken) {
      // Compare with expected secret (could be derived from bot token)
      const expectedSecret = this.generateWebhookSecret();
      return secretToken === expectedSecret;
    }

    // Basic validation: ensure body is valid JSON
    try {
      JSON.parse(body.toString());
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Parse platform-specific message into universal SwarmEnvelope
   * Uses the shared buildTelegramEnvelope function
   */
  async parseMessage(body: unknown): Promise<SwarmEnvelope | null> {
    const update = body as Update;

    return buildTelegramEnvelope(update, {
      agentId: this.agentConfig.id,
      botUsername: this.config.botUsername,
      botId: this.botId,
      allowedChatTypes: this.config.allowedChatTypes,
    });
  }

  async executeAction(
    action: ResponseAction,
    conversationId: string,
    replyToMessageId?: string
  ): Promise<boolean> {
    if (!this.bot) {
      throw new Error('Telegram bot not initialized');
    }

    const chatId = parseInt(conversationId);
    const replyParams = replyToMessageId ? { reply_to_message_id: parseInt(replyToMessageId) } : {};

    try {
      switch (action.type) {
        case 'send_message':
          await this.sendMessage(conversationId, action.text, action.media, replyToMessageId);
          break;

        case 'send_media':
          // Send a media file (image, video, animation)
          if (action.mediaType === 'image') {
            await this.bot.api.sendPhoto(chatId, action.url, {
              caption: action.caption,
              ...replyParams,
            });
          } else if (action.mediaType === 'video') {
            await this.bot.api.sendVideo(chatId, action.url, {
              caption: action.caption,
              ...replyParams,
            });
          } else if (action.mediaType === 'animation') {
            await this.bot.api.sendAnimation(chatId, action.url, {
              caption: action.caption,
              ...replyParams,
            });
          }
          break;

        case 'send_sticker':
          // Send sticker by emoji or ID
          // If we have a sticker ID, use it; otherwise try to find one by emoji
          if (action.stickerId) {
            await this.bot.api.sendSticker(chatId, action.stickerId, replyParams);
          } else {
            // Fallback: send the emoji as text
            await this.bot.api.sendMessage(chatId, action.emoji, replyParams);
          }
          break;

        case 'react':
          await this.bot.api.setMessageReaction(
            chatId,
            parseInt(action.messageId),
            [{ type: 'emoji', emoji: action.emoji as '👍' }]
          );
          break;

        case 'take_selfie':
          // Media generation handled by media processor
          // This action comes with pre-generated media
          break;

        case 'wait':
          await new Promise(resolve => setTimeout(resolve, action.durationMs));
          break;

        case 'ignore':
          // No action needed
          break;

        default:
          console.warn(`Unknown action type: ${(action as ResponseAction).type}`);
      }
      
      return true;
    } catch (error) {
      console.error('Failed to execute Telegram action:', error);
      return false;
    }
  }

  async sendTypingIndicator(conversationId: string): Promise<void> {
    if (!this.bot) return;
    
    try {
      await this.bot.api.sendChatAction(parseInt(conversationId), 'typing');
    } catch (error) {
      console.warn('Failed to send typing indicator:', error);
    }
  }

  /**
   * Send a message with optional media
   */
  private async sendMessage(
    chatId: string,
    text: string,
    media?: Array<{ type: string; url: string }>,
    replyToMessageId?: string
  ): Promise<void> {
    if (!this.bot) return;

    const chatIdNum = parseInt(chatId);
    const replyParams = replyToMessageId 
      ? { reply_to_message_id: parseInt(replyToMessageId) }
      : undefined;

    if (media && media.length > 0) {
      const firstMedia = media[0];
      
      if (firstMedia.type === 'image') {
        await this.bot.api.sendPhoto(chatIdNum, firstMedia.url, {
          caption: text,
          ...replyParams,
        });
      } else if (firstMedia.type === 'video') {
        await this.bot.api.sendVideo(chatIdNum, firstMedia.url, {
          caption: text,
          ...replyParams,
        });
      } else if (firstMedia.type === 'sticker') {
        // Send sticker first, then text separately
        await this.bot.api.sendSticker(chatIdNum, firstMedia.url, replyParams);
        if (text) {
          await this.bot.api.sendMessage(chatIdNum, text);
        }
      }
    } else {
      await this.bot.api.sendMessage(chatIdNum, text, replyParams);
    }
  }

  /**
   * Generate webhook secret for verification
   */
  private generateWebhookSecret(): string {
    // Create a deterministic secret from bot token
    // In production, this should be stored and compared
    return Buffer.from(this.botToken).toString('base64').slice(0, 32);
  }

  /**
   * Get the grammY webhook callback for use with express/http handlers
   */
  getWebhookCallback() {
    if (!this.bot) {
      throw new Error('Telegram bot not initialized');
    }
    return webhookCallback(this.bot, 'aws-lambda');
  }

  /**
   * Get the underlying Bot instance for advanced usage
   */
  getBot(): Bot | null {
    return this.bot;
  }
}
