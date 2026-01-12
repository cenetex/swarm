/**
 * Platform MCP Services Adapter
 * 
 * Bridges core services to MCP tool interfaces for platform handlers.
 * This is the production equivalent of admin-api's mcp-adapter.ts,
 * designed for use in Lambda handlers processing Telegram/Discord/Twitter messages.
 */
import type { AllServices } from '@swarm/mcp-server';
import type {
  AgentConfig,
  StateService,
  MediaService,
} from '@swarm/core';
import { createVoiceServices } from './voice.js';

export interface PlatformServicesConfig {
  agentId: string;
  agentConfig: AgentConfig;
  stateService: StateService;
  mediaService?: MediaService;
  secrets: Record<string, string>;
  wallets?: Array<{ name: string; publicKey: string; walletType: 'solana' | 'ethereum' }>;
  mediaBucket?: string;
  cdnUrl?: string;
}

/**
 * Create MCP-compatible services for platform handlers
 * 
 * This is a lighter-weight adapter than admin-api's version since
 * platform handlers don't need all admin features (secrets management,
 * agent CRUD, etc.)
 */
export function createPlatformMCPServices(config: PlatformServicesConfig): AllServices {
  const { agentId, agentConfig, stateService, mediaService, wallets } = config;
  const voiceServices = createVoiceServices({
    agentId,
    secrets: config.secrets,
    voiceConfig: agentConfig.voice,
    mediaBucket: config.mediaBucket,
    cdnUrl: config.cdnUrl,
  });

  return {
    // =========================================================================
    // Media Services
    // =========================================================================
    media: {
      generateImage: async (params) => {
        if (!mediaService) {
          throw new Error('Media service not configured');
        }
        const result = await mediaService.generateImage(params.prompt, agentConfig.media.image);
        return { id: result.s3Key || 'generated', url: result.url };
      },

      generateVideo: async (params) => {
        if (!mediaService || !agentConfig.media.video) {
          throw new Error('Video generation not configured');
        }
        const result = await mediaService.generateVideo(params.prompt, agentConfig.media.video);
        return { jobId: result.s3Key || `video-${Date.now()}`, status: 'processing' };
      },

      generateSticker: async (params) => {
        if (!mediaService) {
          throw new Error('Media service not configured');
        }
        const stickerPrompt = `sticker style, ${params.prompt || 'cute character'}, white background, simple design`;
        const result = await mediaService.generateImage(stickerPrompt, agentConfig.media.image);
        return { id: result.s3Key || 'sticker', url: result.url };
      },

      getProfileImageUrl: async () => undefined,
      getReferenceImageUrl: async () => undefined,
      getCharacterReferenceUrl: async () => undefined,
      getBestReferenceImageUrl: async () => undefined,
    },

    // =========================================================================
    // Media Credits (no-op for platform - credits managed separately)
    // =========================================================================
    mediaCredits: {
      canUseTool: async () => ({ allowed: true }),
      consumeCredit: async () => true,
    },

    // =========================================================================
    // Job Credits (no-op for platform)
    // =========================================================================
    jobCredits: {
      getToolStatus: async () => ({
        generate_image: { used: 0, limit: 100, remaining: 100 },
        generate_video: { used: 0, limit: 10, remaining: 10 },
        generate_sticker: { used: 0, limit: 50, remaining: 50 },
      }),
    },

    // =========================================================================
    // Gallery Services (simplified for platform)
    // =========================================================================
    gallery: {
      getGallery: async () => [],
      getGalleryItem: async () => null,
      searchGallery: async () => [],
    },

    // =========================================================================
    // Wallet Services
    // =========================================================================
    wallets: {
      listWallets: async () => {
        if (!wallets) return [];
        return wallets
          .filter(w => w.walletType === 'solana')
          .map(w => ({
            name: w.name,
            publicKey: w.publicKey,
            walletType: 'solana' as const,
            solBalance: 0,
          }));
      },

      createWallet: async () => {
        throw new Error('Wallet creation not allowed from platform handlers');
      },

      getBalance: async () => ({
        solBalance: 0,
        solBalanceLamports: 0,
        tokens: [],
      }),
    },

    // =========================================================================
    // Model Services (read-only for platform)
    // =========================================================================
    models: {
      listModels: async () => [],
      getConfig: async () => ({
        model: agentConfig.llm.model,
        provider: agentConfig.llm.provider,
        temperature: agentConfig.llm.temperature,
        maxTokens: agentConfig.llm.maxTokens,
      }),
      updateConfig: async () => {
        throw new Error('Model changes not allowed from platform handlers');
      },
    },

    // =========================================================================
    // Profile Services (read-only for platform)
    // =========================================================================
    profile: {
      getProfile: async () => ({
        name: agentConfig.name,
        persona: agentConfig.persona,
      }),
      updateProfile: async () => {
        throw new Error('Profile updates not allowed from platform handlers');
      },
      setProfileImage: async () => {
        throw new Error('Profile uploads not allowed from platform handlers');
      },
      getProfileUploadUrl: async () => {
        throw new Error('Profile uploads not allowed from platform handlers');
      },
      saveProfileImage: async () => {
        throw new Error('Profile uploads not allowed from platform handlers');
      },
    },

    // =========================================================================
    // Secrets Services (no access from platform)
    // =========================================================================
    secrets: {
      listSecrets: async () => [],
      storeSecret: async () => {
        throw new Error('Secret management not allowed from platform handlers');
      },
      validateTelegramToken: async (token: string) => {
        return { valid: !!token, error: token ? undefined : 'No token' };
      },
    },

    // =========================================================================
    // Jobs Services (simplified for platform)
    // =========================================================================
    jobs: {
      getPendingJobs: async () => [],
      getJob: async () => null,
    },

    // =========================================================================
    // Reference Images (not available from platform)
    // =========================================================================
    reference: {
      listReferenceImages: async () => [],
      getUploadUrl: async () => {
        throw new Error('Reference uploads not allowed from platform handlers');
      },
      saveReferenceImage: async () => {
        throw new Error('Reference uploads not allowed from platform handlers');
      },
      deleteReferenceImage: async () => {
        throw new Error('Reference deletes not allowed from platform handlers');
      },
    },

    // =========================================================================
    // Memory Services (wired to state service!)
    // =========================================================================
    memory: {
      remember: async (fact: string, about?: string, userId?: string) => {
        await stateService.saveFact(agentId, {
          fact,
          about,
          userId,
          timestamp: Date.now(),
        });
        return { saved: true };
      },

      recall: async (query: string, userId?: string) => {
        const facts = await stateService.getFacts(agentId, query, userId);
        return { facts };
      },
    },

    // =========================================================================
    // Voice Services
    // =========================================================================
    voice: voiceServices,
  };
}
