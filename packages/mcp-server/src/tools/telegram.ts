/**
 * Telegram Tools
 * 
 * Tools for Telegram-specific features:
 * - Reading user profile photos
 * - Bot profile management (name, description)
 * - Chat modification voting system (photo, description, title)
 * 
 * Chat modifications require unanimous approval from all bots in the chat
 * and are rate-limited to once per week maximum.
 */
import { z } from 'zod';
import { defineTool, type ToolResult } from '../registry.js';

// ============================================================================
// Service Interface
// ============================================================================

export interface TelegramPhoto {
  fileId: string;
  width: number;
  height: number;
  fileUrl?: string;
}

export interface TelegramUserProfile {
  userId: number;
  firstName?: string;
  lastName?: string;
  username?: string;
  totalPhotos: number;
  photos: TelegramPhoto[];
}

export interface ChatModificationProposal {
  proposalId: string;
  chatId: number;
  type: 'photo' | 'description' | 'title';
  proposedBy: string;
  proposedAt: number;
  newValue: string;
  currentValue?: string;
  reason?: string;
  status: 'pending' | 'approved' | 'rejected' | 'executed' | 'expired';
  votes: Record<string, { vote: 'approve' | 'reject'; votedAt: number; comment?: string }>;
  requiredVotes: number;
  approvalCount: number;
  rejectionCount: number;
}

export interface TelegramStatus {
  configured: boolean;
  botUsername?: string;
  botName?: string;
  webhookSet?: boolean;
}

/**
 * Telegram chat info for channel listing
 */
export interface TelegramChatInfo {
  chatId: number | string;
  title?: string;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  username?: string;
  memberCount?: number;
  lastActivityAt?: number;
  summary?: string;
}

export type TelegramMediaType = 'image' | 'video' | 'sticker';

export interface TelegramServices {
  /** Get Telegram integration status */
  getTelegramStatus?: (avatarId: string) => Promise<TelegramStatus>;

  /** Diagnose Telegram integration (secrets, webhook, recent activity) */
  diagnoseTelegram?: (avatarId: string) => Promise<unknown>;
  
  /** Get user profile photos */
  getUserProfilePhotos: (avatarId: string, userId: number, options?: {
    offset?: number;
    limit?: number;
  }) => Promise<TelegramUserProfile>;
  
  /** Get bot's current name */
  getBotName: (avatarId: string) => Promise<{ name: string }>;
  
  /** Set bot's name (per language, or default) */
  setBotName: (avatarId: string, name: string, languageCode?: string) => Promise<void>;
  
  /** Get bot's description */
  getBotDescription: (avatarId: string) => Promise<{ description: string }>;
  
  /** Set bot's description */
  setBotDescription: (avatarId: string, description: string, languageCode?: string) => Promise<void>;
  
  /** Get bot's short description */
  getBotShortDescription: (avatarId: string) => Promise<{ shortDescription: string }>;
  
  /** Set bot's short description */
  setBotShortDescription: (avatarId: string, shortDescription: string, languageCode?: string) => Promise<void>;
  
  /** Send typing indicator */
  sendChatAction: (avatarId: string, chatId: number, action: 
    | 'typing' | 'upload_photo' | 'record_video' | 'upload_video' 
    | 'record_voice' | 'upload_voice' | 'upload_document' | 'choose_sticker'
    | 'find_location' | 'record_video_note' | 'upload_video_note'
  ) => Promise<void>;

  /** Reply to a specific message in a chat */
  replyToMessage?: (avatarId: string, chatId: number, replyToMessageId: number, text: string) => Promise<{ messageId: number }>;

  /** React to a specific message in a chat */
  reactToMessage?: (avatarId: string, chatId: number, messageId: number, emoji: string) => Promise<void>;
  
  // === Chat Modification Voting System ===
  
  /** Get list of bots in a chat */
  getChatBots: (chatId: number) => Promise<Array<{ avatarId: string; botUsername: string }>>;
  
  /** Create a proposal to modify chat */
  proposeModification: (
    avatarId: string,
    chatId: number,
    type: 'photo' | 'description' | 'title',
    newValue: string,
    reason?: string
  ) => Promise<ChatModificationProposal>;
  
  /** Vote on a proposal */
  voteOnProposal: (
    avatarId: string,
    proposalId: string,
    vote: 'approve' | 'reject',
    comment?: string
  ) => Promise<ChatModificationProposal>;
  
  /** Get active proposals for a chat */
  getActiveProposals: (chatId: number) => Promise<ChatModificationProposal[]>;
  
  /** Get proposal by ID */
  getProposal: (proposalId: string) => Promise<ChatModificationProposal | null>;
  
  /** Check if modification is allowed (rate limit check) */
  canModifyChat: (chatId: number, type: 'photo' | 'description' | 'title') => Promise<{
    allowed: boolean;
    reason?: string;
    lastModifiedAt?: number;
    nextAllowedAt?: number;
  }>;
  
  /** Execute approved modification */
  executeModification: (avatarId: string, proposalId: string) => Promise<{
    success: boolean;
    error?: string;
  }>;

  // === Channel Discovery & Cross-Platform Tools ===

  /** List all known chats for this avatar */
  listChats?: (avatarId: string) => Promise<TelegramChatInfo[]>;

  /** Get detailed info about a specific chat */
  getChatInfo?: (avatarId: string, chatId: number | string) => Promise<TelegramChatInfo | null>;

  /** Send message to a specific chat (cross-platform posting) */
  sendToChat?: (avatarId: string, chatId: number | string, text: string, options?: {
    parseMode?: 'HTML' | 'Markdown' | 'MarkdownV2';
    replyToMessageId?: number;
    disableNotification?: boolean;
  }) => Promise<{ messageId: number } | null>;

  /** Send media to a specific chat (cross-platform posting) */
  sendMediaToChat?: (avatarId: string, chatId: number | string, mediaUrl: string, options?: {
    mediaType?: TelegramMediaType;
    caption?: string;
    replyToMessageId?: number;
    disableNotification?: boolean;
  }) => Promise<{ messageId: number } | null>;

  /** Get chat summary with LLM-generated description */
  getChatSummary?: (avatarId: string, chatId: number | string) => Promise<string | null>;

  /** Discover new chats from recent updates (for channel discovery) */
  discoverChats?: (avatarId: string) => Promise<TelegramChatInfo[]>;
}

// ============================================================================
// Tool Definitions
// ============================================================================

export const createTelegramTools = (services: TelegramServices) => [
  // === Diagnostics ===
  defineTool({
    name: 'diagnose_telegram',
    description:
      'Diagnose Telegram integration for this avatar (token present/valid, webhook URL + errors, pending updates, and last webhook activity if available).',
    category: 'diagnostics',
    platforms: ['telegram', 'admin-ui'],
    inputSchema: z.object({}),
    execute: async (_input, context): Promise<ToolResult> => {
      if (!services.diagnoseTelegram) {
        return { success: false, error: 'diagnoseTelegram service is not available' };
      }

      try {
        const data = await services.diagnoseTelegram(context.avatarId);
        return { success: true, data };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  }),

  // === User Profile Photos ===
  defineTool({
    name: 'get_user_profile_photos',
    description: 'Get profile photos of a Telegram user. Returns up to 100 photos with file URLs.',
    category: 'telegram',
    platforms: ['telegram'],
    inputSchema: z.object({
      userId: z.number().describe('Telegram user ID to get photos for'),
      limit: z.number().min(1).max(100).optional().describe('Max photos to return (default: 10)'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      try {
        const profile = await services.getUserProfilePhotos(
          context.avatarId,
          input.userId,
          { limit: input.limit || 10 }
        );
        
        return {
          success: true,
          data: {
            userId: profile.userId,
            name: [profile.firstName, profile.lastName].filter(Boolean).join(' '),
            username: profile.username,
            totalPhotos: profile.totalPhotos,
            photos: profile.photos.map(p => ({
              fileId: p.fileId,
              size: `${p.width}x${p.height}`,
              url: p.fileUrl,
            })),
          },
        };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  }),

  // === Bot Profile Management ===
  defineTool({
    name: 'set_bot_name',
    description: 'Change my bot display name on Telegram. This is my public-facing name shown in chats.',
    category: 'telegram',
    platforms: ['telegram', 'admin-ui'],
    inputSchema: z.object({
      name: z.string().min(1).max(64).describe('New bot name (1-64 characters)'),
      languageCode: z.string().optional().describe('Language code (e.g., "en", "es"). If omitted, sets default name.'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      try {
        await services.setBotName(context.avatarId, input.name, input.languageCode);
        return {
          success: true,
          data: {
            message: `Bot name updated to "${input.name}"${input.languageCode ? ` for ${input.languageCode}` : ''}`,
          },
        };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  }),

  defineTool({
    name: 'set_bot_description',
    description: 'Change my bot description on Telegram. This is shown when users open a chat with me for the first time.',
    category: 'telegram',
    platforms: ['telegram', 'admin-ui'],
    inputSchema: z.object({
      description: z.string().max(512).describe('New bot description (0-512 characters). Empty to remove.'),
      languageCode: z.string().optional().describe('Language code. If omitted, sets default description.'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      try {
        await services.setBotDescription(context.avatarId, input.description, input.languageCode);
        return {
          success: true,
          data: {
            message: input.description 
              ? `Bot description updated${input.languageCode ? ` for ${input.languageCode}` : ''}`
              : 'Bot description removed',
          },
        };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  }),

  defineTool({
    name: 'set_bot_short_description',
    description: 'Change my short description. This is shown on my profile page and when I\'m shared.',
    category: 'telegram',
    platforms: ['telegram', 'admin-ui'],
    inputSchema: z.object({
      shortDescription: z.string().max(120).describe('New short description (0-120 characters). Empty to remove.'),
      languageCode: z.string().optional().describe('Language code. If omitted, sets default.'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      try {
        await services.setBotShortDescription(context.avatarId, input.shortDescription, input.languageCode);
        return {
          success: true,
          data: {
            message: input.shortDescription 
              ? `Short description updated${input.languageCode ? ` for ${input.languageCode}` : ''}`
              : 'Short description removed',
          },
        };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  }),

  defineTool({
    name: 'send_typing_indicator',
    description: 'Show a typing indicator or other status in a chat. Makes me appear more natural while processing.',
    category: 'telegram',
    platforms: ['telegram'],
    inputSchema: z.object({
      action: z.enum([
        'typing', 'upload_photo', 'record_video', 'upload_video',
        'record_voice', 'upload_voice', 'upload_document', 'choose_sticker',
        'find_location', 'record_video_note', 'upload_video_note'
      ]).optional().describe('Type of action to show. Default: typing'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      if (!context.conversationId) {
        return { success: false, error: 'No chat context available' };
      }
      
      try {
        await services.sendChatAction(
          context.avatarId,
          parseInt(context.conversationId),
          input.action || 'typing'
        );
        return { success: true, data: { message: `Showing ${input.action || 'typing'} indicator` } };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  }),

  defineTool({
    name: 'reply_to_message',
    description: 'Reply to a specific Telegram message (keeps context/threading correct in groups and channels).',
    category: 'telegram',
    platforms: ['telegram'],
    inputSchema: z.object({
      chatId: z.number().optional().describe('Chat ID. Defaults to current chat.'),
      replyToMessageId: z.number().optional().describe('Message ID to reply to. Defaults to the current incoming message.'),
      text: z.string().min(1).max(4096).describe('Reply text'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      if (!services.replyToMessage) {
        return { success: false, error: 'Reply tool is not available' };
      }

      const chatId = typeof input.chatId === 'number'
        ? input.chatId
        : (context.conversationId ? parseInt(context.conversationId) : NaN);
      const replyTo = typeof input.replyToMessageId === 'number'
        ? input.replyToMessageId
        : (context.replyToMessageId ? parseInt(context.replyToMessageId) : NaN);

      if (!Number.isFinite(chatId)) {
        return { success: false, error: 'No chat context available' };
      }
      if (!Number.isFinite(replyTo)) {
        return { success: false, error: 'No reply target message available' };
      }

      try {
        const result = await services.replyToMessage(context.avatarId, chatId, replyTo, input.text);
        return {
          success: true,
          data: {
            message: 'Reply sent',
            messageId: result.messageId,
          },
        };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  }),

  defineTool({
    name: 'react_to_message',
    description: 'React to a Telegram message with an emoji (e.g. 👍, ❤️).',
    category: 'telegram',
    platforms: ['telegram'],
    inputSchema: z.object({
      chatId: z.number().optional().describe('Chat ID. Defaults to current chat.'),
      messageId: z.number().optional().describe('Message ID to react to. Defaults to the current incoming message.'),
      emoji: z.string().min(1).max(16).describe('Emoji reaction'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      if (!services.reactToMessage) {
        return { success: false, error: 'Reaction tool is not available' };
      }

      const chatId = typeof input.chatId === 'number'
        ? input.chatId
        : (context.conversationId ? parseInt(context.conversationId) : NaN);
      const messageId = typeof input.messageId === 'number'
        ? input.messageId
        : (context.replyToMessageId ? parseInt(context.replyToMessageId) : NaN);

      if (!Number.isFinite(chatId)) {
        return { success: false, error: 'No chat context available' };
      }
      if (!Number.isFinite(messageId)) {
        return { success: false, error: 'No message target available' };
      }

      try {
        await services.reactToMessage(context.avatarId, chatId, messageId, input.emoji);
        return { success: true, data: { message: `Reacted with ${input.emoji}` } };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  }),

  // === Chat Modification Voting System ===
  defineTool({
    name: 'propose_chat_change',
    description: `Propose changing the chat's photo, description, or title. All bots in the chat must vote to approve before the change is made. Changes are limited to once per week.`,
    category: 'telegram',
    platforms: ['telegram'],
    inputSchema: z.object({
      type: z.enum(['photo', 'description', 'title']).describe('What to change'),
      newValue: z.string().describe('New value: URL for photo, text for description/title'),
      reason: z.string().optional().describe('Why you want to make this change'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      if (!context.conversationId) {
        return { success: false, error: 'No chat context available' };
      }
      
      const chatId = parseInt(context.conversationId);
      
      try {
        // Check rate limit
        const canModify = await services.canModifyChat(chatId, input.type);
        if (!canModify.allowed) {
          return {
            success: false,
            error: canModify.reason || 'Cannot modify chat at this time',
            data: {
              lastModifiedAt: canModify.lastModifiedAt,
              nextAllowedAt: canModify.nextAllowedAt,
            },
          };
        }
        
        // Create proposal
        const proposal = await services.proposeModification(
          context.avatarId,
          chatId,
          input.type,
          input.newValue,
          input.reason
        );
        
        return {
          success: true,
          data: {
            proposalId: proposal.proposalId,
            message: `Proposal created! Waiting for ${proposal.requiredVotes} vote(s) from other bots.`,
            status: proposal.status,
            votes: proposal.approvalCount,
            required: proposal.requiredVotes,
          },
        };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  }),

  defineTool({
    name: 'vote_on_chat_change',
    description: 'Vote to approve or reject a proposed chat modification. If all bots approve, the change will be made.',
    category: 'telegram',
    platforms: ['telegram'],
    inputSchema: z.object({
      proposalId: z.string().describe('ID of the proposal to vote on'),
      vote: z.enum(['approve', 'reject']).describe('Your vote'),
      comment: z.string().optional().describe('Optional comment explaining your vote'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      try {
        const proposal = await services.voteOnProposal(
          context.avatarId,
          input.proposalId,
          input.vote,
          input.comment
        );
        
        // Check if we should auto-execute
        if (proposal.status === 'approved') {
          const result = await services.executeModification(context.avatarId, proposal.proposalId);
          if (result.success) {
            return {
              success: true,
              data: {
                message: `Vote recorded! All bots approved - change has been applied!`,
                status: 'executed',
                type: proposal.type,
              },
            };
          } else {
            return {
              success: true,
              data: {
                message: `Vote recorded and approved, but execution failed: ${result.error}`,
                status: 'approved',
              },
            };
          }
        }
        
        return {
          success: true,
          data: {
            message: `Vote recorded: ${input.vote}`,
            status: proposal.status,
            approvalCount: proposal.approvalCount,
            rejectionCount: proposal.rejectionCount,
            requiredVotes: proposal.requiredVotes,
            remaining: proposal.requiredVotes - proposal.approvalCount,
          },
        };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  }),

  defineTool({
    name: 'list_chat_proposals',
    description: 'List active proposals for changing the current chat. See what changes are being voted on.',
    category: 'telegram',
    platforms: ['telegram'],
    inputSchema: z.object({}),
    execute: async (_input, context): Promise<ToolResult> => {
      if (!context.conversationId) {
        return { success: false, error: 'No chat context available' };
      }
      
      const chatId = parseInt(context.conversationId);
      
      try {
        const proposals = await services.getActiveProposals(chatId);
        
        if (proposals.length === 0) {
          return {
            success: true,
            data: {
              message: 'No active proposals for this chat',
              proposals: [],
            },
          };
        }
        
        return {
          success: true,
          data: {
            proposals: proposals.map(p => ({
              proposalId: p.proposalId,
              type: p.type,
              proposedBy: p.proposedBy,
              reason: p.reason,
              status: p.status,
              approvals: p.approvalCount,
              rejections: p.rejectionCount,
              required: p.requiredVotes,
              proposedAt: new Date(p.proposedAt).toISOString(),
            })),
          },
        };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  }),

  defineTool({
    name: 'check_chat_modification_limit',
    description: 'Check when the chat photo, description, or title was last modified and when it can be changed again.',
    category: 'telegram',
    platforms: ['telegram'],
    inputSchema: z.object({
      type: z.enum(['photo', 'description', 'title']).describe('Type of modification to check'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      if (!context.conversationId) {
        return { success: false, error: 'No chat context available' };
      }
      
      const chatId = parseInt(context.conversationId);
      
      try {
        const result = await services.canModifyChat(chatId, input.type);
        
        return {
          success: true,
          data: {
            type: input.type,
            canModify: result.allowed,
            lastModifiedAt: result.lastModifiedAt 
              ? new Date(result.lastModifiedAt).toISOString() 
              : null,
            nextAllowedAt: result.nextAllowedAt 
              ? new Date(result.nextAllowedAt).toISOString() 
              : null,
            reason: result.reason,
          },
        };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  }),

  // === Channel Discovery & Cross-Platform Tools ===

  defineTool({
    name: 'telegram_list_chats',
    description: 'List all Telegram chats (groups, channels, DMs) that I am a member of. Useful for cross-platform awareness and posting.',
    category: 'readonly',
    toolset: 'telegram',
    platforms: ['telegram', 'admin-ui', 'api', 'mcp'],
    inputSchema: z.object({}),
    execute: async (_input, context): Promise<ToolResult> => {
      if (!services.listChats) {
        return { success: false, error: 'Chat listing service is not available' };
      }

      try {
        const chats = await services.listChats(context.avatarId);

        return {
          success: true,
          data: {
            count: chats.length,
            chats: chats.map(c => ({
              chatId: c.chatId,
              title: c.title,
              type: c.type,
              username: c.username,
              memberCount: c.memberCount,
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
    name: 'telegram_get_chat_info',
    description: 'Get detailed information about a specific Telegram chat, including recent activity summary.',
    category: 'readonly',
    toolset: 'telegram',
    platforms: ['telegram', 'admin-ui', 'api', 'mcp'],
    inputSchema: z.object({
      chatId: z.union([z.number(), z.string()]).describe('Telegram chat ID'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      if (!services.getChatInfo) {
        return { success: false, error: 'Chat info service is not available' };
      }

      try {
        const chat = await services.getChatInfo(context.avatarId, input.chatId);

        if (!chat) {
          return { success: false, error: 'Chat not found or not accessible' };
        }

        // Get summary if available
        let summary = chat.summary;
        if (!summary && services.getChatSummary) {
          summary = await services.getChatSummary(context.avatarId, input.chatId) || undefined;
        }

        return {
          success: true,
          data: {
            chatId: chat.chatId,
            title: chat.title,
            type: chat.type,
            username: chat.username,
            memberCount: chat.memberCount,
            lastActive: chat.lastActivityAt
              ? new Date(chat.lastActivityAt).toISOString()
              : undefined,
            summary,
          },
        };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  }),

  defineTool({
    name: 'telegram_send_to_chat',
    description: 'Send a message to a specific Telegram chat. Use this for cross-platform posting or proactive messaging to known chats.',
    category: 'telegram',
    toolset: 'telegram',
    platforms: ['telegram', 'admin-ui', 'api', 'mcp'],
    inputSchema: z.object({
      chatId: z.union([z.number(), z.string()]).describe('Telegram chat ID to send to'),
      text: z.string().min(1).max(4096).describe('Message text (1-4096 characters)'),
      parseMode: z.enum(['HTML', 'Markdown', 'MarkdownV2']).optional()
        .describe('Parse mode for formatting'),
      disableNotification: z.boolean().optional()
        .describe('Send silently without notification'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      if (!services.sendToChat) {
        return { success: false, error: 'Send to chat service is not available' };
      }

      try {
        const result = await services.sendToChat(
          context.avatarId,
          input.chatId,
          input.text,
          {
            parseMode: input.parseMode,
            disableNotification: input.disableNotification,
          }
        );

        if (!result) {
          return { success: false, error: 'Failed to send message' };
        }

        return {
          success: true,
          data: {
            messageId: result.messageId,
            chatId: input.chatId,
            message: 'Message sent successfully',
          },
        };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  }),

  defineTool({
    name: 'telegram_send_media_to_chat',
    description: 'Send an image, video, or sticker URL to a specific Telegram chat. Use this when a generated or gallery image must be posted into a Telegram group/channel instead of only shown in admin chat.',
    category: 'telegram',
    toolset: 'telegram',
    platforms: ['telegram', 'admin-ui', 'api', 'mcp'],
    inputSchema: z.object({
      chatId: z.union([z.number(), z.string()]).describe('Telegram chat ID to send to'),
      mediaUrl: z.string().url().describe('Public image/video/sticker URL to send'),
      mediaType: z.enum(['image', 'video', 'sticker']).default('image')
        .describe('Type of media to send. Stickers are sent as photos when only a URL is available.'),
      caption: z.string().max(1024).optional()
        .describe('Optional caption for image/video media'),
      replyToMessageId: z.number().int().positive().optional()
        .describe('Optional Telegram message ID to reply to'),
      disableNotification: z.boolean().optional()
        .describe('Send silently without notification'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      if (!services.sendMediaToChat) {
        return { success: false, error: 'Send media to chat service is not available' };
      }

      try {
        const result = await services.sendMediaToChat(
          context.avatarId,
          input.chatId,
          input.mediaUrl,
          {
            mediaType: input.mediaType,
            caption: input.caption,
            replyToMessageId: input.replyToMessageId,
            disableNotification: input.disableNotification,
          }
        );

        if (!result) {
          return { success: false, error: 'Failed to send media' };
        }

        return {
          success: true,
          data: {
            messageId: result.messageId,
            chatId: input.chatId,
            mediaUrl: input.mediaUrl,
            mediaType: input.mediaType,
            message: 'Media sent successfully',
          },
          media: {
            type: input.mediaType === 'video' ? 'video' : 'image',
            url: input.mediaUrl,
            caption: input.caption,
          },
        };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  }),

  defineTool({
    name: 'telegram_discover_chats',
    description: 'Discover new Telegram chats from recent bot updates. Use this to find chats the bot has been added to.',
    category: 'diagnostics',
    toolset: 'telegram',
    platforms: ['admin-ui', 'api', 'mcp'],
    inputSchema: z.object({}),
    execute: async (_input, context): Promise<ToolResult> => {
      if (!services.discoverChats) {
        return { success: false, error: 'Chat discovery service is not available' };
      }

      try {
        const chats = await services.discoverChats(context.avatarId);

        return {
          success: true,
          data: {
            discovered: chats.length,
            chats: chats.map(c => ({
              chatId: c.chatId,
              title: c.title,
              type: c.type,
            })),
            message: chats.length > 0
              ? `Discovered ${chats.length} new chat(s)`
              : 'No new chats discovered',
          },
        };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  }),
];
