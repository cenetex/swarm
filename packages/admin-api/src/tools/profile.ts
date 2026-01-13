/**
 * Profile and wallet management tools
 */
import { tool } from '@openrouter/sdk';
import { z } from 'zod/v4';

import { ImageSourceSchema } from './schemas.js';
import type { UserSession } from '../types.js';

/**
 * Update agent profile
 */
export const updateMyProfile = (
  _agentId: string,
  _session: UserSession,
  updateProfile: (updates: { name?: string; description?: string; persona?: string }) => Promise<void>
) => tool({
  name: 'update_my_profile',
  description: 'Update my name, description, or persona',
  inputSchema: z.object({
    name: z.string().optional().describe('My display name'),
    description: z.string().optional().describe('Brief description of what I do'),
    persona: z.string().optional().describe('My personality/system prompt'),
  }),
  execute: async (params) => {
    if (!params.name && !params.description && !params.persona) {
      return { error: 'Please specify at least one field to update' };
    }
    await updateProfile(params);
    return {
      success: true,
      message: 'Profile updated',
      updated: Object.keys(params).filter(k => params[k as keyof typeof params]),
    };
  },
});

/**
 * Create a Solana wallet
 */
export const createSolanaWallet = (
  _agentId: string,
  _session: UserSession,
  createWallet: (name: string) => Promise<{ publicKey: string; address: string }>
) => tool({
  name: 'create_solana_wallet',
  description: 'Create a new Solana wallet for myself. The private key is stored securely.',
  inputSchema: z.object({
    name: z.string().describe('Name for the wallet (e.g., "main", "tips", "treasury")'),
  }),
  execute: async ({ name }) => {
    const wallet = await createWallet(name);
    return {
      success: true,
      message: `Wallet "${name}" created`,
      publicKey: wallet.publicKey,
      address: wallet.address,
    };
  },
});

/**
 * Get wallet balance
 */
export const getWalletBalance = (
  getBalance: (publicKey: string) => Promise<{ sol: number; tokens: unknown[] }>
) => tool({
  name: 'get_wallet_balance',
  description: 'Get the SOL balance and token balances for a specific wallet',
  inputSchema: z.object({
    publicKey: z.string().describe('The wallet public key/address'),
  }),
  execute: async ({ publicKey }) => {
    const balance = await getBalance(publicKey);
    return {
      publicKey,
      sol: balance.sol,
      tokens: balance.tokens,
    };
  },
});

/**
 * Set profile image (handles multiple sources)
 */
export const setProfileImage = (
  _agentId: string,
  handlers: {
    generate: (prompt: string) => Promise<{ jobId: string; status: string }>;
    fromUrl: (url: string) => Promise<{ success: boolean; url: string }>;
    fromGallery: (imageId: string) => Promise<{ success: boolean; url: string }>;
    getUploadUrl: () => Promise<{ uploadUrl: string; s3Key: string; publicUrl: string }>;
  }
) => tool({
  name: 'set_profile_image',
  description: 'Set my profile image. Can generate a new one, use a URL, select from gallery, or request the user to upload a file.',
  inputSchema: z.object({
    source: ImageSourceSchema.describe('How to set the profile image'),
    prompt: z.string().optional().describe('For generate: description of the profile image to create'),
    url: z.string().optional().describe('For url: the image URL to use'),
    imageId: z.string().optional().describe('For gallery: ID of an image from my gallery'),
  }),
  execute: async (params) => {
    switch (params.source) {
      case 'generate':
        if (!params.prompt) {
          return { error: 'prompt is required for generate source' };
        }
        return handlers.generate(params.prompt);

      case 'url':
        if (!params.url) {
          return { error: 'url is required for url source' };
        }
        return handlers.fromUrl(params.url);

      case 'gallery':
        if (!params.imageId) {
          return { error: 'imageId is required for gallery source' };
        }
        return handlers.fromGallery(params.imageId);

      case 'upload': {
        // Returns upload widget info - UI will show file picker
        const uploadInfo = await handlers.getUploadUrl();
        return {
          type: 'upload_widget',
          ...uploadInfo,
          purpose: 'profile',
        };
      }

      default:
        return { error: 'Invalid source type' };
    }
  },
});

/**
 * Set character reference image (full-body reference)
 */
export const setCharacterReference = (
  _agentId: string,
  handlers: {
    generate: (prompt: string, description?: string) => Promise<{ url: string; s3Key: string }>;
    fromUrl: (url: string, description?: string) => Promise<{ url: string; s3Key: string }>;
    fromGallery: (imageId: string, description?: string) => Promise<{ url: string; s3Key: string }>;
    getUploadUrl: () => Promise<{ uploadUrl: string; s3Key: string; publicUrl: string }>;
  }
) => tool({
  name: 'set_character_reference',
  description: 'Set my character reference image (full-body turnaround/model sheet) for consistent image and video generation.',
  inputSchema: z.object({
    source: ImageSourceSchema.describe('Where to get the character reference image'),
    prompt: z.string().optional().describe('For generate: description of the character reference to create'),
    url: z.string().optional().describe('For url: the image URL to use'),
    imageId: z.string().optional().describe('For gallery: ID of an image from my gallery'),
    description: z.string().optional().describe('Optional description of the character reference'),
  }),
  execute: async (params) => {
    switch (params.source) {
      case 'generate':
        if (!params.prompt) {
          return { error: 'prompt is required for generate source' };
        }
        return {
          ...(await handlers.generate(params.prompt, params.description)),
          message: 'Character reference generated and saved.',
          description: params.description,
        };

      case 'url':
        if (!params.url) {
          return { error: 'url is required for url source' };
        }
        return {
          ...(await handlers.fromUrl(params.url, params.description)),
          message: 'Character reference updated from URL.',
          description: params.description,
        };

      case 'gallery':
        if (!params.imageId) {
          return { error: 'imageId is required for gallery source' };
        }
        return {
          ...(await handlers.fromGallery(params.imageId, params.description)),
          message: 'Character reference updated from gallery.',
          description: params.description,
        };

      case 'upload': {
        const uploadInfo = await handlers.getUploadUrl();
        return {
          type: 'upload_widget',
          ...uploadInfo,
          purpose: 'character_reference',
          description: params.description,
        };
      }

      default:
        return { error: 'Invalid source type' };
    }
  },
});

/**
 * Get profile upload URL (alternative to set_profile_image with upload)
 */
export const getProfileUploadUrl = (
  getUploadUrl: () => Promise<{ uploadUrl: string; s3Key: string; publicUrl: string }>
) => tool({
  name: 'get_profile_upload_url',
  description: 'Get a signed URL for the user to upload a profile image directly. Prefer using set_profile_image with source="upload" instead.',
  inputSchema: z.object({}),
  execute: async () => {
    const info = await getUploadUrl();
    return {
      type: 'upload_widget',
      ...info,
      purpose: 'profile',
    };
  },
});

/**
 * Get character reference upload URL
 */
export const getCharacterReferenceUploadUrl = (
  getUploadUrl: () => Promise<{ uploadUrl: string; s3Key: string; publicUrl: string }>
) => tool({
  name: 'get_character_reference_upload_url',
  description: 'Get a signed URL for the user to upload a character reference image (turnaround/model sheet).',
  inputSchema: z.object({
    description: z.string().optional().describe('Optional description of the character reference'),
  }),
  execute: async ({ description }) => {
    const info = await getUploadUrl();
    return {
      type: 'upload_widget',
      ...info,
      purpose: 'character_reference',
      description,
    };
  },
});

/**
 * Save an uploaded profile image
 */
export const saveUploadedProfileImage = (
  _agentId: string,
  saveProfile: (s3Key: string, publicUrl: string) => Promise<void>
) => tool({
  name: 'save_uploaded_profile_image',
  description: 'Save an already-uploaded image as my profile picture. Use this after the user has uploaded an image via the upload widget.',
  inputSchema: z.object({
    s3Key: z.string().describe('The S3 key of the uploaded image'),
    publicUrl: z.string().describe('The public URL of the uploaded image'),
  }),
  execute: async ({ s3Key, publicUrl }) => {
    await saveProfile(s3Key, publicUrl);
    return {
      success: true,
      message: 'Profile image saved',
      url: publicUrl,
    };
  },
});

/**
 * Save an uploaded character reference image
 */
export const saveUploadedCharacterReference = (
  _agentId: string,
  saveReference: (s3Key: string, publicUrl: string, description?: string) => Promise<void>
) => tool({
  name: 'save_uploaded_character_reference',
  description: 'Save an already-uploaded image as my character reference.',
  inputSchema: z.object({
    s3Key: z.string().describe('The S3 key of the uploaded image'),
    publicUrl: z.string().describe('The public URL of the uploaded image'),
    description: z.string().optional().describe('Optional description of the character reference'),
  }),
  execute: async ({ s3Key, publicUrl, description }) => {
    await saveReference(s3Key, publicUrl, description);
    return {
      success: true,
      message: 'Character reference saved',
      url: publicUrl,
      description,
    };
  },
});
