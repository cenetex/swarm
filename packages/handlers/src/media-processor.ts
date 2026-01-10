/**
 * Media Processor Handler
 * Consumes media jobs from SQS and enqueues send_media actions back to response queue.
 */
import type { SQSEvent, SQSHandler, Context } from 'aws-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  createMediaService,
  createSecretsService,
  createStateService,
  logger,
  type AgentConfig,
  type ResponseAction,
  type SwarmResponse,
} from '@swarm/core';

interface MediaQueueItem {
  jobId: string;
  agentId: string;
  conversationId: string;
  action: ResponseAction;
  response: SwarmResponse;
}

const sqs = new SQSClient({});

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

export const handler: SQSHandler = async (event: SQSEvent, context: Context) => {
  logger.setContext({
    agentId: getAgentId(),
    requestId: context.awsRequestId,
  });

  await initialize();

  for (const record of event.Records) {
    const item: MediaQueueItem = JSON.parse(record.body);

    logger.setContext({
      jobId: item.jobId,
      conversationId: item.conversationId,
      platform: item.response.platform,
    });

    try {
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
      logger.error('Media job failed', error);
      throw error;
    }
  }
};
