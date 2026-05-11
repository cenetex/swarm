/**
 * Claude Code Callback Handler
 *
 * Processes callbacks from the Claude Code worker and sends responses to users.
 * This is a shared handler that routes responses to the appropriate avatar.
 */
import type { SQSEvent, Context, SQSBatchResponse, Handler } from 'aws-lambda';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import {
  TelegramAdapter,
  TwitterAdapter,
  WebAdapter,
  DiscordAdapter,
  PlatformRegistry,
  createSecretsService,
  logger,
  DEFAULT_LLM_MODEL,
  DEFAULT_MODELS,
  type AvatarConfig,
  type ResponseAction,
} from '@swarm/core';
import { extractAvatarConfigFromStateItem } from '../utils/extract-avatar-config.js';
import { getDynamoClient } from '../services/dynamo-client.js';

const dynamo = getDynamoClient();

const STATE_TABLE = process.env.STATE_TABLE!;

/**
 * Claude Code callback message from the worker
 */
interface ClaudeCodeCallback {
  type: 'claude_code_callback';
  jobId: string;
  avatarId: string;
  conversationId?: string;
  replyToMessageId?: string;
  status: 'pending' | 'processing' | 'waiting_input' | 'completed' | 'failed';
  sessionId?: string;
  result?: string;
  error?: string;
  question?: {
    text: string;
    options: Array<{ label: string; description: string }>;
  };
}

// Cache for avatar configs and secrets
const avatarache = new Map<
  string,
  {
    config: AvatarConfig;
    secrets: Record<string, string>;
    registry: PlatformRegistry;
  }
>();

/**
 * Load avatar config and initialize platform adapters
 */
async function getAvatarContext(avatarId: string) {
  if (avatarache.has(avatarId)) {
    return avatarache.get(avatarId)!;
  }

  // Load avatar config from DynamoDB
  const configResult = await dynamo.send(
    new GetCommand({
      TableName: STATE_TABLE,
      Key: {
        pk: `AVATAR#${avatarId}`,
        sk: 'CONFIG',
      },
    })
  );

  const config = extractAvatarConfigFromStateItem(configResult.Item) || {
    id: avatarId,
    name: avatarId,
    version: '1.0.0',
    persona: '',
    platforms: {},
    llm: {
      provider: 'openrouter',
      model: DEFAULT_LLM_MODEL,
      temperature: 0.8,
      maxTokens: 1024,
    },
    media: { image: { provider: 'replicate', model: DEFAULT_MODELS.image_generation } },
    scheduling: {},
    behavior: {
      responseDelayMs: [1000, 3000],
      typingIndicator: true,
      ignoreBots: true,
      cooldownMinutes: 5,
      maxContextMessages: 20,
    },
    tools: [],
    secrets: [],
  };

  // Load secrets
  const secretsService = createSecretsService();
  const secrets = await secretsService.getSecretJson<Record<string, string>>(
    `swarm/${avatarId}/secrets`
  );

  // Initialize platform adapters
  const registry = new PlatformRegistry();

  if (config.platforms.telegram?.enabled && secrets.TELEGRAM_BOT_TOKEN) {
    registry.register(new TelegramAdapter(config, secrets.TELEGRAM_BOT_TOKEN));
  }

  if (config.platforms.twitter?.enabled && secrets.TWITTER_API_KEY) {
    registry.register(
      new TwitterAdapter(config, {
        appKey: secrets.TWITTER_API_KEY,
        appSecret: secrets.TWITTER_API_SECRET,
        accessToken: secrets.TWITTER_ACCESS_TOKEN,
        accessSecret: secrets.TWITTER_ACCESS_SECRET,
      })
    );
  }

  if (config.platforms.web?.enabled) {
    registry.register(new WebAdapter(config));
  }

  if (config.platforms.discord?.enabled) {
    registry.register(
      new DiscordAdapter(config, {
        botToken: secrets.DISCORD_BOT_TOKEN || secrets.discord_bot_token,
        webhookUrl: config.platforms.discord.webhookUrl,
        webhookId: config.platforms.discord.webhookId,
        webhookToken: config.platforms.discord.webhookToken,
        applicationId: config.platforms.discord.applicationId,
        publicKey: config.platforms.discord.publicKey,
      })
    );
  }

  const context = { config, secrets, registry };
  avatarache.set(avatarId, context);
  return context;
}

/**
 * Format callback as user-facing message
 */
function formatCallbackMessage(callback: ClaudeCodeCallback): string {
  switch (callback.status) {
    case 'completed':
      if (callback.result) {
        // Truncate long results
        const maxLength = 4000;
        if (callback.result.length > maxLength) {
          return `Task completed:\n\n${callback.result.slice(0, maxLength)}...\n\n[Result truncated - ${callback.result.length} chars total]`;
        }
        return `Task completed:\n\n${callback.result}`;
      }
      return 'Task completed successfully.';

    case 'failed':
      return `Task failed: ${callback.error || 'Unknown error'}`;

    case 'waiting_input':
      if (callback.question) {
        let msg = `Claude Code needs your input:\n\n${callback.question.text}`;
        if (callback.question.options.length > 0) {
          msg += '\n\nOptions:';
          for (const opt of callback.question.options) {
            msg += `\n• ${opt.label}: ${opt.description}`;
          }
        }
        msg += `\n\nReply with your answer. (Session: ${callback.sessionId?.slice(0, 8)}...)`;
        return msg;
      }
      return 'Claude Code is waiting for your input.';

    case 'processing':
      return 'Claude Code is working on your task...';

    default:
      return `Task status: ${callback.status}`;
  }
}

/**
 * Detect platform from conversation ID format
 */
function detectPlatform(
  conversationId: string
): 'telegram' | 'discord' | 'twitter' | 'web' {
  // Telegram chat IDs are numeric (possibly negative for groups)
  if (/^-?\d+$/.test(conversationId)) {
    return 'telegram';
  }
  // Discord channel IDs are snowflakes (large numeric)
  if (/^\d{17,19}$/.test(conversationId)) {
    return 'discord';
  }
  // Twitter conversation IDs contain dashes or are tweet IDs
  if (conversationId.includes('-') || conversationId.startsWith('tweet_')) {
    return 'twitter';
  }
  // Default to web
  return 'web';
}

export const handler: Handler<SQSEvent, SQSBatchResponse> = async (
  event: SQSEvent,
  context: Context
): Promise<SQSBatchResponse> => {
  logger.setContext({ requestId: context.awsRequestId });

  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    try {
      const callback = JSON.parse(record.body) as ClaudeCodeCallback;

      if (callback.type !== 'claude_code_callback') {
        logger.warn('Unexpected message type', { type: callback.type });
        continue;
      }

      logger.info('Processing Claude Code callback', {
        jobId: callback.jobId,
        avatarId: callback.avatarId,
        status: callback.status,
      });

      // Skip pending/processing status updates (only notify on actionable states)
      if (callback.status === 'pending' || callback.status === 'processing') {
        continue;
      }

      // Need conversation ID to send response
      if (!callback.conversationId) {
        logger.warn('No conversation ID in callback', { jobId: callback.jobId });
        continue;
      }

      // Get avatar context
      const avatarContext = await getAvatarContext(callback.avatarId);
      const platform = detectPlatform(callback.conversationId);

      // Get platform adapter
      const adapter = avatarContext.registry.get(platform);
      if (!adapter) {
        logger.warn('No adapter for platform', {
          platform,
          avatarId: callback.avatarId,
        });
        continue;
      }

      // Format and send message
      const message = formatCallbackMessage(callback);

      const action: ResponseAction = {
        type: 'send_message',
        text: message,
        replyToMessageId: callback.replyToMessageId,
      };

      try {
        await adapter.executeAction(action, callback.conversationId);
        logger.info('Callback response sent', {
          jobId: callback.jobId,
          platform,
          status: callback.status,
        });
      } catch (sendError) {
        logger.error('Failed to send callback response', {
          error: sendError instanceof Error ? sendError.message : String(sendError),
          jobId: callback.jobId,
          platform,
        });
        // Don't fail the batch item - message was processed
      }
    } catch (error) {
      logger.error('Failed to process callback', {
        error: error instanceof Error ? error.message : String(error),
        messageId: record.messageId,
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
