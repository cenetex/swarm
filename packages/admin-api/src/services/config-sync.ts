/* eslint-disable no-console -- TODO: migrate to structured logger */
/**
 * Avatar Config Sync Service
 * Syncs avatar configurations from Admin API to the main state table
 * so that Lambda handlers can access them at runtime.
 */
import {
  PutCommand,
  DeleteCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
import type { AvatarRecord } from '../types.js';
import { getDynamoClient } from './dynamo-client.js';

// Core AvatarConfig type (matches @swarm/core)
interface AvatarConfig {
  id: string;
  name: string;
  version: string;
  persona: string;
  brain?: {
    writeMode?: 'legacy' | 'dual' | 'canonical';
    readMode?: 'legacy' | 'hybrid' | 'canonical';
  };

  // Profile image for Discord webhooks and reference
  profileImage?: {
    url: string;
    s3Key?: string;
    updatedAt?: number;
  };

  // Character reference for full-body consistency in image/video generation
  characterReference?: {
    url: string;
    s3Key?: string;
    description?: string;
    generatedPrompt?: string;
    updatedAt?: number;
  };

  platforms: {
    telegram?: {
      enabled: boolean;
      botUsername: string;
      botId?: number;
      webhookPath: string;
      allowedChatTypes?: ('private' | 'group' | 'supergroup' | 'channel')[];
      allowedChatIds?: string[];
      allowedDmUserIds?: string[];
      allowedDmUsers?: Array<{ userId: string; username?: string; displayName?: string }>;
      allowedChats?: Array<{ chatId: string; username?: string; title?: string }>;
      homeChannelId?: string;
      homeChannelUsername?: string;
      homeChannelUrl?: string;
      coinSymbol?: string;
      coinAddress?: string;
    };
    twitter?: {
      enabled: boolean;
      username: string;
      features: ('scheduled_tweets' | 'mention_replies' | 'dm_responses' | 'autonomous_posts' | 'community_posts')[];
      charLimit?: number;
      verifiedType?: string;
      communities?: Array<{ id: string; name: string; postFrequency?: number }>;
      autonomousPosts?: {
        enabled: boolean;
        minIntervalHours: number;
        maxIntervalHours: number;
        imageChance: number;
        useMemories: boolean;
        topics?: string[];
      };
    };
    discord?: {
      enabled: boolean;
      mode: 'webhook' | 'bot' | 'hybrid' | 'global';
      applicationId?: string;
      publicKey?: string;
      useGateway?: boolean;
      intents?: number;
      respondToMentions?: boolean;
      respondInDMs?: boolean;
      allowedChannels?: string[];
      allowedGuilds?: string[];
    };
    web?: {
      enabled: boolean;
      corsOrigins: string[];
      rateLimit: {
        windowMs: number;
        maxRequests: number;
      };
    };
  };
  llm: {
    provider: string;
    model: string;
    temperature: number;
    maxTokens: number;
  };
  media: {
    image: {
      provider: string;
      model: string;
    };
    video?: {
      provider: string;
      model: string;
    };
  };
  scheduling: {
    tweets?: Array<{
      cron: string;
      template: string;
    }>;
  };
  behavior: {
    responseDelayMs: [number, number];
    typingIndicator: boolean;
    ignoreBots: boolean;
    cooldownMinutes: number;
    maxContextMessages: number;
  };
  voice?: {
    enabled: boolean;
    defaultVoiceId?: string;
    ttsProvider?: 'voice-clone';
    speed?: number;
    pitch?: number;
    format?: 'ogg' | 'mp3' | 'wav';
    referenceUrl?: string;
  };
  tools: string[];
  secrets: string[];
}

const dynamoClient = getDynamoClient();
const STATE_TABLE = process.env.STATE_TABLE;
const ADMIN_TABLE = process.env.ADMIN_TABLE;

/**
 * Convert AdminAPI AvatarRecord to Core AvatarConfig format
 */
export function convertToAvatarConfig(record: AvatarRecord): AvatarConfig {
  const defaultVoiceConfig = {
    enabled: true,
    ttsProvider: 'voice-clone' as const,
    format: 'ogg' as const,
    ...record.voiceConfig,
  };

  const config: AvatarConfig = {
    id: record.avatarId,
    name: record.name,
    version: '1.0.0',
    persona: record.persona || `You are ${record.name}, a helpful AI assistant.`,
    brain: record.mcpConfig?.brain ? {
      writeMode: record.mcpConfig.brain.writeMode,
      readMode: record.mcpConfig.brain.readMode,
    } : undefined,

    // Sync profile image for character reference
    profileImage: record.profileImage ? {
      url: record.profileImage.url,
      s3Key: record.profileImage.s3Key,
      updatedAt: record.profileImage.updatedAt,
    } : undefined,

    // Sync character reference for full-body consistency
    characterReference: record.characterReference ? {
      url: record.characterReference.url,
      s3Key: record.characterReference.s3Key,
      description: record.characterReference.description,
      generatedPrompt: record.characterReference.generatedPrompt,
      updatedAt: record.characterReference.updatedAt,
    } : undefined,

    platforms: {},
    llm: {
      provider: record.llmConfig.provider,
      model: record.llmConfig.model,
      temperature: record.llmConfig.temperature,
      maxTokens: record.llmConfig.maxTokens,
    },
    media: {
      image: {
        // Priority: integrations config > mediaConfig > default
        provider: 'replicate',
        model: record.integrations?.replicate?.models?.image_generation
          || record.mediaConfig?.image?.model
          || 'google/nano-banana-pro',
      },
      video: (record.integrations?.replicate?.models?.video_generation || record.mediaConfig?.video?.model) ? {
        provider: 'replicate' as const,
        model: record.integrations?.replicate?.models?.video_generation
          || record.mediaConfig?.video?.model
          || 'minimax/video-01',
      } : undefined,
    },
    scheduling: {},
    behavior: {
      responseDelayMs: [1000, 3000],
      typingIndicator: true,
      ignoreBots: true,
      cooldownMinutes: 1,
      maxContextMessages: 20,
    },
    voice: {
      enabled: defaultVoiceConfig.enabled,
      defaultVoiceId: defaultVoiceConfig.defaultVoiceId,
      ttsProvider: defaultVoiceConfig.ttsProvider,
      speed: defaultVoiceConfig.speed,
      pitch: defaultVoiceConfig.pitch,
      format: defaultVoiceConfig.format,
      referenceUrl: defaultVoiceConfig.referenceUrl,
    },
    tools: (() => {
      const tools = ['send_message', 'react', 'ignore', 'wait', 'generate_image', 'remember', 'recall'];

      // Platform-specific tool affordances (kept explicit for safety).
      // These tools are used by the shared handlers pipeline (pollers -> message-processor -> response-sender)
      // and are required for "agentic" Twitter replies (fetch tweet context, reply, etc).
      if (record.platforms.twitter?.enabled) {
        tools.push(
          'twitter_status',
          'twitter_get_tweet',
          'twitter_get_mentions',
          'twitter_get_timeline',
          'twitter_reply',
          'twitter_post',
          'twitter_like',
          'twitter_unlike',
          'twitter_retweet',
          'twitter_unretweet',
          'twitter_quote',
          'twitter_get_activity_summary'
        );
      }

      if (defaultVoiceConfig.enabled) {
        tools.push('send_voice_message', 'create_my_voice', 'transcribe_audio');
      }

      // De-dupe in case config-sync is called repeatedly.
      return Array.from(new Set(tools));
    })(),
    secrets: ['REPLICATE_API_KEY', 'OPENROUTER_API_KEY'],
  };

  // Convert Telegram config
  if (record.platforms.telegram?.enabled) {
    config.platforms.telegram = {
      enabled: true,
      botUsername: record.platforms.telegram.botUsername || '',
      botId: record.platforms.telegram.botId,
      webhookPath: `/webhook/telegram/${record.avatarId}`,
      allowedChatTypes: ['private', 'group', 'supergroup', 'channel'],
      allowedChatIds: record.platforms.telegram.allowedChatIds,
      allowedDmUserIds: record.platforms.telegram.allowedDmUserIds,
      allowedDmUsers: record.platforms.telegram.allowedDmUsers,
      allowedChats: record.platforms.telegram.allowedChats,
      homeChannelId: record.platforms.telegram.homeChannelId,
      homeChannelUsername: record.platforms.telegram.homeChannelUsername,
      homeChannelUrl: record.platforms.telegram.homeChannelUrl,
      coinSymbol: record.platforms.telegram.coinSymbol,
      coinAddress: record.platforms.telegram.coinAddress,
    };
    config.secrets.push('TELEGRAM_BOT_TOKEN');
  }

  // Convert Twitter config
  if (record.platforms.twitter?.enabled) {
    const twitterRecord = record.platforms.twitter;
    type TwitterFeature = NonNullable<AvatarConfig['platforms']['twitter']>['features'][number];
    const features: TwitterFeature[] = Array.isArray(twitterRecord.features)
      ? (twitterRecord.features as TwitterFeature[])
      : ['mention_replies', 'scheduled_tweets'];
    const autonomousPosts = twitterRecord.autonomousPosts
      ? {
          enabled: twitterRecord.autonomousPosts.enabled ?? false,
          minIntervalHours: twitterRecord.autonomousPosts.minIntervalHours ?? 4,
          maxIntervalHours: twitterRecord.autonomousPosts.maxIntervalHours ?? 6,
          imageChance: twitterRecord.autonomousPosts.imageChance ?? 0.3,
          useMemories: twitterRecord.autonomousPosts.useMemories ?? true,
          topics: twitterRecord.autonomousPosts.topics?.length
            ? twitterRecord.autonomousPosts.topics
            : undefined,
        }
      : undefined;

    config.platforms.twitter = {
      enabled: true,
      username: twitterRecord.username || '',
      features,
      communities: twitterRecord.communities,
      autonomousPosts,
    };
    config.secrets.push(
      'TWITTER_API_KEY',
      'TWITTER_API_SECRET',
      'TWITTER_ACCESS_TOKEN',
      'TWITTER_ACCESS_SECRET'
    );
    // Add scheduled tweets only when enabled.
    if (features.includes('scheduled_tweets')) {
      config.scheduling.tweets = [
        { cron: '0 12 * * *', template: 'general' },
        { cron: '0 18 * * *', template: 'general' },
      ];
    }
  }

  // Convert Discord config
  if (record.platforms.discord?.enabled) {
    const discordConfig = record.platforms.discord;
    const allowedGuilds = discordConfig.allowedGuilds
      ?? (discordConfig.guildId ? [discordConfig.guildId] : undefined);

    const discordMode = discordConfig.mode ?? 'bot';
    config.platforms.discord = {
      enabled: true,
      mode: discordMode,
      applicationId: discordConfig.applicationId,
      publicKey: discordConfig.publicKey,
      useGateway: discordConfig.useGateway ?? true,
      intents: discordConfig.intents,
      respondToMentions: discordConfig.respondToMentions ?? true,
      // Global mode is guild-only — DMs don't work with webhook identity
      respondInDMs: discordMode === 'global' ? false : (discordConfig.respondInDMs ?? true),
      allowedChannels: discordConfig.allowedChannels,
      allowedGuilds,
    };
    // Global mode uses the shared global bot token, not a per-avatar secret
    if (discordMode !== 'global') {
      config.secrets.push('DISCORD_BOT_TOKEN');
    }
  }

  // Convert Web config
  if (record.platforms.web?.enabled) {
    config.platforms.web = {
      enabled: true,
      corsOrigins: ['*'],
      rateLimit: {
        windowMs: 60000,
        maxRequests: 20,
      },
    };
  }

  // Add API keys based on LLM provider
  if (record.llmConfig.useGlobalKey) {
    // Global key will be fetched from swarm/shared/secrets
  } else {
    if (record.llmConfig.provider === 'openrouter') {
      config.secrets.push('OPENROUTER_API_KEY');
    } else if (record.llmConfig.provider === 'anthropic') {
      config.secrets.push('ANTHROPIC_API_KEY');
    }
  }

  return config;
}

/**
 * Sync an avatar config to the main state table
 */
export async function syncAvatarConfig(record: AvatarRecord): Promise<void> {
  if (!STATE_TABLE) {
    console.warn('STATE_TABLE not configured, skipping config sync');
    return;
  }

  // Only sync active avatars (not drafts or deleted)
  if (record.status === 'deleted') {
    // Remove from state table
    await dynamoClient.send(new DeleteCommand({
      TableName: STATE_TABLE,
      Key: {
        pk: `AVATAR#${record.avatarId}`,
        sk: 'CONFIG',
      },
    }));
    console.log(`Removed avatar config from state table: ${record.avatarId}`);
    return;
  }

  const config = convertToAvatarConfig(record);

  // Fetch Twitter connection data to include charLimit for premium accounts
  if (config.platforms.twitter?.enabled) {
    // Always set a default charLimit to ensure it's never undefined
    config.platforms.twitter.charLimit = 280;

    if (ADMIN_TABLE) {
      try {
        const connectionResult = await dynamoClient.send(new GetCommand({
          TableName: ADMIN_TABLE,
          Key: {
            pk: `AVATAR#${record.avatarId}`,
            sk: 'TWITTER#CONNECTION',
          },
        }));
        if (connectionResult.Item) {
          // Use stored charLimit or default to 280 (handles legacy records without charLimit)
          config.platforms.twitter.charLimit = connectionResult.Item.charLimit || 280;
          config.platforms.twitter.verifiedType = connectionResult.Item.verifiedType;
        }
      } catch (err) {
        console.warn(`Failed to fetch Twitter connection for ${record.avatarId}:`, err instanceof Error ? err.message : String(err));
        // charLimit remains at default 280
      }
    } else {
      console.warn('ADMIN_TABLE not configured, using default Twitter charLimit=280');
    }
  }

  await dynamoClient.send(new PutCommand({
    TableName: STATE_TABLE,
    Item: {
      pk: `AVATAR#${record.avatarId}`,
      sk: 'CONFIG',
      config,
      // GSI keys for efficient listing
      gsi1pk: 'CONFIG',
      gsi1sk: record.avatarId,
      // Metadata for tracking
      syncedAt: Date.now(),
      syncedFrom: 'admin-api',
      status: record.status,
    },
  }));

  console.log(`Synced avatar config to state table: ${record.avatarId}`);
}

/**
 * Check if state table sync is available
 */
export function isSyncEnabled(): boolean {
  return !!STATE_TABLE;
}
