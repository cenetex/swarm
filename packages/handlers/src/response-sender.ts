/**
 * Response Sender Handler
 * Sends generated responses to platforms
 */
import type { SQSEvent, Context, SQSBatchResponse, Handler } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { randomUUID } from 'crypto';
import {
  TelegramAdapter,
  TwitterAdapter,
  WebAdapter,
  PlatformRegistry,
  createStateService,
  createSecretsService,
  createActivityService,
  createOutboundSender,
  logger,
  type AgentConfig,
  type SwarmResponse,
  type ResponseAction,
} from '@swarm/core';

const sqs = new SQSClient({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

// Environment variables
const MEDIA_QUEUE_URL = process.env.MEDIA_QUEUE_URL;
const STATE_TABLE = process.env.STATE_TABLE!;
const ACTIVITY_TABLE = process.env.ACTIVITY_TABLE!;
const AGENT_ID = process.env.AGENT_ID!;
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

// Services
let stateService: ReturnType<typeof createStateService>;
let activityService: ReturnType<typeof createActivityService>;
let secretsService: ReturnType<typeof createSecretsService>;
let platformRegistry: PlatformRegistry;
let outboundSender: ReturnType<typeof createOutboundSender>;
let secrets: Record<string, string>;
let agentConfig: AgentConfig;

function getResponseKey(response: SwarmResponse, recordMessageId: string): string {
  const anchor = response.replyToMessageId ?? response.generatedAt ?? recordMessageId;
  return `${response.conversationId}#${anchor}`;
}

async function wasResponseHandled(responseKey: string): Promise<boolean> {
  const result = await dynamo.send(new GetCommand({
    TableName: STATE_TABLE,
    Key: {
      pk: `AGENT#${AGENT_ID}`,
      sk: `RESPONSE#${responseKey}`,
    },
  }));
  return Boolean(result.Item);
}

async function markResponseHandled(responseKey: string): Promise<void> {
  const now = Date.now();
  const ttl = Math.floor(now / 1000) + IDEMPOTENCY_TTL_SECONDS;
  try {
    await dynamo.send(new PutCommand({
      TableName: STATE_TABLE,
      Item: {
        pk: `AGENT#${AGENT_ID}`,
        sk: `RESPONSE#${responseKey}`,
        createdAt: now,
        ttl,
      },
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
    }));
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      return;
    }
    logger.warn('Failed to record response idempotency', {
      error: error instanceof Error ? error.message : String(error),
      responseKey,
    });
  }
}

async function initialize(): Promise<void> {
  if (stateService) return;

  stateService = createStateService(STATE_TABLE);
  activityService = createActivityService(ACTIVITY_TABLE);
  secretsService = createSecretsService();

  // Load config and secrets
  agentConfig = await stateService.getAgentConfig(AGENT_ID) || {
    id: AGENT_ID,
    name: AGENT_ID,
    version: '1.0.0',
    persona: '',
    platforms: {},
    llm: { provider: 'openrouter', model: 'anthropic/claude-sonnet-4', temperature: 0.8, maxTokens: 1024 },
    media: { image: { provider: 'replicate', model: 'f2ab8a5bfe79f02f0789a146cf5e73d2a4ff2684a98c2b303d1e1ff3814271db' } }, // flux-schnell
    scheduling: {},
    behavior: { responseDelayMs: [1000, 3000], typingIndicator: true, ignoreBots: true, cooldownMinutes: 5, maxContextMessages: 20 },
    tools: [],
    secrets: [],
  };

  secrets = await secretsService.getSecretJson<Record<string, string>>(
    process.env.SECRETS_ARN || `swarm/${AGENT_ID}/secrets`
  );

  // Initialize platform adapters
  platformRegistry = new PlatformRegistry();

  if (agentConfig.platforms.telegram?.enabled && secrets.TELEGRAM_BOT_TOKEN) {
    platformRegistry.register(new TelegramAdapter(agentConfig, secrets.TELEGRAM_BOT_TOKEN));
  }

  if (agentConfig.platforms.twitter?.enabled && secrets.TWITTER_API_KEY) {
    platformRegistry.register(new TwitterAdapter(agentConfig, {
      appKey: secrets.TWITTER_API_KEY,
      appSecret: secrets.TWITTER_API_SECRET,
      accessToken: secrets.TWITTER_ACCESS_TOKEN,
      accessSecret: secrets.TWITTER_ACCESS_SECRET,
    }));
  }

  if (agentConfig.platforms.web?.enabled) {
    platformRegistry.register(new WebAdapter(agentConfig));
  }

  outboundSender = createOutboundSender(platformRegistry, activityService);
}

export const handler: Handler<SQSEvent, SQSBatchResponse> = async (
  event: SQSEvent,
  context: Context
) => {
  logger.setContext({
    agentId: AGENT_ID,
    requestId: context.awsRequestId,
  });

  await initialize();
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];

  for (const record of event.Records) {
    try {
      let response: SwarmResponse;
      try {
        response = JSON.parse(record.body);
      } catch (parseError) {
        logger.error('Failed to parse message body as JSON', parseError, {
          messageId: record.messageId,
          bodyPreview: record.body?.slice(0, 100),
        });
        batchItemFailures.push({ itemIdentifier: record.messageId });
        continue;
      }

      const responseKey = getResponseKey(response, record.messageId);
      if (await wasResponseHandled(responseKey)) {
        logger.info('Skipping already handled response', { responseKey });
        continue;
      }

      logger.setContext({
        platform: response.platform,
        conversationId: response.conversationId,
      });

      logger.info('Sending response', {
        actions: response.actions.length,
      });

      // Check for media generation actions - queue them first
      const mediaActions = response.actions.filter(
        (a: ResponseAction) => a.type === 'take_selfie' || a.type === 'generate_video'
      );
      const nonMediaActions = response.actions.filter(
        (a: ResponseAction) => a.type !== 'take_selfie' && a.type !== 'generate_video'
      );
      let actionsToSend: ResponseAction[] | null = null;
      let queuedMedia = false;
      let sentMessages: string[] = [];
      let sendSuccess = false;

      if (mediaActions.length > 0) {
        if (MEDIA_QUEUE_URL) {
          // Queue media generation and wait
          for (const action of mediaActions) {
            const jobId = randomUUID();
            await sqs.send(new SendMessageCommand({
              QueueUrl: MEDIA_QUEUE_URL,
              MessageBody: JSON.stringify({
                jobId,
                agentId: AGENT_ID,
                conversationId: response.conversationId,
                action,
                response,
              }),
              MessageGroupId: response.conversationId,
              MessageDeduplicationId: `media_${jobId}`,
            }));
          }

          logger.info('Media generation queued', { count: mediaActions.length });
          queuedMedia = true;

          // For now, send text response without media
          // Media will be sent when generation completes via callback
          if (nonMediaActions.length > 0) {
            actionsToSend = nonMediaActions;
          }
        } else {
          logger.error('MEDIA_QUEUE_URL is not configured; skipping media generation');
          actionsToSend = nonMediaActions.length > 0
            ? nonMediaActions
            : [{
                type: 'send_message',
                text: 'Media generation is unavailable right now.',
              }];
        }
      } else {
        // No media actions, send directly
        actionsToSend = response.actions;
      }

      if (actionsToSend && actionsToSend.length > 0) {
        const result = await outboundSender.send({ ...response, actions: actionsToSend });
        sentMessages = result.sentMessages;
        sendSuccess = result.success;

        if (result.errors.length > 0) {
          logger.warn('Some actions failed', { errors: result.errors });
        }
      } else {
        sendSuccess = queuedMedia;
      }

      // Update channel state with bot's response
      for (const text of sentMessages) {
        try {
          await stateService.addMessageToChannel(
            AGENT_ID,
            response.conversationId,
            response.platform,
            {
              messageId: `bot_${randomUUID()}`,
              sender: agentConfig.name,
              isBot: true,
              content: text,
              timestamp: Date.now(),
            }
          );
        } catch (error) {
          logger.warn('Failed to update channel state for sent message', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      const hasActionsToSend = Boolean(actionsToSend && actionsToSend.length > 0);
      const hasSendMessageAction = actionsToSend?.some(
        (a: ResponseAction) => a.type === 'send_message'
      ) ?? false;
      if (hasSendMessageAction && sentMessages.length === 0) {
        sendSuccess = false;
        logger.warn('send_message action failed to deliver', {
          conversationId: response.conversationId,
        });
      }
      const shouldMarkResponse = hasActionsToSend
        ? (hasSendMessageAction ? sentMessages.length > 0 : sendSuccess)
        : false;
      if (shouldMarkResponse) {
        try {
          await stateService.markResponseSent(
            AGENT_ID,
            response.conversationId,
            `resp_${response.replyToMessageId || Date.now()}_${Date.now()}`
          );
        } catch (error) {
          logger.warn('Failed to mark response sent', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (sendSuccess) {
        await markResponseHandled(responseKey);
      }

      if (actionsToSend && actionsToSend.length > 0 && !sendSuccess) {
        batchItemFailures.push({ itemIdentifier: record.messageId });
        logger.error('Response actions failed to send', {
          messageId: record.messageId,
          platform: response.platform,
        });
        continue;
      }

      logger.info('Response sent successfully');

    } catch (error) {
      logger.error('Failed to send response', error);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
};
