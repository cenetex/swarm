/**
 * Telegram Webhook Handler
 * Handles incoming Telegram bot webhooks
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  TelegramAdapter,
  createStateService,
  createSecretsService,
  createActivityService,
  createMessageEvaluator,
  logger,
  type AgentConfig,
} from '@swarm/core';

const sqs = new SQSClient({});

// Environment variables
const MESSAGE_QUEUE_URL = process.env.MESSAGE_QUEUE_URL!;
const STATE_TABLE = process.env.STATE_TABLE!;
const ACTIVITY_TABLE = process.env.ACTIVITY_TABLE!;
const AGENT_ID = process.env.AGENT_ID!;

// Lazy-initialized services
let stateService: ReturnType<typeof createStateService>;
let activityService: ReturnType<typeof createActivityService>;
let secretsService: ReturnType<typeof createSecretsService>;
let telegramAdapter: TelegramAdapter;
let agentConfig: AgentConfig;

/**
 * Initialize services (called once per Lambda cold start)
 */
async function initialize(): Promise<void> {
  if (stateService) return; // Already initialized

  stateService = createStateService(STATE_TABLE);
  activityService = createActivityService(ACTIVITY_TABLE);
  secretsService = createSecretsService();

  // Load agent config from DynamoDB or environment
  agentConfig = await stateService.getAgentConfig(AGENT_ID) || {
    id: AGENT_ID,
    name: process.env.AGENT_NAME || AGENT_ID,
    version: '1.0.0',
    persona: '',
    platforms: {
      telegram: {
        enabled: true,
        botUsername: process.env.TELEGRAM_BOT_USERNAME || '',
        webhookPath: `/webhook/telegram/${AGENT_ID}`,
      },
    },
    llm: {
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4',
      temperature: 0.8,
      maxTokens: 1024,
    },
    media: {
      image: { provider: 'replicate', model: 'f2ab8a5bfe79f02f0789a146cf5e73d2a4ff2684a98c2b303d1e1ff3814271db' }, // flux-schnell
    },
    scheduling: {},
    behavior: {
      responseDelayMs: [1000, 3000],
      typingIndicator: true,
      ignoreBots: true,
      cooldownMinutes: 5,
      maxContextMessages: 20,
    },
    tools: ['send_message', 'react', 'ignore', 'wait', 'take_selfie'],
    secrets: ['TELEGRAM_BOT_TOKEN'],
  };

  // Get Telegram bot token
  const secrets = await secretsService.getSecretJson<Record<string, string>>(
    process.env.SECRETS_ARN || `swarm/${AGENT_ID}/secrets`
  );

  telegramAdapter = new TelegramAdapter(agentConfig, secrets.TELEGRAM_BOT_TOKEN);
}

/**
 * Lambda handler
 */
export async function handler(
  event: APIGatewayProxyEvent,
  context: Context
): Promise<APIGatewayProxyResult> {
  logger.setContext({
    agentId: AGENT_ID,
    platform: 'telegram',
    requestId: context.awsRequestId,
  });

  try {
    await initialize();

    // Parse and verify request
    const body = event.body ? Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf-8') : Buffer.from('');
    const headers = Object.fromEntries(
      Object.entries(event.headers).map(([k, v]) => [k.toLowerCase(), v || ''])
    );

    const isValid = await telegramAdapter.verifyRequest(body, headers);
    if (!isValid) {
      logger.warn('Invalid request signature');
      return { statusCode: 401, body: 'Unauthorized' };
    }

    // Parse the message
    const update = JSON.parse(body.toString());
    const envelope = await telegramAdapter.parseMessage(update);

    if (!envelope) {
      // Valid update but not a message we handle (e.g., inline query)
      return { statusCode: 200, body: 'OK' };
    }

    // Log received message
    await activityService.logMessageReceived(
      AGENT_ID,
      'telegram',
      envelope.sender.displayName || envelope.sender.username || 'Unknown',
      envelope.content.text || '[media]'
    );

    // Check idempotency
    const isNewMessage = await stateService.checkAndSetIdempotency(
      envelope.metadata.idempotencyKey
    );

    if (!isNewMessage) {
      logger.info('Duplicate message, skipping', { messageId: envelope.messageId });
      return { statusCode: 200, body: 'OK' };
    }

    // Evaluate if we should respond
    const evaluator = createMessageEvaluator(
      agentConfig,
      stateService,
      [agentConfig.platforms.telegram?.botUsername || ''],
    );

    const evaluation = await evaluator.evaluate(envelope);

    if (!evaluation.shouldRespond) {
      logger.info('Not responding', { reason: evaluation.reason });
      return { statusCode: 200, body: 'OK' };
    }

    // Update envelope with evaluation results
    envelope.metadata.shouldRespond = evaluation.shouldRespond;
    envelope.metadata.responseReason = evaluation.reason;
    envelope.metadata.priority = evaluation.priority;

    // Add message to channel state
    await stateService.addMessageToChannel(
      AGENT_ID,
      envelope.conversationId,
      'telegram',
      {
        messageId: envelope.messageId,
        sender: envelope.sender.displayName || envelope.sender.username || envelope.sender.id,
        isBot: envelope.sender.isBot,
        content: envelope.content.text || '[media]',
        timestamp: envelope.timestamp,
      }
    );

    // Queue for response generation
    await sqs.send(new SendMessageCommand({
      QueueUrl: MESSAGE_QUEUE_URL,
      MessageBody: JSON.stringify({
        envelope,
        enqueuedAt: Date.now(),
        attempts: 0,
        maxAttempts: 3,
      }),
      MessageGroupId: envelope.conversationId, // FIFO ordering by conversation
      MessageDeduplicationId: envelope.metadata.idempotencyKey,
    }));

    logger.info('Message queued for processing', {
      messageId: envelope.messageId,
      reason: evaluation.reason,
    });

    // Return 200 immediately (async processing)
    return { statusCode: 200, body: 'OK' };

  } catch (error) {
    logger.error('Handler error', error);
    
    // Log error to activity feed
    try {
      await activityService.logError(
        AGENT_ID,
        'telegram',
        error instanceof Error ? error.message : String(error)
      );
    } catch {
      // Ignore activity logging errors
    }

    // Return 200 to prevent Telegram retries
    return { statusCode: 200, body: 'OK' };
  }
}
