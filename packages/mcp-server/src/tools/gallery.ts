/**
 * Gallery Tools
 * 
 * Tools for managing generated media gallery.
 */
import { z } from 'zod';
import { defineTool, type ToolResult } from '../registry.js';

// ============================================================================
// Service Interface
// ============================================================================

export interface GalleryItem {
  id: string;
  type: 'image' | 'video' | 'sticker';
  url: string;
  prompt?: string;
  createdAt: number;
}

export interface GalleryServices {
  getGallery: (avatarId: string, options: {
    type?: 'image' | 'video' | 'sticker';
    limit?: number;
  }) => Promise<GalleryItem[]>;

  getGalleryItem: (avatarId: string, itemId: string) => Promise<GalleryItem | null>;

  searchGallery: (avatarId: string, query: string, type?: 'image' | 'video' | 'sticker') => Promise<GalleryItem[]>;
}

// ============================================================================
// Context Builders
// ============================================================================

/**
 * Build gallery context summary for tool descriptions
 */
export async function buildGalleryContext(
  services: GalleryServices,
  avatarId: string
): Promise<string | undefined> {
  const items = await services.getGallery(avatarId, { limit: 5 });
  if (items.length === 0) {
    return 'Gallery is empty - generate some images first!';
  }

  const summaries = items.slice(0, 3).map(item => {
    const promptPreview = item.prompt
      ? ` "${item.prompt.slice(0, 25)}${item.prompt.length > 25 ? '...' : ''}"`
      : '';
    return `${item.id}${promptPreview}`;
  });

  const remaining = items.length - summaries.length;
  let context = `Recent: ${summaries.join(', ')}`;
  if (remaining > 0) {
    context += ` (+${remaining} more)`;
  }
  return context;
}

// ============================================================================
// Tool Definitions
// ============================================================================

export const createGalleryTools = (services: GalleryServices) => [
  defineTool({
    name: 'get_my_gallery',
    description: 'View my generated images, videos, and stickers.',
    category: 'gallery',
    inputSchema: z.object({
      type: z.enum(['image', 'video', 'sticker'])
        .optional()
        .describe('Filter by media type'),
      limit: z.number()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .describe('Maximum items to return'),
    }),
    contextBuilder: async (context) => {
      return buildGalleryContext(services, context.avatarId);
    },
    execute: async (input, context): Promise<ToolResult> => {
      const items = await services.getGallery(context.avatarId, {
        type: input.type,
        limit: input.limit,
      });

      return {
        success: true,
        data: items.map(i => ({
          id: i.id,
          type: i.type,
          url: i.url,
          prompt: i.prompt,
        })),
      };
    },
  }),

  defineTool({
    name: 'search_gallery',
    description: 'Search my gallery by description or prompt keywords.',
    category: 'gallery',
    inputSchema: z.object({
      query: z.string().min(1).describe('Search terms'),
      type: z.enum(['image', 'video', 'sticker'])
        .optional()
        .describe('Filter by media type'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      const items = await services.searchGallery(
        context.avatarId,
        input.query,
        input.type
      );

      return {
        success: true,
        data: {
          items: items.map(i => ({
            id: i.id,
            type: i.type,
            url: i.url,
            prompt: i.prompt,
          })),
          count: items.length,
          query: input.query,
        },
      };
    },
  }),

  defineTool({
    name: 'send_gallery_image',
    description: 'Send an image from my gallery to the chat. Use an ID from my gallery.',
    category: 'gallery',
    inputSchema: z.object({
      imageId: z.string().describe('ID of the gallery image to send'),
    }),
    contextBuilder: async (context) => {
      return buildGalleryContext(services, context.avatarId);
    },
    execute: async (input, context): Promise<ToolResult> => {
      const item = await services.getGalleryItem(context.avatarId, input.imageId);

      if (!item) {
        return {
          success: false,
          error: 'FAILED: Image ID not found in gallery. The image may have been deleted or the ID is stale. Run get_my_gallery to fetch current valid image IDs before retrying.',
        };
      }

      return {
        success: true,
        data: { id: item.id, url: item.url },
        media: { type: 'image', url: item.url, caption: item.prompt },
      };
    },
  }),
];

export default createGalleryTools;
