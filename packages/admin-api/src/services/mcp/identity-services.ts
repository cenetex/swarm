/* eslint-disable no-console -- TODO: migrate to structured logger */
/**
 * MCP Identity & Configuration Services
 *
 * Service implementations for profile, secrets, wallets, models,
 * avatar status, billing, and token launch.
 */
import type { AllServices } from '@swarm/mcp-server';
import {
  DEFAULT_LLM_MODEL,
  DEFAULT_LLM_PROVIDER,
  DEFAULT_LLM_TEMPERATURE,
  DEFAULT_LLM_MAX_TOKENS,
} from '@swarm/core';
import type { UserSession, SecretType } from '../../types.js';
import type { TokenLaunchConfig } from '../web3/token-launch.js';
import type { ServiceContainer } from '../service-container.js';
import { getValidModelId } from '../models-registry.js';
import { fetchWithTimeout, API_TIMEOUT_MS } from './helpers.js';

type IdentityServices = Pick<
  AllServices,
  'profile' | 'secrets' | 'wallets' | 'models' | 'avatar' | 'billing' | 'tokenLaunch'
>;

/**
 * Create identity and configuration MCP services for a specific avatar.
 */
export function createIdentityServices(
  _avatarId: string,
  session: UserSession,
  svc: ServiceContainer,
): IdentityServices {
  const {
    avatars,
    secrets,
    wallets,
    telegram,
    media,
    credits: _credits,
    entitlements,
    tokenLaunch,
    telegramAdmin: { setupTelegramIntegration: _setupTelegramIntegration },
    replicate: { validateReplicateApiKey: _validateReplicateApiKey },
    stripe: { createStripeCheckoutSession: _createStripeCheckoutSession, createStripeCustomerPortalSession: _createStripeCustomerPortalSession },
  } = svc;

  return {
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

      setCharacterReference: async (avatarId, source, description) => {
        if (source.type === 'generate') {
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

        models = models.filter(m => {
          const modality = m.architecture?.modality;
          if (!modality) return true;
          return modality.includes('text');
        });

        if (family) {
          const f = family.toLowerCase();
          models = models.filter(m => m.id.toLowerCase().startsWith(f + '/') || m.id.toLowerCase().includes('/' + f));
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
    // Avatar Status Services
    // =========================================================================
    avatar: {
      setStatus: async (avatarId: string, status: 'draft' | 'active' | 'paused') => {
        try {
          const avatar = await avatars.getAvatar(avatarId);
          if (!avatar) {
            return { success: false, error: 'Avatar not found.' };
          }

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
