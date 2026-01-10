/**
 * Gallery and reference image management tools
 */
import { z } from 'zod';
import { defineTool } from './tool-helper.js';
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
) => defineTool({
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
) => defineTool({
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
) => defineTool({
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
) => defineTool({
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
) => defineTool({
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
) => defineTool({
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
