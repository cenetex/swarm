/**
 * Sticker Tools
 *
 * Tools for creating and managing Telegram stickers:
 * - generate_sticker: Generate a new sticker from a text prompt
 * - create_sticker: Convert a gallery image into a sticker
 * - send_sticker: Send a sticker from the avatar's sticker pack
 * - get_sticker_pack: View stickers in the avatar's pack
 */
import { z } from 'zod';
import { defineTool, type ToolResult } from '../registry.js';

// ============================================================================
// Service Interface
// ============================================================================

export interface StickerInfo {
  id: string;
  emoji: string;
  fileId?: string;
  url?: string;
  prompt?: string;
  createdAt: string;
}

export interface StickerPackInfo {
  name: string;
  title: string;
  stickerCount: number;
  stickers: StickerInfo[];
  telegramUrl: string;
}

export interface GalleryItemForSticker {
  id: string;
  url: string;
  prompt?: string;
  type: 'image' | 'video' | 'sticker';
  convertedToSticker: boolean;
}

export interface StickerServices {
  /**
   * Generate a new sticker from a text prompt.
   * This generates an image with sticker-friendly styling, processes it
   * (background removal, sizing), and adds it to the sticker pack.
   */
  generateSticker: (
    avatarId: string,
    prompt: string,
    emoji?: string,
    conversationId?: string,
    ownerUserId?: string
  ) => Promise<{
    success: boolean;
    stickerId?: string;
    stickerUrl?: string;
    emoji?: string;
    packName?: string;
    packUrl?: string;
    fileId?: string;
    error?: string;
  }>;

  /**
   * Create a sticker from an existing gallery image.
   * Processes the image (background removal, sizing) and adds to pack.
   */
  createStickerFromGallery: (
    avatarId: string,
    galleryItemId: string,
    emoji?: string,
    conversationId?: string,
    ownerUserId?: string
  ) => Promise<{
    success: boolean;
    stickerId?: string;
    stickerUrl?: string;
    emoji?: string;
    packName?: string;
    packUrl?: string;
    fileId?: string;
    error?: string;
  }>;

  /**
   * Get the avatar's sticker pack info
   */
  getStickerPack: (avatarId: string) => Promise<StickerPackInfo | null>;

  /**
   * Get gallery items that can be converted to stickers
   */
  getGalleryForStickers: (
    avatarId: string,
    options?: { limit?: number; unconvertedOnly?: boolean }
  ) => Promise<GalleryItemForSticker[]>;

  /**
   * Find a sticker by description/emoji
   */
  findSticker: (
    avatarId: string,
    description: string
  ) => Promise<StickerInfo | null>;
}

// ============================================================================
// Tool Definitions
// ============================================================================

export const createStickerTools = (services: StickerServices) => [
  defineTool({
    name: 'generate_sticker',
    description: `Generate a new sticker from a text prompt. The image will be automatically styled for stickers (bold lines, transparent background) and added to my sticker pack. Use descriptive prompts for best results.`,
    category: 'media',
    platforms: ['telegram', 'admin-ui'],
    inputSchema: z.object({
      prompt: z.string()
        .min(3)
        .max(500)
        .describe('Description of the sticker to generate. Be specific about the subject, pose, and expression.'),
      emoji: z.string()
        .optional()
        .describe('Emoji to associate with this sticker (e.g., "😀", "🔥"). If not provided, one will be selected automatically.'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      try {
        const result = await services.generateSticker(
          context.avatarId,
          input.prompt,
          input.emoji,
          context.conversationId,
          context.userId
        );

        if (!result.success) {
          return { success: false, error: result.error || 'Failed to generate sticker' };
        }

        return {
          success: true,
          data: {
            stickerId: result.stickerId,
            fileId: result.fileId,
            emoji: result.emoji,
            packUrl: result.packUrl,
            message: `Created sticker ${result.emoji} and added to pack!`,
          },
          media: result.stickerUrl ? {
            type: 'sticker' as const,
            url: result.stickerUrl,
          } : undefined,
        };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  }),

  defineTool({
    name: 'create_sticker',
    description: `Convert a gallery image into a sticker. The image will be processed (background removed, resized to 512px) and added to my sticker pack. Use this when you want to turn an existing generated image into a sticker.`,
    category: 'media',
    platforms: ['telegram', 'admin-ui'],
    inputSchema: z.object({
      galleryItemId: z.string()
        .describe('ID of the gallery image to convert. Use get_my_gallery to find image IDs.'),
      emoji: z.string()
        .optional()
        .describe('Emoji to associate with this sticker. If not provided, one will be selected based on the image prompt.'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      try {
        const result = await services.createStickerFromGallery(
          context.avatarId,
          input.galleryItemId,
          input.emoji,
          context.conversationId,
          context.userId
        );

        if (!result.success) {
          return { success: false, error: result.error || 'Failed to create sticker' };
        }

        return {
          success: true,
          data: {
            stickerId: result.stickerId,
            fileId: result.fileId,
            emoji: result.emoji,
            packUrl: result.packUrl,
            message: `Converted image to sticker ${result.emoji}!`,
          },
          media: result.stickerUrl ? {
            type: 'sticker' as const,
            url: result.stickerUrl,
          } : undefined,
        };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  }),

  defineTool({
    name: 'send_sticker',
    description: `Send a sticker from my sticker pack. Can find stickers by emoji or description.`,
    category: 'media',
    platforms: ['telegram'],
    inputSchema: z.object({
      description: z.string()
        .optional()
        .describe('Description or emoji to find the right sticker. E.g., "fire", "😰", "latest", "random"'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      try {
        const pack = await services.getStickerPack(context.avatarId);

        if (!pack || pack.stickerCount === 0) {
          return {
            success: false,
            error: 'No sticker pack yet! Use generate_sticker to create one.',
          };
        }

        // Find a matching sticker
        const description = input.description || 'random';
        const sticker = await services.findSticker(context.avatarId, description);

        if (!sticker) {
          return {
            success: false,
            error: `Could not find a sticker matching "${description}". Pack has ${pack.stickerCount} stickers.`,
          };
        }

        return {
          success: true,
          data: {
            stickerId: sticker.id,
            fileId: sticker.fileId,
            emoji: sticker.emoji,
            message: `Sent sticker ${sticker.emoji}`,
          },
        };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  }),

  defineTool({
    name: 'get_sticker_pack',
    description: `View my sticker pack and all the stickers in it.`,
    category: 'media',
    platforms: ['telegram', 'admin-ui'],
    inputSchema: z.object({}),
    execute: async (_input, context): Promise<ToolResult> => {
      try {
        const pack = await services.getStickerPack(context.avatarId);

        if (!pack) {
          return {
            success: true,
            data: {
              hasPack: false,
              message: 'No sticker pack created yet. Use generate_sticker to create one!',
            },
          };
        }

        return {
          success: true,
          data: {
            hasPack: true,
            name: pack.name,
            title: pack.title,
            stickerCount: pack.stickerCount,
            telegramUrl: pack.telegramUrl,
            stickers: pack.stickers.map(s => ({
              id: s.id,
              emoji: s.emoji,
              prompt: s.prompt?.slice(0, 50),
            })),
          },
        };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  }),

  defineTool({
    name: 'get_gallery_for_stickers',
    description: `View gallery images that can be converted to stickers. Shows which images haven't been made into stickers yet.`,
    category: 'media',
    platforms: ['telegram', 'admin-ui'],
    inputSchema: z.object({
      unconvertedOnly: z.boolean()
        .optional()
        .default(true)
        .describe('Only show images not yet converted to stickers'),
      limit: z.number()
        .min(1)
        .max(20)
        .optional()
        .default(10)
        .describe('Maximum number of images to return'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      try {
        const items = await services.getGalleryForStickers(context.avatarId, {
          limit: input.limit,
          unconvertedOnly: input.unconvertedOnly,
        });

        if (items.length === 0) {
          return {
            success: true,
            data: {
              items: [],
              message: input.unconvertedOnly
                ? 'All gallery images have been converted to stickers!'
                : 'No images in gallery. Generate some images first!',
            },
          };
        }

        return {
          success: true,
          data: {
            items: items.map(i => ({
              id: i.id,
              prompt: i.prompt?.slice(0, 50),
              convertedToSticker: i.convertedToSticker,
            })),
            count: items.length,
          },
        };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },
  }),
];

export default createStickerTools;
