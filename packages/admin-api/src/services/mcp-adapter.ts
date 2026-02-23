/**
 * MCP Service Adapter
 *
 * Bridges existing admin-api services to MCP server service interfaces.
 * This allows the unified tool definitions to work with our current infrastructure.
 *
 * Service dependencies are resolved via the ServiceContainer rather than
 * direct module imports, making this adapter testable with injected stubs.
 */
import type { AllServices, VoiceServices, NFTServices, PropertyServices } from '@swarm/mcp-server';
import {
  DEFAULT_LLM_MODEL,
  DEFAULT_LLM_PROVIDER,
  DEFAULT_LLM_TEMPERATURE,
  DEFAULT_LLM_MAX_TOKENS,
} from '@swarm/core';
import type { UserSession, SecretType } from '../types.js';
import type { IntegrationType, AICapability } from '../services/integrations.js';
import type { TokenLaunchConfig } from '../services/token-launch.js';
import { getDefaultContainer, type ServiceContainer } from '../services/service-container.js';
import { getValidModelId } from './models-registry.js';

// Timeout for external API calls
const API_TIMEOUT_MS = 10_000;


/**
 * Get bot token from secrets for a given avatar
 */
function getBotToken(svc: ServiceContainer, avatarId: string): Promise<string> {
  return svc.secrets._getSecretValueInternal(avatarId, 'telegram_bot_token', 'default').then(
    (botToken) => {
      if (!botToken) {
        throw new Error('No Telegram bot token configured');
      }
      return botToken;
    }
  );
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
 * Create MCP-compatible services for a specific avatar.
 *
 * @param _avatarId  The avatar to bind services to
 * @param session    The authenticated user session
 * @param svc        Optional service container override (for testing)
 */
export function createMCPServices(
  _avatarId: string,
  session: UserSession,
  svc: ServiceContainer = getDefaultContainer(),
): AllServices {
  const avatarId = _avatarId;

  // Destructure service container into local aliases.
  // This keeps the rest of the function body unchanged while allowing
  // tests to inject overrides via the `svc` parameter.
  const {
    avatars,
    secrets,
    wallets,
    telegram,
    discord,
    media,
    gallery,
    credits,
    mediaJobs,
    voice,
    avatarObservability: avatarvents,
    memory,
    memoryMigration,
    memoryConsolidation,
    observability,
    chatVoting,
    integrations,
    tokenLaunch,
    entitlements,
    telegramAdmin: { diagnoseTelegram: _diagnoseTelegram, setupTelegramIntegration: _setupTelegramIntegration },
    replicate: { validateReplicateApiKey: _validateReplicateApiKey },
    modelsRegistry: { getModelsForCapability: _getModelsForCapability, AVAILABLE_MODELS: _AVAILABLE_MODELS },
    stripe: { createStripeCheckoutSession: _createStripeCheckoutSession, createStripeCustomerPortalSession: _createStripeCustomerPortalSession },
  } = svc;

  // Voice tools enabled by default; set ENABLE_VOICE_TOOLS=false to disable
  const voiceEnabled = process.env.ENABLE_VOICE_TOOLS !== 'false';
  const voiceServices: VoiceServices | undefined = voiceEnabled ? {
    transcribeAudio: async (params: Parameters<VoiceServices['transcribeAudio']>[0]) => {
      let audioUrl = params.url;
      if (!audioUrl && params.platformFileId) {
        const botToken = await getBotToken(svc, avatarId);
        audioUrl = await svc.telegram.getFileUrl(botToken, params.platformFileId);
      }
      return svc.voice.transcribeAudio({
        avatarId,
        assetId: params.assetId,
        url: audioUrl,
        language: params.language,
        model: params.model,
        diarize: params.diarize,
      });
    },
    createMyVoice: async (params: Parameters<VoiceServices['createMyVoice']>[0]) => {
      return voice.createMyVoice({
        avatarId: params.avatarId,
        description: params.description,
        updatedBy: session.email,
      });
    },
    hasVoice: async (avatardParam: string) => {
      return voice.hasVoice(avatardParam);
    },
    sendVoiceMessage: async (params: Parameters<VoiceServices['sendVoiceMessage']>[0]) => {
      return voice.sendVoiceMessage({
        avatarId,
        platform: params.platform,
        text: params.text,
        conversationId: params.conversationId,
        voiceId: params.voiceId,
        format: params.format,
        speed: params.speed,
        replyToMessageId: params.replyToMessageId,
      });
    },
  } : undefined;

  return {
    // =========================================================================
    // Media Services
    // =========================================================================
    media: {
      generateImage: async (params) => {
        // Use async generation to avoid API Gateway timeout (29s limit)
        // The image will be delivered via webhook callback
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
        // Return structured credit data
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
    },

    // =========================================================================
    // Wallet Services
    // =========================================================================
    wallets: {
      listWallets: async (avatarId) => {
        const walletList = await wallets.listWallets(avatarId);
        return Promise.all(
          walletList.map(async (w) => {
            try {
              const balance = w.walletType === 'ethereum'
                ? await wallets.getEthereumBalance(w.address, avatarId)
                : await wallets.getSolanaBalance(w.publicKey, avatarId);
              
              return {
                name: w.name,
                publicKey: w.publicKey,
                address: w.address,
                walletType: w.walletType,
                balance: balance.balance,
                solBalance: w.walletType === 'solana' ? balance.balance : null,
                ethBalance: w.walletType === 'ethereum' ? balance.balance : null,
              };
            } catch {
              return {
                name: w.name,
                publicKey: w.publicKey,
                address: w.address,
                walletType: w.walletType,
                balance: 0,
                solBalance: 0,
                ethBalance: 0,
              };
            }
          })
        );
      },

      createWallet: async (avatarId, name, chain = 'solana') => {
        const result = chain === 'ethereum'
          ? await wallets.generateEthereumWallet(avatarId, name, session)
          : await wallets.generateSolanaWallet(avatarId, name, session);
        return { 
          publicKey: result.publicKey, 
          address: result.address,
          walletType: result.walletType
        };
      },

      createVanityWallet: async (avatarId, name, pattern, matchStart) => {
        const result = await wallets.generateAndSaveVanityWallet(
          avatarId, 
          name, 
          pattern, 
          matchStart, 
          session
        );
        return {
          publicKey: result.publicKey,
          address: result.address,
          walletType: result.walletType,
          attempts: result.attempts,
          elapsedMs: result.elapsedMs,
        };
      },

      getBalance: async (publicKey, avatarId, chain = 'solana') => {
        const balance = chain === 'ethereum'
          ? await wallets.getEthereumBalance(publicKey, avatarId)
          : await wallets.getSolanaBalance(publicKey, avatarId);
        return {
          balance: balance.balance,
          chain: balance.chain,
          solBalance: balance.chain === 'solana' ? balance.balance : undefined,
          solBalanceLamports: balance.solBalanceLamports,
          ethBalance: balance.chain === 'ethereum' ? balance.balance : undefined,
          ethBalanceWei: balance.ethBalanceWei,
          tokens: balance.tokens || [],
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

        // Filter to text-capable models (keep entries with missing modality)
        models = models.filter(m => {
          const modality = m.architecture?.modality;
          if (!modality) return true;
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

      getConfig: async (avatarId) => {
        const avatar = await avatars.getAvatar(avatarId);
        if (!avatar) {
          return { model: DEFAULT_LLM_MODEL, temperature: DEFAULT_LLM_TEMPERATURE, maxTokens: DEFAULT_LLM_MAX_TOKENS };
        }
        return {
          model: avatar.llmConfig?.model || DEFAULT_LLM_MODEL,
          temperature: avatar.llmConfig?.temperature ?? DEFAULT_LLM_TEMPERATURE,
          maxTokens: avatar.llmConfig?.maxTokens || DEFAULT_LLM_MAX_TOKENS,
        };
      },

      updateConfig: async (avatarId, config) => {
        const avatar = await avatars.getAvatar(avatarId);
        const currentConfig = avatar?.llmConfig || {
          provider: DEFAULT_LLM_PROVIDER,
          model: DEFAULT_LLM_MODEL,
          temperature: DEFAULT_LLM_TEMPERATURE,
          maxTokens: DEFAULT_LLM_MAX_TOKENS,
          useGlobalKey: true,
        };
        const resolvedModel = config.model
          ? getValidModelId(config.model) ?? currentConfig.model
          : currentConfig.model;
        const newLlmConfig = {
          ...currentConfig,
          ...config,
          model: resolvedModel,
        };
        await avatars.updateAvatar(avatarId, { llmConfig: newLlmConfig } as Record<string, unknown>, session);
      },
    },

    // =========================================================================
    // Profile Services
    // =========================================================================
    profile: {
      getProfile: async (avatarId) => {
        const avatar = await avatars.getAvatar(avatarId);
        if (!avatar) {
          return { name: 'Unknown' };
        }
        return {
          name: avatar.name || 'Unnamed',
          description: avatar.description,
          persona: avatar.persona,
          profileImage: avatar.profileImage ? { url: avatar.profileImage.url } : undefined,
          characterReference: avatar.characterReference ? { 
            url: avatar.characterReference.url, 
            description: avatar.characterReference.description 
          } : undefined,
        };
      },

      updateProfile: async (avatarId, updates) => {
        await avatars.updateAvatar(avatarId, updates, session);
      },

      setProfileImage: async (avatarId, source) => {
        if (source.type === 'generate') {
          if (!source.prompt) {
            throw new Error('Prompt is required to generate a profile image.');
          }
          const job = await media.generateProfileImageAsync(avatarId, source.prompt);
          return { jobId: job.jobId, status: job.status };
        }

        const result = await media.setProfileImage(avatarId, source);
        await avatars.updateAvatar(avatarId, {
          profileImage: { url: result.url, s3Key: result.s3Key, updatedAt: Date.now() }
        }, session);
        return { url: result.url };
      },

      getProfileUploadUrl: async (avatarId) => {
        return media.getProfileImageUploadUrl(avatarId);
      },

      saveProfileImage: async (avatarId, s3Key, publicUrl) => {
        await avatars.updateAvatar(avatarId, {
          profileImage: { url: publicUrl, s3Key, updatedAt: Date.now() }
        }, session);
      },

      // Character reference (full-body) for image/video generation
      setCharacterReference: async (avatarId, source, description) => {
        // For now, we handle url and gallery directly; generate would need async job
        if (source.type === 'generate') {
          // Character sheet generation - uses wider aspect ratio
          const result = await media.setCharacterReference(avatarId, source, description);
          return { url: result.url };
        }

        const result = await media.setCharacterReference(avatarId, source, description);
        return { url: result.url };
      },

      getCharacterReferenceUploadUrl: async (avatarId) => {
        return media.getCharacterReferenceUploadUrl(avatarId);
      },

      saveCharacterReference: async (avatarId, s3Key, publicUrl, description) => {
        await avatars.updateAvatar(avatarId, {
          characterReference: { url: publicUrl, s3Key, description, updatedAt: Date.now() }
        }, session);
      },
    },

    // =========================================================================
    // Secret Services
    // =========================================================================
    secrets: {
      listSecrets: async (avatarId) => {
        const secretList = await secrets.listSecrets(avatarId);
        return secretList.map(s => ({
          secretType: s.secretType as SecretType,
          name: s.name,
          description: s.description,
          lastUpdated: s.createdAt,
        }));
      },

      storeSecret: async (avatarId, secretType, name, value, description) => {
        if (secretType === 'telegram_bot_token') {
          console.log(JSON.stringify({
            level: 'INFO',
            subsystem: 'telegram',
            event: 'telegram_token_setup_requested',
            avatarId,
            message: 'Telegram bot token received, validating and registering webhook...',
          }));

          const setupResult = await _setupTelegramIntegration({
            avatarId,
            token: value,
            session,
            deps: {
              validateTelegramToken: telegram.validateTelegramToken,
              registerTelegramWebhook: telegram.registerTelegramWebhook,
              generateWebhookSecret: telegram.generateWebhookSecret,
              updateAvatar: avatars.updateAvatar,
              storeSecret: secrets.storeSecret,
            },
          });

          if (!setupResult.success) {
            console.log(JSON.stringify({
              level: 'ERROR',
              subsystem: 'telegram',
              event: 'telegram_token_setup_failed',
              avatarId,
              error: setupResult.error,
            }));
            throw new Error(setupResult.error || 'Failed to configure Telegram');
          }

          return;
        }

        if (secretType === 'replicate_api_key') {
          console.log(JSON.stringify({
            level: 'INFO',
            subsystem: 'media',
            event: 'replicate_key_validation_requested',
            avatarId,
            message: 'Replicate API key received, validating...',
          }));

          const validation = await _validateReplicateApiKey(value);
          if (!validation.valid) {
            throw new Error(validation.error || 'Replicate API key invalid');
          }
        }

        await secrets.storeSecret(avatarId, secretType as SecretType, name, value, session, description);
      },

      validateTelegramToken: telegram.validateTelegramToken,
    },

    // =========================================================================
    // Job Services
    // =========================================================================
    jobs: {
      getPendingJobs: async (avatarId) => {
        let pendingJobs = await mediaJobs.getPendingJobs(avatarId);

        // Poll Replicate for processing jobs
        if (pendingJobs.length > 0) {
          const replicateKey = await media.getProviderApiKey(avatarId, 'replicate');
          if (replicateKey) {
            for (const job of pendingJobs) {
              if ((job.status === 'processing' || job.status === 'pending') && job.externalId) {
                await mediaJobs.pollAndCompleteJob(job.jobId, replicateKey);
              }
            }
            pendingJobs = await mediaJobs.getPendingJobs(avatarId);
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

      getJob: async (avatarId, jobId) => {
        let job = await mediaJobs.getJob(jobId);
        if (!job) return null;

        // Verify job belongs to this avatar
        if (job.avatarId !== avatarId) {
          return null;
        }

        // Poll if still processing
        if ((job.status === 'processing' || job.status === 'pending') && job.externalId) {
          const replicateKey = await media.getProviderApiKey(job.avatarId, 'replicate');
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
    // Voice Services (optional)
    // =========================================================================
    voice: voiceServices,

    // =========================================================================
    // Memory Services
    // =========================================================================
    memory: {
      remember: async (fact: string, about?: string, userId?: string) => {
        const result = await memory.remember(avatarId, fact, about, userId);
        return { saved: result.saved };
      },

      recall: async (query: string, userId?: string) => {
        const result = await memory.recall(avatarId, query, userId);
        return {
          facts: result.facts.map(f => ({
            fact: f.fact,
            about: f.about,
            userId,
            timestamp: f.timestamp,
            strength: f.strength,
          })),
        };
      },

      graphRecall: async (query: string, userId?: string) => {
        const searchResult = await memory.graphSearch(avatarId, query, {
          directLimit: 8,
          maxGraphMatches: 6,
          graphDepth: 1,
        });
        const mapMem = (m: { content: string; about?: string; createdAt: number; strength: number }) => ({
          fact: m.content,
          about: m.about,
          userId,
          timestamp: m.createdAt,
          strength: m.strength,
        });
        // Filter by userId if provided
        const filterByUser = (items: typeof searchResult.directMatches) =>
          userId ? items.filter(m => !m.userId || m.userId === userId) : items;

        return {
          facts: filterByUser(searchResult.directMatches).map(mapMem),
          associatedFacts: filterByUser(searchResult.graphMatches).map(mapMem),
          edgesTraversed: searchResult.edgesTraversed,
        };
      },

      getEmbeddingStats: async () => {
        return memoryMigration.getEmbeddingStats(avatarId);
      },

      backfillEmbeddings: async (options?: { dryRun?: boolean }) => {
        return memoryMigration.backfillEmbeddings(avatarId, {
          dryRun: options?.dryRun,
        });
      },

      consolidate: async (options?: { skipIdentity?: boolean }) => {
        return memoryConsolidation.triggerConsolidation(avatarId, {
          skipIdentity: options?.skipIdentity,
        });
      },

      getGraphStats: async () => {
        return memory.getGraphStats(avatarId);
      },
    },

    // =========================================================================
    // Telegram Services
    // =========================================================================
    telegram: {
      diagnoseTelegram: async (avatarId: string) => {
        return _diagnoseTelegram(avatarId);
      },

      getUserProfilePhotos: async (avatarId, userId, options) => {
        const botToken = await getBotToken(svc, avatarId);
        
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

      getBotName: async (avatarId) => {
        const botToken = await getBotToken(svc, avatarId);
        return telegram.getBotName(botToken);
      },

      setBotName: async (avatarId, name, languageCode) => {
        const botToken = await getBotToken(svc, avatarId);
        await telegram.setBotName(botToken, name, languageCode);
      },

      getBotDescription: async (avatarId) => {
        const botToken = await getBotToken(svc, avatarId);
        return telegram.getBotDescription(botToken);
      },

      setBotDescription: async (avatarId, description, languageCode) => {
        const botToken = await getBotToken(svc, avatarId);
        await telegram.setBotDescription(botToken, description, languageCode);
      },

      getBotShortDescription: async (avatarId) => {
        const botToken = await getBotToken(svc, avatarId);
        return telegram.getBotShortDescription(botToken);
      },

      setBotShortDescription: async (avatarId, shortDescription, languageCode) => {
        const botToken = await getBotToken(svc, avatarId);
        await telegram.setBotShortDescription(botToken, shortDescription, languageCode);
      },

      sendChatAction: async (avatarId, chatId, action) => {
        const botToken = await getBotToken(svc, avatarId);
        await telegram.sendChatAction(botToken, chatId, action);
      },

      replyToMessage: async (avatarId, chatId, replyToMessageId, text) => {
        const botToken = await getBotToken(svc, avatarId);
        return telegram.sendMessage(botToken, chatId, text, { replyToMessageId });
      },

      reactToMessage: async (avatarId, chatId, messageId, emoji) => {
        const botToken = await getBotToken(svc, avatarId);
        await telegram.setMessageReaction(botToken, chatId, messageId, emoji);
      },

      // Chat Modification Voting System
      getChatBots: async (chatId) => {
        return chatVoting.getChatBots(chatId);
      },

      proposeModification: async (avatarId, chatId, type, newValue, reason) => {
        const proposal = await chatVoting.createProposal(avatarId, chatId, type, newValue, reason);
        const withCounts = chatVoting.computeProposalCounts(proposal);
        return withCounts;
      },

      voteOnProposal: async (avatarId, proposalId, vote, comment) => {
        const proposal = await chatVoting.voteOnProposal(avatarId, proposalId, vote, comment);
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

      executeModification: async (avatarId, proposalId) => {
        const botToken = await getBotToken(svc, avatarId);
        return chatVoting.executeModification(avatarId, proposalId, botToken);
      },
    },

    // =========================================================================
    // Twitter Services (extracted to mcp-twitter-adapter.ts)
    // =========================================================================
    twitter: svc.createTwitterServices(_avatarId),

    // =========================================================================
    // Discord Services
    // =========================================================================
    discord: {
      getConnectionStatus: async () => {
        return discord.getConnectionStatus(_avatarId);
      },

      sendMessage: async (channelId, content, options) => {
        return discord.sendMessage(_avatarId, channelId, content, options);
      },

      sendWebhookMessage: async (content, options) => {
        return discord.sendWebhookMessage(_avatarId, content, options);
      },

      getChannel: async (channelId) => {
        return discord.getChannel(_avatarId, channelId);
      },

      listChannels: async (guildId) => {
        return discord.listChannels(_avatarId, guildId);
      },

      listGuilds: async () => {
        return discord.listGuilds(_avatarId);
      },

      getMessages: async (channelId, limit) => {
        return discord.getMessages(_avatarId, channelId, limit);
      },

      addReaction: async (channelId, messageId, emoji) => {
        return discord.addReaction(_avatarId, channelId, messageId, emoji);
      },

      removeReaction: async (channelId, messageId, emoji) => {
        return discord.removeReaction(_avatarId, channelId, messageId, emoji);
      },
    },

    // =========================================================================
    // Integrations Services (Unified Configuration)
    // =========================================================================
    integrations: {
      getStatus: async (integration: IntegrationType) => {
        return integrations.getIntegrationStatus(_avatarId, integration);
      },

      getAllStatuses: async () => {
        return integrations.getAllIntegrationStatuses(_avatarId);
      },

      testConnection: async (integration: IntegrationType) => {
        return integrations.testIntegrationConnection(_avatarId, integration);
      },

      getAvailableModels: (integration?: string, capability?: string) => {
        if (capability && integration) {
          return _getModelsForCapability(capability as AICapability, integration);
        } else if (capability) {
          return _getModelsForCapability(capability as AICapability);
        } else if (integration) {
          return _AVAILABLE_MODELS.filter(m => m.provider === integration);
        }
        return _AVAILABLE_MODELS;
      },

      setModelPreference: async (integration: string, capability: string, modelId: string) => {
        return integrations.setModelPreference(
          _avatarId,
          integration as IntegrationType,
          capability as AICapability,
          modelId,
          session
        );
      },
    },

    // =========================================================================
    // NFT Services (Avatar Inhabitation & Lineage)
    // =========================================================================
    nft: createNFTServices(svc),

    // =========================================================================
    // Property Research Services
    // =========================================================================
    property: createPropertyServices(_avatarId, session, svc),

    // =========================================================================
    // Sticker Services
    // =========================================================================
    stickers: svc.createStickerServices(),

    // =========================================================================
    // Diagnostics Services (Issues & Feedback)
    // =========================================================================
    diagnostics: {
      recordIssue: async (params) => {
        return avatarvents.recordIssue({
          avatarId: params.avatarId,
          platform: params.platform,
          severity: params.severity,
          category: params.category,
          title: params.title,
          description: params.description,
          userMessage: params.userMessage,
          context: params.context,
        });
      },
      recordFeedback: async (params) => {
        return avatarvents.recordFeedback({
          avatarId: params.avatarId,
          platform: params.platform,
          sentiment: params.sentiment,
          feature: params.feature,
          feedback: params.feedback,
        });
      },
    },

    // =========================================================================
    // Observability Services
    // =========================================================================
    observability: {
      getSystemStatus: async (options) => {
        return observability.getSystemStatus(options);
      },
      getAvatarActivity: async (avatarId, options) => {
        const activity = await observability.getAvatarActivity(avatarId, options);
        return {
          ...activity,
          items: activity.items.map(item => item as unknown as Record<string, unknown>),
        };
      },
    },

    // =========================================================================
    // MCP Admin Services (Toolset & External Server Management)
    // =========================================================================
    mcpAdmin: svc.createMcpAdminServices(),

    // =========================================================================
    // Avatar Status Services
    // =========================================================================
    avatar: {
      setStatus: async (avatarId: string, status: 'draft' | 'active' | 'paused') => {
        try {
          const avatar = await avatars.getAvatar(avatarId);
          if (!avatar) {
            return { success: false, error: 'Avatar not found.' };
          }

          // Validate avatar has minimum requirements for activation
          if (status === 'active') {
            if (!avatar.persona) {
              return { success: false, error: 'Avatar must have a persona configured before activation.' };
            }
          }

          await avatars.updateAvatar(avatarId, { status }, session);
          return { success: true, name: avatar.name };
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          return { success: false, error: message };
        }
      },

      getStatus: async (avatarId: string) => {
        const avatar = await avatars.getAvatar(avatarId);
        if (!avatar) {
          return null;
        }
        return { status: avatar.status as 'draft' | 'active' | 'paused', name: avatar.name };
      },
    },

    // =========================================================================
    // Moltbook Services (Social network for AI agents)
    // =========================================================================
    moltbook: svc.createMoltbookServices(_avatarId, session),

    // =========================================================================
    // Token Launch Services
    // =========================================================================
    tokenLaunch: {
      preflightLaunch: async (avatarId: string) => {
        return tokenLaunch.preflightTokenLaunch(avatarId);
      },
      launchToken: async (avatarId: string, config: TokenLaunchConfig) => {
        return tokenLaunch.launchToken(avatarId, config);
      },
      getTokenStatus: async (avatarId: string) => {
        return tokenLaunch.getTokenStatus(avatarId);
      },
    },

    // =========================================================================
    // Billing Services (Stripe subscriptions & usage)
    // =========================================================================
    billing: {
      createCheckoutSession: async (params) => {
        const session = await _createStripeCheckoutSession({
          accountId: params.accountId,
          avatarId: params.avatarId,
          plan: params.plan,
          successUrl: params.successUrl,
          cancelUrl: params.cancelUrl,
          customerId: params.customerId,
          customerEmail: params.customerEmail,
        });
        return {
          checkoutUrl: session.url || '',
          sessionId: session.id,
        };
      },
      createPortalSession: async (params) => {
        const portal = await _createStripeCustomerPortalSession({
          customerId: params.customerId,
          returnUrl: params.returnUrl,
        });
        return { portalUrl: portal.url || '' };
      },
      getBillingStatus: async (avatarId: string) => {
        const ent = await entitlements.getEntitlement(avatarId);
        if (!ent) return null;
        return {
          accountId: ent.accountId,
          avatarId: ent.avatarId,
          plan: ent.plan,
          status: ent.status,
          stripeSubscriptionId: ent.stripeSubscriptionId,
          stripeCustomerId: ent.stripeCustomerId,
          trialEndsAt: ent.trialEndsAt,
          suspendedAt: ent.suspendedAt,
          suspendedReason: ent.suspendedReason,
          limits: {
            dailyMessageLimit: ent.limits.dailyMessageLimit,
            dailyMediaCredits: ent.limits.dailyMediaCredits,
            dailyVoiceMinutes: ent.limits.dailyVoiceMinutes,
            maxToolCallsPerMessage: ent.limits.maxToolCallsPerMessage,
            maxPlatforms: ent.limits.maxPlatforms,
            maxChannels: ent.limits.maxChannels,
            memoryEnabled: ent.limits.memoryEnabled,
            memoryRetentionDays: ent.limits.memoryRetentionDays,
            autonomousPostsEnabled: ent.limits.autonomousPostsEnabled,
            customModelEnabled: ent.limits.customModelEnabled,
            priorityProcessing: ent.limits.priorityProcessing,
          },
        };
      },
      getUsage: async (avatarId: string, date?: string) => {
        const usage = await entitlements.getUsage(avatarId, date);
        if (!usage) return null;
        return {
          avatarId: usage.avatarId,
          date: usage.date,
          messagesProcessed: usage.messagesProcessed || 0,
          mediaCreditsUsed: usage.mediaCreditsUsed || 0,
          voiceMinutesUsed: usage.voiceMinutesUsed || 0,
          toolCallsMade: usage.toolCallsMade || 0,
          imageGenerations: usage.imageGenerations || 0,
          videoGenerations: usage.videoGenerations || 0,
          stickerGenerations: usage.stickerGenerations || 0,
        };
      },
    },
  };
}

/**
 * Create NFT services for ownership and lineage
 */
function createNFTServices(svc: ServiceContainer): NFTServices {
  const { avatars, avatarOwnership: avatarwnership, nftGate, lineageNft } = svc;
  return {
    // Gate NFT operations
    getGateStatus: async (walletAddress: string) => {
      return nftGate.getGateStatus(walletAddress);
    },

    getGateCollectionAddress: () => {
      return nftGate.getGateCollection();
    },

    // Legacy ownership operations
    getInhabitationInfo: async (walletAddress: string) => {
      return avatarwnership.getInhabitationInfo(walletAddress);
    },

    listUnclaimedAvatars: async () => {
      // Get all avatars without an active inhabitant association
      const allAgents = await avatars.listAvatars();
      return allAgents
        .filter((avatar) => !avatar.inhabitantWallet)
        .map((avatar) => ({
          avatarId: avatar.avatarId,
          name: avatar.name,
          description: avatar.description,
          avatarUrl: avatar.profileImage?.url,
          era: avatar.currentEra || 0,
        }));
    },

    inhabitAvatar: async (walletAddress: string, avatarId: string) => {
      return avatarwnership.inhabitAvatar(walletAddress, avatarId);
    },

    canAbandon: async (walletAddress: string) => {
      const result = await avatarwnership.canAbandon(walletAddress);
      return {
        canAbandon: result.canAbandon,
        gateStatus: result.gateStatus,
        inhabitedAvatarId: result.inhabitedAvatar?.avatarId,
        inhabitedAvatarName: result.inhabitedAvatar?.name,
      };
    },

    abandonAvatar: async (walletAddress: string, burnTxSignature: string) => {
      return avatarwnership.abandonAvatar(walletAddress, burnTxSignature);
    },

    // Burn verification
    verifyGateBurn: async (walletAddress: string, signature: string) => {
      return lineageNft.verifyGateBurn(walletAddress, signature);
    },

    // Lineage NFT operations
    getLineageCollection: async (avatarId: string) => {
      return lineageNft.getLineageCollection(avatarId);
    },

    prepareLineageMint: async (avatarId: string, walletAddress: string) => {
      return lineageNft.prepareLineageMint(avatarId, walletAddress);
    },

    recordLineageMint: async (
      avatarId: string,
      walletAddress: string,
      nftMint: string,
      era: number,
      burnSignature?: string
    ) => {
      return lineageNft.recordLineageMint(avatarId, walletAddress, nftMint, era, burnSignature);
    },

    generateLineageMetadata: (metadata) => {
      return lineageNft.generateLineageMetadataJson(metadata);
    },

    // Avatar self-awareness (what avatars can actually use)
    getAvatarInhabitationStatus: async (avatarId: string) => {
      const avatar = await avatars.getAvatar(avatarId);
      if (!avatar) {
        return {
          isInhabited: false,
          currentEra: 0,
          totalEras: 0,
        };
      }

      return {
        isInhabited: !!avatar.inhabitantWallet,
        inhabitantWallet: avatar.inhabitantWallet,
        inhabitedAt: avatar.inhabitedAt,
        currentEra: avatar.currentEra || 0,
        totalEras: avatar.currentEra || 0, // Era increments on each abandon
      };
    },

    getInhabitationUrl: (avatarId: string) => {
      // Legacy claim URL (claim flow is deprecated)
      const baseUrl = process.env.ADMIN_UI_URL || 'https://swarm.rati.chat';
      return `${baseUrl}/avatars/${avatarId}`;
    },

    getAvatarAscensionStatus: async (avatarId: string) => {
      const avatar = await avatars.getAvatar(avatarId);
      if (!avatar || !avatar.isAscended) {
        return { isAscended: false };
      }

      // Import ASCENSION_ENERGY_BOOST from core
      const { ASCENSION_ENERGY_BOOST } = await import('@swarm/core');

      return {
        isAscended: true,
        ascendedAt: avatar.ascendedAt,
        ascendedNftMint: avatar.ascendedNftMint,
        ascendedByWallet: avatar.ascendedByWallet,
        energyBoost: {
          maxEnergyMultiplier: ASCENSION_ENERGY_BOOST.maxEnergyMultiplier,
          regenRateMultiplier: ASCENSION_ENERGY_BOOST.regenRateMultiplier,
        },
      };
    },

    // NFT Collection Avatar operations
    getClaimableNFTs: async (walletAddress: string) => {
      return nftGate.getClaimableNFTs(walletAddress);
    },

    claimNFTAsAvatar: async (walletAddress: string, mintAddress: string) => {
      // First get the NFT details from the claimable list to verify ownership and get metadata
      const claimableNFTs = await nftGate.getClaimableNFTs(walletAddress);
      const nft = claimableNFTs.find((n) => n.mint === mintAddress);

      if (!nft) {
        // The NFT is not in the claimable list - either not owned, not in whitelisted collection, or already claimed
        // Let's give a more specific error
        const isOwned = await nftGate.verifyNFTOwnership(walletAddress, mintAddress);
        if (!isOwned) {
          return { success: false, error: 'nft_not_owned' };
        }
        if (await nftGate.isNFTClaimed(mintAddress)) {
          return { success: false, error: 'nft_already_claimed' };
        }
        return { success: false, error: 'nft_not_in_collection' };
      }

      // Create the avatar from the NFT
      const result = await avatars.createAvatarFromNFT(nft, walletAddress);

      if (!result.success) {
        return {
          success: false,
          error: result.error,
        };
      }

      return {
        success: true,
        avatarId: result.avatar?.avatarId,
        avatarName: result.avatar?.name,
        avatarImage: result.avatar?.profileImage?.url,
      };
    },

    getWhitelistedCollections: () => {
      return nftGate.getWhitelistedCollections();
    },
  };
}

/**
 * Create MCP services for Telegram context (minimal session)
 */
export function createTelegramMCPServices(
  avatarId: string,
  svc: ServiceContainer = getDefaultContainer(),
): AllServices {
  const telegramSession: UserSession = {
    email: 'telegram-user@telegram.bot',
    userId: `telegram-${avatarId}`,
    isAdmin: false,
    accessToken: '',
  };
  return createMCPServices(avatarId, telegramSession, svc);
}

/**
 * Create property research services
 */
function createPropertyServices(_avatarId: string, _session: UserSession, svc: ServiceContainer): PropertyServices {
  const { propertyResearch } = svc;
  const webSearch = svc.createWebSearch();

  const isPropertyResearchStatus = (
    value: string
  ): value is 'queued' | 'researching' | 'completed' | 'failed' => {
    return value === 'queued' || value === 'researching' || value === 'completed' || value === 'failed';
  };

  return {
    // Authorization
    checkAuth: async (avatarId: string, walletAddress: string) => {
      return propertyResearch.checkAuth(avatarId, walletAddress);
    },

    grantAuth: async (avatarId: string, walletAddress: string) => {
      await propertyResearch.grantAuth(avatarId, walletAddress);
    },

    revokeAuth: async (avatarId: string, walletAddress: string) => {
      await propertyResearch.revokeAuth(avatarId, walletAddress);
    },

    // Job management
    createJob: async (avatarId: string, property, requestedBy) => {
      return propertyResearch.createJob(avatarId, property, requestedBy);
    },

    getJob: async (jobId: string) => {
      return propertyResearch.getJob(jobId);
    },

    getJobsForAvatar: async (avatarId: string, statusFilter?: string) => {
      const parsedStatus = statusFilter && isPropertyResearchStatus(statusFilter) ? statusFilter : undefined;
      return propertyResearch.getJobsForAvatar(avatarId, parsedStatus);
    },

    deleteJob: async (jobId: string) => {
      await propertyResearch.deleteJob(jobId);
    },

    // Research execution
    executeResearch: async (jobId: string) => {
      return propertyResearch.executeResearch(jobId, webSearch);
    },
  };
}
