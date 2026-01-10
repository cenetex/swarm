/**
 * Telegram Platform Adapter
 * Handles Telegram Bot API webhooks and message sending
 */
import { Bot, Context, webhookCallback } from 'grammy';
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
} from '../types/index.js';

export class TelegramAdapter extends PlatformAdapter {
  readonly platform = 'telegram' as const;
  private bot: Bot | null = null;
  private config: TelegramConfig;

  constructor(agentConfig: AgentConfig, private readonly botToken: string) {
    super(agentConfig);
    this.config = agentConfig.platforms.telegram!;
    
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

  async parseMessage(body: unknown): Promise<SwarmEnvelope | null> {
    const update = body as Update;
    
    // Handle different update types
    const message = update.message || update.edited_message || update.channel_post;
    if (!message) {
      return null;
    }

    // Check if chat type is allowed
    if (this.config.allowedChatTypes) {
      if (!this.config.allowedChatTypes.includes(message.chat.type as 'private' | 'group' | 'supergroup' | 'channel')) {
        return null;
      }
    }

    const sender = this.extractSender(message);
    const content = this.extractContent(message);
    const mentions = this.extractMentions(message);

    const envelope = this.createBaseEnvelope({
      messageId: message.message_id.toString(),
      conversationId: message.chat.id.toString(),
      timestamp: message.date * 1000,
      sender,
      content,
      raw: update,
    });

    envelope.mentions = mentions;
    envelope.replyTo = message.reply_to_message?.message_id.toString();

    return envelope;
  }

  async executeAction(
    action: ResponseAction,
    conversationId: string,
    replyToMessageId?: string
  ): Promise<boolean> {
    if (!this.bot) {
      throw new Error('Telegram bot not initialized');
    }

    try {
      switch (action.type) {
        case 'send_message':
          await this.sendMessage(conversationId, action.text, action.media, replyToMessageId);
          break;

        case 'react':
          await this.bot.api.setMessageReaction(
            parseInt(conversationId),
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
   * Extract sender information from Telegram message
   */
  private extractSender(message: Message): SenderInfo {
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
  private extractContent(message: Message): MessageContent {
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
  private extractMentions(message: Message): SwarmEnvelope['mentions'] {
    const mentions: SwarmEnvelope['mentions'] = [];
    
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
