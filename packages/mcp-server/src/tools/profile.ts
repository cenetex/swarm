/**
 * Profile & Configuration Tools
 * 
 * Tools for managing agent profile, persona, and settings.
 */
import { z } from 'zod';
import { defineTool, type ToolResult } from '../registry.js';

// ============================================================================
// Service Interface
// ============================================================================

export interface ProfileServices {
  getProfile: (agentId: string) => Promise<{
    name: string;
    description?: string;
    persona?: string;
    profileImage?: { url: string };
  }>;
  
  updateProfile: (agentId: string, updates: {
    name?: string;
    description?: string;
    persona?: string;
  }) => Promise<void>;
  
  setProfileImage: (agentId: string, source: 
    | { type: 'url'; url: string }
    | { type: 'gallery'; imageId: string }
    | { type: 'generate'; prompt: string }
  ) => Promise<{ url: string }>;
  
  getProfileUploadUrl: (agentId: string) => Promise<{
    uploadUrl: string;
    s3Key: string;
    publicUrl: string;
  }>;
}

// ============================================================================
// Tool Definitions
// ============================================================================

export const createProfileTools = (services: ProfileServices) => [
  defineTool({
    name: 'update_my_profile',
    description: 'Update my name, description, or persona. I use the persona to shape my personality.',
    category: 'profile',
    inputSchema: z.object({
      name: z.string().optional().describe('My display name'),
      description: z.string().optional().describe('A brief description of my purpose'),
      persona: z.string().optional().describe('My personality and communication style'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      if (!input.name && !input.description && !input.persona) {
        return { success: false, error: 'Provide at least one field to update' };
      }

      await services.updateProfile(context.agentId, {
        name: input.name,
        description: input.description,
        persona: input.persona,
      });

      return {
        success: true,
        data: {
          message: 'Profile updated!',
          updated: Object.keys(input).filter(k => input[k as keyof typeof input]),
        },
      };
    },
  }),

  defineTool({
    name: 'set_profile_image',
    description: 'Set my profile image from a URL, gallery image, or generate a new one.',
    category: 'profile',
    inputSchema: z.object({
      source: z.enum(['url', 'gallery', 'generate', 'upload'])
        .describe('Where to get the image from'),
      url: z.string().optional().describe('URL of the image (when source=url)'),
      imageId: z.string().optional().describe('Gallery image ID (when source=gallery)'),
      prompt: z.string().optional().describe('Generation prompt (when source=generate)'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      // Upload source returns a widget for the UI
      if (input.source === 'upload') {
        const uploadInfo = await services.getProfileUploadUrl(context.agentId);
        return {
          success: true,
          data: uploadInfo,
          uiAction: {
            type: 'upload_widget',
            payload: uploadInfo,
          },
        };
      }

      // Validate source-specific params
      if (input.source === 'url' && !input.url) {
        return { success: false, error: 'URL required when source=url' };
      }
      if (input.source === 'gallery' && !input.imageId) {
        return { success: false, error: 'imageId required when source=gallery' };
      }
      if (input.source === 'generate' && !input.prompt) {
        return { success: false, error: 'prompt required when source=generate' };
      }

      let sourceArg: Parameters<typeof services.setProfileImage>[1];
      if (input.source === 'url') {
        sourceArg = { type: 'url', url: input.url! };
      } else if (input.source === 'gallery') {
        sourceArg = { type: 'gallery', imageId: input.imageId! };
      } else {
        sourceArg = { type: 'generate', prompt: input.prompt! };
      }

      const result = await services.setProfileImage(context.agentId, sourceArg);

      return {
        success: true,
        data: {
          message: 'Profile image updated!',
          url: result.url,
        },
      };
    },
  }),

  defineTool({
    name: 'get_profile_upload_url',
    description: 'Get a URL to upload a new profile image.',
    category: 'profile',
    platforms: ['admin-ui'], // Only makes sense in UI context
    inputSchema: z.object({}),
    execute: async (_input, context): Promise<ToolResult> => {
      const uploadInfo = await services.getProfileUploadUrl(context.agentId);

      return {
        success: true,
        data: uploadInfo,
        uiAction: {
          type: 'upload_widget',
          payload: uploadInfo,
        },
      };
    },
  }),
];

export default createProfileTools;
