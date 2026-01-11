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

export interface TelegramServices {
  /** Get user profile photos */
  getUserProfilePhotos: (agentId: string, userId: number, options?: {
    offset?: number;
    limit?: number;
  }) => Promise<TelegramUserProfile>;
  
  /** Get bot's current name */
  getBotName: (agentId: string) => Promise<{ name: string }>;
  
  /** Set bot's name (per language, or default) */
  setBotName: (agentId: string, name: string, languageCode?: string) => Promise<void>;
  
  /** Get bot's description */
  getBotDescription: (agentId: string) => Promise<{ description: string }>;
  
  /** Set bot's description */
  setBotDescription: (agentId: string, description: string, languageCode?: string) => Promise<void>;
  
  /** Get bot's short description */
  getBotShortDescription: (agentId: string) => Promise<{ shortDescription: string }>;
  
  /** Set bot's short description */
  setBotShortDescription: (agentId: string, shortDescription: string, languageCode?: string) => Promise<void>;
  
  /** Send typing indicator */
  sendChatAction: (agentId: string, chatId: number, action: 
    | 'typing' | 'upload_photo' | 'record_video' | 'upload_video' 
    | 'record_voice' | 'upload_voice' | 'upload_document' | 'choose_sticker'
    | 'find_location' | 'record_video_note' | 'upload_video_note'
  ) => Promise<void>;
  
  // === Chat Modification Voting System ===
  
  /** Get list of bots in a chat */
  getChatBots: (chatId: number) => Promise<Array<{ agentId: string; botUsername: string }>>;
  
  /** Create a proposal to modify chat */
  proposeModification: (
    agentId: string,
    chatId: number,
    type: 'photo' | 'description' | 'title',
    newValue: string,
    reason?: string
  ) => Promise<ChatModificationProposal>;
  
  /** Vote on a proposal */
  voteOnProposal: (
    agentId: string,
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
  executeModification: (agentId: string, proposalId: string) => Promise<{
    success: boolean;
    error?: string;
  }>;
}

// ============================================================================
// Tool Definitions
// ============================================================================

export const createTelegramTools = (services: TelegramServices) => [
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
          context.agentId,
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
        await services.setBotName(context.agentId, input.name, input.languageCode);
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
        await services.setBotDescription(context.agentId, input.description, input.languageCode);
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
        await services.setBotShortDescription(context.agentId, input.shortDescription, input.languageCode);
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
          context.agentId,
          parseInt(context.conversationId),
          input.action || 'typing'
        );
        return { success: true, data: { message: `Showing ${input.action || 'typing'} indicator` } };
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
          context.agentId,
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
          context.agentId,
          input.proposalId,
          input.vote,
          input.comment
        );
        
        // Check if we should auto-execute
        if (proposal.status === 'approved') {
          const result = await services.executeModification(context.agentId, proposal.proposalId);
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
];
