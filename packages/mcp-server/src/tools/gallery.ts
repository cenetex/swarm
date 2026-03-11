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

  getUploadUrl?: (avatarId: string, contentType: string) => Promise<{
    uploadUrl: string;
    s3Key: string;
    publicUrl: string;
  }>;

  saveUploadedPhoto?: (avatarId: string, data: {
    s3Key: string;
    publicUrl: string;
    caption?: string;
  }) => Promise<{ id: string }>;
}

// ============================================================================
// Context Builders
// ============================================================================

/**
 * Build gallery context summary for tool descriptions
 */
export async function buildGalleryContext(
  services: GalleryServices,
  avatarId: string,
  options: {
    type?: GalleryItem['type'];
    emptyMessage?: string;
  } = {}
): Promise<string | undefined> {
  const items = await services.getGallery(avatarId, {
    type: options.type,
    limit: 5,
  });
  if (items.length === 0) {
    if (options.emptyMessage) {
      return options.emptyMessage;
    }
    return options.type === 'image'
      ? 'Gallery has no images yet - generate one first.'
      : 'Gallery is empty - generate some images first!';
  }

  const summaries = items.slice(0, 3).map(item => {
    const promptPreview = item.prompt
      ? ` "${item.prompt.slice(0, 25)}${item.prompt.length > 25 ? '...' : ''}"`
      : '';
    return `${item.id}${promptPreview}`;
  });

  const remaining = items.length - summaries.length;
  const contextPrefix = options.type ? `Recent ${options.type}s` : 'Recent';
  let context = `${contextPrefix}: ${summaries.join(', ')}`;
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
    description: 'Send an image from my gallery to the chat. Use an image ID from get_my_gallery.',
    category: 'gallery',
    inputSchema: z.object({
      imageId: z.string()
        .trim()
        .min(1, 'Image ID is required')
        .describe('ID of the gallery image to send'),
    }),
    contextBuilder: async (context) => {
      return buildGalleryContext(services, context.avatarId, {
        type: 'image',
        emptyMessage: 'Gallery has no images yet - run generate_image or get_my_gallery(type: image) first.',
      });
    },
    execute: async (input, context): Promise<ToolResult> => {
      const item = await services.getGalleryItem(context.avatarId, input.imageId);

      if (!item) {
        return {
          success: false,
          error: 'FAILED: Image ID not found in gallery. The image may have been deleted or the ID is stale. Run get_my_gallery to fetch current valid image IDs before retrying.',
        };
      }

      if (item.type !== 'image') {
        return {
          success: false,
          error: `FAILED: Gallery item "${item.id}" is type "${item.type}", not an image. Use get_my_gallery with type "image" to fetch a valid image ID before retrying.`,
        };
      }

      return {
        success: true,
        data: { id: item.id, url: item.url },
        media: { type: 'image', url: item.url, caption: item.prompt },
      };
    },
  }),

  defineTool({
    name: 'send_gallery_media',
    description: 'Send any media item (image, video, or sticker) from my gallery to the chat. Use an item ID from get_my_gallery.',
    category: 'gallery',
    inputSchema: z.object({
      itemId: z.string()
        .trim()
        .min(1, 'Item ID is required')
        .describe('ID of the gallery item to send'),
    }),
    contextBuilder: async (context) => {
      return buildGalleryContext(services, context.avatarId, {
        emptyMessage: 'Gallery is empty - generate some media first.',
      });
    },
    execute: async (input, context): Promise<ToolResult> => {
      const item = await services.getGalleryItem(context.avatarId, input.itemId);

      if (!item) {
        return {
          success: false,
          error: 'FAILED: Item ID not found in gallery. The item may have been deleted or the ID is stale. Run get_my_gallery to fetch current valid IDs before retrying.',
        };
      }

      return {
        success: true,
        data: { id: item.id, type: item.type, url: item.url },
        media: { type: item.type, url: item.url, caption: item.prompt },
      };
    },
  }),
  ...(services.getUploadUrl ? [defineTool({
    name: 'upload_photo_to_gallery',
    description: 'Get a signed URL to upload a photo to the gallery. Returns an upload URL for the user to send their image to.',
    category: 'gallery',
    platforms: ['admin-ui'],
    inputSchema: z.object({
      contentType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
        .optional()
        .default('image/png')
        .describe('The MIME type of the image being uploaded'),
      caption: z.string().optional().describe('Optional caption or description for the photo'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      const uploadInfo = await services.getUploadUrl!(context.avatarId, input.contentType);

      return {
        success: true,
        data: {
          ...uploadInfo,
          contentType: input.contentType,
          caption: input.caption,
        },
        uiAction: {
          type: 'upload_widget',
          payload: {
            ...uploadInfo,
            purpose: 'gallery',
            contentType: input.contentType,
            caption: input.caption,
          },
        },
      };
    },
  })] : []),

  ...(services.saveUploadedPhoto ? [defineTool({
    name: 'save_gallery_upload',
    description: 'Save metadata for a photo after it has been uploaded to the gallery.',
    category: 'gallery',
    platforms: ['admin-ui'],
    inputSchema: z.object({
      s3Key: z.string().describe('The S3 key returned from upload_photo_to_gallery'),
      publicUrl: z.string().describe('The public URL returned from upload_photo_to_gallery'),
      caption: z.string().optional().describe('Optional caption for the photo'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      const result = await services.saveUploadedPhoto!(context.avatarId, {
        s3Key: input.s3Key,
        publicUrl: input.publicUrl,
        caption: input.caption,
      });

      return {
        success: true,
        data: {
          message: 'Photo saved to gallery!',
          id: result.id,
          url: input.publicUrl,
        },
        media: { type: 'image', url: input.publicUrl, caption: input.caption },
      };
    },
  })] : []),
];

export default createGalleryTools;
