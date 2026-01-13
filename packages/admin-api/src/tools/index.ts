/**
 * Admin Tools Index
 *
 * Exports tool factories for the admin chat interface.
 * Tools are created with agent context using the factory pattern.
 */
export * from './schemas.js';

// Export individual tool creators
export * from './readonly.js';
export * from './models.js';
export * from './secrets.js';
export * from './profile.js';
export * from './media.js';
export * from './gallery.js';
export * from './features.js';

import type { Tool } from '@openrouter/sdk';
import type { UserSession } from '../types.js';

// Import all tool creators
import {
  getMyModelConfig,
  getMyWallets,
  getMySecrets,
  getPendingJobs,
  getJobStatus,
  getToolCredits,
} from './readonly.js';

import {
  listAvailableModels,
  changeMyModel,
  requestModelSelection,
} from './models.js';

import {
  requestSecret,
  storeSecret,
} from './secrets.js';

import {
  updateMyProfile,
  createSolanaWallet,
  getWalletBalance,
  setProfileImage,
  getProfileUploadUrl,
  saveUploadedProfileImage,
} from './profile.js';

import {
  generateImage,
  generateVideo,
  generateSticker,
} from './media.js';

import {
  getReferenceImageUploadUrl,
  saveReferenceImage,
  listReferenceImages,
  deleteReferenceImage,
  getMyGallery,
  searchGallery,
  sendGalleryImage,
} from './gallery.js';

import { requestFeatureToggle } from './features.js';

/**
 * Service dependencies for tool execution
 */
export interface ToolServices {
  // Agent data
  getAgentConfig: () => Promise<unknown>;
  updateAgentConfig: (updates: unknown) => Promise<void>;

  // Wallets
  listWallets: () => Promise<unknown[]>;
  createWallet: (name: string) => Promise<{ publicKey: string; address: string }>;
  getBalance: (publicKey: string) => Promise<{ sol: number; tokens: unknown[] }>;

  // Secrets
  listSecrets: () => Promise<unknown[]>;
  storeSecret: (
    agentId: string,
    secretType: string,
    name: string,
    value: string,
    session: UserSession,
    description?: string
  ) => Promise<void>;
  validateTelegramToken?: (value: string) => Promise<{ valid: boolean; username?: string; error?: string }>;

  // Media jobs
  listPendingJobs: () => Promise<unknown[]>;
  getJob: (jobId: string) => Promise<unknown>;
  getCredits: () => Promise<unknown>;

  // Profile
  updateProfile: (updates: { name?: string; description?: string; persona?: string }) => Promise<void>;
  getProfileUploadUrl: () => Promise<{ uploadUrl: string; s3Key: string; publicUrl: string }>;
  saveProfileImage: (s3Key: string, publicUrl: string) => Promise<void>;
  setProfileFromUrl: (url: string) => Promise<{ success: boolean; url: string }>;
  setProfileFromGallery: (imageId: string) => Promise<{ success: boolean; url: string }>;
  generateProfileImage: (prompt: string) => Promise<{ jobId: string; status: string }>;

  // Media generation
  generateImage: (params: {
    prompt: string;
    useProfileAsReference?: boolean;
    galleryImageIds?: string[];
    referenceImageId?: string;
    resolution?: string;
    aspectRatio?: string;
  }) => Promise<{ jobId: string; status: 'pending' | 'processing' | 'completed' | 'failed'; resultUrl?: string }>;
  generateVideo: (params: {
    prompt: string;
    useProfileAsReference?: boolean;
    referenceImageId?: string;
  }) => Promise<{ jobId: string; status: 'pending' | 'processing' | 'completed' | 'failed'; resultUrl?: string }>;
  generateSticker: (params: {
    prompt?: string;
    sourceImageId?: string;
  }) => Promise<{ jobId: string; status: 'pending' | 'processing' | 'completed' | 'failed'; resultUrl?: string }>;

  // Gallery
  listGallery: (type?: string, limit?: number) => Promise<Array<{
    id: string;
    type: string;
    url: string;
    prompt?: string;
    createdAt: number;
  }>>;
  searchGallery: (query: string, type?: string) => Promise<Array<{
    id: string;
    type: string;
    url: string;
    prompt?: string;
    createdAt: number;
  }>>;
  getGalleryItem: (imageId: string) => Promise<{
    id: string;
    type: string;
    url: string;
    prompt?: string;
    createdAt: number;
  } | null>;

  // Reference images
  getReferenceUploadUrl: (category: string, name: string, description?: string) => Promise<{
    uploadUrl: string;
    s3Key: string;
    publicUrl: string;
  }>;
  saveReferenceImage: (data: {
    s3Key: string;
    publicUrl: string;
    category: string;
    name: string;
    description?: string;
  }) => Promise<{ id: string }>;
  listReferenceImages: (category?: string) => Promise<Array<{
    id: string;
    category: string;
    name: string;
    url: string;
    description?: string;
  }>>;
  deleteReferenceImage: (imageId: string) => Promise<void>;

  // Models
  fetchModels: (family?: string) => Promise<Array<{
    id: string;
    name: string;
    pricing: { prompt: string; completion: string };
    context_length: number;
    top_provider?: { max_completion_tokens?: number };
  }>>;
  updateModelConfig: (config: { model?: string; temperature?: number; maxTokens?: number }) => Promise<void>;
}

/**
 * Create all agent tools with context
 *
 * @param agentId - The agent ID
 * @param session - The user session
 * @param services - Service dependencies
 * @returns Array of configured tools
 */
export function createAgentTools(
  agentId: string,
  session: UserSession,
  services: ToolServices
): Tool[] {
  return [
    // Manual tools (no execute function, return to UI)
    requestSecret,
    requestModelSelection,
    requestFeatureToggle,

    // Read-only tools
    getMyModelConfig(agentId, services.getAgentConfig),
    getMyWallets(agentId, services.listWallets),
    getMySecrets(agentId, services.listSecrets),
    getPendingJobs(agentId, services.listPendingJobs),
    getJobStatus(agentId, services.getJob),
    getToolCredits(agentId, services.getCredits),

    // Model management
    listAvailableModels(services.fetchModels),
    changeMyModel(agentId, services.updateModelConfig),

    // Secrets
    storeSecret(agentId, session, services.storeSecret, services.validateTelegramToken),

    // Profile
    updateMyProfile(agentId, session, services.updateProfile),
    createSolanaWallet(agentId, session, services.createWallet),
    getWalletBalance(services.getBalance),
    setProfileImage(agentId, {
      generate: services.generateProfileImage,
      fromUrl: services.setProfileFromUrl,
      fromGallery: services.setProfileFromGallery,
      getUploadUrl: services.getProfileUploadUrl,
    }),
    getProfileUploadUrl(services.getProfileUploadUrl),
    saveUploadedProfileImage(agentId, services.saveProfileImage),

    // Media generation
    generateImage(agentId, services.generateImage),
    generateVideo(agentId, services.generateVideo),
    generateSticker(agentId, services.generateSticker),

    // Gallery
    getMyGallery(agentId, services.listGallery),
    searchGallery(agentId, services.searchGallery),
    sendGalleryImage(agentId, services.getGalleryItem),

    // Reference images
    getReferenceImageUploadUrl(services.getReferenceUploadUrl),
    saveReferenceImage(agentId, services.saveReferenceImage),
    listReferenceImages(agentId, services.listReferenceImages),
    deleteReferenceImage(agentId, services.deleteReferenceImage),
  ];
}

/**
 * List of tool names that require user interaction (manual tools)
 * These should NOT be auto-executed
 */
export const MANUAL_TOOL_NAMES = [
  'request_secret',
  'request_model_selection',
  'request_feature_toggle',
] as const;

/**
 * List of tool names that return upload widgets
 * These pause the conversation for file upload
 */
export const UPLOAD_TOOL_NAMES = [
  'get_profile_upload_url',
  'get_reference_image_upload_url',
] as const;

/**
 * Check if a tool call should pause for user input
 */
export function isPauseForInputTool(toolName: string, args?: Record<string, unknown>): boolean {
  if (MANUAL_TOOL_NAMES.includes(toolName as typeof MANUAL_TOOL_NAMES[number])) {
    return true;
  }
  if (toolName === 'set_profile_image' && args?.source === 'upload') {
    return true;
  }
  if (UPLOAD_TOOL_NAMES.includes(toolName as typeof UPLOAD_TOOL_NAMES[number])) {
    return true;
  }
  return false;
}
