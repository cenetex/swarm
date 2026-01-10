/**
 * Profile and wallet management tools
 */
import { z } from 'zod';
import { defineTool } from './tool-helper.js';
import { ImageSourceSchema } from './schemas.js';
import type { UserSession } from '../types.js';

/**
 * Update agent profile
 */
export const updateMyProfile = (
  _agentId: string,
  _session: UserSession,
  updateProfile: (updates: { name?: string; description?: string; persona?: string }) => Promise<void>
) => defineTool({
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
) => defineTool({
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
) => defineTool({
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
) => defineTool({
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
    }
  },
});

/**
 * Get profile upload URL (alternative to set_profile_image with upload)
 */
export const getProfileUploadUrl = (
  getUploadUrl: () => Promise<{ uploadUrl: string; s3Key: string; publicUrl: string }>
) => defineTool({
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
 * Save an uploaded profile image
 */
export const saveUploadedProfileImage = (
  _agentId: string,
  saveProfile: (s3Key: string, publicUrl: string) => Promise<void>
) => defineTool({
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
