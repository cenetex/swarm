/**
 * Reference Image Tools
 * 
 * Tools for managing reference images used in media generation.
 * Categories: profile, character, style, background, other
 */
import { z } from 'zod';
import { defineTool, type ToolResult } from '../registry.js';

// ============================================================================
// Service Interface
// ============================================================================

export type ReferenceImageCategory = 'profile' | 'character' | 'style' | 'background' | 'other';

export interface ReferenceImage {
  id: string;
  category: ReferenceImageCategory;
  name: string;
  url: string;
  description?: string;
  createdAt: number;
}

export interface ReferenceImageServices {
  getUploadUrl: (agentId: string, category: ReferenceImageCategory, name: string, description?: string) => Promise<{
    uploadUrl: string;
    s3Key: string;
    publicUrl: string;
  }>;
  
  saveReferenceImage: (agentId: string, data: {
    s3Key: string;
    publicUrl: string;
    category: ReferenceImageCategory;
    name: string;
    description?: string;
  }) => Promise<{ id: string }>;
  
  listReferenceImages: (agentId: string, category?: ReferenceImageCategory) => Promise<ReferenceImage[]>;
  
  deleteReferenceImage: (agentId: string, imageId: string) => Promise<void>;
}

// ============================================================================
// Schemas
// ============================================================================

const ReferenceImageCategorySchema = z.enum(['profile', 'character', 'style', 'background', 'other']);

// ============================================================================
// Context Builders
// ============================================================================

/**
 * Build reference images context summary
 */
export async function buildReferenceContext(
  services: ReferenceImageServices,
  agentId: string
): Promise<string | undefined> {
  const images = await services.listReferenceImages(agentId);
  if (images.length === 0) {
    return 'No reference images uploaded yet.';
  }

  // Group by category
  const byCategory: Record<string, number> = {};
  for (const img of images) {
    byCategory[img.category] = (byCategory[img.category] || 0) + 1;
  }

  const parts = Object.entries(byCategory)
    .map(([cat, count]) => `${cat}: ${count}`)
    .join(', ');

  return `Categories: ${parts}`;
}

// ============================================================================
// Tool Definitions
// ============================================================================

export const createReferenceImageTools = (services: ReferenceImageServices) => [
  defineTool({
    name: 'get_reference_image_upload_url',
    description: 'Get a signed URL to upload a reference image. Categories: profile (avatar), character (for consistency), style (art style), background (scenes), other.',
    category: 'gallery',
    platforms: ['admin-ui'],
    inputSchema: z.object({
      category: ReferenceImageCategorySchema.describe('The category of reference image'),
      name: z.string().describe('A descriptive name for this reference image'),
      description: z.string().optional().describe('Optional description of what this reference shows'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      const uploadInfo = await services.getUploadUrl(
        context.agentId,
        input.category,
        input.name,
        input.description
      );

      return {
        success: true,
        data: {
          ...uploadInfo,
          category: input.category,
          name: input.name,
        },
        uiAction: {
          type: 'upload_widget',
          payload: {
            ...uploadInfo,
            purpose: 'reference',
            category: input.category,
            name: input.name,
            description: input.description,
          },
        },
      };
    },
  }),

  defineTool({
    name: 'save_reference_image',
    description: 'Save the metadata for a reference image after it has been uploaded.',
    category: 'gallery',
    platforms: ['admin-ui'],
    inputSchema: z.object({
      s3Key: z.string().describe('The S3 key returned from get_reference_image_upload_url'),
      publicUrl: z.string().describe('The public URL returned from get_reference_image_upload_url'),
      category: ReferenceImageCategorySchema,
      name: z.string().describe('Name for the reference image'),
      description: z.string().optional().describe('Optional description'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      const result = await services.saveReferenceImage(context.agentId, {
        s3Key: input.s3Key,
        publicUrl: input.publicUrl,
        category: input.category,
        name: input.name,
        description: input.description,
      });

      return {
        success: true,
        data: {
          message: 'Reference image saved!',
          id: result.id,
          url: input.publicUrl,
          category: input.category,
        },
      };
    },
  }),

  defineTool({
    name: 'list_reference_images',
    description: 'List all reference images, optionally filtered by category.',
    category: 'gallery',
    inputSchema: z.object({
      category: ReferenceImageCategorySchema.optional().describe('Filter by category'),
    }),
    contextBuilder: async (context) => {
      return buildReferenceContext(services, context.agentId);
    },
    execute: async (input, context): Promise<ToolResult> => {
      const images = await services.listReferenceImages(context.agentId, input.category);

      return {
        success: true,
        data: {
          images: images.map(img => ({
            id: img.id,
            category: img.category,
            name: img.name,
            url: img.url,
            description: img.description,
          })),
          count: images.length,
        },
      };
    },
  }),

  defineTool({
    name: 'delete_reference_image',
    description: 'Delete a reference image by its ID.',
    category: 'gallery',
    inputSchema: z.object({
      imageId: z.string().describe('The ID of the reference image to delete'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      await services.deleteReferenceImage(context.agentId, input.imageId);

      return {
        success: true,
        data: {
          message: `Reference image ${input.imageId} deleted`,
        },
      };
    },
  }),
];

export default createReferenceImageTools;
