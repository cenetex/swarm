/**
 * MCP Service Adapter
 * 
 * Bridges existing admin-api services to MCP server service interfaces.
 * This allows the unified tool definitions to work with our current infrastructure.
 */
import type { AllServices } from '@swarm/mcp-server';
import type { UserSession, SecretType } from '../types.js';
import * as agents from '../services/agents.js';
import * as secrets from '../services/secrets.js';
import * as wallets from '../services/wallets.js';
import * as telegram from '../services/telegram.js';
import * as media from '../services/media.js';
import * as gallery from '../services/gallery.js';
import * as credits from '../services/credits.js';
import * as mediaJobs from '../services/media-jobs.js';

// Timeout for external API calls
const API_TIMEOUT_MS = 10_000;

/**
 * Fetch with timeout using AbortController
 */
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

/**
 * Create MCP-compatible services for a specific agent
 */
export function createMCPServices(_agentId: string, session: UserSession): AllServices {
  return {
    // =========================================================================
    // Media Services
    // =========================================================================
    media: {
      generateImage: async (params) => {
        const result = await media.generateImage({
          prompt: params.prompt,
          agentId: params.agentId,
          platform: params.platform,
          referenceImageUrls: params.referenceImageUrls,
          resolution: params.resolution as '1K' | '2K' | '4K' | undefined,
          aspectRatio: params.aspectRatio as '1:1' | '2:3' | '3:2' | '3:4' | '4:3' | '4:5' | '5:4' | '9:16' | '16:9' | '21:9' | undefined,
        });
        return { id: result.id, url: result.url };
      },

      generateVideo: async (params) => {
        const result = await media.generateVideo({
          prompt: params.prompt,
          agentId: params.agentId,
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
          agentId: params.agentId,
          sourceImageId: params.sourceImageId,
        });
        return { id: result.id, url: result.url };
      },

      getProfileImageUrl: async (agentId) => {
        const agent = await agents.getAgent(agentId);
        return agent?.profileImage?.url;
      },

      getReferenceImageUrl: async (agentId, category) => {
        const images = await media.listReferenceImages(agentId);
        const found = images.find(img => img.category === category);
        return found?.url;
      },
    },

    // =========================================================================
    // Media Credits
    // =========================================================================
    mediaCredits: {
      canUseTool: async (agentId, tool) => {
        const result = await credits.canUseTool(agentId, tool);
        return { allowed: result.allowed, reason: result.reason };
      },
      consumeCredit: async (agentId, tool) => {
        return credits.consumeCredit(agentId, tool);
      },
    },

    // =========================================================================
    // Job Credits (same as media credits for now)
    // =========================================================================
    jobCredits: {
      getToolStatus: async (agentId) => {
        // Return structured credit data
        const status = await credits.getToolStatusStructured(agentId);
        return status;
      },
    },

    // =========================================================================
    // Gallery Services
    // =========================================================================
    gallery: {
      getGallery: async (agentId, options) => {
        const items = await gallery.getGallery(agentId, {
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

      getGalleryItem: async (agentId, itemId) => {
        const item = await gallery.getGalleryItem(agentId, itemId);
        if (!item) return null;
        return {
          id: item.id,
          type: item.type as 'image' | 'video' | 'sticker',
          url: item.url,
          prompt: item.prompt,
          createdAt: item.createdAt,
        };
      },

      searchGallery: async (agentId, query, type) => {
        const items = await gallery.findByDescription(agentId, query, type);
        return items.map(item => ({
          id: item.id,
          type: item.type as 'image' | 'video' | 'sticker',
          url: item.url,
          prompt: item.prompt,
          createdAt: item.createdAt,
        }));
      },
    },

    // =========================================================================
    // Wallet Services
    // =========================================================================
    wallets: {
      listWallets: async (agentId) => {
        const walletList = await wallets.listWallets(agentId);
        return Promise.all(
          walletList
            .filter(w => w.walletType === 'solana')
            .map(async (w) => {
              try {
                const balance = await wallets.getSolanaBalance(w.publicKey, agentId);
                return {
                  name: w.name,
                  publicKey: w.publicKey,
                  walletType: 'solana' as const,
                  solBalance: balance.solBalance || 0,
                };
              } catch {
                return {
                  name: w.name,
                  publicKey: w.publicKey,
                  walletType: 'solana' as const,
                  solBalance: 0,
                };
              }
            })
        );
      },

      createWallet: async (agentId, name) => {
        const result = await wallets.generateSolanaWallet(agentId, name, session);
        return { publicKey: result.publicKey, address: result.address };
      },

      getBalance: async (publicKey, agentId) => {
        const balance = await wallets.getSolanaBalance(publicKey, agentId);
        return {
          solBalance: balance.solBalance || 0,
          solBalanceLamports: balance.solBalanceLamports,
          tokens: (balance as { tokens?: unknown[] }).tokens || [],
        };
      },
    },

    // =========================================================================
    // Model Services
    // =========================================================================
    models: {
      listModels: async (family) => {
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
          }>;
        };

        let models = data.data || [];

        if (family) {
          const f = family.toLowerCase();
          models = models.filter(m => m.id.toLowerCase().includes(f));
        }

        return models
          .sort((a, b) => a.name.localeCompare(b.name))
          .slice(0, 50)
          .map(m => ({
            id: m.id,
            name: m.name,
            contextLength: m.context_length,
            pricing: m.pricing ? {
              prompt: parseFloat(m.pricing.prompt),
              completion: parseFloat(m.pricing.completion),
            } : undefined,
          }));
      },

      getConfig: async (agentId) => {
        const agent = await agents.getAgent(agentId);
        if (!agent) {
          return { model: 'anthropic/claude-sonnet-4', temperature: 0.8, maxTokens: 1024 };
        }
        return {
          model: agent.llmConfig?.model || 'anthropic/claude-sonnet-4',
          temperature: agent.llmConfig?.temperature ?? 0.8,
          maxTokens: agent.llmConfig?.maxTokens || 1024,
        };
      },

      updateConfig: async (agentId, config) => {
        const agent = await agents.getAgent(agentId);
        const currentConfig = agent?.llmConfig || {
          provider: 'openrouter',
          model: 'anthropic/claude-sonnet-4',
          temperature: 0.8,
          maxTokens: 1024,
          useGlobalKey: true,
        };
        const newLlmConfig = {
          ...currentConfig,
          ...config,
        };
        await agents.updateAgent(agentId, { llmConfig: newLlmConfig } as Record<string, unknown>, session);
      },
    },

    // =========================================================================
    // Profile Services
    // =========================================================================
    profile: {
      getProfile: async (agentId) => {
        const agent = await agents.getAgent(agentId);
        if (!agent) {
          return { name: 'Unknown' };
        }
        return {
          name: agent.name || 'Unnamed',
          description: agent.description,
          persona: agent.persona,
          profileImage: agent.profileImage ? { url: agent.profileImage.url } : undefined,
        };
      },

      updateProfile: async (agentId, updates) => {
        await agents.updateAgent(agentId, updates, session);
      },

      setProfileImage: async (agentId, source) => {
        const result = await media.setProfileImage(agentId, source);
        await agents.updateAgent(agentId, {
          profileImage: { url: result.url, s3Key: result.s3Key, updatedAt: Date.now() }
        }, session);
        return { url: result.url };
      },

      getProfileUploadUrl: async (agentId) => {
        return media.getProfileImageUploadUrl(agentId);
      },

      saveProfileImage: async (agentId, s3Key, publicUrl) => {
        await agents.updateAgent(agentId, {
          profileImage: { url: publicUrl, s3Key, updatedAt: Date.now() }
        }, session);
      },
    },

    // =========================================================================
    // Secret Services
    // =========================================================================
    secrets: {
      listSecrets: async (agentId) => {
        const secretList = await secrets.listSecrets(agentId);
        return secretList.map(s => ({
          secretType: s.secretType as SecretType,
          name: s.name,
          description: s.description,
          lastUpdated: s.createdAt,
        }));
      },

      storeSecret: async (agentId, secretType, name, value, description) => {
        await secrets.storeSecret(agentId, secretType as SecretType, name, value, session, description);

        // Special handling for Telegram bot tokens
        if (secretType === 'telegram_bot_token') {
          const validation = await telegram.validateTelegramToken(value);
          if (validation.valid) {
            await agents.updateAgent(agentId, {
              platforms: {
                telegram: {
                  enabled: true,
                  botUsername: validation.botInfo?.username
                }
              }
            }, session);

            const webhookResult = await telegram.registerTelegramWebhook(value, agentId);
            if (webhookResult.success && webhookResult.secretToken) {
              await secrets.storeSecret(
                agentId,
                'telegram_webhook_secret',
                'default',
                webhookResult.secretToken,
                session,
                `Telegram webhook secret for ${agentId}`
              );
            }
          }
        }
      },

      validateTelegramToken: telegram.validateTelegramToken,
    },

    // =========================================================================
    // Job Services
    // =========================================================================
    jobs: {
      getPendingJobs: async (agentId) => {
        let pendingJobs = await mediaJobs.getPendingJobs(agentId);

        // Poll Replicate for processing jobs
        if (pendingJobs.length > 0) {
          const replicateKey = await media.getProviderApiKey(agentId, 'replicate');
          if (replicateKey) {
            for (const job of pendingJobs) {
              if ((job.status === 'processing' || job.status === 'pending') && job.externalId) {
                await mediaJobs.pollAndCompleteJob(job.jobId, replicateKey);
              }
            }
            pendingJobs = await mediaJobs.getPendingJobs(agentId);
          }
        }

        return pendingJobs.map(job => ({
          jobId: job.jobId,
          type: job.type as 'image' | 'video' | 'sticker',
          status: job.status as 'pending' | 'processing' | 'completed' | 'failed',
          prompt: job.prompt,
          resultUrl: job.resultUrl,
          createdAt: job.createdAt,
          completedAt: job.completedAt,
        }));
      },

      getJob: async (agentId, jobId) => {
        let job = await mediaJobs.getJob(jobId);
        if (!job) return null;

        // Verify job belongs to this agent
        if (job.agentId !== agentId) {
          return null;
        }

        // Poll if still processing
        if ((job.status === 'processing' || job.status === 'pending') && job.externalId) {
          const replicateKey = await media.getProviderApiKey(job.agentId, 'replicate');
          if (replicateKey) {
            const polledJob = await mediaJobs.pollAndCompleteJob(job.jobId, replicateKey);
            if (polledJob) job = polledJob;
          }
        }

        return {
          jobId: job.jobId,
          type: job.type as 'image' | 'video' | 'sticker',
          status: job.status as 'pending' | 'processing' | 'completed' | 'failed',
          prompt: job.prompt,
          resultUrl: job.resultUrl,
          error: job.error,
          createdAt: job.createdAt,
          completedAt: job.completedAt,
        };
      },
    },

    // =========================================================================
    // Reference Image Services
    // =========================================================================
    reference: {
      getUploadUrl: async (agentId, category, name, _description) => {
        return media.getReferenceImageUploadUrl(agentId, category, name);
      },

      saveReferenceImage: async (agentId, data) => {
        const result = await media.saveReferenceImage(
          agentId,
          data.category,
          data.s3Key,
          data.publicUrl,
          data.name,
          data.description
        );
        return { id: result.id };
      },

      listReferenceImages: async (agentId, category) => {
        const images = await media.listReferenceImages(agentId, category);
        return images.map(img => ({
          id: img.id,
          category: img.category as 'profile' | 'character' | 'style' | 'background' | 'other',
          name: img.name,
          url: img.url,
          description: img.description,
          createdAt: img.createdAt || Date.now(),
        }));
      },

      deleteReferenceImage: async (agentId, imageId) => {
        await media.deleteReferenceImage(agentId, imageId);
      },
    },
  };
}

/**
 * Create MCP services for Telegram context (minimal session)
 */
export function createTelegramMCPServices(agentId: string): AllServices {
  const telegramSession: UserSession = {
    email: 'telegram-user@telegram.bot',
    userId: `telegram-${agentId}`,
    isAdmin: false,
    accessToken: '',
  };
  return createMCPServices(agentId, telegramSession);
}
