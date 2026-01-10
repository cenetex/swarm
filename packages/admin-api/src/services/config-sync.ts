/**
 * Agent Config Sync Service
 * Syncs agent configurations from Admin API to the main state table
 * so that Lambda handlers can access them at runtime.
 */
import {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { AgentRecord } from '../types.js';

// Core AgentConfig type (matches @swarm/core)
interface AgentConfig {
  id: string;
  name: string;
  version: string;
  persona: string;
  platforms: {
    telegram?: {
      enabled: boolean;
      botUsername: string;
      webhookPath: string;
      allowedChatTypes?: ('private' | 'group' | 'supergroup' | 'channel')[];
    };
    twitter?: {
      enabled: boolean;
      username: string;
      features: ('scheduled_tweets' | 'mention_replies' | 'dm_responses')[];
    };
    discord?: {
      enabled: boolean;
      applicationId: string;
      publicKey: string;
      useGateway: boolean;
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
  tools: string[];
  secrets: string[];
}

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const STATE_TABLE = process.env.STATE_TABLE;

/**
 * Convert AdminAPI AgentRecord to Core AgentConfig format
 */
function convertToAgentConfig(record: AgentRecord): AgentConfig {
  const config: AgentConfig = {
    id: record.agentId,
    name: record.name,
    version: '1.0.0',
    persona: record.persona || `You are ${record.name}, a helpful AI assistant.`,
    platforms: {},
    llm: {
      provider: record.llmConfig.provider,
      model: record.llmConfig.model,
      temperature: record.llmConfig.temperature,
      maxTokens: record.llmConfig.maxTokens,
    },
    media: {
      image: {
        provider: 'openrouter',
        model: 'openai/dall-e-3',
      },
    },
    scheduling: {},
    behavior: {
      responseDelayMs: [1000, 3000],
      typingIndicator: true,
      ignoreBots: true,
      cooldownMinutes: 1,
      maxContextMessages: 20,
    },
    tools: ['send_message', 'react', 'ignore', 'wait'],
    secrets: [],
  };

  // Convert Telegram config
  if (record.platforms.telegram?.enabled) {
    config.platforms.telegram = {
      enabled: true,
      botUsername: record.platforms.telegram.botUsername || '',
      webhookPath: `/webhook/telegram/${record.agentId}`,
      allowedChatTypes: ['private', 'group', 'supergroup'],
    };
    config.secrets.push('TELEGRAM_BOT_TOKEN');
  }

  // Convert Twitter config
  if (record.platforms.twitter?.enabled) {
    config.platforms.twitter = {
      enabled: true,
      username: record.platforms.twitter.username || '',
      features: ['mention_replies', 'scheduled_tweets'],
    };
    config.secrets.push(
      'TWITTER_API_KEY',
      'TWITTER_API_SECRET',
      'TWITTER_ACCESS_TOKEN',
      'TWITTER_ACCESS_SECRET'
    );
    // Add scheduled tweets
    config.scheduling.tweets = [
      { cron: '0 12 * * *', template: 'general' },
      { cron: '0 18 * * *', template: 'general' },
    ];
  }

  // Convert Discord config
  if (record.platforms.discord?.enabled) {
    config.platforms.discord = {
      enabled: true,
      applicationId: '',
      publicKey: '',
      useGateway: false,
    };
    config.secrets.push('DISCORD_BOT_TOKEN');
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
 * Sync an agent config to the main state table
 */
export async function syncAgentConfig(record: AgentRecord): Promise<void> {
  if (!STATE_TABLE) {
    console.warn('STATE_TABLE not configured, skipping config sync');
    return;
  }

  // Only sync active agents (not drafts or deleted)
  if (record.status === 'deleted') {
    // Remove from state table
    await dynamoClient.send(new DeleteCommand({
      TableName: STATE_TABLE,
      Key: {
        pk: `AGENT#${record.agentId}`,
        sk: 'CONFIG',
      },
    }));
    console.log(`Removed agent config from state table: ${record.agentId}`);
    return;
  }

  const config = convertToAgentConfig(record);

  await dynamoClient.send(new PutCommand({
    TableName: STATE_TABLE,
    Item: {
      pk: `AGENT#${record.agentId}`,
      sk: 'CONFIG',
      config,
      // Metadata for tracking
      syncedAt: Date.now(),
      syncedFrom: 'admin-api',
      status: record.status,
    },
  }));

  console.log(`Synced agent config to state table: ${record.agentId}`);
}

/**
 * Check if state table sync is available
 */
export function isSyncEnabled(): boolean {
  return !!STATE_TABLE;
}
