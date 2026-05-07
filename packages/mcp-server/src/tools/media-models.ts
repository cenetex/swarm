/**
 * Media Model Discovery & Configuration Tools
 *
 * Tools for browsing available Replicate image/video models
 * and setting media model preferences for avatars.
 */
import { z } from 'zod';
import { defineTool, type ToolResult } from '../registry.js';

// ============================================================================
// Service Interface
// ============================================================================

export interface ReplicateModelSearchResult {
  id: string; // owner/name
  name: string;
  description: string;
  runCount: number;
  coverImageUrl?: string;
}

export interface MediaModelServices {
  /** Search Replicate for image/video models */
  browseReplicateModels: (query: string, capability?: 'image' | 'video') => Promise<ReplicateModelSearchResult[]>;

  /** Set the media model preference for an avatar */
  setMediaModel: (
    avatarId: string,
    capability: 'image_generation' | 'video_generation',
    modelId: string,
  ) => Promise<void>;

  /** Get the currently configured media model for an avatar */
  getMediaModel: (
    avatarId: string,
    capability: 'image_generation' | 'video_generation',
  ) => Promise<{ model: string; provider: string }>;
}

// ============================================================================
// Tool Definitions
// ============================================================================

export const createMediaModelTools = (services: MediaModelServices) => [
  defineTool({
    name: 'browse_image_models',
    description:
      'Search for available image or video generation models on Replicate. ' +
      'Use this to discover models before setting one with set_media_model. ' +
      'Returns model IDs, descriptions, and popularity.',
    category: 'config',
    toolset: 'models',
    platforms: ['admin-ui', 'api'],
    inputSchema: z.object({
      query: z
        .string()
        .describe('Search query (e.g., "flux", "anime", "realistic", "video generation")'),
      capability: z
        .enum(['image', 'video'])
        .optional()
        .default('image')
        .describe('"image" for image generation models, "video" for video generation models'),
    }),
    execute: async (input, _context): Promise<ToolResult> => {
      const results = await services.browseReplicateModels(input.query, input.capability);

      if (results.length === 0) {
        return {
          success: true,
          data: {
            models: [],
            message: `No ${input.capability} models found for "${input.query}". Try a broader search term.`,
          },
        };
      }

      return {
        success: true,
        data: {
          models: results.slice(0, 10).map((m) => ({
            id: m.id,
            name: m.name,
            description: m.description.slice(0, 120),
            runs: m.runCount > 1_000_000 ? `${(m.runCount / 1_000_000).toFixed(1)}M` : `${Math.round(m.runCount / 1000)}K`,
          })),
          total: results.length,
          hint: 'Use set_media_model to change your model. Model ID format: "owner/name".',
        },
      };
    },
  }),

  defineTool({
    name: 'set_media_model',
    description:
      'Set the image or video generation model for this avatar. ' +
      'Accepts any Replicate model in "owner/name" format. ' +
      'Use browse_image_models to find available models first.',
    category: 'config',
    toolset: 'models',
    platforms: ['admin-ui', 'api'],
    inputSchema: z.object({
      model: z
        .string()
        .regex(/^[a-z0-9_-]+\/[a-z0-9_-]+$/i, 'Model must be in "owner/name" format')
        .describe('Replicate model ID (e.g., "black-forest-labs/flux-1.1-pro")'),
      capability: z
        .enum(['image_generation', 'video_generation'])
        .optional()
        .default('image_generation')
        .describe('"image_generation" or "video_generation"'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      await services.setMediaModel(context.avatarId, input.capability, input.model);

      return {
        success: true,
        data: {
          message: `${input.capability === 'image_generation' ? 'Image' : 'Video'} model set to ${input.model}`,
          model: input.model,
          capability: input.capability,
        },
      };
    },
  }),

  defineTool({
    name: 'get_media_model',
    description:
      'Get the currently configured image or video generation model for this avatar.',
    category: 'config',
    toolset: 'models',
    platforms: ['admin-ui', 'api'],
    inputSchema: z.object({
      capability: z
        .enum(['image_generation', 'video_generation'])
        .optional()
        .default('image_generation')
        .describe('"image_generation" or "video_generation"'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      const config = await services.getMediaModel(context.avatarId, input.capability);

      return {
        success: true,
        data: {
          model: config.model,
          provider: config.provider,
          capability: input.capability,
          hint: 'Use set_media_model to change, or browse_image_models to discover new models.',
        },
      };
    },
  }),
];

export default createMediaModelTools;
