/**
 * Telegram Platform Adapter
 * Handles Telegram Bot API webhooks and message sending
 */
import { Bot, InputFile, webhookCallback } from 'grammy';
import type { Message, Update, MessageOrigin } from 'grammy/types';
import { Jimp } from 'jimp';
import { PlatformAdapter } from './base.js';
import { fetchWithRetry } from '../utils/fetch-retry.js';
import { PlatformError } from '../errors/errors.js';
import { SwarmErrorCode } from '../errors/codes.js';
import { logger } from '../utils/logger.js';
import type {
  AvatarConfig,
  SwarmEnvelope,
  ResponseAction,
  SenderInfo,
  MessageContent,
  MediaAttachment,
  TelegramConfig,
  Mention,
  ForwardMetadata,
} from '../types/index.js';

// Re-export ForwardMetadata type for consumers importing from this module
export type { ForwardMetadata } from '../types/index.js';

// =============================================================================
// BOTFATHER CONSTANTS
// =============================================================================

/**
 * BotFather's official Telegram user ID
 */
export const BOTFATHER_USER_ID = 93372553;

/**
 * BotFather's official username (without @)
 */
export const BOTFATHER_USERNAME = 'BotFather';

// =============================================================================
// LEGACY FORWARD FIELD TYPES (for compatibility with older Telegram API)
// =============================================================================

/**
 * Extended Message type that includes legacy forward fields
 * These fields are deprecated in favor of forward_origin (API 7.0+)
 * but may still be present in API responses for backwards compatibility
 */
interface MessageWithLegacyForward extends Message {
  forward_from?: {
    id: number;
    is_bot: boolean;
    first_name: string;
    last_name?: string;
    username?: string;
  };
  forward_from_chat?: {
    id: number;
    type: string;
    title?: string;
    username?: string;
  };
  forward_date?: number;
  forward_sender_name?: string;
}

// =============================================================================
// SHARED TELEGRAM ENVELOPE BUILDER
// =============================================================================

/**
 * Configuration for building a Telegram envelope
 */
export interface TelegramEnvelopeConfig {
  avatarId: string;
  botUsername?: string;
  botId?: number;
  allowedChatTypes?: ('private' | 'group' | 'supergroup' | 'channel')[];
}

/**
 * Build a SwarmEnvelope from a raw Telegram Update
 *
 * This is a shared utility function that can be used by webhook ingress code (e.g. shared multi-tenant handlers).
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
  // Note: DMs ('private') are ALWAYS allowed through - they're handled by the admin service
  // for bot creation flow. The allowedChatTypes config only applies to groups/channels.
  if (config.allowedChatTypes) {
    const validChatTypes = ['private', 'group', 'supergroup', 'channel'] as const;
    const rawChatType = message.chat.type;

    // Validate that chat type is one we recognize
    if (!validChatTypes.includes(rawChatType as typeof validChatTypes[number])) {
      logger.warn('Unknown chat type, treating as group', { subsystem: 'platform', platform: 'telegram', chatType: rawChatType });
    }

    const chatType = validChatTypes.includes(rawChatType as typeof validChatTypes[number])
      ? (rawChatType as 'private' | 'group' | 'supergroup' | 'channel')
      : 'group'; // Default to group for unknown types

    // Always allow DMs through - they go to admin service for bot creation
    if (chatType !== 'private' && !config.allowedChatTypes.includes(chatType)) {
      return null;
    }
  }

  const sender = extractSenderInfo(message);
  const content = extractMessageContent(message);
  const mentions = extractMentions(message);
  const forwardMetadata = extractForwardMetadata(message);

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
    avatarId: config.avatarId,
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
      idempotencyKey: `telegram:${config.avatarId}:${message.message_id}`,

      // Direct engagement detection
      isMention,
      isReplyToBot,

      // Chat context
      chatType: message.chat.type as 'private' | 'group' | 'supergroup' | 'channel',
      chatTitle: 'title' in message.chat ? message.chat.title : undefined,

      // Platform update ID for deduplication
      platformUpdateId: update.update_id,

      // Forward metadata (for detecting BotFather messages, etc.)
      forwardMetadata: forwardMetadata || undefined,
    },
  };

  return envelope;
}

function inferFileNameFromUrl(url: string, fallback: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').pop();
    if (last && last.includes('.')) return last;
  } catch {
    // ignore
  }
  return fallback;
}

// Telegram's limit for photos sent via URL is 5MB, but to be safe we compress at 4MB
const TELEGRAM_PHOTO_SIZE_LIMIT = 4 * 1024 * 1024;

/**
 * Compress an image buffer to fit within Telegram's size limit.
 * Uses JPEG compression with decreasing quality until the size is acceptable.
 */
async function compressImageForTelegram(buf: Buffer, originalName: string): Promise<{ buffer: Buffer; fileName: string }> {
  // If already small enough, return as-is
  if (buf.length <= TELEGRAM_PHOTO_SIZE_LIMIT) {
    return { buffer: buf, fileName: originalName };
  }

  logger.info('Image too large, compressing for Telegram', { subsystem: 'platform', platform: 'telegram', originalSizeMB: (buf.length / 1024 / 1024).toFixed(2) });

  try {
    const image = await Jimp.read(buf);
    
    // Resize if dimensions are very large (max 2048px on longest side)
    const maxDim = 2048;
    if (image.width > maxDim || image.height > maxDim) {
      if (image.width > image.height) {
        image.resize({ w: maxDim });
      } else {
        image.resize({ h: maxDim });
      }
      logger.info('Image resized for Telegram', { subsystem: 'platform', platform: 'telegram', width: image.width, height: image.height });
    }

    // Try different quality levels until we're under the limit
    for (const quality of [85, 70, 55, 40]) {
      const compressed = await image.getBuffer('image/jpeg', { quality });
      if (compressed.length <= TELEGRAM_PHOTO_SIZE_LIMIT) {
        logger.info('Image compressed for Telegram', { subsystem: 'platform', platform: 'telegram', compressedSizeMB: (compressed.length / 1024 / 1024).toFixed(2), quality });
        // Change extension to .jpg
        const jpgName = originalName.replace(/\.(png|webp|gif)$/i, '.jpg');
        return { buffer: compressed, fileName: jpgName };
      }
    }

    // Last resort: resize more aggressively
    image.resize({ w: 1024 });
    const finalBuffer = await image.getBuffer('image/jpeg', { quality: 40 });
    logger.info('Image final compression for Telegram', { subsystem: 'platform', platform: 'telegram', compressedSizeMB: (finalBuffer.length / 1024 / 1024).toFixed(2), widthPx: 1024 });
    const jpgName = originalName.replace(/\.(png|webp|gif)$/i, '.jpg');
    return { buffer: finalBuffer, fileName: jpgName };
  } catch (err) {
    logger.warn('Failed to compress image, sending original', { subsystem: 'platform', platform: 'telegram', error: err instanceof Error ? err.message : String(err) });
    return { buffer: buf, fileName: originalName };
  }
}

async function fetchToInputFile(url: string, fallbackName: string, timeoutMs: number = 60_000): Promise<InputFile> {
  const res = await fetchWithRetry(url, { method: 'GET' }, {
    timeoutMs,
    maxRetries: 2,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new PlatformError(`Failed to fetch media: ${res.status} - ${text}`, {
      code: SwarmErrorCode.PLATFORM_MEDIA_UPLOAD_ERROR,
      platform: 'telegram',
      statusCode: res.status,
    });
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const fileName = inferFileNameFromUrl(url, fallbackName);
  
  // Compress if it's an image and too large for Telegram
  const isImage = /\.(png|jpg|jpeg|webp|gif)$/i.test(fileName) || fallbackName.includes('image');
  if (isImage) {
    const { buffer: compressedBuf, fileName: compressedName } = await compressImageForTelegram(buf, fileName);
    return new InputFile(compressedBuf, compressedName);
  }
  
  return new InputFile(buf, fileName);
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

  if (message.voice) {
    mediaAttachments.push({
      type: 'audio',
      fileId: message.voice.file_id,
      mimeType: message.voice.mime_type,
      size: message.voice.file_size,
    });
  }

  if (message.audio) {
    mediaAttachments.push({
      type: 'audio',
      fileId: message.audio.file_id,
      mimeType: message.audio.mime_type,
      size: message.audio.file_size,
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
 * Extract forward metadata from a Telegram message
 * Supports both modern forward_origin (API 7.0+) and legacy forward_from fields
 */
export function extractForwardMetadata(message: Message): ForwardMetadata | null {
  // Check for modern forward_origin (Telegram API 7.0+)
  const forwardOrigin = (message as Message & { forward_origin?: MessageOrigin }).forward_origin;

  if (forwardOrigin) {
    return parseForwardOrigin(forwardOrigin);
  }

  // Fall back to legacy forward_from fields (cast to extended type)
  const legacyMessage = message as MessageWithLegacyForward;
  const legacyForwardFrom = legacyMessage.forward_from;
  const legacyForwardFromChat = legacyMessage.forward_from_chat;
  const legacyForwardDate = legacyMessage.forward_date;
  const legacySenderName = legacyMessage.forward_sender_name;

  if (legacyForwardFrom) {
    const isFromBotFather =
      legacyForwardFrom.id === BOTFATHER_USER_ID ||
      legacyForwardFrom.username?.toLowerCase() === BOTFATHER_USERNAME.toLowerCase();

    return {
      originType: 'user',
      originalSenderId: legacyForwardFrom.id.toString(),
      originalSenderUsername: legacyForwardFrom.username,
      originalSenderName: legacyForwardFrom.first_name + (legacyForwardFrom.last_name ? ` ${legacyForwardFrom.last_name}` : ''),
      originalSenderIsBot: legacyForwardFrom.is_bot,
      isFromBotFather,
      originalDate: legacyForwardDate,
    };
  }

  if (legacyForwardFromChat) {
    return {
      originType: legacyForwardFromChat.type === 'channel' ? 'channel' : 'chat',
      originalChatId: legacyForwardFromChat.id.toString(),
      originalChatTitle: legacyForwardFromChat.title,
      isFromBotFather: false,
      originalDate: legacyForwardDate,
    };
  }

  if (legacySenderName) {
    // Hidden user - only sender name is available
    return {
      originType: 'hidden_user',
      originalSenderName: legacySenderName,
      isFromBotFather: false,
      originalDate: legacyForwardDate,
    };
  }

  return null;
}

/**
 * Parse modern MessageOrigin structure (Telegram API 7.0+)
 */
function parseForwardOrigin(origin: MessageOrigin): ForwardMetadata {
  switch (origin.type) {
    case 'user': {
      const user = origin.sender_user;
      const isFromBotFather =
        user.id === BOTFATHER_USER_ID ||
        user.username?.toLowerCase() === BOTFATHER_USERNAME.toLowerCase();

      return {
        originType: 'user',
        originalSenderId: user.id.toString(),
        originalSenderUsername: user.username,
        originalSenderName: user.first_name + (user.last_name ? ` ${user.last_name}` : ''),
        originalSenderIsBot: user.is_bot,
        isFromBotFather,
        originalDate: origin.date,
      };
    }

    case 'hidden_user': {
      return {
        originType: 'hidden_user',
        originalSenderName: origin.sender_user_name,
        isFromBotFather: false,
        originalDate: origin.date,
      };
    }

    case 'chat': {
      const chat = origin.sender_chat;
      return {
        originType: 'chat',
        originalChatId: chat.id.toString(),
        originalChatTitle: chat.title,
        originalSenderName: origin.author_signature,
        isFromBotFather: false,
        originalDate: origin.date,
      };
    }

    case 'channel': {
      const channel = origin.chat;
      return {
        originType: 'channel',
        originalChatId: channel.id.toString(),
        originalChatTitle: channel.title,
        originalSenderName: origin.author_signature,
        isFromBotFather: false,
        originalDate: origin.date,
      };
    }

    default:
      return {
        originType: 'unknown',
        isFromBotFather: false,
      };
  }
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
  private botIdentityPromise: Promise<void> | null = null;

  constructor(avatarConfig: AvatarConfig, private readonly botToken: string, botId?: number) {
    super(avatarConfig);
    this.config = avatarConfig.platforms.telegram!;
    this.botId = botId;

    if (this.isConfigured()) {
      // Configure Bot for Node.js 20+ compatibility:
      // 1. Use native fetch instead of node-fetch to avoid AbortSignal issues
      // 2. Include duplex: 'half' for streaming uploads (required for file uploads on Node.js 20+)
      this.bot = new Bot(botToken, {
        client: {
          // JUSTIFIED TYPE ASSERTION:
          // Use native fetch - cast needed because grammy's fetch typing expects a specific
          // fetch implementation signature that's stricter than the standard globalThis.fetch.
          // The runtime behavior is correct and has been verified to work.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          fetch: globalThis.fetch as any,
          // Base config for all fetch calls - duplex is required for streaming request bodies
          baseFetchConfig: {
            duplex: 'half',
          },
        },
      });
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

    await this.ensureBotIdentity();

    return buildTelegramEnvelope(update, {
      avatarId: this.avatarConfig.id,
      botUsername: this.config.botUsername,
      botId: this.botId,
      allowedChatTypes: this.config.allowedChatTypes,
    });
  }

  private async ensureBotIdentity(): Promise<void> {
    if (!this.bot) return;
    if (this.botId && this.config.botUsername) return;

    if (!this.botIdentityPromise) {
      this.botIdentityPromise = (async () => {
        try {
          const me = await this.bot!.api.getMe();
          if (!this.botId) this.botId = me.id;
          if (!this.config.botUsername && me.username) this.config.botUsername = me.username;
        } catch (err) {
          logger.warn('Failed to fetch bot identity (getMe)', { subsystem: 'platform', platform: 'telegram', error: err instanceof Error ? err.message : String(err) });
        }
      })();
    }

    await this.botIdentityPromise;
  }

  async executeAction(
    action: ResponseAction,
    conversationId: string,
    replyToMessageId?: string
  ): Promise<boolean> {
    if (!this.bot) {
      throw new PlatformError('Telegram bot not initialized', {
      code: SwarmErrorCode.PLATFORM_NOT_INITIALIZED,
      platform: 'telegram',
    });
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
            // Telegram can be flaky fetching signed/redirecting URLs.
            // Prefer uploading bytes so images reliably post when the model intends them.
            try {
              const inputFile = await fetchToInputFile(action.url, 'image.png');
              await this.bot.api.sendPhoto(chatId, inputFile, {
                caption: action.caption,
                ...replyParams,
              });
            } catch (err) {
              logger.warn('Failed to upload photo bytes, falling back to URL send', { subsystem: 'platform', platform: 'telegram', error: err instanceof Error ? err.message : String(err) });
              await this.bot.api.sendPhoto(chatId, action.url, {
                caption: action.caption,
                ...replyParams,
              });
            }
          } else if (action.mediaType === 'video') {
            await this.bot.api.sendVideo(chatId, action.url, {
              caption: action.caption,
              ...replyParams,
            });
          } else if (action.mediaType === 'animation') {
            // Same flakiness as photos; try bytes first then URL.
            try {
              const inputFile = await fetchToInputFile(action.url, 'animation.gif');
              await this.bot.api.sendAnimation(chatId, inputFile, {
                caption: action.caption,
                ...replyParams,
              });
            } catch (err) {
              logger.warn('Failed to upload animation bytes, falling back to URL send', { subsystem: 'platform', platform: 'telegram', error: err instanceof Error ? err.message : String(err) });
              await this.bot.api.sendAnimation(chatId, action.url, {
                caption: action.caption,
                ...replyParams,
              });
            }
          }
          break;

        case 'send_voice':
          // Telegram can be flaky fetching signed/redirecting URLs.
          // Prefer uploading bytes so it works consistently in groups and DMs.
          try {
            const inputFile = await fetchToInputFile(action.url, 'voice.ogg');
            await this.bot.api.sendVoice(chatId, inputFile, {
              caption: action.caption,
              ...replyParams,
            });
          } catch (err) {
            logger.warn('Failed to upload voice bytes, falling back to URL send', { subsystem: 'platform', platform: 'telegram', error: err instanceof Error ? err.message : String(err) });
            await this.bot.api.sendVoice(chatId, action.url, {
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
          logger.warn('Unknown action type', { subsystem: 'platform', platform: 'telegram', actionType: (action as ResponseAction).type });
      }
      
      return true;
    } catch (error) {
      logger.error('Failed to execute Telegram action', error, { subsystem: 'platform', platform: 'telegram' });
      return false;
    }
  }

  async sendTypingIndicator(conversationId: string): Promise<void> {
    if (!this.bot) return;
    
    try {
      await this.bot.api.sendChatAction(parseInt(conversationId), 'typing');
    } catch (error) {
      logger.warn('Failed to send typing indicator', { subsystem: 'platform', platform: 'telegram', error: error instanceof Error ? error.message : String(error) });
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
      throw new PlatformError('Telegram bot not initialized', {
      code: SwarmErrorCode.PLATFORM_NOT_INITIALIZED,
      platform: 'telegram',
    });
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
