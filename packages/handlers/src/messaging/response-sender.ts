/**
 * Response Sender Handler
 * Sends generated responses to platforms
 */
import type { SQSEvent, Context, SQSBatchResponse, Handler } from 'aws-lambda';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';
import {
  TelegramAdapter,
  TwitterAdapter,
  WebAdapter,
  DiscordAdapter,
  PlatformRegistry,
  createStateService,
  createActivityService,
  createOutboundSender,
  createRuntimeMetricsLogger,
  logger,
  extractCorrelationIdFromSqsRecord,
  DEFAULT_AVATAR_CONFIG,
  type ActionError,
  type AvatarConfig,
  type SwarmResponse,
  type ResponseAction,
} from '@swarm/core';
import { isAllowedDmUserById } from '../telegram/telegram-webhook-shared.js';
import { parseSqsRecordBody, cleanupSqsRecord, sendSqsMessage } from '../services/sqs-send.js';
import { loadAvatarSecrets } from '../utils/load-avatar-secrets.js';
import { getDynamoClient } from '../services/dynamo-client.js';

const dynamo = getDynamoClient();

// Environment variables
const MEDIA_QUEUE_URL = process.env.MEDIA_QUEUE_URL;
const STATE_TABLE = process.env.STATE_TABLE!;
const ACTIVITY_TABLE = process.env.ACTIVITY_TABLE!;
const LEGACY_AVATAR_ID = process.env.AVATAR_ID;
const SECRET_PREFIX = process.env.SECRET_PREFIX || 'swarm';
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

const DEFAULT_RATICHAT_URL = 'https://t.me/ratichat';

function isTelegramDirectMessageChatId(conversationId: string): boolean {
  const chatId = Number(conversationId);
  // Telegram private chats use positive IDs. Groups/supergroups/channels are negative.
  return Number.isFinite(chatId) && chatId > 0;
}

function buildTelegramDmRedirect(params?: { ratichatUrl?: string }): {
  text: string;
  replyMarkup: {
    inline_keyboard: Array<Array<{ text: string; url: string }>>;
  };
} {
  const ratichatUrl = params?.ratichatUrl || DEFAULT_RATICHAT_URL;
  return {
    text: `I can’t chat in DMs.

Use RATi Chat to create a new bot or manage your account:
${ratichatUrl}`,
    replyMarkup: {
      inline_keyboard: [
        [{ text: 'Open RATi Chat', url: ratichatUrl }],
        [{ text: 'New Bot', url: `${ratichatUrl}?start=new_bot` }],
      ],
    },
  };
}

// Services
let stateService: ReturnType<typeof createStateService>;
let activityService: ReturnType<typeof createActivityService>;

type AvatarOutboundRuntime = {
  avatarId: string;
  avatarConfig: AvatarConfig;
  secrets: Record<string, string>;
  platformRegistry: PlatformRegistry;
  outboundSender: ReturnType<typeof createOutboundSender>;
};

type AvatarOutboundRuntimeCacheEntry = {
  value: AvatarOutboundRuntime;
  expiresAt: number;
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const OUTBOUND_CACHE_TTL_MS = parsePositiveInt(process.env.OUTBOUND_CACHE_TTL_MS, 5 * 60 * 1000);
const OUTBOUND_CACHE_MAX_SIZE = parsePositiveInt(process.env.OUTBOUND_CACHE_MAX_SIZE, 200);
const OUTBOUND_CACHE_LOG_INTERVAL_MS = parsePositiveInt(
  process.env.OUTBOUND_CACHE_LOG_INTERVAL_MS,
  60 * 1000
);
const outboundCache = new Map<string, AvatarOutboundRuntimeCacheEntry>();
const outboundCacheMetrics = {
  hits: 0,
  misses: 0,
  expirations: 0,
  writes: 0,
  evictions: 0,
  lastLoggedAt: 0,
};

function maybeLogOutboundCacheMetrics(): void {
  const now = Date.now();
  if (now - outboundCacheMetrics.lastLoggedAt < OUTBOUND_CACHE_LOG_INTERVAL_MS) {
    return;
  }
  outboundCacheMetrics.lastLoggedAt = now;

  logger.info('Outbound runtime cache metrics', {
    event: 'outbound_runtime_cache_metrics',
    subsystem: 'cache',
    cache: 'outbound_runtime',
    size: outboundCache.size,
    ttlMs: OUTBOUND_CACHE_TTL_MS,
    maxSize: OUTBOUND_CACHE_MAX_SIZE,
    hits: outboundCacheMetrics.hits,
    misses: outboundCacheMetrics.misses,
    expirations: outboundCacheMetrics.expirations,
    writes: outboundCacheMetrics.writes,
    evictions: outboundCacheMetrics.evictions,
  });
}

function getCachedOutboundRuntime(avatarId: string): AvatarOutboundRuntime | null {
  const now = Date.now();
  const cached = outboundCache.get(avatarId);
  if (!cached) {
    outboundCacheMetrics.misses++;
    maybeLogOutboundCacheMetrics();
    return null;
  }
  if (cached.expiresAt <= now) {
    outboundCache.delete(avatarId);
    outboundCacheMetrics.expirations++;
    outboundCacheMetrics.misses++;
    maybeLogOutboundCacheMetrics();
    return null;
  }

  // Touch for LRU behavior.
  outboundCache.delete(avatarId);
  outboundCache.set(avatarId, cached);
  outboundCacheMetrics.hits++;
  maybeLogOutboundCacheMetrics();
  return cached.value;
}

function setCachedOutboundRuntime(avatarId: string, runtime: AvatarOutboundRuntime): void {
  const entry: AvatarOutboundRuntimeCacheEntry = {
    value: runtime,
    expiresAt: Date.now() + OUTBOUND_CACHE_TTL_MS,
  };

  outboundCache.delete(avatarId);
  outboundCache.set(avatarId, entry);
  outboundCacheMetrics.writes++;

  while (outboundCache.size > OUTBOUND_CACHE_MAX_SIZE) {
    const oldestKey = outboundCache.keys().next().value;
    if (!oldestKey) break;
    outboundCache.delete(oldestKey);
    outboundCacheMetrics.evictions++;
  }
  maybeLogOutboundCacheMetrics();
}

function getResponseKey(response: SwarmResponse, recordMessageId: string): string {
  const anchor = response.replyToMessageId ?? response.generatedAt ?? recordMessageId;
  return `${response.conversationId}#${anchor}`;
}

async function wasResponseHandled(avatarId: string, responseKey: string): Promise<boolean> {
  const result = await dynamo.send(new GetCommand({
    TableName: STATE_TABLE,
    Key: {
      pk: `AVATAR#${avatarId}`,
      sk: `RESPONSE#${responseKey}`,
    },
  }));
  return Boolean(result.Item);
}

async function markResponseHandled(avatarId: string, responseKey: string): Promise<void> {
  const now = Date.now();
  const ttl = Math.floor(now / 1000) + IDEMPOTENCY_TTL_SECONDS;
  try {
    await dynamo.send(new PutCommand({
      TableName: STATE_TABLE,
      Item: {
        pk: `AVATAR#${avatarId}`,
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
      avatarId,
      responseKey,
    });
  }
}

async function initialize(): Promise<void> {
  if (stateService) return;

  stateService = createStateService(STATE_TABLE);
  activityService = createActivityService(ACTIVITY_TABLE);
}

/**
 * Fetch individual secrets from Secrets Manager using direct paths.
 * Delegates to the shared loadAvatarSecrets utility for consistent
 * fallback chains and naming conventions across all handlers.
 */
async function fetchAvatarSecrets(avatarId: string): Promise<Record<string, string>> {
  const secretsService = (await import('@swarm/core')).createSecretsService();
  return loadAvatarSecrets(secretsService, avatarId, SECRET_PREFIX);
}

async function getOutboundRuntime(avatarId: string): Promise<AvatarOutboundRuntime> {
  const cached = getCachedOutboundRuntime(avatarId);
  if (cached) return cached;

  const avatarConfig = await stateService.getAvatarConfig(avatarId) || {
    ...DEFAULT_AVATAR_CONFIG,
    id: avatarId,
    name: avatarId,
    persona: '',
    tools: [],
    secrets: [],
  };

  // Fetch individual secrets from Secrets Manager using direct paths
  const secrets = await fetchAvatarSecrets(avatarId);

  const platformRegistry = new PlatformRegistry();

  if (avatarConfig.platforms.telegram?.enabled && secrets.TELEGRAM_BOT_TOKEN) {
    platformRegistry.register(new TelegramAdapter(avatarConfig, secrets.TELEGRAM_BOT_TOKEN));
  }

  if (avatarConfig.platforms.twitter?.enabled && secrets.TWITTER_API_KEY) {
    platformRegistry.register(new TwitterAdapter(avatarConfig, {
      appKey: secrets.TWITTER_API_KEY,
      appSecret: secrets.TWITTER_API_SECRET,
      accessToken: secrets.TWITTER_ACCESS_TOKEN,
      accessSecret: secrets.TWITTER_ACCESS_SECRET,
    }));
  }

  if (avatarConfig.platforms.web?.enabled) {
    platformRegistry.register(new WebAdapter(avatarConfig));
  }

  if (avatarConfig.platforms.discord?.enabled) {
    platformRegistry.register(new DiscordAdapter(avatarConfig, {
      botToken: secrets.DISCORD_BOT_TOKEN || secrets.discord_bot_token,
      webhookUrl: avatarConfig.platforms.discord.webhookUrl,
      webhookId: avatarConfig.platforms.discord.webhookId,
      webhookToken: avatarConfig.platforms.discord.webhookToken,
      applicationId: avatarConfig.platforms.discord.applicationId,
      publicKey: avatarConfig.platforms.discord.publicKey,
    }));
  }

  const outboundSender = createOutboundSender(platformRegistry, activityService);

  const runtime: AvatarOutboundRuntime = {
    avatarId,
    avatarConfig,
    secrets,
    platformRegistry,
    outboundSender,
  };

  setCachedOutboundRuntime(avatarId, runtime);
  return runtime;
}

export const handler: Handler<SQSEvent, SQSBatchResponse> = async (
  event: SQSEvent,
  context: Context
) => {
  logger.setContext({
    avatarId: LEGACY_AVATAR_ID || 'shared',
    requestId: context.awsRequestId,
  });

  logger.info('Response sender invoked', {
    event: 'handler_started',
    subsystem: 'outbound',
    recordCount: event.Records.length,
  });

  await initialize();

  const metrics = createRuntimeMetricsLogger('ResponseSender');
  metrics.incrementCounter('ResponsesReceived', event.Records.length);

  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];

  for (const record of event.Records) {
    const recordStartTime = Date.now();
    try {
      const traceId = record.messageAttributes?.traceId?.stringValue;
      const correlationId = extractCorrelationIdFromSqsRecord(record);

      let response: SwarmResponse;
      let rawBody: string = record.body;
      let wasOffloaded = false;
      try {
        const parsed = await parseSqsRecordBody(record.body);
        response = parsed.payload as SwarmResponse;
        rawBody = parsed.rawBody;
        wasOffloaded = parsed.wasOffloaded;
      } catch (parseError) {
        logger.error('Failed to parse message body', parseError, {
          event: 'parse_error',
          subsystem: 'outbound',
          messageId: record.messageId,
          bodyPreview: record.body?.slice(0, 100),
        });
        batchItemFailures.push({ itemIdentifier: record.messageId });
        continue;
      }

      const responseKey = getResponseKey(response, record.messageId);
      const avatarId = response.avatarId || LEGACY_AVATAR_ID;
      if (!avatarId) {
        logger.error('Missing avatarId in response (shared sender requires response.avatarId)', {
          event: 'validation_error',
          subsystem: 'outbound',
          messageId: record.messageId,
        });
        batchItemFailures.push({ itemIdentifier: record.messageId });
        continue;
      }

      if (await wasResponseHandled(avatarId, responseKey)) {
        logger.info('Skipping already handled response', {
          event: 'response_skipped',
          subsystem: 'outbound',
          reason: 'already_handled',
          responseKey,
        });
        metrics.incrementCounter('DuplicatesSkipped');
        continue;
      }

      const outboundRuntime = await getOutboundRuntime(avatarId);

      logger.setContext({
        avatarId,
        platform: response.platform,
        conversationId: response.conversationId,
        correlationId,
        traceId,
      });

      logger.info('Sending response', {
        event: 'sending_response',
        subsystem: 'outbound',
        actions: response.actions.length,
      });

      // Defense-in-depth: avatar bots should not send persona replies in Telegram DMs
      // UNLESS the user is in the allowedDmUserIds list.
      // For DMs, conversationId is the user's Telegram ID.
      const telegramCfg = outboundRuntime.avatarConfig.platforms.telegram;
      if (
        response.platform === 'telegram' &&
        isTelegramDirectMessageChatId(response.conversationId) &&
        !(await isAllowedDmUserById(response.conversationId, telegramCfg))
      ) {
        const adapter = outboundRuntime.platformRegistry.get('telegram');
        if (!adapter || !(adapter instanceof TelegramAdapter)) {
          logger.error('Telegram adapter missing for DM redirect', {
            event: 'dm_redirect_failed',
            subsystem: 'outbound',
            reason: 'missing_adapter',
          });
          batchItemFailures.push({ itemIdentifier: record.messageId });
          continue;
        }

        const bot = adapter.getBot();
        if (!bot) {
          logger.error('Telegram bot not initialized for DM redirect', {
            event: 'dm_redirect_failed',
            subsystem: 'outbound',
            reason: 'missing_bot',
          });
          batchItemFailures.push({ itemIdentifier: record.messageId });
          continue;
        }

        const dm = buildTelegramDmRedirect({
          ratichatUrl: outboundRuntime.avatarConfig.platforms.telegram?.homeChannelUrl
            || DEFAULT_RATICHAT_URL,
        });

        try {
          await bot.api.sendMessage(parseInt(response.conversationId), dm.text, {
            reply_markup: dm.replyMarkup,
          });

          logger.info('Sent Telegram DM redirect instead of persona reply', {
            event: 'dm_redirect_sent',
            subsystem: 'outbound',
            chatId: response.conversationId,
          });

          // Mark handled so it doesn't retry.
          await markResponseHandled(avatarId, responseKey);
          try {
            await stateService.markResponseSent(
              avatarId,
              response.conversationId,
              `resp_dm_redirect_${Date.now()}`
            );
          } catch {
            // Best-effort.
          }

          continue;
        } catch (error) {
          logger.error('Failed to send Telegram DM redirect', error, {
            event: 'dm_redirect_failed',
            subsystem: 'outbound',
          });
          batchItemFailures.push({ itemIdentifier: record.messageId });
          continue;
        }
      }

      // Log Twitter-specific reply targeting for observability
      if (response.platform === 'twitter') {
        logger.info('Twitter reply targeting', {
          event: 'twitter_reply_target',
          subsystem: 'outbound',
          avatarId,
          threadId: response.conversationId,
          replyToMessageId: response.replyToMessageId,
        });
      }

      // Check for media generation actions - queue them first
      const mediaActions = response.actions.filter(
        (a: ResponseAction) => a.type === 'take_selfie' || a.type === 'generate_video' || a.type === 'generate_image'
      );
      const nonMediaActions = response.actions.filter(
        (a: ResponseAction) => a.type !== 'take_selfie' && a.type !== 'generate_video' && a.type !== 'generate_image'
      );
      let actionsToSend: ResponseAction[] | null = null;
      let queuedMedia = false;
      let sentMessages: string[] = [];
      let sendErrors: ActionError[] = [];
      let sendSuccess = false;

      if (mediaActions.length > 0) {
        if (MEDIA_QUEUE_URL) {
          // Queue media generation and wait
          for (const action of mediaActions) {
            const jobId = randomUUID();
            await sendSqsMessage({
              QueueUrl: MEDIA_QUEUE_URL,
              MessageAttributes: traceId
                ? { traceId: { DataType: 'String', StringValue: traceId } }
                : undefined,
              MessageGroupId: response.conversationId,
              MessageDeduplicationId: `media_${jobId}`,
            }, {
              jobId,
              avatarId,
              conversationId: response.conversationId,
              action,
              response,
              traceId,
            });
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
        const result = await outboundRuntime.outboundSender.send({ ...response, actions: actionsToSend });
        sentMessages = result.sentMessages;
        sendErrors = result.errors;
        sendSuccess = result.success;

        if (sendErrors.length > 0) {
          logger.warn('Some actions failed during outbound send', {
            event: 'outbound_action_errors',
            subsystem: 'outbound',
            platform: response.platform,
            avatarId,
            conversationId: response.conversationId,
            errorCount: sendErrors.length,
            errors: sendErrors,
            actionTypes: actionsToSend.map((a: ResponseAction) => a.type),
          });
        }
      } else {
        sendSuccess = queuedMedia;
      }

      // Update channel state with bot's response
      for (const text of sentMessages) {
        try {
          await stateService.addMessageToChannel(
            avatarId,
            response.conversationId,
            response.platform,
            {
              messageId: `bot_${randomUUID()}`,
              sender: outboundRuntime.avatarConfig.name,
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
          event: 'send_failed',
          subsystem: 'outbound',
          conversationId: response.conversationId,
        });
      }
      const shouldMarkResponse = hasActionsToSend
        ? (hasSendMessageAction ? sentMessages.length > 0 : sendSuccess)
        : false;
      if (shouldMarkResponse) {
        try {
          await stateService.markResponseSent(
            avatarId,
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
        await markResponseHandled(avatarId, responseKey);
      }

      if (actionsToSend && actionsToSend.length > 0 && !sendSuccess) {
        metrics.trackDuration('SendLatency', recordStartTime);
        metrics.incrementCounter('SendErrors');
        metrics.setProperty('Outcome', 'error');

        // Check if ALL errors are non-retryable (e.g. 403 reply restrictions).
        // If so, don't add to batchItemFailures — retrying won't help.
        const hasRetryableError = sendErrors.length === 0 ||
          sendErrors.some(e => e.isRetryable !== false);

        if (!hasRetryableError) {
          logger.warn('All action errors are non-retryable, skipping SQS retry', {
            event: 'non_retryable_errors_discarded',
            subsystem: 'outbound',
            messageId: record.messageId,
            platform: response.platform,
            avatarId,
            conversationId: response.conversationId,
            errors: sendErrors,
          });
          // Mark as handled so the idempotency guard prevents future processing
          await markResponseHandled(avatarId, responseKey);
        } else {
          batchItemFailures.push({ itemIdentifier: record.messageId });
          logger.error('Response actions failed to send', undefined, {
            event: 'send_error',
            subsystem: 'outbound',
            messageId: record.messageId,
            platform: response.platform,
            avatarId,
            conversationId: response.conversationId,
            actionTypes: actionsToSend.map((a: ResponseAction) => a.type),
            errors: sendErrors,
          });
        }
        continue;
      }

      // Clean up offloaded S3 payload (if any)
      if (wasOffloaded) {
        await cleanupSqsRecord(rawBody);
      }

      metrics.trackDuration('SendLatency', recordStartTime);
      metrics.incrementCounter('ResponsesSent');
      metrics.setProperty('Outcome', 'success');
      metrics.setProperty('Platform', response.platform);

      logger.info('Response sent successfully', {
        event: 'response_sent',
        subsystem: 'outbound',
        conversationId: response.conversationId,
        platform: response.platform,
        actionCount: actionsToSend?.length || 0,
      });

    } catch (error) {
      metrics.trackDuration('SendLatency', recordStartTime);
      metrics.incrementCounter('SendErrors');
      metrics.setProperty('Outcome', 'error');

      logger.error('Failed to send response', error, {
        event: 'handler_error',
        subsystem: 'outbound',
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  metrics.flush();

  return { batchItemFailures };
};
