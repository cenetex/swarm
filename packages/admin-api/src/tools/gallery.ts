/**
 * Gallery and reference image management tools
 */
import { tool } from '@openrouter/sdk';
import { z } from 'zod/v4';

import { MediaTypeSchema, ReferenceImageCategorySchema } from './schemas.js';

// Types
interface GalleryItem {
  id: string;
  type: string;
  url: string;
  prompt?: string;
  createdAt: number;
}

interface ReferenceImage {
  id: string;
  category: string;
  name: string;
  url: string;
  description?: string;
}

/**
 * Get reference image upload URL
 */
export const getReferenceImageUploadUrl = (
  getUploadUrl: (category: string, name: string, description?: string) => Promise<{
    uploadUrl: string;
    s3Key: string;
    publicUrl: string;
  }>
) => tool({
  name: 'get_reference_image_upload_url',
  description: 'Get a signed URL to upload a reference image. Categories: profile (avatar), character (for consistency in generations), style (style references), background (scene references), other.',
  inputSchema: z.object({
    category: ReferenceImageCategorySchema.describe('The category of reference image'),
    name: z.string().describe('A descriptive name for this reference image'),
    description: z.string().optional().describe('Optional description of what this reference shows'),
  }),
  execute: async ({ category, name, description }) => {
    const info = await getUploadUrl(category, name, description);
    return {
      type: 'upload_widget',
      ...info,
      purpose: 'reference',
      category,
      name,
      description,
    };
  },
});

/**
 * Save reference image metadata
 */
export const saveReferenceImage = (
  _agentId: string,
  saveFn: (data: {
    s3Key: string;
    publicUrl: string;
    category: string;
    name: string;
    description?: string;
  }) => Promise<{ id: string }>
) => tool({
  name: 'save_reference_image',
  description: 'Save the metadata for a reference image after it has been uploaded',
  inputSchema: z.object({
    s3Key: z.string().describe('The S3 key returned from get_reference_image_upload_url'),
    publicUrl: z.string().describe('The public URL returned from get_reference_image_upload_url'),
    category: ReferenceImageCategorySchema,
    name: z.string().describe('Name for the reference image'),
    description: z.string().optional().describe('Optional description'),
  }),
  execute: async (params) => {
    const result = await saveFn(params);
    return {
      success: true,
      message: 'Reference image saved',
      id: result.id,
      url: params.publicUrl,
    };
  },
});

/**
 * List reference images
 */
export const listReferenceImages = (
  _agentId: string,
  listFn: (category?: string) => Promise<ReferenceImage[]>
) => tool({
  name: 'list_reference_images',
  description: 'List all reference images for this agent, optionally filtered by category',
  inputSchema: z.object({
    category: ReferenceImageCategorySchema.optional().describe('Filter by category (optional)'),
  }),
  execute: async ({ category }) => {
    const images = await listFn(category);
    return {
      images,
      count: images.length,
    };
  },
});

/**
 * Delete reference image
 */
export const deleteReferenceImage = (
  _agentId: string,
  deleteFn: (imageId: string) => Promise<void>
) => tool({
  name: 'delete_reference_image',
  description: 'Delete a reference image by its ID',
  inputSchema: z.object({
    imageId: z.string().describe('The ID of the reference image to delete'),
  }),
  execute: async ({ imageId }) => {
    await deleteFn(imageId);
    return {
      success: true,
      message: `Reference image ${imageId} deleted`,
    };
  },
});

/**
 * Get gallery items
 */
export const getMyGallery = (
  _agentId: string,
  listFn: (type?: string, limit?: number) => Promise<GalleryItem[]>
) => tool({
  name: 'get_my_gallery',
  description: 'View my generated images, videos, and stickers',
  inputSchema: z.object({
    type: MediaTypeSchema.optional().describe('Filter by media type'),
    limit: z.number().default(20).describe('Max items to return (default 20)'),
  }),
  execute: async ({ type, limit }) => {
    const items = await listFn(type, limit);
    return {
      items,
      count: items.length,
    };
  },
});

/**
 * Search gallery
 */
export const searchGallery = (
  _agentId: string,
  searchFn: (query: string, type?: string) => Promise<GalleryItem[]>
) => tool({
  name: 'search_gallery',
  description: 'Search my gallery by description or prompt keywords',
  inputSchema: z.object({
    query: z.string().describe('Search terms'),
    type: MediaTypeSchema.optional().describe('Filter by media type'),
  }),
  execute: async ({ query, type }) => {
    const items = await searchFn(query, type);
    return {
      items,
      count: items.length,
      query,
    };
  },
});

/**
 * Send gallery image to the chat
 * Returns the image for display in the conversation
 */
export const sendGalleryImage = (
  _agentId: string,
  getItemFn: (imageId: string) => Promise<GalleryItem | null>
) => tool({
  name: 'send_gallery_image',
  description: 'Send an image from my gallery to the chat. Use this when the user asks to see a specific image from the gallery.',
  inputSchema: z.object({
    imageId: z.string().describe('ID of the gallery image to send'),
  }),
  execute: async ({ imageId }) => {
    const item = await getItemFn(imageId);
    if (!item) {
      return { success: false, error: 'Image not found in gallery' };
    }
    return {
      success: true,
      result: { id: item.id, url: item.url, prompt: item.prompt },
      media: { type: 'image', url: item.url, caption: item.prompt },
    };
  },
});
