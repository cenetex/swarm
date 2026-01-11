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
import * as chatVoting from '../services/chat-voting.js';
import * as media from '../services/media.js';
import * as gallery from '../services/gallery.js';
import * as credits from '../services/credits.js';
import * as mediaJobs from '../services/media-jobs.js';

// Timeout for external API calls
const API_TIMEOUT_MS = 10_000;

/**
 * Get bot token from secrets for a given agent
 */
async function getBotToken(agentId: string): Promise<string> {
  const botToken = await secrets._getSecretValueInternal(agentId, 'telegram_bot_token', 'default');
  if (!botToken) {
    throw new Error('No Telegram bot token configured');
  }
  return botToken;
}

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
            architecture?: { modality?: string };
          }>;
        };

        let models = data.data || [];

        // Filter to text-capable models (exclude image-only models)
        models = models.filter(m => {
          const modality = m.architecture?.modality || '';
          return modality.includes('text');
        });

        if (family) {
          const f = family.toLowerCase();
          models = models.filter(m => m.id.toLowerCase().startsWith(f + '/') || m.id.toLowerCase().includes('/' + f));
        }

        // Sort by provider, then by name
        models.sort((a, b) => {
          const providerA = a.id.split('/')[0] || '';
          const providerB = b.id.split('/')[0] || '';
          if (providerA !== providerB) return providerA.localeCompare(providerB);
          return a.name.localeCompare(b.name);
        });

        // Return all models (UI will handle display)
        return models.map(m => ({
          id: m.id,
          name: m.name,
          provider: m.id.split('/')[0] || 'other',
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
        if (source.type === 'generate') {
          if (!source.prompt) {
            throw new Error('Prompt is required to generate a profile image.');
          }
          const job = await media.generateProfileImageAsync(agentId, source.prompt);
          return { jobId: job.jobId, status: job.status };
        }

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

        // Special handling for Telegram bot tokens - register webhook automatically
        if (secretType === 'telegram_bot_token') {
          console.log(JSON.stringify({
            level: 'INFO',
            subsystem: 'telegram',
            event: 'telegram_token_stored',
            agentId,
            message: 'Telegram bot token stored, validating and registering webhook...',
          }));

          const validation = await telegram.validateTelegramToken(value);
          if (!validation.valid) {
            console.log(JSON.stringify({
              level: 'WARN',
              subsystem: 'telegram',
              event: 'telegram_token_invalid',
              agentId,
              error: validation.error,
            }));
            return;
          }

          console.log(JSON.stringify({
            level: 'INFO',
            subsystem: 'telegram',
            event: 'telegram_token_valid',
            agentId,
            botUsername: validation.botInfo?.username,
          }));

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
            console.log(JSON.stringify({
              level: 'INFO',
              subsystem: 'telegram',
              event: 'telegram_webhook_registered',
              agentId,
              webhookUrl: webhookResult.webhookUrl,
            }));
          } else {
            console.log(JSON.stringify({
              level: 'ERROR',
              subsystem: 'telegram',
              event: 'telegram_webhook_failed',
              agentId,
              error: webhookResult.message,
            }));
          }
        }

        // Special handling for Replicate API key - validate it works
        if (secretType === 'replicate_api_key') {
          console.log(JSON.stringify({
            level: 'INFO',
            subsystem: 'media',
            event: 'replicate_key_stored',
            agentId,
            message: 'Replicate API key stored, validating...',
          }));

          try {
            // Test the API key by getting account info
            const response = await fetch('https://api.replicate.com/v1/account', {
              headers: { 'Authorization': `Bearer ${value}` },
            });
            
            if (response.ok) {
              const account = await response.json() as { username?: string };
              console.log(JSON.stringify({
                level: 'INFO',
                subsystem: 'media',
                event: 'replicate_key_valid',
                agentId,
                username: account.username,
              }));
            } else {
              console.log(JSON.stringify({
                level: 'WARN',
                subsystem: 'media',
                event: 'replicate_key_invalid',
                agentId,
                status: response.status,
              }));
            }
          } catch (err) {
            console.log(JSON.stringify({
              level: 'WARN',
              subsystem: 'media',
              event: 'replicate_key_validation_error',
              agentId,
              error: err instanceof Error ? err.message : 'Unknown error',
            }));
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

    // =========================================================================
    // Telegram Services
    // =========================================================================
    telegram: {
      getUserProfilePhotos: async (agentId, userId, options) => {
        const botToken = await getBotToken(agentId);
        
        const result = await telegram.getUserProfilePhotos(botToken, userId, options);
        
        // Get file URLs for photos
        const photos = [];
        for (const photoSizes of result.photos) {
          // Get the largest size
          const largest = photoSizes.reduce((a, b) => 
            (a.width * a.height > b.width * b.height) ? a : b
          );
          
          let fileUrl: string | undefined;
          try {
            fileUrl = await telegram.getFileUrl(botToken, largest.file_id);
          } catch {
            // File URL fetch failed, skip
          }
          
          photos.push({
            fileId: largest.file_id,
            width: largest.width,
            height: largest.height,
            fileUrl,
          });
        }
        
        return {
          userId,
          totalPhotos: result.totalCount,
          photos,
        };
      },

      getBotName: async (agentId) => {
        const botToken = await getBotToken(agentId);
        return telegram.getBotName(botToken);
      },

      setBotName: async (agentId, name, languageCode) => {
        const botToken = await getBotToken(agentId);
        await telegram.setBotName(botToken, name, languageCode);
      },

      getBotDescription: async (agentId) => {
        const botToken = await getBotToken(agentId);
        return telegram.getBotDescription(botToken);
      },

      setBotDescription: async (agentId, description, languageCode) => {
        const botToken = await getBotToken(agentId);
        await telegram.setBotDescription(botToken, description, languageCode);
      },

      getBotShortDescription: async (agentId) => {
        const botToken = await getBotToken(agentId);
        return telegram.getBotShortDescription(botToken);
      },

      setBotShortDescription: async (agentId, shortDescription, languageCode) => {
        const botToken = await getBotToken(agentId);
        await telegram.setBotShortDescription(botToken, shortDescription, languageCode);
      },

      sendChatAction: async (agentId, chatId, action) => {
        const botToken = await getBotToken(agentId);
        await telegram.sendChatAction(botToken, chatId, action);
      },

      // Chat Modification Voting System
      getChatBots: async (chatId) => {
        return chatVoting.getChatBots(chatId);
      },

      proposeModification: async (agentId, chatId, type, newValue, reason) => {
        const proposal = await chatVoting.createProposal(agentId, chatId, type, newValue, reason);
        const withCounts = chatVoting.computeProposalCounts(proposal);
        return withCounts;
      },

      voteOnProposal: async (agentId, proposalId, vote, comment) => {
        const proposal = await chatVoting.voteOnProposal(agentId, proposalId, vote, comment);
        return chatVoting.computeProposalCounts(proposal);
      },

      getActiveProposals: async (chatId) => {
        const proposals = await chatVoting.getActiveProposals(chatId);
        return proposals.map(p => chatVoting.computeProposalCounts(p));
      },

      getProposal: async (proposalId) => {
        const proposal = await chatVoting.getProposal(proposalId);
        if (!proposal) return null;
        return chatVoting.computeProposalCounts(proposal);
      },

      canModifyChat: async (chatId, type) => {
        return chatVoting.canModifyChat(chatId, type);
      },

      executeModification: async (agentId, proposalId) => {
        const botToken = await getBotToken(agentId);
        return chatVoting.executeModification(agentId, proposalId, botToken);
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
