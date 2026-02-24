/**
 * Configuration loader for avatars
 * Loads avatar configuration from YAML files or DynamoDB
 */
import { readFileSync, existsSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { AvatarConfig } from '../types/index.js';
import { ConfigError } from '../errors/errors.js';
import { SwarmErrorCode } from '../errors/codes.js';

// =============================================================================
// CONFIG FILE SCHEMAS (with defaults and snake_case support)
// =============================================================================

const TelegramConfigFileSchema = z.object({
  enabled: z.boolean().default(true),
  bot_username: z.string().optional(),
  botUsername: z.string().optional(),
  webhook_path: z.string().optional(),
  webhookPath: z.string().optional(),
  allowed_chat_types: z.array(z.enum(['private', 'group', 'supergroup', 'channel'])).optional(),
  allowedChatTypes: z.array(z.enum(['private', 'group', 'supergroup', 'channel'])).optional(),
  allowed_chat_ids: z.array(z.union([z.string(), z.number()])).optional(),
  allowedChatIds: z.array(z.union([z.string(), z.number()])).optional(),
  allowed_dm_user_ids: z.array(z.union([z.string(), z.number()])).optional(),
  allowedDmUserIds: z.array(z.union([z.string(), z.number()])).optional(),
}).transform((val) => ({
  enabled: val.enabled,
  botUsername: val.botUsername || val.bot_username || '',
  webhookPath: val.webhookPath || val.webhook_path || '',
  allowedChatTypes: val.allowedChatTypes || val.allowed_chat_types,
  allowedChatIds: (val.allowedChatIds || val.allowed_chat_ids)?.map(v => String(v)),
  allowedDmUserIds: (val.allowedDmUserIds || val.allowed_dm_user_ids)?.map(v => String(v)),
}));

const DiscordConfigFileSchema = z.object({
  enabled: z.boolean().default(true),
  mode: z.enum(['webhook', 'bot', 'hybrid']).default('webhook'),
  // Webhook mode
  webhook_url: z.string().optional(),
  webhookUrl: z.string().optional(),
  webhook_id: z.string().optional(),
  webhookId: z.string().optional(),
  webhook_token: z.string().optional(),
  webhookToken: z.string().optional(),
  // Bot mode
  application_id: z.string().optional(),
  applicationId: z.string().optional(),
  public_key: z.string().optional(),
  publicKey: z.string().optional(),
  use_gateway: z.boolean().optional(),
  useGateway: z.boolean().optional(),
  intents: z.number().optional(),
  // Behavior
  respond_to_mentions: z.boolean().optional(),
  respondToMentions: z.boolean().optional(),
  respond_in_dms: z.boolean().optional(),
  respondInDMs: z.boolean().optional(),
  allowed_channels: z.array(z.string()).optional(),
  allowedChannels: z.array(z.string()).optional(),
  allowed_guilds: z.array(z.string()).optional(),
  allowedGuilds: z.array(z.string()).optional(),
}).transform((val) => ({
  enabled: val.enabled,
  mode: val.mode,
  webhookUrl: val.webhookUrl || val.webhook_url,
  webhookId: val.webhookId || val.webhook_id,
  webhookToken: val.webhookToken || val.webhook_token,
  applicationId: val.applicationId || val.application_id,
  publicKey: val.publicKey || val.public_key,
  useGateway: val.useGateway ?? val.use_gateway,
  intents: val.intents,
  respondToMentions: val.respondToMentions ?? val.respond_to_mentions,
  respondInDMs: val.respondInDMs ?? val.respond_in_dms,
  allowedChannels: val.allowedChannels || val.allowed_channels,
  allowedGuilds: val.allowedGuilds || val.allowed_guilds,
}));

const TwitterConfigFileSchema = z.object({
  enabled: z.boolean().default(true),
  username: z.string(),
  features: z.array(z.enum(['scheduled_tweets', 'mention_replies', 'dm_responses'])).default(['scheduled_tweets', 'mention_replies']),
}).transform((val) => ({
  enabled: val.enabled,
  username: val.username,
  features: val.features,
}));

// Rate limit schema with snake_case/camelCase support
const RateLimitFileSchema = z.object({
  window_ms: z.number().optional(),
  windowMs: z.number().optional(),
  max_requests: z.number().optional(),
  maxRequests: z.number().optional(),
});

// Token gating schema with snake_case/camelCase support
const TokenGatedFileSchema = z.object({
  enabled: z.boolean(),
  token_mint: z.string().optional(),
  tokenMint: z.string().optional(),
  min_balance: z.number().optional(),
  minBalance: z.number().optional(),
});

const WebConfigFileSchema = z.object({
  enabled: z.boolean().default(true),
  cors_origins: z.array(z.string()).optional(),
  corsOrigins: z.array(z.string()).optional(),
  rate_limit: RateLimitFileSchema.optional(),
  rateLimit: RateLimitFileSchema.optional(),
  token_gated: TokenGatedFileSchema.optional(),
  tokenGated: TokenGatedFileSchema.optional(),
}).transform((val) => {
  const rateLimit = val.rateLimit || val.rate_limit;
  const tokenGated = val.tokenGated || val.token_gated;
  return {
    enabled: val.enabled,
    corsOrigins: val.corsOrigins || val.cors_origins || [],
    rateLimit: {
      windowMs: rateLimit?.windowMs || rateLimit?.window_ms || 60000,
      maxRequests: rateLimit?.maxRequests || rateLimit?.max_requests || 20,
    },
    tokenGated: tokenGated ? {
      enabled: tokenGated.enabled,
      tokenMint: tokenGated.tokenMint || tokenGated.token_mint || '',
      minBalance: tokenGated.minBalance ?? tokenGated.min_balance ?? 0,
    } : undefined,
  };
});

const PlatformConfigsFileSchema = z.object({
  telegram: TelegramConfigFileSchema.optional(),
  discord: DiscordConfigFileSchema.optional(),
  twitter: TwitterConfigFileSchema.optional(),
  web: WebConfigFileSchema.optional(),
}).default({});

const LLMConfigFileSchema = z.object({
  provider: z.enum(['bedrock', 'openrouter', 'anthropic']).default('openrouter'),
  model: z.string().default('anthropic/claude-sonnet-4'),
  fallback_model: z.string().optional(),
  fallbackModel: z.string().optional(),
  temperature: z.number().default(0.8),
  max_tokens: z.number().optional(),
  maxTokens: z.number().optional(),
  timeout_ms: z.number().optional(),
  timeoutMs: z.number().optional(),
}).transform((val) => ({
  provider: val.provider,
  model: val.model,
  fallbackModel: val.fallbackModel || val.fallback_model,
  temperature: val.temperature,
  maxTokens: val.maxTokens ?? val.max_tokens ?? 1024,
  ...((val.timeoutMs ?? val.timeout_ms) !== undefined
    ? { timeoutMs: val.timeoutMs ?? val.timeout_ms }
    : {}),
}));

const MediaConfigFileSchema = z.object({
  image: z.object({
    provider: z.enum(['openrouter', 'replicate', 'dalle']).default('replicate'),
    model: z.string().default('black-forest-labs/flux-schnell'),
  }).default({ provider: 'replicate', model: 'black-forest-labs/flux-schnell' }),
  video: z.object({
    provider: z.literal('replicate').default('replicate'),
    model: z.string().default('minimax/video-01'),
  }).optional(),
}).default({ image: { provider: 'replicate', model: 'black-forest-labs/flux-schnell' } });

const ScheduledTweetFileSchema = z.object({
  cron: z.string(),
  template: z.string(),
  enabled: z.boolean().default(true),
});

const SchedulingConfigFileSchema = z.object({
  tweets: z.array(ScheduledTweetFileSchema).optional(),
  mention_check: z.object({ cron: z.string() }).optional(),
  mentionCheck: z.object({ cron: z.string() }).optional(),
  maintenance: z.object({ cron: z.string() }).optional(),
}).transform((val) => ({
  tweets: val.tweets,
  mentionCheck: val.mentionCheck || val.mention_check,
  maintenance: val.maintenance,
})).default({ tweets: undefined, mentionCheck: undefined, maintenance: undefined });

const BehaviorConfigFileSchema = z.object({
  response_delay_ms: z.tuple([z.number(), z.number()]).optional(),
  responseDelayMs: z.tuple([z.number(), z.number()]).optional(),
  typing_indicator: z.boolean().optional(),
  typingIndicator: z.boolean().optional(),
  ignore_bots: z.boolean().optional(),
  ignoreBots: z.boolean().optional(),
  cooldown_minutes: z.number().optional(),
  cooldownMinutes: z.number().optional(),
  max_context_messages: z.number().optional(),
  maxContextMessages: z.number().optional(),
}).transform((val) => ({
  responseDelayMs: val.responseDelayMs || val.response_delay_ms || [1000, 3000] as [number, number],
  typingIndicator: val.typingIndicator ?? val.typing_indicator ?? true,
  ignoreBots: val.ignoreBots ?? val.ignore_bots ?? true,
  cooldownMinutes: val.cooldownMinutes ?? val.cooldown_minutes ?? 5,
  maxContextMessages: val.maxContextMessages ?? val.max_context_messages ?? 20,
})).default({
  responseDelayMs: [1000, 3000] as [number, number],
  typingIndicator: true,
  ignoreBots: true,
  cooldownMinutes: 5,
  maxContextMessages: 20,
});

const SolanaFeatureFileSchema = z.enum([
  'token_gating',
  'nft_generation',
  'token_transfers',
  'balance_queries',
  'wallet_verification',
]);

const SolanaConfigFileSchema = z.object({
  enabled: z.boolean().default(true),
  network: z.enum(['mainnet-beta', 'devnet', 'testnet']).default('mainnet-beta'),
  rpc_url: z.string().optional(),
  rpcUrl: z.string().optional(),
  token_mint: z.string().optional(),
  tokenMint: z.string().optional(),
  wallet_secret_name: z.string().optional(),
  walletSecretName: z.string().optional(),
  features: z.array(SolanaFeatureFileSchema).default([]),
}).transform((val) => ({
  enabled: val.enabled,
  network: val.network,
  rpcUrl: val.rpcUrl || val.rpc_url || '',
  tokenMint: val.tokenMint || val.token_mint,
  walletSecretName: val.walletSecretName || val.wallet_secret_name || '',
  features: val.features,
}));

const AvatarConfigFileSchema = z.object({
  avatar: z.object({
    id: z.string(),
    name: z.string().optional(),
    version: z.string().default('1.0.0'),
    persona: z.string().default(''),
  }).optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  version: z.string().optional(),
  persona: z.string().optional(),
  platforms: PlatformConfigsFileSchema,
  llm: LLMConfigFileSchema,
  media: MediaConfigFileSchema,
  scheduling: SchedulingConfigFileSchema,
  behavior: BehaviorConfigFileSchema,
  solana: SolanaConfigFileSchema.optional(),
  tools: z.array(z.string()).default(['send_message', 'ignore']),
  secrets: z.array(z.string()).default([]),
}).transform((val): AvatarConfig => {
  const avatar = val.avatar || { id: val.id || 'unknown', name: val.name, version: val.version, persona: val.persona };
  return {
    id: avatar.id || val.id || 'unknown',
    name: avatar.name || val.name || avatar.id || val.id || 'Unknown Avatar',
    version: avatar.version || val.version || '1.0.0',
    persona: avatar.persona || val.persona || '',
    platforms: val.platforms,
    llm: val.llm,
    media: val.media,
    scheduling: val.scheduling,
    behavior: val.behavior,
    solana: val.solana,
    tools: val.tools,
    secrets: val.secrets,
  };
});

/**
 * Load avatar configuration from a YAML file
 */
export function loadAvatarConfigFromFile(filePath: string): AvatarConfig {
  if (!existsSync(filePath)) {
    throw new ConfigError(`Avatar config file not found: ${filePath}`, {
      code: SwarmErrorCode.CONFIG_NOT_FOUND,
      context: { filePath },
    });
  }

  const content = readFileSync(filePath, 'utf-8');
  const parsed = parseYaml(content);

  const result = AvatarConfigFileSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(`Invalid avatar config: ${result.error.message}`, {
      code: SwarmErrorCode.CONFIG_VALIDATION_ERROR,
      context: { filePath, zodErrors: result.error.flatten() },
    });
  }

  return result.data;
}

/**
 * Load avatar configuration from environment variables or inline object
 */
export function loadAvatarConfigFromEnv(avatarId: string): AvatarConfig {
  const configJson = process.env[`AGENT_CONFIG_${avatarId.toUpperCase()}`];

  if (configJson) {
    const result = AvatarConfigFileSchema.safeParse(JSON.parse(configJson));
    if (!result.success) {
      throw new ConfigError(`Invalid avatar config from env: ${result.error.message}`, {
        code: SwarmErrorCode.CONFIG_VALIDATION_ERROR,
        context: { avatarId, source: 'env' },
      });
    }
    return result.data;
  }

  // Build minimal config from individual env vars
  return {
    id: avatarId,
    name: process.env.AVATAR_NAME || avatarId,
    version: '1.0.0',
    persona: process.env.AGENT_PERSONA || '',
    platforms: {
      telegram: process.env.TELEGRAM_BOT_USERNAME ? {
        enabled: true,
        botUsername: process.env.TELEGRAM_BOT_USERNAME,
        webhookPath: `/webhook/telegram/${avatarId}`,
      } : undefined,
      twitter: process.env.TWITTER_USERNAME ? {
        enabled: true,
        username: process.env.TWITTER_USERNAME,
        features: ['scheduled_tweets', 'mention_replies'],
      } : undefined,
      web: process.env.WEB_ENABLED === 'true' ? {
        enabled: true,
        corsOrigins: (process.env.WEB_CORS_ORIGINS || '*').split(','),
        rateLimit: {
          windowMs: 60000,
          maxRequests: 20,
        },
      } : undefined,
    },
    llm: {
      provider: (process.env.LLM_PROVIDER as 'bedrock' | 'openrouter' | 'anthropic') || 'openrouter',
      model: process.env.LLM_MODEL || 'anthropic/claude-sonnet-4',
      temperature: parseFloat(process.env.LLM_TEMPERATURE || '0.8'),
      maxTokens: parseInt(process.env.LLM_MAX_TOKENS || '1024', 10),
      ...(process.env.LLM_TIMEOUT_MS ? { timeoutMs: parseInt(process.env.LLM_TIMEOUT_MS, 10) } : {}),
    },
    media: {
      image: {
        provider: (process.env.IMAGE_PROVIDER as 'openrouter' | 'replicate' | 'dalle') || 'replicate',
        model: process.env.IMAGE_MODEL || 'black-forest-labs/flux-schnell',
      },
    },
    scheduling: {},
    behavior: {
      responseDelayMs: [1000, 3000],
      typingIndicator: true,
      ignoreBots: true,
      cooldownMinutes: parseInt(process.env.COOLDOWN_MINUTES || '5', 10),
      maxContextMessages: parseInt(process.env.MAX_CONTEXT_MESSAGES || '20', 10),
    },
    tools: ['send_message', 'react', 'ignore', 'wait'],
    secrets: ['TELEGRAM_BOT_TOKEN', 'TWITTER_API_KEY', 'OPENROUTER_API_KEY'],
  };
}

/**
 * Merge multiple configs with later configs overriding earlier ones
 */
export function mergeAvatarConfigs(...configs: Partial<AvatarConfig>[]): AvatarConfig {
  // Start with an empty object and merge each config
  let result: Record<string, unknown> = {};

  for (const config of configs) {
    result = {
      ...result,
      ...config,
      platforms: { ...(result.platforms as object), ...config.platforms },
      llm: { ...(result.llm as object), ...config.llm },
      media: { ...(result.media as object), ...config.media },
      behavior: { ...(result.behavior as object), ...config.behavior },
      solana: config.solana || result.solana,
    };
  }

  // Validate the merged config
  const parseResult = AvatarConfigFileSchema.safeParse(result);
  if (!parseResult.success) {
    throw new ConfigError(`Invalid merged avatar config: ${parseResult.error.message}`, {
      code: SwarmErrorCode.CONFIG_VALIDATION_ERROR,
      context: { source: 'merge' },
    });
  }

  return parseResult.data;
}

// Export the config file schema for use in other parts of the codebase
export { AvatarConfigFileSchema };
