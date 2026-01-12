/**
 * MCP Service Adapter
 * 
 * Bridges existing admin-api services to MCP server service interfaces.
 * This allows the unified tool definitions to work with our current infrastructure.
 */
import type { AllServices, VoiceServices, NFTServices } from '@swarm/mcp-server';
import type { UserSession, SecretType } from '../types.js';
import * as agents from '../services/agents.js';
import * as secrets from '../services/secrets.js';
import * as wallets from '../services/wallets.js';
import * as telegram from '../services/telegram.js';
import * as twitterOAuth from '../services/twitter-oauth.js';
import * as chatVoting from '../services/chat-voting.js';
import * as discord from '../services/discord.js';
import * as media from '../services/media.js';
import * as gallery from '../services/gallery.js';
import * as credits from '../services/credits.js';
import * as mediaJobs from '../services/media-jobs.js';
import * as voice from '../services/voice.js';
import * as agentOwnership from '../services/agent-ownership.js';
import * as nftGate from '../services/nft-gate.js';
import * as lineageNft from '../services/lineage-nft.js';

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
  const agentId = _agentId;
  const voiceEnabled = process.env.ENABLE_VOICE_TOOLS === 'true';
  const voiceServices: VoiceServices | undefined = voiceEnabled ? {
    transcribeAudio: async (params: Parameters<VoiceServices['transcribeAudio']>[0]) => {
      let audioUrl = params.url;
      if (!audioUrl && params.platformFileId) {
        const botToken = await getBotToken(agentId);
        audioUrl = await telegram.getFileUrl(botToken, params.platformFileId);
      }
      return voice.transcribeAudio({
        agentId,
        assetId: params.assetId,
        url: audioUrl,
        language: params.language,
        model: params.model,
        diarize: params.diarize,
      });
    },
    createVoiceSeed: async (params: Parameters<VoiceServices['createVoiceSeed']>[0]) => {
      return voice.createVoiceSeed({
        agentId,
        prompt: params.prompt,
        durationMs: params.durationMs,
        styleTags: params.styleTags,
        negativeTags: params.negativeTags,
      });
    },
    cloneVoiceFromSeed: async (params: Parameters<VoiceServices['cloneVoiceFromSeed']>[0]) => {
      return voice.cloneVoiceFromSeed({
        agentId,
        seedAssetId: params.seedAssetId,
        name: params.name,
      });
    },
    createVoiceProfile: async (params: Parameters<VoiceServices['createVoiceProfile']>[0]) => {
      return voice.createVoiceProfile({
        agentId,
        seedPrompt: params.seedPrompt,
        seedAssetId: params.seedAssetId,
        voiceName: params.voiceName,
      });
    },
    setActiveVoiceProfile: async (params: Parameters<VoiceServices['setActiveVoiceProfile']>[0]) => {
      await voice.setActiveVoiceProfile(agentId, params.voiceId, session.email);
    },
    generateVoiceMessage: async (params: Parameters<VoiceServices['generateVoiceMessage']>[0]) => {
      return voice.generateVoiceMessage({
        agentId,
        text: params.text,
        voiceId: params.voiceId,
        format: params.format,
        speed: params.speed,
        pitch: params.pitch,
        emotion: params.emotion,
        maxDurationMs: params.maxDurationMs,
      });
    },
    sendVoiceMessage: async (params: Parameters<VoiceServices['sendVoiceMessage']>[0]) => {
      return voice.sendVoiceMessage({
        agentId,
        platform: params.platform,
        conversationId: params.conversationId,
        assetId: params.assetId,
        url: params.url,
        caption: params.caption,
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
        // The image will be delivered via job polling
        const job = await media.generateImageAsync({
          prompt: params.prompt,
          agentId: params.agentId,
          platform: params.platform,
          referenceImageUrls: params.referenceImageUrls,
          resolution: params.resolution as '1K' | '2K' | '4K' | undefined,
          aspectRatio: params.aspectRatio as '1:1' | '2:3' | '3:2' | '3:4' | '4:3' | '4:5' | '5:4' | '9:16' | '16:9' | '21:9' | undefined,
          conversationId: `admin-ui-${Date.now()}`,
        });
        return { jobId: job.jobId, status: job.status };
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

      getCharacterReferenceUrl: async (agentId) => {
        const agent = await agents.getAgent(agentId);
        return agent?.characterReference?.url;
      },

      getBestReferenceImageUrl: async (agentId) => {
        return media.getBestReferenceImageUrl(agentId);
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
          characterReference: agent.characterReference ? { 
            url: agent.characterReference.url, 
            description: agent.characterReference.description 
          } : undefined,
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

      // Character reference (full-body) for image/video generation
      setCharacterReference: async (agentId, source, description) => {
        // For now, we handle url and gallery directly; generate would need async job
        if (source.type === 'generate') {
          // Character sheet generation - uses wider aspect ratio
          const result = await media.setCharacterReference(agentId, source, description);
          return { url: result.url };
        }

        const result = await media.setCharacterReference(agentId, source, description);
        return { url: result.url };
      },

      getCharacterReferenceUploadUrl: async (agentId) => {
        return media.getCharacterReferenceUploadUrl(agentId);
      },

      saveCharacterReference: async (agentId, s3Key, publicUrl, description) => {
        await agents.updateAgent(agentId, {
          characterReference: { url: publicUrl, s3Key, description, updatedAt: Date.now() }
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
    // Voice Services (optional)
    // =========================================================================
    voice: voiceServices,

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

    // =========================================================================
    // Twitter Services
    // =========================================================================
    twitter: {
      getConnectionStatus: async () => {
        return twitterOAuth.getConnectionStatus(_agentId);
      },

      startOAuthFlow: async () => {
        try {
          const result = await twitterOAuth.startOAuthFlow(_agentId);
          return { authorizationUrl: result.authorizationUrl };
        } catch (error) {
          console.error('Failed to start Twitter OAuth flow:', error);
          return null;
        }
      },

      postTweet: async (text: string, mediaUrls?: string[]) => {
        // Get credentials
        const creds = await twitterOAuth.getAgentTwitterCredentials(_agentId);
        if (!creds.configured) {
          return null;
        }

        // Import twitter-api-v2 dynamically to avoid loading it when not needed
        const { TwitterApi } = await import('twitter-api-v2');
        
        const client = new TwitterApi({
          appKey: creds.appKey!,
          appSecret: creds.appSecret!,
          accessToken: creds.accessToken!,
          accessSecret: creds.accessSecret!,
        });

        try {
          // Handle media uploads if provided
          let mediaIds: string[] | undefined;
          if (mediaUrls && mediaUrls.length > 0) {
            mediaIds = [];
            for (const url of mediaUrls.slice(0, 4)) {
              try {
                const response = await fetch(url);
                const buffer = Buffer.from(await response.arrayBuffer());
                const mediaId = await client.v1.uploadMedia(buffer, {
                  mimeType: 'image/png',
                });
                mediaIds.push(mediaId);
              } catch (err) {
                console.error('Failed to upload media to Twitter:', err);
              }
            }
          }

          // Post the tweet
          const tweetParams: Parameters<typeof client.v2.tweet>[0] = { text };
          if (mediaIds && mediaIds.length > 0) {
            tweetParams.media = { media_ids: mediaIds as [string] };
          }

          const result = await client.v2.tweet(tweetParams);
          const tweetId = result.data.id;

          // Get connection status for username
          const status = await twitterOAuth.getConnectionStatus(_agentId);
          const username = status.username || 'unknown';

          return {
            tweetId,
            url: `https://x.com/${username}/status/${tweetId}`,
          };
        } catch (error) {
          console.error('Failed to post tweet:', error);
          return null;
        }
      },

      // Extended Twitter methods
      getTimeline: async (count = 20) => {
        const creds = await twitterOAuth.getAgentTwitterCredentials(_agentId);
        if (!creds.configured) return [];

        const { TwitterApi } = await import('twitter-api-v2');
        const client = new TwitterApi({
          appKey: creds.appKey!,
          appSecret: creds.appSecret!,
          accessToken: creds.accessToken!,
          accessSecret: creds.accessSecret!,
        });

        try {
          const me = await client.v2.me();
          const timeline = await client.v2.userTimeline(me.data.id, {
            max_results: Math.min(count, 100),
            expansions: ['author_id'],
            'tweet.fields': ['created_at', 'public_metrics', 'conversation_id'],
            'user.fields': ['username', 'name'],
          });

          return (timeline.data.data || []).map(t => {
            const author = timeline.includes?.users?.find(u => u.id === t.author_id);
            return {
              id: t.id,
              text: t.text,
              authorId: t.author_id || '',
              authorUsername: author?.username,
              authorName: author?.name,
              createdAt: t.created_at || new Date().toISOString(),
              conversationId: t.conversation_id,
              metrics: t.public_metrics ? {
                replyCount: t.public_metrics.reply_count,
                retweetCount: t.public_metrics.retweet_count,
                likeCount: t.public_metrics.like_count,
                quoteCount: t.public_metrics.quote_count,
              } : undefined,
            };
          });
        } catch (error) {
          console.error('Failed to get Twitter timeline:', error);
          return [];
        }
      },

      getMentions: async (sinceId?: string, count = 20) => {
        const creds = await twitterOAuth.getAgentTwitterCredentials(_agentId);
        if (!creds.configured) return [];

        const { TwitterApi } = await import('twitter-api-v2');
        const client = new TwitterApi({
          appKey: creds.appKey!,
          appSecret: creds.appSecret!,
          accessToken: creds.accessToken!,
          accessSecret: creds.accessSecret!,
        });

        try {
          const me = await client.v2.me();
          const mentions = await client.v2.userMentionTimeline(me.data.id, {
            since_id: sinceId,
            max_results: Math.min(count, 100),
            expansions: ['author_id'],
            'tweet.fields': ['created_at', 'conversation_id', 'in_reply_to_user_id'],
            'user.fields': ['username', 'name'],
          });

          return (mentions.data.data || []).map(t => {
            const author = mentions.includes?.users?.find(u => u.id === t.author_id);
            return {
              id: t.id,
              text: t.text,
              authorId: t.author_id || '',
              authorUsername: author?.username,
              authorName: author?.name,
              createdAt: t.created_at || new Date().toISOString(),
              conversationId: t.conversation_id,
              inReplyToUserId: t.in_reply_to_user_id,
            };
          });
        } catch (error) {
          console.error('Failed to get Twitter mentions:', error);
          return [];
        }
      },

      getTweet: async (tweetId: string) => {
        const creds = await twitterOAuth.getAgentTwitterCredentials(_agentId);
        if (!creds.configured) return null;

        const { TwitterApi } = await import('twitter-api-v2');
        const client = new TwitterApi({
          appKey: creds.appKey!,
          appSecret: creds.appSecret!,
          accessToken: creds.accessToken!,
          accessSecret: creds.accessSecret!,
        });

        try {
          const tweet = await client.v2.singleTweet(tweetId, {
            expansions: ['author_id', 'referenced_tweets.id'],
            'tweet.fields': ['created_at', 'public_metrics', 'conversation_id'],
            'user.fields': ['username', 'name'],
          });

          const author = tweet.includes?.users?.find(u => u.id === tweet.data.author_id);
          return {
            id: tweet.data.id,
            text: tweet.data.text,
            authorId: tweet.data.author_id || '',
            authorUsername: author?.username,
            authorName: author?.name,
            createdAt: tweet.data.created_at || new Date().toISOString(),
            conversationId: tweet.data.conversation_id,
            metrics: tweet.data.public_metrics ? {
              replyCount: tweet.data.public_metrics.reply_count,
              retweetCount: tweet.data.public_metrics.retweet_count,
              likeCount: tweet.data.public_metrics.like_count,
              quoteCount: tweet.data.public_metrics.quote_count,
            } : undefined,
            referencedTweets: tweet.data.referenced_tweets?.map(r => ({
              type: r.type as 'replied_to' | 'quoted' | 'retweeted',
              id: r.id,
            })),
          };
        } catch (error) {
          console.error('Failed to get tweet:', error);
          return null;
        }
      },

      reply: async (tweetId: string, text: string, mediaUrls?: string[]) => {
        const creds = await twitterOAuth.getAgentTwitterCredentials(_agentId);
        if (!creds.configured) return null;

        const { TwitterApi } = await import('twitter-api-v2');
        const client = new TwitterApi({
          appKey: creds.appKey!,
          appSecret: creds.appSecret!,
          accessToken: creds.accessToken!,
          accessSecret: creds.accessSecret!,
        });

        try {
          let mediaIds: string[] | undefined;
          if (mediaUrls && mediaUrls.length > 0) {
            mediaIds = [];
            for (const url of mediaUrls.slice(0, 4)) {
              try {
                const response = await fetch(url);
                const buffer = Buffer.from(await response.arrayBuffer());
                const mediaId = await client.v1.uploadMedia(buffer, { mimeType: 'image/png' });
                mediaIds.push(mediaId);
              } catch (err) {
                console.error('Failed to upload media:', err);
              }
            }
          }

          const tweetParams: Parameters<typeof client.v2.tweet>[0] = {
            text,
            reply: { in_reply_to_tweet_id: tweetId },
          };
          if (mediaIds && mediaIds.length > 0) {
            tweetParams.media = { media_ids: mediaIds as [string] };
          }

          const result = await client.v2.tweet(tweetParams);
          const status = await twitterOAuth.getConnectionStatus(_agentId);
          return {
            tweetId: result.data.id,
            url: `https://x.com/${status.username || 'unknown'}/status/${result.data.id}`,
          };
        } catch (error) {
          console.error('Failed to reply to tweet:', error);
          return null;
        }
      },

      like: async (tweetId: string) => {
        const creds = await twitterOAuth.getAgentTwitterCredentials(_agentId);
        if (!creds.configured) return false;

        const { TwitterApi } = await import('twitter-api-v2');
        const client = new TwitterApi({
          appKey: creds.appKey!,
          appSecret: creds.appSecret!,
          accessToken: creds.accessToken!,
          accessSecret: creds.accessSecret!,
        });

        try {
          const me = await client.v2.me();
          await client.v2.like(me.data.id, tweetId);
          return true;
        } catch (error) {
          console.error('Failed to like tweet:', error);
          return false;
        }
      },

      unlike: async (tweetId: string) => {
        const creds = await twitterOAuth.getAgentTwitterCredentials(_agentId);
        if (!creds.configured) return false;

        const { TwitterApi } = await import('twitter-api-v2');
        const client = new TwitterApi({
          appKey: creds.appKey!,
          appSecret: creds.appSecret!,
          accessToken: creds.accessToken!,
          accessSecret: creds.accessSecret!,
        });

        try {
          const me = await client.v2.me();
          await client.v2.unlike(me.data.id, tweetId);
          return true;
        } catch (error) {
          console.error('Failed to unlike tweet:', error);
          return false;
        }
      },

      retweet: async (tweetId: string) => {
        const creds = await twitterOAuth.getAgentTwitterCredentials(_agentId);
        if (!creds.configured) return false;

        const { TwitterApi } = await import('twitter-api-v2');
        const client = new TwitterApi({
          appKey: creds.appKey!,
          appSecret: creds.appSecret!,
          accessToken: creds.accessToken!,
          accessSecret: creds.accessSecret!,
        });

        try {
          const me = await client.v2.me();
          await client.v2.retweet(me.data.id, tweetId);
          return true;
        } catch (error) {
          console.error('Failed to retweet:', error);
          return false;
        }
      },

      unretweet: async (tweetId: string) => {
        const creds = await twitterOAuth.getAgentTwitterCredentials(_agentId);
        if (!creds.configured) return false;

        const { TwitterApi } = await import('twitter-api-v2');
        const client = new TwitterApi({
          appKey: creds.appKey!,
          appSecret: creds.appSecret!,
          accessToken: creds.accessToken!,
          accessSecret: creds.accessSecret!,
        });

        try {
          const me = await client.v2.me();
          await client.v2.unretweet(me.data.id, tweetId);
          return true;
        } catch (error) {
          console.error('Failed to unretweet:', error);
          return false;
        }
      },

      quoteTweet: async (tweetId: string, text: string, mediaUrls?: string[]) => {
        const creds = await twitterOAuth.getAgentTwitterCredentials(_agentId);
        if (!creds.configured) return null;

        const { TwitterApi } = await import('twitter-api-v2');
        const client = new TwitterApi({
          appKey: creds.appKey!,
          appSecret: creds.appSecret!,
          accessToken: creds.accessToken!,
          accessSecret: creds.accessSecret!,
        });

        try {
          let mediaIds: string[] | undefined;
          if (mediaUrls && mediaUrls.length > 0) {
            mediaIds = [];
            for (const url of mediaUrls.slice(0, 4)) {
              try {
                const response = await fetch(url);
                const buffer = Buffer.from(await response.arrayBuffer());
                const mediaId = await client.v1.uploadMedia(buffer, { mimeType: 'image/png' });
                mediaIds.push(mediaId);
              } catch (err) {
                console.error('Failed to upload media:', err);
              }
            }
          }

          const tweetParams: Parameters<typeof client.v2.tweet>[0] = {
            text,
            quote_tweet_id: tweetId,
          };
          if (mediaIds && mediaIds.length > 0) {
            tweetParams.media = { media_ids: mediaIds as [string] };
          }

          const result = await client.v2.tweet(tweetParams);
          const status = await twitterOAuth.getConnectionStatus(_agentId);
          return {
            tweetId: result.data.id,
            url: `https://x.com/${status.username || 'unknown'}/status/${result.data.id}`,
          };
        } catch (error) {
          console.error('Failed to quote tweet:', error);
          return null;
        }
      },
    },

    // =========================================================================
    // Discord Services
    // =========================================================================
    discord: {
      getConnectionStatus: async () => {
        return discord.getConnectionStatus(_agentId);
      },

      sendMessage: async (channelId, content, options) => {
        return discord.sendMessage(_agentId, channelId, content, options);
      },

      sendWebhookMessage: async (content, options) => {
        return discord.sendWebhookMessage(_agentId, content, options);
      },

      getChannel: async (channelId) => {
        return discord.getChannel(_agentId, channelId);
      },

      listChannels: async (guildId) => {
        return discord.listChannels(_agentId, guildId);
      },

      listGuilds: async () => {
        return discord.listGuilds(_agentId);
      },

      getMessages: async (channelId, limit) => {
        return discord.getMessages(_agentId, channelId, limit);
      },

      addReaction: async (channelId, messageId, emoji) => {
        return discord.addReaction(_agentId, channelId, messageId, emoji);
      },

      removeReaction: async (channelId, messageId, emoji) => {
        return discord.removeReaction(_agentId, channelId, messageId, emoji);
      },
    },

    // =========================================================================
    // NFT Services (Agent Inhabitation & Lineage)
    // =========================================================================
    nft: createNFTServices(),
  };
}

/**
 * Create NFT services for agent inhabitation and lineage
 */
function createNFTServices(): NFTServices {
  return {
    // Gate NFT operations
    getGateStatus: async (walletAddress: string) => {
      return nftGate.getGateStatus(walletAddress);
    },

    getGateCollectionAddress: () => {
      return nftGate.getGateCollection();
    },

    // Inhabitation operations
    getInhabitationInfo: async (walletAddress: string) => {
      return agentOwnership.getInhabitationInfo(walletAddress);
    },

    listUnclaimedAgents: async () => {
      // Get all agents without an inhabitant
      const allAgents = await agents.listAgents();
      return allAgents
        .filter((agent) => !agent.inhabitantWallet)
        .map((agent) => ({
          agentId: agent.agentId,
          name: agent.name,
          description: agent.description,
          avatarUrl: agent.profileImage?.url,
          era: agent.currentEra || 0,
        }));
    },

    inhabitAgent: async (walletAddress: string, agentId: string) => {
      return agentOwnership.inhabitAgent(walletAddress, agentId);
    },

    canAbandon: async (walletAddress: string) => {
      const result = await agentOwnership.canAbandon(walletAddress);
      return {
        canAbandon: result.canAbandon,
        gateStatus: result.gateStatus,
        inhabitedAgentId: result.inhabitedAgent?.agentId,
        inhabitedAgentName: result.inhabitedAgent?.name,
      };
    },

    abandonAgent: async (walletAddress: string, burnTxSignature: string) => {
      return agentOwnership.abandonAgent(walletAddress, burnTxSignature);
    },

    // Burn verification
    verifyGateBurn: async (walletAddress: string, signature: string) => {
      return lineageNft.verifyGateBurn(walletAddress, signature);
    },

    // Lineage NFT operations
    getLineageCollection: async (agentId: string) => {
      return lineageNft.getLineageCollection(agentId);
    },

    prepareLineageMint: async (agentId: string, walletAddress: string) => {
      return lineageNft.prepareLineageMint(agentId, walletAddress);
    },

    recordLineageMint: async (
      agentId: string,
      walletAddress: string,
      nftMint: string,
      era: number,
      burnSignature?: string
    ) => {
      return lineageNft.recordLineageMint(agentId, walletAddress, nftMint, era, burnSignature);
    },

    generateLineageMetadata: (metadata) => {
      return lineageNft.generateLineageMetadataJson(metadata);
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
