/**
 * Media Generation Tools
 * 
 * Tools for generating images, videos, and stickers.
 */
import { z } from 'zod';
import { defineTool, type ToolResult } from '../registry.js';

// ============================================================================
// Service Interface
// ============================================================================

/**
 * Media services required by these tools
 */
export interface MediaServices {
  generateImage: (params: {
    prompt: string;
    agentId: string;
    platform: string;
    referenceImageUrls?: string[];
    resolution?: '1K' | '2K' | '4K';
    aspectRatio?: string;
  }) => Promise<{ url: string; id: string } | { jobId: string; status: string; url?: string; id?: string }>;

  generateVideo: (params: {
    prompt: string;
    agentId: string;
    platform: string;
    referenceImageUrl?: string;
    conversationId?: string;
    replyToMessageId?: string;
  }) => Promise<{ jobId: string; status: string }>;

  generateSticker: (params: {
    prompt?: string;
    sourceImageId?: string;
    agentId: string;
  }) => Promise<{ url: string; id: string }>;

  getProfileImageUrl: (agentId: string) => Promise<string | undefined>;
  getReferenceImageUrl: (agentId: string, category: 'profile' | 'character') => Promise<string | undefined>;
  getCharacterReferenceUrl?: (agentId: string) => Promise<string | undefined>;
  getBestReferenceImageUrl?: (agentId: string) => Promise<string | undefined>;
}

export interface CreditServices {
  canUseTool: (agentId: string, toolName: string) => Promise<{ allowed: boolean; reason?: string }>;
  consumeCredit: (agentId: string, toolName: string) => Promise<boolean>;
}

// ============================================================================
// Tool Definitions
// ============================================================================

export const createMediaTools = (
  media: MediaServices,
  credits: CreditServices
) => [
  defineTool({
    name: 'generate_image',
    description: 'Generate an image from a text prompt. The image will be created based on your description.',
    category: 'media',
    inputSchema: z.object({
      prompt: z.string().min(1).describe('Description of the image to generate'),
      aspectRatio: z.enum(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9'])
        .optional()
        .default('1:1')
        .describe('Aspect ratio of the image'),
      resolution: z.enum(['1K', '2K', '4K'])
        .optional()
        .default('2K')
        .describe('Resolution quality'),
      useProfileAsReference: z.boolean()
        .optional()
        .default(true)
        .describe('Use character reference (or profile image) for consistency'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      // Check credits
      const canUse = await credits.canUseTool(context.agentId, 'generate_image');
      if (!canUse.allowed) {
        return { success: false, error: `Rate limited: ${canUse.reason}` };
      }

      // Get reference images - prefer character reference for full-body consistency
      const referenceImageUrls: string[] = [];
      if (input.useProfileAsReference) {
        // Use getBestReferenceImageUrl if available (prefers character reference over profile)
        if (media.getBestReferenceImageUrl) {
          const bestRef = await media.getBestReferenceImageUrl(context.agentId);
          if (bestRef) referenceImageUrls.push(bestRef);
        } else {
          // Fallback: try character reference first, then profile image
          const charRef = media.getCharacterReferenceUrl 
            ? await media.getCharacterReferenceUrl(context.agentId)
            : await media.getReferenceImageUrl(context.agentId, 'character');
          if (charRef) {
            referenceImageUrls.push(charRef);
          } else {
            const profileUrl = await media.getProfileImageUrl(context.agentId);
            if (profileUrl) referenceImageUrls.push(profileUrl);
          }
        }
      }

      const result = await media.generateImage({
        prompt: input.prompt,
        agentId: context.agentId,
        platform: context.platform,
        referenceImageUrls,
        resolution: input.resolution,
        aspectRatio: input.aspectRatio,
      });

      // If synchronous result with URL
      if ('url' in result && result.url) {
        return {
          success: true,
          data: { id: result.id, url: result.url },
          media: { type: 'image', url: result.url, caption: input.prompt },
        };
      }

      // Async job - use 'in' check for proper narrowing
      if ('jobId' in result && result.jobId) {
        return {
          success: true,
          data: { jobId: result.jobId, status: result.status },
          pendingJob: {
            jobId: result.jobId,
            type: 'image',
            prompt: input.prompt,
          },
        };
      }

      // Fallback - shouldn't happen
      return { success: false, error: 'Unexpected response from image generation' };
    },
  }),

  defineTool({
    name: 'generate_video',
    description: 'Generate a short video from a text prompt. This takes longer than images - I will send it when ready.',
    category: 'media',
    inputSchema: z.object({
      prompt: z.string().min(1).describe('Description of the video to generate'),
      useProfileAsReference: z.boolean()
        .optional()
        .default(true)
        .describe('Use character reference (or profile image) as starting frame'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      const canUse = await credits.canUseTool(context.agentId, 'generate_video');
      if (!canUse.allowed) {
        return { success: false, error: `Rate limited: ${canUse.reason}` };
      }

      // Get best reference image - prefer character reference for full-body consistency
      let referenceImageUrl: string | undefined;
      if (input.useProfileAsReference) {
        if (media.getBestReferenceImageUrl) {
          referenceImageUrl = await media.getBestReferenceImageUrl(context.agentId);
        } else {
          // Fallback: try character reference first, then profile image
          if (media.getCharacterReferenceUrl) {
            referenceImageUrl = await media.getCharacterReferenceUrl(context.agentId);
          }
          if (!referenceImageUrl) {
            referenceImageUrl = await media.getReferenceImageUrl(context.agentId, 'character');
          }
          if (!referenceImageUrl) {
            referenceImageUrl = await media.getProfileImageUrl(context.agentId);
          }
        }
      }

      const result = await media.generateVideo({
        prompt: input.prompt,
        agentId: context.agentId,
        platform: context.platform,
        referenceImageUrl,
        conversationId: context.conversationId,
        replyToMessageId: context.replyToMessageId,
      });

      return {
        success: true,
        data: { jobId: result.jobId, status: 'started', message: 'Video generation started. I will send it when ready!' },
        pendingJob: {
          jobId: result.jobId,
          type: 'video',
          prompt: input.prompt,
        },
      };
    },
  }),

  defineTool({
    name: 'generate_sticker',
    description: 'Generate a sticker from a prompt or existing image. Creates a transparent PNG suitable for messaging apps.',
    category: 'media',
    platforms: ['admin-ui', 'api'], // Not available on Telegram yet
    inputSchema: z.object({
      prompt: z.string().optional().describe('Description for new sticker generation'),
      sourceImageId: z.string().optional().describe('Gallery image ID to convert to sticker'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      if (!input.prompt && !input.sourceImageId) {
        return { success: false, error: 'Provide either prompt or sourceImageId' };
      }

      const canUse = await credits.canUseTool(context.agentId, 'generate_sticker');
      if (!canUse.allowed) {
        return { success: false, error: `Rate limited: ${canUse.reason}` };
      }

      const result = await media.generateSticker({
        prompt: input.prompt,
        sourceImageId: input.sourceImageId,
        agentId: context.agentId,
      });

      return {
        success: true,
        data: { id: result.id, url: result.url },
        media: { type: 'sticker', url: result.url },
      };
    },
  }),
];

export default createMediaTools;
