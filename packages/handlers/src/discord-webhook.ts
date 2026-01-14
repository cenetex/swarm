/**
 * Discord Interaction Webhook Handler
 * Handles incoming Discord application commands and interactions.
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  DiscordAdapter,
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
let discordAdapter: DiscordAdapter;
let agentConfig: AgentConfig;

async function initialize(): Promise<void> {
  if (stateService) return;

  stateService = createStateService(STATE_TABLE);
  activityService = createActivityService(ACTIVITY_TABLE);
  secretsService = createSecretsService();

  agentConfig = await stateService.getAgentConfig(AGENT_ID) || {
    id: AGENT_ID,
    name: process.env.AGENT_NAME || AGENT_ID,
    version: '1.0.0',
    persona: '',
    platforms: {
      discord: {
        enabled: true,
        mode: 'bot',
        respondToMentions: true,
        respondInDMs: true,
      },
    },
    llm: {
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4',
      temperature: 0.8,
      maxTokens: 1024,
    },
    media: {
      image: { provider: 'replicate', model: 'f2ab8a5bfe79f02f0789a146cf5e73d2a4ff2684a98c2b303d1e1ff3814271db' },
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
    secrets: ['DISCORD_BOT_TOKEN'],
  };

  const secrets = await secretsService.getSecretJson<Record<string, string>>(
    process.env.SECRETS_ARN || `swarm/${AGENT_ID}/secrets`
  );

  discordAdapter = new DiscordAdapter(agentConfig, {
    botToken: secrets.DISCORD_BOT_TOKEN || secrets.discord_bot_token,
    applicationId: agentConfig.platforms.discord?.applicationId,
    publicKey: agentConfig.platforms.discord?.publicKey,
    webhookUrl: agentConfig.platforms.discord?.webhookUrl,
    webhookId: agentConfig.platforms.discord?.webhookId,
    webhookToken: agentConfig.platforms.discord?.webhookToken,
  });
}

function isInteraction(payload: unknown): payload is { type: number; token: string } {
  const obj = payload as Record<string, unknown>;
  return typeof obj.type === 'number' && typeof obj.token === 'string';
}

export async function handler(
  event: APIGatewayProxyEvent,
  context: Context
): Promise<APIGatewayProxyResult> {
  logger.setContext({
    agentId: AGENT_ID,
    platform: 'discord',
    requestId: context.awsRequestId,
  });

  try {
    await initialize();

    const body = event.body
      ? Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf-8')
      : Buffer.from('');
    const headers = Object.fromEntries(
      Object.entries(event.headers).map(([k, v]) => [k.toLowerCase(), v || ''])
    );

    const isValid = await discordAdapter.verifyRequest(body, headers);
    if (!isValid) {
      logger.warn('Invalid Discord request signature');
      return { statusCode: 401, body: 'Unauthorized' };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body.toString());
    } catch (parseError) {
      logger.error('Failed to parse Discord payload', parseError);
      return { statusCode: 400, body: 'Invalid JSON' };
    }

    if (isInteraction(payload) && payload.type === 1) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 1 }),
      };
    }

    const envelope = await discordAdapter.parseMessage(payload);
    if (!envelope) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: isInteraction(payload) ? JSON.stringify({ type: 5 }) : 'OK',
      };
    }

    await activityService.logMessageReceived(
      AGENT_ID,
      'discord',
      envelope.sender.displayName || envelope.sender.username || 'Unknown',
      envelope.content.text || '[interaction]'
    );

    const isNewMessage = await stateService.checkAndSetIdempotency(
      envelope.metadata.idempotencyKey
    );

    if (!isNewMessage) {
      logger.info('Duplicate Discord message, skipping', { messageId: envelope.messageId });
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: isInteraction(payload) ? JSON.stringify({ type: 5 }) : 'OK',
      };
    }

    const evaluator = createMessageEvaluator(agentConfig, stateService, {
      botUsernames: [],
    });

    const evaluation = await evaluator.evaluate(envelope);
    if (!evaluation.shouldRespond) {
      logger.info('Not responding', { reason: evaluation.reason });
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: isInteraction(payload) ? JSON.stringify({ type: 5 }) : 'OK',
      };
    }

    envelope.metadata.shouldRespond = evaluation.shouldRespond;
    envelope.metadata.responseReason = evaluation.reason;
    envelope.metadata.priority = evaluation.priority;

    await stateService.addMessageToChannel(
      AGENT_ID,
      envelope.conversationId,
      'discord',
      {
        messageId: envelope.messageId,
        sender: envelope.sender.displayName || envelope.sender.username || envelope.sender.id,
        isBot: envelope.sender.isBot,
        content: envelope.content.text || '[interaction]',
        timestamp: envelope.timestamp,
      }
    );

    await sqs.send(new SendMessageCommand({
      QueueUrl: MESSAGE_QUEUE_URL,
      MessageBody: JSON.stringify({
        envelope,
        enqueuedAt: Date.now(),
        attempts: 0,
        maxAttempts: 3,
      }),
      MessageGroupId: envelope.conversationId,
      MessageDeduplicationId: envelope.metadata.idempotencyKey,
    }));

    logger.info('Discord message queued', { messageId: envelope.messageId });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: isInteraction(payload) ? JSON.stringify({ type: 5 }) : 'OK',
    };
  } catch (error) {
    logger.error('Discord webhook handler error', error);

    try {
      await activityService.logError(
        AGENT_ID,
        'discord',
        error instanceof Error ? error.message : String(error)
      );
    } catch {
      // Ignore activity logging errors
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 5 }),
    };
  }
}
