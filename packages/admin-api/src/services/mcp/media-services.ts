/**
 * MCP Media Services
 *
 * Service implementations for media generation, credits, gallery,
 * reference images, stickers, and media model discovery.
 */
import type { AllServices } from '@swarm/mcp-server';
import type { UserSession } from '../../types.js';
import type { ServiceContainer } from '../service-container.js';
import { searchReplicateModels } from '../replicate-schema.js';
import { DEFAULT_MODELS } from '../models-registry.js';
import { searchOpenRouterModels } from '../openrouter-models.js';

type MediaServices = Pick<
  AllServices,
  'media' | 'mediaCredits' | 'jobCredits' | 'gallery' | 'reference' | 'stickers' | 'mediaModels'
>;

/**
 * Create media-related MCP services for a specific avatar.
 */
export function createMediaServices(
  avatarId: string,
  session: UserSession,
  svc: ServiceContainer,
): MediaServices {
  const { avatars, media, gallery, credits, integrations } = svc;

  return {
    // =========================================================================
    // Media Services
    // =========================================================================
    media: {
      generateImage: async (params) => {
        const job = await media.generateImageAsync({
          prompt: params.prompt,
          avatarId: params.avatarId,
          platform: params.platform,
          referenceImageUrls: params.referenceImageUrls,
          resolution: params.resolution as '1K' | '2K' | '4K' | undefined,
          aspectRatio: params.aspectRatio as '1:1' | '2:3' | '3:2' | '3:4' | '4:3' | '4:5' | '5:4' | '9:16' | '16:9' | '21:9' | undefined,
          conversationId: params.conversationId || `admin-ui-${Date.now()}`,
          replyToMessageId: params.replyToMessageId,
        });
        if (job.status === 'completed' && job.resultUrl) {
          return {
            id: job.resultS3Key?.split('/').pop()?.split('.')[0] || job.jobId,
            url: job.resultUrl,
          };
        }
        return { jobId: job.jobId, status: job.status };
      },

      generateVideo: async (params) => {
        const result = await media.generateVideo({
          prompt: params.prompt,
          avatarId: params.avatarId,
          platform: params.platform,
          referenceImageUrl: params.referenceImageUrl,
          conversationId: params.conversationId || `mcp-${Date.now()}`,
          replyToMessageId: params.replyToMessageId,
        });
        return { jobId: result.jobId, status: result.status };
      },

      generateSticker: async (params) => {
        const result = await media.generateSticker({
          prompt: params.prompt || 'sticker',
          avatarId: params.avatarId,
          sourceImageId: params.sourceImageId,
        });
        return { id: result.id, url: result.url };
      },

      getProfileImageUrl: async (avatarId) => {
        const avatar = await avatars.getAvatar(avatarId);
        return avatar?.profileImage?.url;
      },

      getReferenceImageUrl: async (avatarId, category) => {
        const images = await media.listReferenceImages(avatarId);
        const found = images.find(img => img.category === category);
        return found?.url;
      },

      getCharacterReferenceUrl: async (avatarId) => {
        const avatar = await avatars.getAvatar(avatarId);
        return avatar?.characterReference?.url;
      },

      getBestReferenceImageUrl: async (avatarId) => {
        return media.getBestReferenceImageUrl(avatarId);
      },
    },

    // =========================================================================
    // Media Credits
    // =========================================================================
    mediaCredits: {
      canUseTool: async (avatarId, tool) => {
        const result = await credits.canUseTool(avatarId, tool);
        return { allowed: result.allowed, reason: result.reason };
      },
      consumeCredit: async (avatarId, tool) => {
        return credits.consumeCredit(avatarId, tool);
      },
    },

    // =========================================================================
    // Job Credits (same as media credits for now)
    // =========================================================================
    jobCredits: {
      getToolStatus: async (avatarId) => {
        const status = await credits.getToolStatusStructured(avatarId);
        return status;
      },
      getEnergyStatus: async (avatarId) => {
        return credits.getEnergyStatus(avatarId);
      },
    },

    // =========================================================================
    // Gallery Services
    // =========================================================================
    gallery: {
      getGallery: async (avatarId, options) => {
        const items = await gallery.getGallery(avatarId, {
          type: options.type,
          limit: options.limit,
        });
        return items.map(item => ({
          id: item.id,
          type: item.type as 'image' | 'video' | 'sticker',
          url: item.url,
          prompt: item.prompt,
          createdAt: item.createdAt,
        }));
      },

      getGalleryItem: async (avatarId, itemId) => {
        const item = await gallery.getGalleryItem(avatarId, itemId);
        if (!item) return null;
        return {
          id: item.id,
          type: item.type as 'image' | 'video' | 'sticker',
          url: item.url,
          prompt: item.prompt,
          createdAt: item.createdAt,
        };
      },

      searchGallery: async (avatarId, query, type) => {
        const items = await gallery.findByDescription(avatarId, query, type);
        return items.map(item => ({
          id: item.id,
          type: item.type as 'image' | 'video' | 'sticker',
          url: item.url,
          prompt: item.prompt,
          createdAt: item.createdAt,
        }));
      },

      getUploadUrl: async (avatarId, contentType) => {
        return media.getGalleryUploadUrl(avatarId, contentType);
      },

      saveUploadedPhoto: async (avatarId, data) => {
        const id = gallery.generateGalleryId();
        await gallery.addToGallery(avatarId, {
          id,
          type: 'image',
          url: data.publicUrl,
          s3Key: data.s3Key,
          prompt: '',
          caption: data.caption || '',
          model: 'upload',
          platform: 'admin-ui',
        });
        return { id };
      },
    },

    // =========================================================================
    // Reference Image Services
    // =========================================================================
    reference: {
      getUploadUrl: async (avatarId, category, name, _description) => {
        return media.getReferenceImageUploadUrl(avatarId, category, name);
      },

      saveReferenceImage: async (avatarId, data) => {
        const result = await media.saveReferenceImage(
          avatarId,
          data.category,
          data.s3Key,
          data.publicUrl,
          data.name,
          data.description
        );
        return { id: result.id };
      },

      listReferenceImages: async (avatarId, category) => {
        const images = await media.listReferenceImages(avatarId, category);
        return images.map(img => ({
          id: img.id,
          category: img.category as 'profile' | 'character' | 'style' | 'background' | 'other',
          name: img.name,
          url: img.url,
          description: img.description,
          createdAt: img.createdAt || Date.now(),
        }));
      },

      deleteReferenceImage: async (avatarId, imageId) => {
        await media.deleteReferenceImage(avatarId, imageId);
      },
    },

    // =========================================================================
    // Sticker Services
    // =========================================================================
    stickers: svc.createStickerServices(),

    // =========================================================================
    // Media Model Discovery & Configuration
    // =========================================================================
    mediaModels: {
      browseMediaModels: async (query, capability, provider = 'openrouter') => {
        if (provider === 'openrouter') {
          let apiKey: string | undefined;
          try {
            apiKey = await media.getProviderApiKey(avatarId, 'openrouter') ?? undefined;
          } catch {
            apiKey = process.env.OPENROUTER_API_KEY;
          }

          const results = await searchOpenRouterModels(query, { capability, apiKey });
          return results.map(r => ({
            id: r.id,
            name: r.name,
            description: r.description,
            runCount: 0,
          }));
        }

        let apiKey: string | undefined;
        try {
          apiKey = await media.getProviderApiKey(avatarId, 'replicate') ?? undefined;
        } catch {
          apiKey = process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY;
        }
        if (!apiKey) {
          throw new Error('No Replicate API key available for model search. Configure a Replicate key first.');
        }

        const searchQuery = capability === 'video'
          ? `${query} video generation`
          : `${query} image generation`;

        const { results } = await searchReplicateModels(searchQuery, apiKey);

        return results.map(r => ({
          id: `${r.owner}/${r.name}`,
          name: r.name,
          description: r.description || '',
          runCount: r.run_count || 0,
          coverImageUrl: r.cover_image_url,
        }));
      },

      setMediaModel: async (targetAvatarId, capability, modelId, provider = 'openrouter') => {
        await integrations.setModelPreference(
          targetAvatarId,
          provider,
          capability,
          modelId,
          session,
        );
      },

      getMediaModel: async (targetAvatarId, capability, provider = 'openrouter') => {
        const model = await integrations.getConfiguredModel(targetAvatarId, capability, provider);
        return {
          model: model || DEFAULT_MODELS[capability],
          provider,
        };
      },
    },
  };
}
