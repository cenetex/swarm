/**
 * Configuration loader for agents
 * Loads agent configuration from YAML files or DynamoDB
 */
import { readFileSync, existsSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import type { AgentConfig } from '../types/index.js';

/**
 * Load agent configuration from a YAML file
 */
export function loadAgentConfigFromFile(filePath: string): AgentConfig {
  if (!existsSync(filePath)) {
    throw new Error(`Agent config file not found: ${filePath}`);
  }

  const content = readFileSync(filePath, 'utf-8');
  const parsed = parseYaml(content);

  return normalizeAgentConfig(parsed);
}

/**
 * Load agent configuration from environment variables or inline object
 */
export function loadAgentConfigFromEnv(agentId: string): AgentConfig {
  const configJson = process.env[`AGENT_CONFIG_${agentId.toUpperCase()}`];
  
  if (configJson) {
    return normalizeAgentConfig(JSON.parse(configJson));
  }

  // Build minimal config from individual env vars
  return {
    id: agentId,
    name: process.env.AGENT_NAME || agentId,
    version: '1.0.0',
    persona: process.env.AGENT_PERSONA || '',
    platforms: {
      telegram: process.env.TELEGRAM_BOT_USERNAME ? {
        enabled: true,
        botUsername: process.env.TELEGRAM_BOT_USERNAME,
        webhookPath: `/webhook/telegram/${agentId}`,
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
    },
    media: {
      image: {
        provider: (process.env.IMAGE_PROVIDER as 'openrouter' | 'replicate' | 'dalle') || 'openrouter',
        model: process.env.IMAGE_MODEL || 'openai/dall-e-3',
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
 * Normalize parsed config to ensure all required fields
 */
function normalizeAgentConfig(parsed: Record<string, unknown>): AgentConfig {
  const agent = parsed.agent as Record<string, unknown> || parsed;

  return {
    id: (agent.id as string) || 'unknown',
    name: (agent.name as string) || agent.id as string || 'Unknown Agent',
    version: (agent.version as string) || '1.0.0',
    persona: (agent.persona as string) || '',
    platforms: normalizePlatforms(parsed.platforms as Record<string, unknown> || {}),
    llm: normalizeLLM(parsed.llm as Record<string, unknown> || {}),
    media: normalizeMedia(parsed.media as Record<string, unknown> || {}),
    scheduling: (parsed.scheduling as AgentConfig['scheduling']) || {},
    behavior: normalizeBehavior(parsed.behavior as Record<string, unknown> || {}),
    solana: parsed.solana as AgentConfig['solana'],
    tools: (parsed.tools as string[]) || ['send_message', 'ignore'],
    secrets: (parsed.secrets as string[]) || [],
  };
}

function normalizePlatforms(platforms: Record<string, unknown>): AgentConfig['platforms'] {
  return {
    telegram: platforms.telegram as AgentConfig['platforms']['telegram'],
    discord: platforms.discord as AgentConfig['platforms']['discord'],
    twitter: platforms.twitter as AgentConfig['platforms']['twitter'],
    web: platforms.web as AgentConfig['platforms']['web'],
  };
}

function normalizeLLM(llm: Record<string, unknown>): AgentConfig['llm'] {
  return {
    provider: (llm.provider as 'bedrock' | 'openrouter' | 'anthropic') || 'openrouter',
    model: (llm.model as string) || 'anthropic/claude-sonnet-4',
    fallbackModel: llm.fallback_model as string,
    temperature: (llm.temperature as number) ?? 0.8,
    maxTokens: (llm.max_tokens as number) || 1024,
  };
}

function normalizeMedia(media: Record<string, unknown>): AgentConfig['media'] {
  const image = media.image as Record<string, unknown> || {};
  const video = media.video as Record<string, unknown>;

  return {
    image: {
      provider: (image.provider as 'openrouter' | 'replicate' | 'dalle') || 'openrouter',
      model: (image.model as string) || 'openai/dall-e-3',
    },
    video: video ? {
      provider: 'replicate',
      model: (video.model as string) || 'minimax/video-01',
    } : undefined,
  };
}

function normalizeBehavior(behavior: Record<string, unknown>): AgentConfig['behavior'] {
  return {
    responseDelayMs: (behavior.response_delay_ms as [number, number]) || [1000, 3000],
    typingIndicator: (behavior.typing_indicator as boolean) ?? true,
    ignoreBots: (behavior.ignore_bots as boolean) ?? true,
    cooldownMinutes: (behavior.cooldown_minutes as number) ?? 5,
    maxContextMessages: (behavior.max_context_messages as number) ?? 20,
  };
}

/**
 * Merge multiple configs with later configs overriding earlier ones
 */
export function mergeAgentConfigs(...configs: Partial<AgentConfig>[]): AgentConfig {
  const merged = configs.reduce((acc, config) => ({
    ...acc,
    ...config,
    platforms: { ...acc.platforms, ...config.platforms },
    llm: { ...acc.llm, ...config.llm },
    media: { ...acc.media, ...config.media },
    behavior: { ...acc.behavior, ...config.behavior },
    solana: config.solana || acc.solana,
  }), {} as AgentConfig);

  return merged;
}
