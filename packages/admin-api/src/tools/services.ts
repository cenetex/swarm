/**
 * Tool service adapter for admin chat tools
 */
import type { UserSession } from '../types.js';
import type { ToolServices } from './index.js';
import * as agents from '../services/agents.js';
import * as wallets from '../services/wallets.js';
import * as secrets from '../services/secrets.js';
import * as telegram from '../services/telegram.js';
import * as twitterOAuth from '../services/twitter-oauth.js';
import * as media from '../services/media.js';
import * as gallery from '../services/gallery.js';
import * as credits from '../services/credits.js';
import * as mediaJobs from '../services/media-jobs.js';
import type { SecretType } from '../types.js';

const API_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getReferenceImageUrl(agentId: string, referenceImageId?: string): Promise<string | undefined> {
  if (!referenceImageId) return undefined;
  const images = await media.listReferenceImages(agentId);
  return images.find(img => img.id === referenceImageId)?.url;
}

async function getGalleryImageUrls(agentId: string, imageIds?: string[]): Promise<string[]> {
  if (!imageIds || imageIds.length === 0) return [];
  const items = await Promise.all(
    imageIds.map(imageId => gallery.getGalleryItem(agentId, imageId))
  );
  return items.filter(Boolean).map(item => (item as { url: string }).url);
}

export function createToolServices(agentId: string, session: UserSession): ToolServices {
  return {
    getAgentConfig: async () => agents.getAgent(agentId),
    updateAgentConfig: async (updates: unknown) => {
      await agents.updateAgent(agentId, updates as Parameters<typeof agents.updateAgent>[1], session);
    },

    listWallets: async () => wallets.listWallets(agentId),
    createWallet: async (name: string) => {
      const result = await wallets.generateSolanaWallet(agentId, name, session);
      return { publicKey: result.publicKey, address: result.address };
    },
    getBalance: async (publicKey: string) => {
      const balance = await wallets.getSolanaBalance(publicKey, agentId);
      return { sol: balance.solBalance, tokens: balance.tokens };
    },

    listSecrets: async () => secrets.listSecrets(agentId),
    storeSecret: async (agentIdParam, secretType, name, value, sessionParam, description) => {
      await secrets.storeSecret(
        agentIdParam,
        secretType as SecretType,
        name,
        value,
        sessionParam,
        description
      );
    },
    validateTelegramToken: telegram.validateTelegramToken,

    getTwitterConnectionStatus: async () => twitterOAuth.getConnectionStatus(agentId),

    listPendingJobs: async () => mediaJobs.getPendingJobs(agentId),
    getJob: async (jobId: string) => mediaJobs.getJob(jobId),
    getCredits: async () => credits.getToolStatusStructured(agentId),

    updateProfile: async (updates) => {
      await agents.updateAgent(agentId, updates, session);
    },
    getProfileUploadUrl: async () => media.getProfileImageUploadUrl(agentId),
    saveProfileImage: async (s3Key: string, publicUrl: string) => {
      await agents.updateAgent(agentId, {
        profileImage: { url: publicUrl, s3Key, updatedAt: Date.now() },
      }, session);
    },
    setProfileFromUrl: async (url: string) => {
      const result = await media.setProfileImage(agentId, { type: 'url', url });
      await agents.updateAgent(agentId, {
        profileImage: { url: result.url, s3Key: result.s3Key, updatedAt: Date.now() },
      }, session);
      return { success: true, url: result.url };
    },
    setProfileFromGallery: async (imageId: string) => {
      const result = await media.setProfileImage(agentId, { type: 'gallery', imageId });
      await agents.updateAgent(agentId, {
        profileImage: { url: result.url, s3Key: result.s3Key, updatedAt: Date.now() },
      }, session);
      return { success: true, url: result.url };
    },
    generateProfileImage: async (prompt: string) => {
      const job = await media.generateProfileImageAsync(agentId, prompt);
      return { jobId: job.jobId, status: job.status };
    },

    generateImage: async (params) => {
      const referenceUrls: string[] = [];
      if (params.useProfileAsReference !== false) {
        const best = await media.getBestReferenceImageUrl(agentId);
        if (best) referenceUrls.push(best);
      }

      referenceUrls.push(...await getGalleryImageUrls(agentId, params.galleryImageIds));

      const referenceImageUrl = await getReferenceImageUrl(agentId, params.referenceImageId);
      if (referenceImageUrl) referenceUrls.push(referenceImageUrl);

      const job = await media.generateImageAsync({
        prompt: params.prompt,
        agentId,
        platform: 'admin-ui',
        referenceImageUrls: referenceUrls,
        resolution: params.resolution as '1K' | '2K' | '4K' | undefined,
        aspectRatio: params.aspectRatio as '1:1' | '2:3' | '3:2' | '3:4' | '4:3' | '4:5' | '5:4' | '9:16' | '16:9' | '21:9' | undefined,
        conversationId: `admin-ui-${Date.now()}`,
      });
      return { jobId: job.jobId, status: job.status };
    },
    generateVideo: async (params) => {
      const referenceImageUrl = params.referenceImageId
        ? await getReferenceImageUrl(agentId, params.referenceImageId)
        : params.useProfileAsReference === false
          ? undefined
          : await media.getBestReferenceImageUrl(agentId);

      const job = await media.generateVideo({
        prompt: params.prompt,
        agentId,
        platform: 'admin-ui',
        referenceImageUrl,
        conversationId: `admin-ui-${Date.now()}`,
      });
      return { jobId: job.jobId, status: job.status };
    },
    generateSticker: async (params) => {
      const item = await media.generateSticker({
        prompt: params.prompt || 'sticker',
        agentId,
        platform: 'admin-ui',
        sourceImageId: params.sourceImageId,
      });
      return { jobId: item.id, status: 'completed', resultUrl: item.url };
    },

    listGallery: async (type, limit) => {
      const items = await gallery.getGallery(agentId, { type: type as 'image' | 'video' | 'sticker' | undefined, limit });
      return items.map(item => ({
        id: item.id,
        type: item.type,
        url: item.url,
        prompt: item.prompt,
        createdAt: item.createdAt,
      }));
    },
    searchGallery: async (query, type) => {
      const items = await gallery.findByDescription(agentId, query, type as 'image' | 'video' | 'sticker' | undefined);
      return items.map(item => ({
        id: item.id,
        type: item.type,
        url: item.url,
        prompt: item.prompt,
        createdAt: item.createdAt,
      }));
    },
    getGalleryItem: async (imageId) => {
      const item = await gallery.getGalleryItem(agentId, imageId);
      if (!item) return null;
      return {
        id: item.id,
        type: item.type,
        url: item.url,
        prompt: item.prompt,
        createdAt: item.createdAt,
      };
    },

    getReferenceUploadUrl: async (category, name, description) => {
      void description;
      return media.getReferenceImageUploadUrl(agentId, category as media.ReferenceImageCategory, name);
    },
    saveReferenceImage: async (data) => {
      const saved = await media.saveReferenceImage(
        agentId,
        data.category as media.ReferenceImageCategory,
        data.s3Key,
        data.publicUrl,
        data.name,
        data.description
      );
      return { id: saved.id };
    },
    listReferenceImages: async (category) => {
      const items = await media.listReferenceImages(agentId, category as media.ReferenceImageCategory | undefined);
      return items.map(item => ({
        id: item.id,
        category: item.category,
        name: item.name,
        url: item.url,
        description: item.description,
      }));
    },
    deleteReferenceImage: async (imageId) => {
      await media.deleteReferenceImage(agentId, imageId);
    },

    fetchModels: async (family?: string) => {
      const response = await fetchWithTimeout(
        'https://openrouter.ai/api/v1/models',
        { headers: { 'Content-Type': 'application/json' } },
        API_TIMEOUT_MS
      );

      if (!response.ok) return [];

      const data = await response.json() as {
        data: Array<{
          id: string;
          name: string;
          context_length: number;
          pricing?: { prompt: string; completion: string };
          architecture?: { modality?: string };
          top_provider?: { max_completion_tokens?: number };
        }>;
      };

      let models = data.data || [];
      models = models.filter(m => (m.architecture?.modality || '').includes('text'));

      if (family) {
        const normalized = family.toLowerCase();
        models = models.filter(m => m.id.toLowerCase().startsWith(`${normalized}/`) || m.id.toLowerCase().includes(`/${normalized}`));
      }

      models.sort((a, b) => {
        const providerA = a.id.split('/')[0] || '';
        const providerB = b.id.split('/')[0] || '';
        if (providerA !== providerB) return providerA.localeCompare(providerB);
        return a.name.localeCompare(b.name);
      });

      return models.map(m => ({
        id: m.id,
        name: m.name,
        pricing: m.pricing ? {
          prompt: m.pricing.prompt,
          completion: m.pricing.completion,
        } : { prompt: '0', completion: '0' },
        context_length: m.context_length,
        top_provider: m.top_provider,
      }));
    },
    updateModelConfig: async (config) => {
      const agent = await agents.getAgent(agentId);
      const current = agent?.llmConfig || {
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4',
        temperature: 0.8,
        maxTokens: 1024,
        useGlobalKey: true,
      };
      await agents.updateAgent(agentId, {
        llmConfig: {
          provider: current.provider || 'openrouter',
          model: config.model ?? current.model,
          temperature: config.temperature ?? current.temperature,
          maxTokens: config.maxTokens ?? current.maxTokens,
          useGlobalKey: current.useGlobalKey ?? true,
        },
      }, session);
    },
  };
}
