/**
 * Media Processor Handler
 * Consumes media jobs from SQS and enqueues send_media actions back to response queue.
 */
import type { SQSEvent, Context } from 'aws-lambda';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { logger, DEFAULT_LLM_MODEL } from '@swarm/core';
import {
  createMediaServiceWithDeps,
  createMediaDependencies,
  createSecretsService,
  createStateService,
} from '@swarm/core/services';
import {
  ResponseActionSchema,
  SwarmResponseSchema,
  type AvatarConfig,
  type ResponseAction,
  type SwarmResponse,
} from '@swarm/core/types';
import { ensureReplicateKey } from './utils/system-replicate-key.js';
import { parseSqsRecordBody, cleanupSqsRecord, sendSqsMessage } from './services/sqs-send.js';
import { checkMediaWithEnergyFallback } from './services/entitlement-enforcement.js';
import { getDynamoClient } from './services/dynamo-client.js';

// Schema for media queue items
const MediaQueueItemSchema = z.object({
  jobId: z.string(),
  avatarId: z.string(),
  traceId: z.string().optional(),
  usageAccounted: z.boolean().optional(),
  conversationId: z.string(),
  action: ResponseActionSchema,
  response: SwarmResponseSchema,
});

const dynamo = getDynamoClient();

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
let _mediaBucket: string | undefined;

function getResponseQueueUrl(): string {
  if (!_responseQueueUrl) _responseQueueUrl = getRequiredEnv('RESPONSE_QUEUE_URL');
  return _responseQueueUrl;
}

function getStateTable(): string {
  if (!_stateTable) _stateTable = getRequiredEnv('STATE_TABLE');
  return _stateTable;
}

function getMediaBucket(): string {
  if (!_mediaBucket) _mediaBucket = getRequiredEnv('MEDIA_BUCKET');
  return _mediaBucket;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function claimJob(avatarId: string, jobId: string): Promise<boolean> {
  const now = Date.now();
  const ttl = Math.floor(now / 1000) + IDEMPOTENCY_TTL_SECONDS;

  try {
    await dynamo.send(new PutCommand({
      TableName: getStateTable(),
      Item: {
        pk: `AVATAR#${avatarId}`,
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

let secretsService: ReturnType<typeof createSecretsService>;

type AvatarMediaRuntime = {
  avatarConfig: AvatarConfig;
  secrets: Record<string, string>;
  mediaService: ReturnType<typeof createMediaServiceWithDeps>;
};

type AvatarMediaRuntimeCacheEntry = {
  value: AvatarMediaRuntime;
  expiresAt: number;
};

const MEDIA_RUNTIME_CACHE_TTL_MS = parsePositiveInt(process.env.MEDIA_RUNTIME_CACHE_TTL_MS, 5 * 60 * 1000);
const MEDIA_RUNTIME_CACHE_MAX_SIZE = parsePositiveInt(process.env.MEDIA_RUNTIME_CACHE_MAX_SIZE, 200);
const MEDIA_RUNTIME_CACHE_LOG_INTERVAL_MS = parsePositiveInt(
  process.env.MEDIA_RUNTIME_CACHE_LOG_INTERVAL_MS,
  60 * 1000
);
const avatarRuntimeCache = new Map<string, AvatarMediaRuntimeCacheEntry>();
const mediaRuntimeCacheMetrics = {
  hits: 0,
  misses: 0,
  expirations: 0,
  writes: 0,
  evictions: 0,
  lastLoggedAt: 0,
};

function maybeLogMediaRuntimeCacheMetrics(): void {
  const now = Date.now();
  if (now - mediaRuntimeCacheMetrics.lastLoggedAt < MEDIA_RUNTIME_CACHE_LOG_INTERVAL_MS) {
    return;
  }
  mediaRuntimeCacheMetrics.lastLoggedAt = now;

  logger.info('Media runtime cache metrics', {
    event: 'media_runtime_cache_metrics',
    subsystem: 'cache',
    cache: 'media_runtime',
    size: avatarRuntimeCache.size,
    ttlMs: MEDIA_RUNTIME_CACHE_TTL_MS,
    maxSize: MEDIA_RUNTIME_CACHE_MAX_SIZE,
    hits: mediaRuntimeCacheMetrics.hits,
    misses: mediaRuntimeCacheMetrics.misses,
    expirations: mediaRuntimeCacheMetrics.expirations,
    writes: mediaRuntimeCacheMetrics.writes,
    evictions: mediaRuntimeCacheMetrics.evictions,
  });
}

async function initialize(): Promise<void> {
  if (secretsService) return;
  secretsService = createSecretsService();
}

const SECRET_PREFIX = process.env.SECRET_PREFIX || 'swarm';

function getCachedAvatarRuntime(avatarId: string): AvatarMediaRuntime | null {
  const now = Date.now();
  const cached = avatarRuntimeCache.get(avatarId);
  if (!cached) {
    mediaRuntimeCacheMetrics.misses++;
    maybeLogMediaRuntimeCacheMetrics();
    return null;
  }
  if (cached.expiresAt <= now) {
    avatarRuntimeCache.delete(avatarId);
    mediaRuntimeCacheMetrics.expirations++;
    mediaRuntimeCacheMetrics.misses++;
    maybeLogMediaRuntimeCacheMetrics();
    return null;
  }

  // Touch for LRU behavior.
  avatarRuntimeCache.delete(avatarId);
  avatarRuntimeCache.set(avatarId, cached);
  mediaRuntimeCacheMetrics.hits++;
  maybeLogMediaRuntimeCacheMetrics();
  return cached.value;
}

function setCachedAvatarRuntime(avatarId: string, runtime: AvatarMediaRuntime): void {
  const entry: AvatarMediaRuntimeCacheEntry = {
    value: runtime,
    expiresAt: Date.now() + MEDIA_RUNTIME_CACHE_TTL_MS,
  };

  avatarRuntimeCache.delete(avatarId);
  avatarRuntimeCache.set(avatarId, entry);
  mediaRuntimeCacheMetrics.writes++;

  while (avatarRuntimeCache.size > MEDIA_RUNTIME_CACHE_MAX_SIZE) {
    const oldestKey = avatarRuntimeCache.keys().next().value;
    if (!oldestKey) break;
    avatarRuntimeCache.delete(oldestKey);
    mediaRuntimeCacheMetrics.evictions++;
  }
  maybeLogMediaRuntimeCacheMetrics();
}

async function getAvatarRuntime(avatarId: string): Promise<AvatarMediaRuntime> {
  const cached = getCachedAvatarRuntime(avatarId);
  if (cached) return cached;

  const stateService = createStateService(getStateTable());
  const avatarConfig = await stateService.getAvatarConfig(avatarId) || {
    id: avatarId,
    name: avatarId,
    version: '1.0.0',
    persona: process.env.AGENT_PERSONA || 'You are a helpful AI assistant.',
    platforms: {},
    llm: {
      provider: (process.env.LLM_PROVIDER as 'openrouter') || 'openrouter',
      model: process.env.LLM_MODEL || DEFAULT_LLM_MODEL,
      temperature: 0.8,
      maxTokens: 1024,
    },
    media: {
      image: {
        provider: 'replicate',
        model: 'black-forest-labs/flux-schnell',
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

  const secrets = await secretsService.getSecretJson<Record<string, string>>(
    `${SECRET_PREFIX}/${avatarId}/secrets`
  ) || {};

  try {
    const ok = await ensureReplicateKey(secrets, secretsService);
    if (ok && secrets.REPLICATE_API_KEY) {
      logger.info('Loaded system Replicate key for media processor', { subsystem: 'media', avatarId });
    } else if (!ok) {
      logger.warn('System Replicate key not configured for media processor', {
        subsystem: 'media',
        avatarId,
        hasEnvKey: Boolean(process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY),
        hasSecretArn: Boolean(process.env.REPLICATE_API_KEY_SECRET_ARN),
      });
    }
  } catch (err) {
    logger.warn('Failed to load system Replicate key for media processor', {
      subsystem: 'media',
      avatarId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const mediaDeps = createMediaDependencies({ tableName: getStateTable() });
  const mediaService = createMediaServiceWithDeps(secrets, getMediaBucket(), process.env.CDN_URL, mediaDeps);

  const runtime: AvatarMediaRuntime = { avatarConfig, secrets, mediaService };
  setCachedAvatarRuntime(avatarId, runtime);
  return runtime;
}

function buildImagePrompt(action: { prompt: string; style?: string }, avatar: AvatarConfig): string {
  let prompt = action.prompt;
  if (action.style) {
    prompt = `${prompt}, ${action.style} style`;
  }
  if (avatar.name) {
    prompt = `${avatar.name}: ${prompt}`;
  }
  return prompt;
}

export const handler = async (event: SQSEvent, context: Context): Promise<{ batchItemFailures: { itemIdentifier: string }[] } | void> => {
  logger.setContext({
    requestId: context.awsRequestId,
  });

  logger.info('Media processor invoked', {
    event: 'handler_started',
    subsystem: 'media',
    recordCount: event.Records.length,
  });

  await initialize();

  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    let traceId = record.messageAttributes?.traceId?.stringValue;
    if (!traceId) {
      traceId = randomUUID();
    }
    logger.setContext({ traceId });

    let parsedBody: unknown;
    let rawBody: string = record.body;
    let wasOffloaded = false;
    try {
      const parsed = await parseSqsRecordBody(record.body);
      parsedBody = parsed.payload;
      rawBody = parsed.rawBody;
      wasOffloaded = parsed.wasOffloaded;
    } catch (parseError) {
      logger.error('Failed to parse message body', {
        event: 'parse_error',
        subsystem: 'media',
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
        event: 'validation_error',
        subsystem: 'media',
        messageId: record.messageId,
        error: parseResult.error.message
      });
      // Schema validation failures are permanent - don't retry (send to DLQ)
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }
    const item = parseResult.data;

    const avatarId = item.avatarId;
    if (!avatarId) {
      logger.error('Missing avatarId in media queue item', {
        event: 'validation_error',
        subsystem: 'media',
        messageId: record.messageId,
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
      continue;
    }

    logger.setContext({ avatarId });

    if (!record.messageAttributes?.traceId?.stringValue && item.traceId) {
      traceId = item.traceId;
      logger.setContext({ traceId });
    }

    logger.setContext({
      jobId: item.jobId,
      conversationId: item.conversationId,
      platform: item.response.platform,
    });

    try {

      const { avatarConfig, mediaService } = await getAvatarRuntime(avatarId);

      const claimed = await claimJob(avatarId, item.jobId);
      if (!claimed) {
        logger.info('Media job already claimed', {
          event: 'job_skipped',
          subsystem: 'media',
          reason: 'already_claimed',
          jobId: item.jobId,
        });
        continue;
      }

      let mediaAction: ResponseAction | null = null;
      if (!item.usageAccounted) {
        // Unified burst pool: entitlement-first, energy-fallback
        const usageCheck = await checkMediaWithEnergyFallback(avatarId);
        if (!usageCheck.allowed) {
          logger.warn('Media generation blocked by entitlement limits', {
            event: 'limit_exceeded',
            subsystem: 'entitlements',
            avatarId: avatarId,
            jobId: item.jobId,
            reason: usageCheck.reason,
            limit: usageCheck.limit,
            current: usageCheck.current,
          });
          mediaAction = {
            type: 'send_message',
            text: usageCheck.reason || 'Daily media generation limit reached',
            replyToMessageId: item.response.replyToMessageId,
          };
        }
      }

      if (!mediaAction && item.action.type === 'take_selfie') {
        const prompt = buildImagePrompt(item.action, avatarConfig);
        const media = await mediaService.generateImage(prompt, avatarConfig.media.image, {
          avatarId: avatarId,
          platform: item.response.platform,
          saveToGallery: true,
          checkCredits: false,
        });
        mediaAction = {
          type: 'send_media',
          mediaType: media.type === 'video' ? 'video' : 'image',
          url: media.url,
          caption: item.action.prompt,
          replyToMessageId: item.response.replyToMessageId,
        };
      } else if (!mediaAction && item.action.type === 'generate_image') {
        // Handle generate_image action from decoupled queue
        const action = item.action as { prompt: string; aspectRatio?: string; referenceImageUrls?: string[] };
        const validRatios = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9'] as const;
        type AspectRatio = typeof validRatios[number];
        const aspectRatio: AspectRatio = validRatios.includes(action.aspectRatio as AspectRatio)
          ? action.aspectRatio as AspectRatio
          : '1:1';
        const mediaConfig = {
          ...avatarConfig.media.image,
          aspectRatio,
        };
        const media = await mediaService.generateImage(action.prompt, mediaConfig, {
          avatarId: avatarId,
          platform: item.response.platform,
          saveToGallery: true,
          checkCredits: false,
          referenceImageUrls: action.referenceImageUrls,
        });
        mediaAction = {
          type: 'send_media',
          mediaType: media.type === 'video' ? 'video' : 'image',
          url: media.url,
          caption: action.prompt,
          replyToMessageId: item.response.replyToMessageId,
        };
      } else if (!mediaAction && item.action.type === 'generate_video') {
        if (!avatarConfig.media.video) {
          throw new Error('Video generation is not configured for this avatar');
        }
        const prompt = avatarConfig.name
          ? `${avatarConfig.name}: ${item.action.prompt}`
          : item.action.prompt;
        const media = await mediaService.generateVideo(prompt, avatarConfig.media.video);
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

      await sendSqsMessage({
        QueueUrl: getResponseQueueUrl(),
        MessageAttributes: {
          traceId: {
            DataType: 'String',
            StringValue: traceId,
          },
        },
        MessageGroupId: item.conversationId,
        MessageDeduplicationId: `media_${item.jobId}`,
      }, mediaResponse);

      // Clean up offloaded S3 payload from the inbound message (if any)
      if (wasOffloaded) {
        await cleanupSqsRecord(rawBody);
      }

      logger.info('Media job completed', {
        event: 'job_completed',
        subsystem: 'media',
        jobId: item.jobId,
        type: item.action.type,
      });
    } catch (error) {
      logger.error('Media job failed', error, {
        event: 'job_failed',
        subsystem: 'media',
        jobId: item.jobId,
        messageId: record.messageId,
      });
      // Add to batch failures for partial batch failure handling
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  // Return partial batch failure response for SQS
  if (batchItemFailures.length > 0) {
    logger.warn('Partial batch failure', {
      event: 'batch_partial_failure',
      subsystem: 'media',
      failedCount: batchItemFailures.length,
      totalCount: event.Records.length
    });
    return { batchItemFailures };
  }
};
