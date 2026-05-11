/**
 * Media Model Discovery & Configuration Tools
 *
 * Tools for browsing available image/video models
 * and setting media model preferences for avatars.
 */
import { z } from 'zod';
import { defineTool, type ToolResult } from '../registry.js';

// ============================================================================
// Service Interface
// ============================================================================

export interface MediaModelSearchResult {
  id: string; // provider-native model ID
  name: string;
  description: string;
  runCount: number;
  coverImageUrl?: string;
}

export interface MediaModelServices {
  /** Search configured media model providers for image/video models */
  browseMediaModels: (
    query: string,
    capability?: 'image' | 'video',
    provider?: 'openrouter' | 'replicate',
  ) => Promise<MediaModelSearchResult[]>;

  /** Set the media model preference for an avatar */
  setMediaModel: (
    avatarId: string,
    capability: 'image_generation' | 'video_generation',
    modelId: string,
    provider?: 'openrouter' | 'replicate',
  ) => Promise<void>;

  /** Get the currently configured media model for an avatar */
  getMediaModel: (
    avatarId: string,
    capability: 'image_generation' | 'video_generation',
    provider?: 'openrouter' | 'replicate',
  ) => Promise<{ model: string; provider: string }>;
}

// ============================================================================
// Tool Definitions
// ============================================================================

export const createMediaModelTools = (services: MediaModelServices) => [
  defineTool({
    name: 'browse_image_models',
    description:
      'Search for available image or video generation models. ' +
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
      provider: z
        .enum(['openrouter', 'replicate'])
        .optional()
        .default('openrouter')
        .describe('Model provider to search; defaults to OpenRouter for image/video generation'),
    }),
    execute: async (input, _context): Promise<ToolResult> => {
      const results = await services.browseMediaModels(input.query, input.capability, input.provider);

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
          provider: input.provider,
          hint: 'Use set_media_model to change your model. Model ID format is provider-native, usually "owner/name".',
        },
      };
    },
  }),

  defineTool({
    name: 'set_media_model',
    description:
      'Set the image or video generation model for this avatar. ' +
      'Accepts provider-native model IDs, usually in "owner/name" format. ' +
      'Use browse_image_models to find available models first.',
    category: 'config',
    toolset: 'models',
    platforms: ['admin-ui', 'api'],
    inputSchema: z.object({
      model: z
        .string()
        .regex(/^[a-z0-9_.-]+\/[a-z0-9_.:-]+$/i, 'Model must be in provider-native "owner/name" format')
        .describe('Model ID (e.g., "black-forest-labs/flux.2-pro")'),
      capability: z
        .enum(['image_generation', 'video_generation'])
        .optional()
        .default('image_generation')
        .describe('"image_generation" or "video_generation"'),
      provider: z
        .enum(['openrouter', 'replicate'])
        .optional()
        .default('openrouter')
        .describe('Provider to store this model under; defaults to OpenRouter'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      await services.setMediaModel(context.avatarId, input.capability, input.model, input.provider);

      return {
        success: true,
        data: {
          message: `${input.capability === 'image_generation' ? 'Image' : 'Video'} model set to ${input.model} on ${input.provider}`,
          model: input.model,
          capability: input.capability,
          provider: input.provider,
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
      provider: z
        .enum(['openrouter', 'replicate'])
        .optional()
        .default('openrouter')
        .describe('Provider to read; defaults to OpenRouter'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      const config = await services.getMediaModel(context.avatarId, input.capability, input.provider);

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
