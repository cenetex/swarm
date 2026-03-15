/**
 * Platform MCP Services Adapter
 * 
 * Bridges core services to MCP tool interfaces for platform handlers.
 * This is the production equivalent of admin-api's mcp-adapter.ts,
 * designed for use in Lambda handlers processing Telegram/Discord/Twitter messages.
 * 
 * Async Twitter Posting:
 * When POST_QUEUE_URL is configured, postTweet and reply operations are decoupled:
 * 1. Create a post in content store with status='queued'
 * 2. Enqueue to POST_QUEUE for tweet-sender to process
 * 3. Return immediately with { queued: true, postId }
 * This avoids Lambda timeout issues when image generation + Twitter posting exceed 120s.
 */
import { buildMediaUrl, logger } from '@swarm/core';
import type { AllServices } from '@swarm/mcp-server';
import type {
  AvatarConfig,
  StateService,
  MediaService,
  ContentStoreService,
  PostMedia,
} from '@swarm/core';
import { TwitterAdapter, DiscordAdapter, createContentStoreService, enqueuePost, isPostQueueConfigured, getPostQueueUrl, enqueueMediaJob, isMediaQueueConfigured, getMediaQueueUrl } from '@swarm/core';
import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { createVoiceServices } from './voice.js';
import { createRuntimeBrainService } from './brain.js';
import {
  checkMediaLimit,
  checkMediaWithEnergyFallback,
  checkVideoWithEnergyFallback,
  checkVoiceWithEnergyFallback,
  getRuntimeContract,
  getRuntimeUsageSnapshot,
} from './entitlement-enforcement.js';
import type { TokenLaunchConfig, TokenLaunchPreflightResult, TokenLaunchResult, TokenLaunchStatus } from '@swarm/core';
import { getDynamoClient } from './dynamo-client.js';
import { getAdminTable, _resetAdminTableCache } from './env-validation.js';

// Re-export for backward compatibility (tests import from this module)
export { getAdminTable, _resetAdminTableCache };

// ---------------------------------------------------------------------------
// Dynamic import helper for @swarm/admin-api
// ---------------------------------------------------------------------------
// @swarm/admin-api is NOT listed in handlers' package.json to avoid pulling in
// the full admin-api bundle as a static dependency.  At runtime the module is
// resolved via pnpm workspace hoisting.  This single helper centralises the
// the TS error suppression and the export-shape validation so every call
// site stays DRY.
// ---------------------------------------------------------------------------

/** Cached module reference so we only import once per cold start. */
let _adminApiModule: Record<string, unknown> | null = null;

/**
 * Dynamically import a named export from `@swarm/admin-api` and validate its
 * shape at runtime.
 *
 * @param exportName   Top-level export to extract (e.g. `"tokenLaunch"`).
 * @param validators   Map of property names on the export to their expected
 *                     `typeof` strings.  For exports that are themselves bare
 *                     functions (no sub-properties to check), pass an empty
 *                     object -- the helper will still verify the export exists.
 * @param expectedType Optional `typeof` check for the export itself (e.g.
 *                     `"function"`).  When omitted only the sub-property
 *                     validators are applied.
 * @returns The typed export value.
 */
async function importAdminApiExport<T>(
  exportName: string,
  validators: Record<string, string>,
  expectedType?: string,
): Promise<T> {
  if (!_adminApiModule) {
    // @ts-expect-error -- resolved at runtime via pnpm workspace hoisting
    _adminApiModule = (await import('@swarm/admin-api')) as Record<string, unknown>;
  }

  const exported = _adminApiModule[exportName] as T | undefined;

  if (exported == null) {
    throw new Error(`Failed to load ${exportName} from @swarm/admin-api: export not found`);
  }

  if (expectedType && typeof exported !== expectedType) {
    throw new Error(
      `Failed to load ${exportName} from @swarm/admin-api: expected ${expectedType}, got ${typeof exported}`,
    );
  }

  // JUSTIFIED TYPE ASSERTION:
  // Dynamic property validation requires runtime type checking of arbitrary properties.
  // The validators map provides runtime verification of expected property types.
  for (const [prop, kind] of Object.entries(validators)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof (exported as any)[prop] !== kind) {
      throw new Error(
        `Failed to load ${exportName} from @swarm/admin-api: expected ${prop} to be ${kind}`,
      );
    }
  }

  return exported;
}

// Lazy-loaded token launch operations (avoids static dependency on @swarm/admin-api)
interface TokenLaunchModule {
  preflightTokenLaunch: (avatarId: string) => Promise<TokenLaunchPreflightResult>;
  launchToken: (avatarId: string, config: TokenLaunchConfig) => Promise<TokenLaunchResult>;
  getTokenStatus: (avatarId: string) => Promise<TokenLaunchStatus>;
}

let _tokenLaunch: TokenLaunchModule | null = null;

async function getTokenLaunch(): Promise<TokenLaunchModule> {
  if (!_tokenLaunch) {
    _tokenLaunch = await importAdminApiExport<TokenLaunchModule>('tokenLaunch', {
      preflightTokenLaunch: 'function',
      launchToken: 'function',
      getTokenStatus: 'function',
    });
  }
  return _tokenLaunch;
}

const dynamoClient = getDynamoClient();

const DISCORD_API_BASE = 'https://discord.com/api/v10';

/**
 * Map Discord channel type number to human-readable string
 */
function mapDiscordChannelType(type: number): 'text' | 'voice' | 'category' | 'announcement' | 'forum' | 'thread' | 'dm' | 'group_dm' {
  const types: Record<number, 'text' | 'voice' | 'category' | 'announcement' | 'forum' | 'thread' | 'dm' | 'group_dm'> = {
    0: 'text',
    2: 'voice',
    4: 'category',
    5: 'announcement',
    10: 'thread',
    11: 'thread',
    12: 'thread',
    13: 'thread',
    15: 'forum',
    1: 'dm',
    3: 'group_dm',
  };
  return types[type] || 'text';
}

export interface PlatformServicesConfig {
  avatarId: string;
  avatarConfig: AvatarConfig;
  stateService: StateService;
  mediaService?: MediaService;
  secrets: Record<string, string>;
  wallets?: Array<{ name: string; publicKey: string; address?: string; walletType: 'solana' | 'ethereum' }>;
  mediaBucket?: string;
  cdnUrl?: string;
}

/**
 * Create MCP-compatible services for platform handlers
 * 
 * This is a lighter-weight adapter than admin-api's version since
 * platform handlers don't need all admin features (secrets management,
 * avatar CRUD, etc.)
 */
export function createPlatformMCPServices(config: PlatformServicesConfig): AllServices {
  const { avatarId, avatarConfig, stateService, mediaService, wallets } = config;
  const brainService = createRuntimeBrainService(stateService, avatarConfig.brain);
  const rawVoiceServices = createVoiceServices({
    avatarId,
    secrets: config.secrets,
    voiceConfig: avatarConfig.voice,
    mediaBucket: config.mediaBucket,
    cdnUrl: config.cdnUrl,
  });
  const twitterConfig = avatarConfig.platforms?.twitter;
  const twitterAdapter = twitterConfig
    ? new TwitterAdapter(avatarConfig, {
      appKey: config.secrets.TWITTER_API_KEY,
      appSecret: config.secrets.TWITTER_API_SECRET,
      accessToken: config.secrets.TWITTER_ACCESS_TOKEN,
      accessSecret: config.secrets.TWITTER_ACCESS_SECRET,
    })
    : null;
  let cachedTwitterUsername: string | undefined;

  // Discord adapter setup
  const discordConfig = avatarConfig.platforms?.discord;
  const discordBotToken = config.secrets.DISCORD_BOT_TOKEN || config.secrets.discord_bot_token;
  const discordWebhookUrl = discordConfig?.webhookUrl || config.secrets.DISCORD_WEBHOOK_URL || config.secrets.discord_webhook_url;
  const discordAdapter = discordConfig?.enabled
    ? new DiscordAdapter(avatarConfig, {
      botToken: discordBotToken,
      webhookUrl: discordWebhookUrl,
      webhookId: discordConfig.webhookId,
      webhookToken: discordConfig.webhookToken,
      applicationId: discordConfig.applicationId,
      publicKey: discordConfig.publicKey,
    })
    : null;

  // Initialize content store for decoupled Twitter posting
  const stateTable = process.env.STATE_TABLE;
  const contentStoreService: ContentStoreService | null = stateTable
    ? createContentStoreService(stateTable)
    : null;
  const postQueueUrl = getPostQueueUrl();
  const useDecoupledPosting = isPostQueueConfigured() && contentStoreService !== null;

  // Initialize media queue for decoupled image generation
  const mediaQueueUrl = getMediaQueueUrl();
  const useDecoupledMedia = isMediaQueueConfigured();

  const MEDIA_TOOLS = new Set(['generate_image', 'generate_video', 'generate_sticker']);

  function buildLimitError(reason?: string): string {
    return reason || 'Daily media generation limit reached';
  }

  const voiceServices = {
    ...rawVoiceServices,
    generateVoiceMessage: async (params: {
      avatarId: string;
      text: string;
      voiceId?: string;
      format?: 'ogg' | 'mp3' | 'wav';
      speed?: number;
    }) => {
      // Unified burst pool: entitlement-first, energy-fallback
      const gate = await checkVoiceWithEnergyFallback(avatarId, 1);
      if (!gate.allowed) {
        throw new Error(gate.reason || 'Daily voice generation limit reached');
      }
      return rawVoiceServices.generateVoiceMessage(params);
    },
    sendVoiceMessage: async (params: {
      avatarId: string;
      platform: string;
      text: string;
      conversationId?: string;
      voiceId?: string;
      format?: 'ogg' | 'mp3' | 'wav';
      speed?: number;
      replyToMessageId?: string;
    }) => {
      // Unified burst pool: entitlement-first, energy-fallback
      const gate = await checkVoiceWithEnergyFallback(avatarId, 1);
      if (!gate.allowed) {
        throw new Error(gate.reason || 'Daily voice generation limit reached');
      }
      return rawVoiceServices.sendVoiceMessage(params);
    },
  };

  function normalizeCdnUrl(raw?: string): string | undefined {
    if (!raw) return undefined;
    const trimmed = raw.trim().replace(/\/+$/, '');
    if (!trimmed) return undefined;
    return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  }

  function resolveMediaUrls(mediaUrls?: string[], mediaIds?: string[]): string[] {
    const resolved: string[] = [];

    if (mediaUrls && mediaUrls.length > 0) {
      resolved.push(...mediaUrls);
    }

    if (resolved.length === 0 && mediaIds && mediaIds.length > 0) {
      const cdnBase = normalizeCdnUrl(config.cdnUrl);
      const bucket = config.mediaBucket;
      for (const id of mediaIds.slice(0, 4)) {
        if (/^https?:\/\//i.test(id)) {
          resolved.push(id);
          continue;
        }
        if (cdnBase || bucket) {
          resolved.push(buildMediaUrl(id.replace(/^\/+/, ''), bucket || '', cdnBase));
          continue;
        }
      }
    }

    return resolved;
  }

  function inferMediaType(url: string): 'image' | 'video' {
    const lower = url.toLowerCase();
    if (lower.endsWith('.mp4')) return 'video';
    return 'image';
  }

  function getTwitterClient() {
    if (!twitterAdapter || !twitterAdapter.isConfigured()) {
      throw new Error('Twitter not configured');
    }
    const client = twitterAdapter.getClient();
    if (!client) {
      throw new Error('Twitter client not initialized');
    }
    return client;
  }

  async function getTwitterUsername(): Promise<string | undefined> {
    if (cachedTwitterUsername) return cachedTwitterUsername;
    if (twitterConfig?.username) {
      cachedTwitterUsername = twitterConfig.username;
      return cachedTwitterUsername;
    }
    try {
      const client = getTwitterClient();
      const me = await client.v2.me();
      cachedTwitterUsername = me.data.username;
      return cachedTwitterUsername;
    } catch {
      return undefined;
    }
  }

  return {
    // =========================================================================
    // Media Services
    // =========================================================================
    media: {
      generateImage: async (params: { prompt: string; aspectRatio?: string; platform?: string; referenceImageUrls?: string[]; conversationId?: string; replyToMessageId?: string }) => {
        // Unified burst pool: entitlement-first, energy-fallback
        const usageCheck = await checkMediaWithEnergyFallback(avatarId);
        if (!usageCheck.allowed) {
          throw new Error(buildLimitError(usageCheck.reason));
        }

        // Validate and default aspect ratio
        const validRatios = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9'] as const;
        const aspectRatio = validRatios.includes(params.aspectRatio as typeof validRatios[number])
          ? params.aspectRatio as typeof validRatios[number]
          : '1:1';

        // Decoupled path: enqueue to MEDIA_QUEUE and return immediately
        if (useDecoupledMedia && mediaQueueUrl) {
          const { jobId } = await enqueueMediaJob(mediaQueueUrl, {
            avatarId,
            conversationId: params.conversationId || 'unknown',
            platform: params.platform || 'telegram',
            replyToMessageId: params.replyToMessageId,
            prompt: params.prompt,
            aspectRatio,
            referenceImageUrls: params.referenceImageUrls,
            usageAccounted: true,
          });
          return { jobId, status: 'processing' };
        }

        // Fallback to synchronous generation if queue not configured
        if (!mediaService) {
          throw new Error('Media service not configured');
        }
        const mediaConfig = {
          ...avatarConfig.media.image,
          aspectRatio,
        };
        const result = await mediaService.generateImage(params.prompt, mediaConfig, {
          avatarId,
          platform: params.platform,
          saveToGallery: true,
          checkCredits: false,
          referenceImageUrls: params.referenceImageUrls,
        });
        // Return the real gallery item ID (if saved) instead of the raw S3 key
        const galleryItem = (result as { galleryItem?: { id: string } }).galleryItem;
        return { id: galleryItem?.id || result.s3Key || 'generated', url: result.url };
      },

      generateVideo: async (params: { prompt: string }) => {
        // Unified burst pool: entitlement-first, energy-fallback (video has higher energy cost)
        const usageCheck = await checkVideoWithEnergyFallback(avatarId);
        if (!usageCheck.allowed) {
          throw new Error(buildLimitError(usageCheck.reason));
        }
        if (!mediaService || !avatarConfig.media.video) {
          throw new Error('Video generation not configured');
        }
        const result = await mediaService.generateVideo(params.prompt, avatarConfig.media.video);
        return { jobId: result.s3Key || `video-${Date.now()}`, status: 'processing' };
      },

      generateSticker: async (params: { prompt?: string; platform?: string }) => {
        // Unified burst pool: entitlement-first, energy-fallback
        const usageCheck = await checkMediaWithEnergyFallback(avatarId);
        if (!usageCheck.allowed) {
          throw new Error(buildLimitError(usageCheck.reason));
        }
        if (!mediaService) {
          throw new Error('Media service not configured');
        }
        const stickerPrompt = `sticker style, ${params.prompt || 'cute character'}, white background, simple design`;
        const result = await mediaService.generateImage(stickerPrompt, avatarConfig.media.image, {
          avatarId,
          platform: params.platform,
          saveToGallery: true,
          checkCredits: false,
        });
        // Return the real gallery item ID (if saved) instead of the raw S3 key
        const galleryItem = (result as { galleryItem?: { id: string } }).galleryItem;
        return { id: galleryItem?.id || result.s3Key || 'sticker', url: result.url };
      },

      getProfileImageUrl: async () => {
        return avatarConfig.profileImage?.url;
      },
      getReferenceImageUrl: async (_avatarId: string, category?: string) => {
        // For 'character' category, prefer characterReference from config
        if (category === 'character' && avatarConfig.characterReference?.url) {
          return avatarConfig.characterReference.url;
        }
        // Query DynamoDB for uploaded reference images
        try {
          const dynamo = getDynamoClient();
          const table = getAdminTable();
          const skPrefix = category ? `REFERENCE#${category}#` : 'REFERENCE#';
          const result = await dynamo.send(new QueryCommand({
            TableName: table,
            KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
            ExpressionAttributeValues: {
              ':pk': `AVATAR#${avatarId}`,
              ':sk': skPrefix,
            },
            Limit: 1,
          }));
          if (result.Items && result.Items.length > 0 && result.Items[0].url) {
            return result.Items[0].url as string;
          }
        } catch (err) {
          logger.warn('Failed to query reference images from DynamoDB', { error: err, avatarId });
        }
        // Fall back to profile image
        return avatarConfig.profileImage?.url;
      },
      getCharacterReferenceUrl: async () => {
        return avatarConfig.characterReference?.url;
      },
      getBestReferenceImageUrl: async () => {
        // Prefer character reference for full-body consistency
        if (avatarConfig.characterReference?.url) {
          return avatarConfig.characterReference.url;
        }
        // Fall back to profile image
        if (avatarConfig.profileImage?.url) {
          return avatarConfig.profileImage.url;
        }
        // Query DynamoDB for uploaded 'character' category reference images
        try {
          const dynamo = getDynamoClient();
          const table = getAdminTable();
          const result = await dynamo.send(new QueryCommand({
            TableName: table,
            KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
            ExpressionAttributeValues: {
              ':pk': `AVATAR#${avatarId}`,
              ':sk': 'REFERENCE#character#',
            },
            Limit: 1,
          }));
          if (result.Items && result.Items.length > 0 && result.Items[0].url) {
            return result.Items[0].url as string;
          }
        } catch (err) {
          logger.warn('Failed to query reference images from DynamoDB', { error: err, avatarId });
        }
        return undefined;
      },
    },

    // =========================================================================
    // Media Credits (preflight checks against runtime entitlement contract)
    // =========================================================================
    mediaCredits: {
      canUseTool: async (_avatarId: string, toolName: string) => {
        if (!MEDIA_TOOLS.has(toolName)) {
          return { allowed: true };
        }
        const check = await checkMediaLimit(avatarId);
        return check.allowed
          ? { allowed: true }
          : { allowed: false, reason: check.reason || 'Daily media generation limit reached' };
      },
      consumeCredit: async () => true,
    },

    // =========================================================================
    // Job Credits (derived from runtime entitlement contract)
    // =========================================================================
    jobCredits: {
      getToolStatus: async () => {
        const [contract, usage] = await Promise.all([
          getRuntimeContract(avatarId),
          getRuntimeUsageSnapshot(avatarId),
        ]);
        const limit = contract.dailyMediaCredits;
        const used = usage.media;
        const remaining = limit === -1 ? -1 : Math.max(0, limit - used);
        return {
          generate_image: { used, limit, remaining },
          generate_video: { used, limit, remaining },
          generate_sticker: { used, limit, remaining },
        };
      },
      getEnergyStatus: async () => {
        const contract = await getRuntimeContract(avatarId);
        const energy = contract.augmentations?.energy;
        const burn = contract.augmentations?.burn;
        const maxEnergy = energy?.max ?? burn?.maxEnergy ?? 0;
        const refillPerHour = energy?.refillPerHour ?? burn?.regenPerHour;
        return {
          current: energy?.current ?? maxEnergy,
          max: maxEnergy,
          nextRefillIn: energy?.nextRefillIn ?? 0,
          refillPerHour,
          bankCredits: energy?.bankCredits,
        };
      },
    },

    // =========================================================================
    // Gallery Services (platform has read access to gallery)
    // =========================================================================
    gallery: {
      getGallery: async (_avatarId: string, options?: { type?: 'image' | 'video' | 'sticker'; limit?: number }) => {
        try {
          const limit = options?.limit || 20;
          const typeFilter = options?.type;
          const matched: Array<{
            id: string;
            url: string;
            s3Key: string;
            type: string;
            prompt?: string;
            platform?: string;
            createdAt: number;
          }> = [];
          let lastEvaluatedKey: Record<string, unknown> | undefined;
          const MAX_ROWS_SCANNED = 2000;
          let rowsScanned = 0;

          do {
            const result = await dynamoClient.send(new QueryCommand({
              TableName: getAdminTable(),
              KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
              ExpressionAttributeValues: {
                ':pk': `AVATAR#${avatarId}`,
                ':sk': 'GALLERY#',
              },
              ScanIndexForward: false, // Most recent first
              Limit: typeFilter ? 100 : limit,
              ExclusiveStartKey: lastEvaluatedKey,
            }));

            const items = (result.Items || []) as Array<{
              id: string;
              url: string;
              s3Key: string;
              type: string;
              prompt?: string;
              platform?: string;
              createdAt: number;
            }>;
            rowsScanned += items.length;

            for (const item of items) {
              if (typeFilter && item.type !== typeFilter) continue;
              matched.push(item);
              if (matched.length >= limit) break;
            }

            lastEvaluatedKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
          } while (
            matched.length < limit &&
            lastEvaluatedKey &&
            rowsScanned < MAX_ROWS_SCANNED
          );

          return matched.map(item => ({
            id: item.id,
            url: item.url,
            s3Key: item.s3Key,
            type: item.type as 'image' | 'video' | 'sticker',
            prompt: item.prompt,
            platform: item.platform,
            createdAt: item.createdAt,
          }));
        } catch {
          return [];
        }
      },
      getGalleryItem: async (_avatarId: string, itemId: string) => {
        try {
          // DynamoDB applies Limit BEFORE FilterExpression, so we must
          // paginate through all GALLERY# items to find the one we want.
          let lastEvaluatedKey: Record<string, unknown> | undefined;

          do {
            const result = await dynamoClient.send(new QueryCommand({
              TableName: getAdminTable(),
              KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
              FilterExpression: 'id = :id',
              ExpressionAttributeValues: {
                ':pk': `AVATAR#${avatarId}`,
                ':sk': 'GALLERY#',
                ':id': itemId,
              },
              ExclusiveStartKey: lastEvaluatedKey,
              Limit: 100,
            }));

            const item = result.Items?.[0] as {
              id: string;
              url: string;
              s3Key: string;
              type: string;
              prompt?: string;
              platform?: string;
              createdAt: number;
            } | undefined;

            if (item) {
              return {
                id: item.id,
                url: item.url,
                s3Key: item.s3Key,
                type: item.type as 'image' | 'video' | 'sticker',
                prompt: item.prompt,
                platform: item.platform,
                createdAt: item.createdAt,
              };
            }

            lastEvaluatedKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
          } while (lastEvaluatedKey);

          return null;
        } catch {
          return null;
        }
      },
      searchGallery: async (_avatarId: string, query: string, type?: 'image' | 'video' | 'sticker') => {
        // Simple search by prompt text — paginate through all gallery items
        try {
          const lowerQuery = query.toLowerCase();
          const matched: Array<{
            id: string;
            url: string;
            s3Key: string;
            type: string;
            prompt?: string;
            platform?: string;
            createdAt: number;
          }> = [];
          let lastEvaluatedKey: Record<string, unknown> | undefined;
          const MAX_RESULTS = 20;
          const MAX_ROWS_SCANNED = 2000;
          let rowsScanned = 0;

          do {
            const result = await dynamoClient.send(new QueryCommand({
              TableName: getAdminTable(),
              KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
              ExpressionAttributeValues: {
                ':pk': `AVATAR#${avatarId}`,
                ':sk': 'GALLERY#',
              },
              ScanIndexForward: false,
              Limit: 100,
              ExclusiveStartKey: lastEvaluatedKey,
            }));

            const items = (result.Items || []) as Array<{
              id: string;
              url: string;
              s3Key: string;
              type: string;
              prompt?: string;
              platform?: string;
              createdAt: number;
            }>;
            rowsScanned += items.length;

            for (const item of items) {
              if (type && item.type !== type) continue;
              if (!item.prompt?.toLowerCase().includes(lowerQuery)) continue;
              matched.push(item);
              if (matched.length >= MAX_RESULTS) break;
            }

            lastEvaluatedKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
          } while (
            matched.length < MAX_RESULTS &&
            lastEvaluatedKey &&
            rowsScanned < MAX_ROWS_SCANNED
          );

          return matched.map(item => ({
            id: item.id,
            url: item.url,
            s3Key: item.s3Key,
            type: item.type as 'image' | 'video' | 'sticker',
            prompt: item.prompt,
            platform: item.platform,
            createdAt: item.createdAt,
          }));
        } catch {
          return [];
        }
      },
    },

    // =========================================================================
    // Wallet Services
    // =========================================================================
    wallets: {
      listWallets: async () => {
        if (!wallets) return [];
        return wallets
          .map(w => ({
            name: w.name,
            publicKey: w.publicKey,
            address: w.address,
            walletType: w.walletType as 'solana' | 'ethereum',
            balance: 0,
            solBalance: w.walletType === 'solana' ? 0 : undefined,
            ethBalance: w.walletType === 'ethereum' ? 0 : undefined,
          }));
      },

      getBalance: async (_publicKey: string, _avatarId: string, chain = 'solana') => ({
        balance: 0,
        chain,
        solBalance: chain === 'solana' ? 0 : undefined,
        solBalanceLamports: chain === 'solana' ? 0 : undefined,
        ethBalance: chain === 'ethereum' ? 0 : undefined,
        tokens: [],
      }),
    },

    // =========================================================================
    // Model Services (read-only for platform)
    // =========================================================================
    models: {
      listModels: async () => [],
      getConfig: async () => ({
        model: avatarConfig.llm.model,
        provider: avatarConfig.llm.provider,
        temperature: avatarConfig.llm.temperature,
        maxTokens: avatarConfig.llm.maxTokens,
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
        name: avatarConfig.name,
        persona: avatarConfig.persona,
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
    // Memory Services (wired to unified brain adapter)
    // =========================================================================
    memory: {
      remember: async (fact: string, about?: string, userId?: string) => {
        const result = await brainService.remember(avatarId, fact, about, userId);
        return { saved: result.saved };
      },

      recall: async (query: string, userId?: string) => {
        const result = await brainService.recall(avatarId, query, userId);
        return {
          facts: result.facts.map((item) => ({
            fact: item.fact,
            about: item.about,
            userId: item.userId,
            timestamp: item.timestamp,
            strength: item.strength,
          })),
        };
      },
    },

    // =========================================================================
    // Voice Services
    // =========================================================================
    voice: voiceServices,

    // =========================================================================
    // Twitter Services (platform runtime)
    // =========================================================================
    ...(twitterConfig?.enabled && twitterAdapter ? {
      twitter: {
        getConnectionStatus: async () => {
          const connected = twitterAdapter.isConfigured();
          return {
            connected,
            username: twitterConfig.username,
            charLimit: twitterConfig.charLimit,
            verifiedType: twitterConfig.verifiedType,
          };
        },

        startOAuthFlow: async () => null,

        postTweet: async (text: string, mediaUrls?: string[], mediaIds?: string[]) => {
          try {
            if (!twitterAdapter.isConfigured()) {
              return { error: 'Twitter is not configured. Please connect Twitter first.' };
            }
            const resolvedMediaUrls = resolveMediaUrls(mediaUrls, mediaIds);

            // Use decoupled posting via content store + POST_QUEUE when available
            // This prevents Lambda timeouts when image generation + Twitter posting exceed 120s
            if (useDecoupledPosting && contentStoreService && postQueueUrl) {
              try {
                const media: PostMedia[] = resolvedMediaUrls.map(url => ({
                  type: inferMediaType(url),
                  url,
                }));

                // Create post in content store with 'queued' status
                const post = await contentStoreService.createPost({
                  avatarId,
                  text,
                  media: media.length > 0 ? media : undefined,
                  source: 'generated',
                  status: 'queued',
                });

                // Enqueue for tweet-sender to process
                await enqueuePost(postQueueUrl, avatarId, post.postId);

                logger.info('[Twitter] Tweet queued for async posting', {
                  postId: post.postId,
                  avatarId,
                  textLength: text.length,
                  hasMedia: media.length > 0,
                });

                const username = await getTwitterUsername();
                return {
                  queued: true,
                  postId: post.postId,
                  message: 'Tweet queued for posting',
                  // Provide a placeholder URL - will be updated by tweet-sender when posted
                  url: username ? `https://x.com/${username}` : undefined,
                };
              } catch (queueError) {
                // Fall through to synchronous posting if queue fails
                logger.warn('[Twitter] Decoupled posting failed, falling back to sync', { errorMessage: queueError instanceof Error ? queueError.message : String(queueError) });
              }
            }

            // Synchronous fallback (or when decoupled posting not configured)
            const media = resolvedMediaUrls.map(url => ({ type: inferMediaType(url), url }));
            const tweetId = await twitterAdapter.postTweet(text, media.length > 0 ? media : undefined);
            const username = await getTwitterUsername();
            return {
              tweetId,
              url: username ? `https://x.com/${username}/status/${tweetId}` : `https://x.com/i/web/status/${tweetId}`,
            };
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Failed to post tweet';
            logger.error('[TwitterAdapter.postTweet] Failed to post tweet', undefined, {
              errorDetail: errorMessage,
              textLength: text.length,
              hasMedia: (mediaUrls?.length ?? 0) > 0 || (mediaIds?.length ?? 0) > 0,
            });
            return { error: errorMessage };
          }
        },

        getTimeline: async (count = 20) => {
          try {
            const client = getTwitterClient();
            const userId = await twitterAdapter.getBotUserId();
            const timeline = await client.v2.userTimeline(userId, {
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
          } catch {
            return [];
          }
        },

        getMentions: async (sinceId?: string, count = 20) => {
          try {
            const client = getTwitterClient();
            const userId = await twitterAdapter.getBotUserId();
            const mentions = await client.v2.userMentionTimeline(userId, {
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
          } catch {
            return [];
          }
        },

        getTweet: async (tweetId: string) => {
          try {
            const client = getTwitterClient();
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
          } catch {
            return null;
          }
        },

        reply: async (tweetId: string, text: string, mediaUrls?: string[], mediaIds?: string[]) => {
          try {
            // Check if we've already replied to this tweet (deduplication)
            if (stateService.checkAndSetTweetReply) {
              const isFirstReply = await stateService.checkAndSetTweetReply(avatarId, tweetId);
              if (!isFirstReply) {
                logger.info(`[Twitter] Skipping duplicate reply to tweet ${tweetId} for avatar ${avatarId}`);
                return null; // Return null for duplicates (same as error case)
              }
            }
            
            const resolvedMediaUrls = resolveMediaUrls(mediaUrls, mediaIds);

            // Use decoupled posting via content store + POST_QUEUE when available
            if (useDecoupledPosting && contentStoreService && postQueueUrl) {
              try {
                const media: PostMedia[] = resolvedMediaUrls.map(url => ({
                  type: inferMediaType(url),
                  url,
                }));

                // Create post in content store with 'queued' status and inReplyToId
                const post = await contentStoreService.createPost({
                  avatarId,
                  text,
                  media: media.length > 0 ? media : undefined,
                  source: 'generated',
                  status: 'queued',
                  inReplyToId: tweetId,
                });

                // Enqueue for tweet-sender to process
                await enqueuePost(postQueueUrl, avatarId, post.postId);

                logger.info('[Twitter] Reply queued for async posting', {
                  postId: post.postId,
                  avatarId,
                  inReplyToId: tweetId,
                  textLength: text.length,
                  hasMedia: media.length > 0,
                });

                const username = await getTwitterUsername();
                return {
                  queued: true,
                  postId: post.postId,
                  message: 'Reply queued for posting',
                  url: username ? `https://x.com/${username}` : undefined,
                };
              } catch (queueError) {
                logger.warn('[Twitter] Decoupled reply failed, falling back to sync', { errorMessage: queueError instanceof Error ? queueError.message : String(queueError) });
              }
            }

            // Synchronous fallback
            const media = resolvedMediaUrls.map(url => ({ type: inferMediaType(url), url }));
            const replyId = await twitterAdapter.postTweet(text, media.length > 0 ? media : undefined, tweetId);
            const username = await getTwitterUsername();
            return {
              tweetId: replyId,
              url: username ? `https://x.com/${username}/status/${replyId}` : `https://x.com/i/web/status/${replyId}`,
            };
          } catch {
            return null;
          }
        },

        like: async (tweetId: string) => {
          try {
            const client = getTwitterClient();
            const userId = await twitterAdapter.getBotUserId();
            await client.v2.like(userId, tweetId);
            return true;
          } catch {
            return false;
          }
        },

        unlike: async (tweetId: string) => {
          try {
            const client = getTwitterClient();
            const userId = await twitterAdapter.getBotUserId();
            await client.v2.unlike(userId, tweetId);
            return true;
          } catch {
            return false;
          }
        },

        retweet: async (tweetId: string) => {
          try {
            const client = getTwitterClient();
            const userId = await twitterAdapter.getBotUserId();
            await client.v2.retweet(userId, tweetId);
            return true;
          } catch {
            return false;
          }
        },

        unretweet: async (tweetId: string) => {
          try {
            const client = getTwitterClient();
            const userId = await twitterAdapter.getBotUserId();
            await client.v2.unretweet(userId, tweetId);
            return true;
          } catch {
            return false;
          }
        },

        quoteTweet: async (tweetId: string, text: string, mediaUrls?: string[], mediaIds?: string[]) => {
          try {
            const resolvedMediaUrls = resolveMediaUrls(mediaUrls, mediaIds);
            const media = resolvedMediaUrls.map(url => ({ type: inferMediaType(url), url }));
            const quoteId = await twitterAdapter.quoteTweet(text, tweetId, media.length > 0 ? media : undefined);
            const username = await getTwitterUsername();
            return {
              tweetId: quoteId,
              url: username ? `https://x.com/${username}/status/${quoteId}` : `https://x.com/i/web/status/${quoteId}`,
            };
          } catch {
            return null;
          }
        },

        getActivitySummary: async () => {
          try {
            const mentions = await (async () => {
              const client = getTwitterClient();
              const userId = await twitterAdapter.getBotUserId();
              const result = await client.v2.userMentionTimeline(userId, {
                max_results: 10,
                'tweet.fields': ['created_at'],
              });
              return result.data.data || [];
            })();

            return {
              pendingMentions: mentions.length,
              lastMentionAt: mentions[0]?.created_at,
              summary: mentions.length > 0
                ? `${mentions.length} pending mention(s) to review`
                : 'No pending mentions',
            };
          } catch {
            return null;
          }
        },
      },
    } : {}),

    // =========================================================================
    // Discord Services (platform runtime)
    // =========================================================================
    ...(discordConfig?.enabled && discordAdapter ? {
      discord: {
        getConnectionStatus: async () => {
          const hasBotToken = !!discordBotToken;
          const hasWebhook = !!discordWebhookUrl;

          if (!hasBotToken && !hasWebhook) {
            return { connected: false, mode: 'none' as const };
          }

          let mode: 'webhook' | 'bot' | 'hybrid' | 'none' = 'none';
          if (hasBotToken && hasWebhook) {
            mode = 'hybrid';
          } else if (hasBotToken) {
            mode = 'bot';
          } else if (hasWebhook) {
            mode = 'webhook';
          }

          const result: {
            connected: boolean;
            mode: 'webhook' | 'bot' | 'hybrid' | 'none';
            botUsername?: string;
            botId?: string;
            webhookConfigured?: boolean;
            guilds?: Array<{ id: string; name: string; memberCount?: number }>;
          } = {
            connected: true,
            mode,
            webhookConfigured: hasWebhook,
          };

          if (discordBotToken) {
            try {
              const meResponse = await fetch(`${DISCORD_API_BASE}/users/@me`, {
                headers: { Authorization: `Bot ${discordBotToken}` },
              });
              if (meResponse.ok) {
                const me = (await meResponse.json()) as { id: string; username: string };
                result.botId = me.id;
                result.botUsername = me.username;
              }

              const guildsResponse = await fetch(`${DISCORD_API_BASE}/users/@me/guilds`, {
                headers: { Authorization: `Bot ${discordBotToken}` },
              });
              if (guildsResponse.ok) {
                const guilds = (await guildsResponse.json()) as Array<{
                  id: string;
                  name: string;
                  approximate_member_count?: number;
                }>;
                result.guilds = guilds.map(g => ({
                  id: g.id,
                  name: g.name,
                  memberCount: g.approximate_member_count,
                }));
              }
            } catch (error) {
              logger.error('[Discord] Failed to fetch bot info', error);
            }
          }

          return result;
        },

        sendMessage: async (
          channelId: string,
          content: string,
          options?: {
            embeds?: Array<{
              title?: string;
              description?: string;
              color?: number;
              image?: { url: string };
              fields?: Array<{ name: string; value: string; inline?: boolean }>;
            }>;
            replyTo?: string;
          }
        ) => {
          if (!discordBotToken) return null;

          const payload: Record<string, unknown> = { content };
          if (options?.replyTo) {
            payload.message_reference = { message_id: options.replyTo };
          }
          if (options?.embeds) {
            payload.embeds = options.embeds;
          }

          try {
            const response = await fetch(`${DISCORD_API_BASE}/channels/${channelId}/messages`, {
              method: 'POST',
              headers: {
                Authorization: `Bot ${discordBotToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(payload),
            });

            if (!response.ok) {
              const error = await response.text();
              logger.error('[Discord] Send message failed', undefined, { responseError: String(error) });
              return null;
            }

            const message = (await response.json()) as { id: string };
            return { messageId: message.id };
          } catch (error) {
            logger.error('[Discord] Send message error', error);
            return null;
          }
        },

        sendWebhookMessage: async (
          content: string,
          options?: {
            username?: string;
            avatarUrl?: string;
            embeds?: Array<Record<string, unknown>>;
          }
        ) => {
          const webhookUrl = discordWebhookUrl;
          if (!webhookUrl) return null;

          const payload: Record<string, unknown> = {
            content,
            username: options?.username || avatarConfig.name,
            avatar_url: options?.avatarUrl || avatarConfig.profileImage?.url,
          };
          if (options?.embeds) {
            payload.embeds = options.embeds;
          }

          try {
            const url = webhookUrl.includes('?') ? `${webhookUrl}&wait=true` : `${webhookUrl}?wait=true`;
            const response = await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
            });

            if (!response.ok) {
              const error = await response.text();
              logger.error('[Discord] Webhook message failed', undefined, { responseError: String(error) });
              return null;
            }

            const message = (await response.json()) as { id?: string };
            return { messageId: message.id };
          } catch (error) {
            logger.error('[Discord] Webhook message error', error);
            return null;
          }
        },

        getChannel: async (channelId: string) => {
          if (!discordBotToken) return null;

          try {
            const response = await fetch(`${DISCORD_API_BASE}/channels/${channelId}`, {
              headers: { Authorization: `Bot ${discordBotToken}` },
            });
            if (!response.ok) return null;

            const channel = (await response.json()) as {
              id: string;
              name: string;
              type: number;
              guild_id?: string;
              parent_id?: string;
            };
            return {
              id: channel.id,
              name: channel.name,
              type: mapDiscordChannelType(channel.type),
              guildId: channel.guild_id,
              parentId: channel.parent_id,
            };
          } catch (error) {
            logger.error('[Discord] Get channel error', error);
            return null;
          }
        },

        listChannels: async (guildId: string) => {
          if (!discordBotToken) return [];

          try {
            const response = await fetch(`${DISCORD_API_BASE}/guilds/${guildId}/channels`, {
              headers: { Authorization: `Bot ${discordBotToken}` },
            });
            if (!response.ok) return [];

            const channels = (await response.json()) as Array<{
              id: string;
              name: string;
              type: number;
              parent_id?: string;
            }>;
            return channels.map(c => ({
              id: c.id,
              name: c.name,
              type: mapDiscordChannelType(c.type),
              guildId,
              parentId: c.parent_id,
            }));
          } catch (error) {
            logger.error('[Discord] List channels error', error);
            return [];
          }
        },

        listGuilds: async () => {
          if (!discordBotToken) return [];

          try {
            const response = await fetch(`${DISCORD_API_BASE}/users/@me/guilds`, {
              headers: { Authorization: `Bot ${discordBotToken}` },
            });
            if (!response.ok) return [];

            const guilds = (await response.json()) as Array<{
              id: string;
              name: string;
              icon?: string;
              approximate_member_count?: number;
            }>;
            return guilds.map(g => ({
              id: g.id,
              name: g.name,
              icon: g.icon,
              memberCount: g.approximate_member_count,
            }));
          } catch (error) {
            logger.error('[Discord] List guilds error', error);
            return [];
          }
        },

        getMessages: async (channelId: string, limit = 20) => {
          if (!discordBotToken) return [];

          try {
            const response = await fetch(
              `${DISCORD_API_BASE}/channels/${channelId}/messages?limit=${limit}`,
              { headers: { Authorization: `Bot ${discordBotToken}` } }
            );
            if (!response.ok) return [];

            const messages = (await response.json()) as Array<{
              id: string;
              channel_id: string;
              content: string;
              author: { id: string; username: string };
              timestamp: string;
              attachments?: Array<{ url: string; content_type?: string }>;
            }>;
            return messages.map(m => ({
              id: m.id,
              channelId: m.channel_id,
              content: m.content,
              authorId: m.author.id,
              authorUsername: m.author.username,
              createdAt: m.timestamp,
              attachments: m.attachments?.map(a => ({
                url: a.url,
                type: a.content_type || 'unknown',
              })),
            }));
          } catch (error) {
            logger.error('[Discord] Get messages error', error);
            return [];
          }
        },

        addReaction: async (channelId: string, messageId: string, emoji: string) => {
          if (!discordBotToken) return false;

          try {
            const encodedEmoji = encodeURIComponent(emoji);
            const response = await fetch(
              `${DISCORD_API_BASE}/channels/${channelId}/messages/${messageId}/reactions/${encodedEmoji}/@me`,
              {
                method: 'PUT',
                headers: { Authorization: `Bot ${discordBotToken}` },
              }
            );
            return response.ok;
          } catch (error) {
            logger.error('[Discord] Add reaction error', error);
            return false;
          }
        },

        removeReaction: async (channelId: string, messageId: string, emoji: string) => {
          if (!discordBotToken) return false;

          try {
            const encodedEmoji = encodeURIComponent(emoji);
            const response = await fetch(
              `${DISCORD_API_BASE}/channels/${channelId}/messages/${messageId}/reactions/${encodedEmoji}/@me`,
              {
                method: 'DELETE',
                headers: { Authorization: `Bot ${discordBotToken}` },
              }
            );
            return response.ok;
          } catch (error) {
            logger.error('[Discord] Remove reaction error', error);
            return false;
          }
        },

        setPresence: async (_status: 'online' | 'idle' | 'dnd' | 'invisible', _activity?: string) => {
          // Presence can only be set via the Gateway WebSocket (discord-gateway.ts),
          // not via REST API. Return false from platform handler context.
          logger.warn('[Discord] setPresence is only available via the Gateway WebSocket connection');
          return false;
        },
      },
    } : {}),

    // =========================================================================
    // Token Launch Services
    // =========================================================================
    tokenLaunch: {
      preflightLaunch: async (targetAvatarId: string) => {
        const tokenLaunch = await getTokenLaunch();
        return tokenLaunch.preflightTokenLaunch(targetAvatarId);
      },
      launchToken: async (targetAvatarId: string, launchConfig: TokenLaunchConfig) => {
        const tokenLaunch = await getTokenLaunch();
        return tokenLaunch.launchToken(targetAvatarId, launchConfig);
      },
      getTokenStatus: async (targetAvatarId: string) => {
        const tokenLaunch = await getTokenLaunch();
        return tokenLaunch.getTokenStatus(targetAvatarId);
      },
    },

    // =========================================================================
    // Billing Services (read-only status + usage from entitlements)
    // =========================================================================
    billing: {
      createCheckoutSession: async (params) => {
        type CheckoutFn = (p: {
          accountId: string; avatarId: string; plan: string;
          successUrl: string; cancelUrl: string;
          customerId?: string; customerEmail?: string;
        }) => Promise<{ id: string; url?: string }>;

        const createStripeCheckoutSession = await importAdminApiExport<CheckoutFn>(
          'createStripeCheckoutSession',
          {},
          'function',
        );
        const session = await createStripeCheckoutSession({
          accountId: params.accountId,
          avatarId: params.avatarId,
          plan: params.plan,
          successUrl: params.successUrl,
          cancelUrl: params.cancelUrl,
          customerId: params.customerId,
          customerEmail: params.customerEmail,
        });
        return { checkoutUrl: session.url || '', sessionId: session.id };
      },
      createPortalSession: async (params) => {
        type PortalFn = (p: {
          customerId: string; returnUrl: string;
        }) => Promise<{ id: string; url?: string }>;

        const createStripeCustomerPortalSession = await importAdminApiExport<PortalFn>(
          'createStripeCustomerPortalSession',
          {},
          'function',
        );
        const portal = await createStripeCustomerPortalSession({
          customerId: params.customerId,
          returnUrl: params.returnUrl,
        });
        return { portalUrl: portal.url || '' };
      },
      getBillingStatus: async (targetAvatarId: string) => {
        // Query admin table directly to avoid cross-package dependency
        const result = await dynamoClient.send(new QueryCommand({
          TableName: getAdminTable(),
          IndexName: 'GSI1',
          KeyConditionExpression: 'gsi1pk = :pk AND gsi1sk = :sk',
          ExpressionAttributeValues: {
            ':pk': `AVATAR#${targetAvatarId}`,
            ':sk': 'ENTITLEMENT',
          },
          Limit: 1,
        }));
        const ent = result.Items?.[0];
        if (!ent) return null;
        const limits = ent.limits || {};
        return {
          accountId: ent.accountId as string,
          avatarId: ent.avatarId as string,
          plan: (ent.plan || 'free') as 'free' | 'pro' | 'enterprise' | 'team',
          status: (ent.status || 'active') as 'active' | 'suspended' | 'cancelled' | 'trial',
          stripeSubscriptionId: ent.stripeSubscriptionId as string | undefined,
          stripeCustomerId: ent.stripeCustomerId as string | undefined,
          trialEndsAt: ent.trialEndsAt as number | undefined,
          suspendedAt: ent.suspendedAt as number | undefined,
          suspendedReason: ent.suspendedReason as string | undefined,
          limits: {
            dailyMessageLimit: (limits.dailyMessageLimit ?? 50) as number,
            dailyMediaCredits: (limits.dailyMediaCredits ?? 5) as number,
            dailyVoiceMinutes: (limits.dailyVoiceMinutes ?? 2) as number,
            maxToolCallsPerMessage: (limits.maxToolCallsPerMessage ?? 3) as number,
            maxPlatforms: (limits.maxPlatforms ?? 1) as number,
            maxChannels: (limits.maxChannels ?? 2) as number,
            memoryEnabled: (limits.memoryEnabled ?? false) as boolean,
            memoryRetentionDays: (limits.memoryRetentionDays ?? 0) as number,
            autonomousPostsEnabled: (limits.autonomousPostsEnabled ?? false) as boolean,
            customModelEnabled: (limits.customModelEnabled ?? false) as boolean,
            priorityProcessing: (limits.priorityProcessing ?? false) as boolean,
          },
        };
      },
      getUsage: async (targetAvatarId: string, date?: string) => {
        const dateStr = date || new Date().toISOString().split('T')[0];
        const result = await dynamoClient.send(new GetCommand({
          TableName: getAdminTable(),
          Key: {
            pk: `USAGE#${targetAvatarId}`,
            sk: `DAY#${dateStr}`,
          },
        }));
        const item = result.Item;
        if (!item) return null;
        return {
          avatarId: item.avatarId as string,
          date: item.date as string,
          messagesProcessed: (item.messagesProcessed || 0) as number,
          mediaCreditsUsed: (item.mediaCreditsUsed || 0) as number,
          voiceMinutesUsed: (item.voiceMinutesUsed || 0) as number,
          toolCallsMade: (item.toolCallsMade || 0) as number,
          imageGenerations: (item.imageGenerations || 0) as number,
          videoGenerations: (item.videoGenerations || 0) as number,
          stickerGenerations: (item.stickerGenerations || 0) as number,
        };
      },
    },
  };
}
