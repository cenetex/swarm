/**
 * Response Sender Handler
 * Sends generated responses to platforms
 */
import type { SQSEvent, SQSHandler, Context } from 'aws-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
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

// Environment variables
const MEDIA_QUEUE_URL = process.env.MEDIA_QUEUE_URL;
const STATE_TABLE = process.env.STATE_TABLE!;
const ACTIVITY_TABLE = process.env.ACTIVITY_TABLE!;
const AGENT_ID = process.env.AGENT_ID!;

// Services
let stateService: ReturnType<typeof createStateService>;
let activityService: ReturnType<typeof createActivityService>;
let secretsService: ReturnType<typeof createSecretsService>;
let platformRegistry: PlatformRegistry;
let outboundSender: ReturnType<typeof createOutboundSender>;
let secrets: Record<string, string>;
let agentConfig: AgentConfig;

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

export const handler: SQSHandler = async (event: SQSEvent, context: Context) => {
  logger.setContext({
    agentId: AGENT_ID,
    requestId: context.awsRequestId,
  });

  await initialize();

  for (const record of event.Records) {
    try {
      const response: SwarmResponse = JSON.parse(record.body);

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
      const hasSendMessageAction = response.actions.some(
        (a: ResponseAction) => a.type === 'send_message'
      );
      let sentMessages: string[] = [];
      let sendSuccess = false;

      if (mediaActions.length > 0 && MEDIA_QUEUE_URL) {
        // Queue media generation and wait
        for (const action of mediaActions) {
          await sqs.send(new SendMessageCommand({
            QueueUrl: MEDIA_QUEUE_URL,
            MessageBody: JSON.stringify({
              agentId: AGENT_ID,
              conversationId: response.conversationId,
              action,
              callback: {
                queueUrl: process.env.AWS_LAMBDA_FUNCTION_NAME, // Self-invoke for callback
                response,
              },
            }),
          }));
        }

        logger.info('Media generation queued', { count: mediaActions.length });

        sendSuccess = true;

        // For now, send text response without media
        // Media will be sent when generation completes via callback
        const textActions = response.actions.filter(
          (a: ResponseAction) => a.type !== 'take_selfie' && a.type !== 'generate_video'
        );

        if (textActions.length > 0) {
          const textResponse = { ...response, actions: textActions };
          const result = await outboundSender.send(textResponse);
          sentMessages = result.sentMessages;
          sendSuccess = result.success;
          
          if (result.errors.length > 0) {
            logger.warn('Some actions failed', { errors: result.errors });
          }
        }
      } else {
        // No media actions, send directly
        const result = await outboundSender.send(response);
        sentMessages = result.sentMessages;
        sendSuccess = result.success;

        if (result.errors.length > 0) {
          logger.warn('Some actions failed', { errors: result.errors });
        }
      }

      // Update channel state with bot's response
      for (const text of sentMessages) {
        await stateService.addMessageToChannel(
          AGENT_ID,
          response.conversationId,
          response.platform,
          {
            messageId: `bot_${Date.now()}`,
            sender: agentConfig.name,
            isBot: true,
            content: text,
            timestamp: Date.now(),
          }
        );
      }

      const shouldMarkResponse = hasSendMessageAction ? sentMessages.length > 0 : sendSuccess;
      if (shouldMarkResponse) {
        await stateService.markResponseSent(
          AGENT_ID,
          response.conversationId,
          `resp_${response.replyToMessageId || Date.now()}_${Date.now()}`
        );
      }

      logger.info('Response sent successfully');

    } catch (error) {
      logger.error('Failed to send response', error);
      throw error;
    }
  }
};
