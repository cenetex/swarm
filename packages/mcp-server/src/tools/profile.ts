/**
 * Profile & Configuration Tools
 * 
 * Tools for managing avatar profile, persona, and settings.
 */
import { z } from 'zod';
import { defineTool, type ToolResult } from '../registry.js';

// ============================================================================
// Service Interface
// ============================================================================

export interface ProfileServices {
  getProfile: (avatarId: string) => Promise<{
    name: string;
    description?: string;
    persona?: string;
    profileImage?: { url: string };
    characterReference?: { url: string; description?: string };
  }>;
  
  updateProfile: (avatarId: string, updates: {
    name?: string;
    description?: string;
    persona?: string;
  }) => Promise<void>;
  
  setProfileImage: (avatarId: string, source: 
    | { type: 'url'; url: string }
    | { type: 'gallery'; imageId: string }
    | { type: 'generate'; prompt: string }
  ) => Promise<{ url: string } | { jobId: string; status: string }>;
  
  getProfileUploadUrl: (avatarId: string) => Promise<{
    uploadUrl: string;
    s3Key: string;
    publicUrl: string;
  }>;
  
  saveProfileImage: (avatarId: string, s3Key: string, publicUrl: string) => Promise<void>;

  // Character reference (full-body) for image/video generation
  setCharacterReference?: (avatarId: string, source: 
    | { type: 'url'; url: string }
    | { type: 'gallery'; imageId: string }
    | { type: 'generate'; prompt: string },
    description?: string
  ) => Promise<{ url: string } | { jobId: string; status: string }>;

  getCharacterReferenceUploadUrl?: (avatarId: string) => Promise<{
    uploadUrl: string;
    s3Key: string;
    publicUrl: string;
  }>;

  saveCharacterReference?: (avatarId: string, s3Key: string, publicUrl: string, description?: string) => Promise<void>;
}

// ============================================================================
// Tool Definitions
// ============================================================================

export const createProfileTools = (services: ProfileServices) => [
  defineTool({
    name: 'update_my_profile',
    description: 'Update my name, description, or persona. I use the persona to shape my personality.',
    category: 'profile',
    platforms: ['admin-ui', 'api'],
    inputSchema: z.object({
      name: z.string().optional().describe('My display name'),
      description: z.string().optional().describe('A brief description of my purpose'),
      persona: z.string().optional().describe('My personality and communication style'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      if (!input.name && !input.description && !input.persona) {
        return { success: false, error: 'Provide at least one field to update' };
      }

      await services.updateProfile(context.avatarId, {
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
    platforms: ['admin-ui', 'api'],
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
        const uploadInfo = await services.getProfileUploadUrl(context.avatarId);
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

      const result = await services.setProfileImage(context.avatarId, sourceArg);

      if ('jobId' in result) {
        return {
          success: true,
          data: {
            jobId: result.jobId,
            status: result.status,
            message: 'Profile image generation started!',
          },
          pendingJob: {
            jobId: result.jobId,
            type: 'image',
            prompt: input.prompt || 'profile image',
            purpose: 'profile',
          },
        };
      }

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
      const uploadInfo = await services.getProfileUploadUrl(context.avatarId);

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

  defineTool({
    name: 'save_uploaded_profile_image',
    description: 'Save an already-uploaded image as my profile picture.',
    category: 'profile',
    platforms: ['admin-ui'],
    inputSchema: z.object({
      s3Key: z.string().describe('The S3 key of the uploaded image'),
      publicUrl: z.string().describe('The public URL of the uploaded image'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      await services.saveProfileImage(context.avatarId, input.s3Key, input.publicUrl);

      return {
        success: true,
        data: {
          message: 'Profile image saved!',
          url: input.publicUrl,
        },
      };
    },
  }),

  // Character Reference Tools - for full-body consistency in image/video generation
  defineTool({
    name: 'set_character_reference',
    description: 'Set my character reference image (full-body turnaround/model sheet) for consistent image and video generation. This is used instead of my profile image when generating full-body images.',
    category: 'profile',
    platforms: ['admin-ui', 'api'],
    inputSchema: z.object({
      source: z.enum(['url', 'gallery', 'generate', 'upload'])
        .describe('Where to get the character reference from'),
      url: z.string().optional().describe('URL of the image (when source=url)'),
      imageId: z.string().optional().describe('Gallery image ID (when source=gallery)'),
      prompt: z.string().optional().describe('Description for generating a character sheet (when source=generate)'),
      description: z.string().optional().describe('Description of the character reference (e.g., "blue furry creature, front/side/back view")'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      if (!services.setCharacterReference) {
        return { success: false, error: 'Character reference not supported in this environment' };
      }

      // Upload source returns a widget for the UI
      if (input.source === 'upload') {
        if (!services.getCharacterReferenceUploadUrl) {
          return { success: false, error: 'Character reference upload not supported' };
        }
        const uploadInfo = await services.getCharacterReferenceUploadUrl(context.avatarId);
        return {
          success: true,
          data: { ...uploadInfo, description: input.description },
          uiAction: {
            type: 'upload_widget',
            payload: { ...uploadInfo, purpose: 'character_reference' },
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

      let sourceArg: Parameters<NonNullable<typeof services.setCharacterReference>>[1];
      if (input.source === 'url') {
        sourceArg = { type: 'url', url: input.url! };
      } else if (input.source === 'gallery') {
        sourceArg = { type: 'gallery', imageId: input.imageId! };
      } else {
        sourceArg = { type: 'generate', prompt: input.prompt! };
      }

      const result = await services.setCharacterReference(context.avatarId, sourceArg, input.description);

      if ('jobId' in result) {
        return {
          success: true,
          data: {
            jobId: result.jobId,
            status: result.status,
            message: 'Character reference generation started! This will create a character sheet for consistent image generation.',
          },
          pendingJob: {
            jobId: result.jobId,
            type: 'image',
            prompt: input.prompt || 'character reference',
            purpose: 'character_reference',
          },
        };
      }

      return {
        success: true,
        data: {
          message: 'Character reference set! This will be used for full-body image and video generation.',
          url: result.url,
          description: input.description,
        },
      };
    },
  }),

  defineTool({
    name: 'get_character_reference_upload_url',
    description: 'Get a URL to upload a character reference image (turnaround/model sheet).',
    category: 'profile',
    platforms: ['admin-ui'],
    inputSchema: z.object({
      description: z.string().optional().describe('Description of the character reference'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      if (!services.getCharacterReferenceUploadUrl) {
        return { success: false, error: 'Character reference upload not supported' };
      }

      const uploadInfo = await services.getCharacterReferenceUploadUrl(context.avatarId);

      return {
        success: true,
        data: { ...uploadInfo, description: input.description },
        uiAction: {
          type: 'upload_widget',
          payload: { ...uploadInfo, purpose: 'character_reference', description: input.description },
        },
      };
    },
  }),

  defineTool({
    name: 'save_uploaded_character_reference',
    description: 'Save an already-uploaded image as my character reference.',
    category: 'profile',
    platforms: ['admin-ui'],
    inputSchema: z.object({
      s3Key: z.string().describe('The S3 key of the uploaded image'),
      publicUrl: z.string().describe('The public URL of the uploaded image'),
      description: z.string().optional().describe('Description of the character reference'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      if (!services.saveCharacterReference) {
        return { success: false, error: 'Character reference not supported' };
      }

      await services.saveCharacterReference(context.avatarId, input.s3Key, input.publicUrl, input.description);

      return {
        success: true,
        data: {
          message: 'Character reference saved! This will be used for full-body image and video generation.',
          url: input.publicUrl,
          description: input.description,
        },
      };
    },
  }),
];

export default createProfileTools;
