/**
 * Media Processor Handler
 * Consumes media jobs from SQS and enqueues send_media actions back to response queue.
 */
import type { SQSEvent, Context } from 'aws-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import {
  createMediaService,
  createSecretsService,
  createStateService,
  logger,
  ResponseActionSchema,
  SwarmResponseSchema,
  type AgentConfig,
  type ResponseAction,
  type SwarmResponse,
} from '@swarm/core';

// Schema for media queue items
const MediaQueueItemSchema = z.object({
  jobId: z.string(),
  agentId: z.string(),
  conversationId: z.string(),
  action: ResponseActionSchema,
  response: SwarmResponseSchema,
});

const sqs = new SQSClient({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

let _responseQueueUrl: string | undefined;
let _stateTable: string | undefined;
let _agentId: string | undefined;
let _mediaBucket: string | undefined;

function getResponseQueueUrl(): string {
  if (!_responseQueueUrl) _responseQueueUrl = getRequiredEnv('RESPONSE_QUEUE_URL');
  return _responseQueueUrl;
}

function getStateTable(): string {
  if (!_stateTable) _stateTable = getRequiredEnv('STATE_TABLE');
  return _stateTable;
}

function getAgentId(): string {
  if (!_agentId) _agentId = getRequiredEnv('AGENT_ID');
  return _agentId;
}

function getMediaBucket(): string {
  if (!_mediaBucket) _mediaBucket = getRequiredEnv('MEDIA_BUCKET');
  return _mediaBucket;
}

async function claimJob(jobId: string): Promise<boolean> {
  const now = Date.now();
  const ttl = Math.floor(now / 1000) + IDEMPOTENCY_TTL_SECONDS;

  try {
    await dynamo.send(new PutCommand({
      TableName: getStateTable(),
      Item: {
        pk: `AGENT#${getAgentId()}`,
        sk: `MEDIAJOB#${jobId}`,
        createdAt: now,
        ttl,
      },
      ConditionExpression: 'attribute_not_exists(pk) AND attribute_not_exists(sk)',
    }));
    return true;
  } catch (error) {
    if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
      return false;
    }
    throw error;
  }
}

let stateService: ReturnType<typeof createStateService>;
let secretsService: ReturnType<typeof createSecretsService>;
let secrets: Record<string, string>;
let agentConfig: AgentConfig;
let mediaService: ReturnType<typeof createMediaService>;

async function initialize(): Promise<void> {
  if (stateService) return;

  stateService = createStateService(getStateTable());
  secretsService = createSecretsService();

  agentConfig = await stateService.getAgentConfig(getAgentId()) || {
    id: getAgentId(),
    name: process.env.AGENT_NAME || getAgentId(),
    version: '1.0.0',
    persona: process.env.AGENT_PERSONA || 'You are a helpful AI assistant.',
    platforms: {},
    llm: {
      provider: (process.env.LLM_PROVIDER as 'openrouter') || 'openrouter',
      model: process.env.LLM_MODEL || 'anthropic/claude-sonnet-4',
      temperature: 0.8,
      maxTokens: 1024,
    },
    media: {
      image: {
        provider: 'replicate',
        model: 'f2ab8a5bfe79f02f0789a146cf5e73d2a4ff2684a98c2b303d1e1ff3814271db',
      },
    },
    scheduling: {},
    behavior: {
      responseDelayMs: [1000, 3000],
      typingIndicator: true,
      ignoreBots: true,
      cooldownMinutes: 5,
      maxContextMessages: 20,
    },
    tools: [],
    secrets: ['OPENROUTER_API_KEY', 'REPLICATE_API_KEY'],
  };

  secrets = await secretsService.getSecretJson<Record<string, string>>(
    process.env.SECRETS_ARN || `swarm/${getAgentId()}/secrets`
  );

  mediaService = createMediaService(secrets, getMediaBucket(), process.env.CDN_DOMAIN);
}

function buildImagePrompt(action: { prompt: string; style?: string }, agent: AgentConfig): string {
  let prompt = action.prompt;
  if (action.style) {
    prompt = `${prompt}, ${action.style} style`;
  }
  if (agent.name) {
    prompt = `${agent.name}: ${prompt}`;
  }
  return prompt;
}

export const handler = async (event: SQSEvent, context: Context): Promise<{ batchItemFailures: { itemIdentifier: string }[] } | void> => {
  logger.setContext({
    agentId: getAgentId(),
    requestId: context.awsRequestId,
  });

  await initialize();

  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(record.body);
    } catch (parseError) {
      logger.error('Failed to parse message body as JSON', {
        messageId: record.messageId,
        error: parseError instanceof Error ? parseError.message : String(parseError),
        bodyPreview: record.body?.slice(0, 100)
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }

    const parseResult = MediaQueueItemSchema.safeParse(parsedBody);
    if (!parseResult.success) {
      logger.error('Invalid media queue item schema', {
        messageId: record.messageId,
        error: parseResult.error.message
      });
      // Schema validation failures are permanent - don't retry (send to DLQ)
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }
    const item = parseResult.data;

    logger.setContext({
      jobId: item.jobId,
      conversationId: item.conversationId,
      platform: item.response.platform,
    });

    try {

      if (item.agentId && item.agentId !== getAgentId()) {
        logger.warn('Media job agentId mismatch', {
          jobAgentId: item.agentId,
          handlerAgentId: getAgentId(),
        });
        continue;
      }

      const claimed = await claimJob(item.jobId);
      if (!claimed) {
        logger.info('Media job already claimed', { jobId: item.jobId });
        continue;
      }

      let mediaAction: ResponseAction | null = null;

      if (item.action.type === 'take_selfie') {
        const prompt = buildImagePrompt(item.action, agentConfig);
        const media = await mediaService.generateImage(prompt, agentConfig.media.image);
        mediaAction = {
          type: 'send_media',
          mediaType: media.type === 'video' ? 'video' : 'image',
          url: media.url,
          caption: item.action.prompt,
          replyToMessageId: item.response.replyToMessageId,
        };
      } else if (item.action.type === 'generate_video') {
        if (!agentConfig.media.video) {
          throw new Error('Video generation is not configured for this agent');
        }
        const prompt = agentConfig.name
          ? `${agentConfig.name}: ${item.action.prompt}`
          : item.action.prompt;
        const media = await mediaService.generateVideo(prompt, agentConfig.media.video);
        mediaAction = {
          type: 'send_media',
          mediaType: 'video',
          url: media.url,
          caption: item.action.prompt,
          replyToMessageId: item.response.replyToMessageId,
        };
      } else {
        logger.warn('Unsupported media action', { type: item.action.type });
        continue;
      }

      if (!mediaAction) {
        logger.warn('No media action generated', { jobId: item.jobId });
        continue;
      }

      const mediaResponse: SwarmResponse = {
        ...item.response,
        actions: [mediaAction],
        generatedAt: Date.now(),
      };

      await sqs.send(new SendMessageCommand({
        QueueUrl: getResponseQueueUrl(),
        MessageBody: JSON.stringify(mediaResponse),
        MessageGroupId: item.conversationId,
        MessageDeduplicationId: `media_${item.jobId}`,
      }));

      logger.info('Media job completed', { jobId: item.jobId, type: item.action.type });
    } catch (error) {
      logger.error('Media job failed', error, { jobId: item.jobId, messageId: record.messageId });
      // Add to batch failures for partial batch failure handling
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  // Return partial batch failure response for SQS
  if (batchItemFailures.length > 0) {
    logger.warn('Partial batch failure', {
      failedCount: batchItemFailures.length,
      totalCount: event.Records.length
    });
    return { batchItemFailures };
  }
};
