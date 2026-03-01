/**
 * DLQ Processor Handler
 *
 * Processes messages from the dead-letter queue (DLQ) for inspection,
 * categorization, and selective redrive or archival.
 *
 * Responsibilities:
 * - Reads failed messages from the DLQ
 * - Categorizes failure reasons (parse error, schema error, transient, permanent)
 * - Emits CloudWatch metrics for DLQ processing
 * - Archives failed messages to DynamoDB for later analysis
 * - Optionally redrives transient failures back to the source queue
 *
 * This handler is triggered on a schedule (not directly from SQS) so it can
 * control batch sizes and avoid consuming messages that shouldn't be retried.
 */
import type { ScheduledEvent, Context } from 'aws-lambda';
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  SendMessageCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { logger } from '@swarm/core';
import { getDynamoClient } from './services/dynamo-client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Failure category for a DLQ message.
 *
 * - `parse_error`    : message body is not valid JSON (poison pill)
 * - `schema_error`   : JSON is valid but doesn't match any known schema
 * - `transient`      : likely a transient error (timeout, throttle, etc.)
 * - `permanent`      : deterministic failure that won't resolve on retry
 * - `unknown`        : could not determine failure category
 */
export type FailureCategory =
  | 'parse_error'
  | 'schema_error'
  | 'transient'
  | 'permanent'
  | 'unknown';

export interface DlqMessageAnalysis {
  messageId: string;
  category: FailureCategory;
  sourceQueue: string | undefined;
  avatarId: string | undefined;
  platform: string | undefined;
  conversationId: string | undefined;
  errorSummary: string;
  receivedAt: number;
  bodyPreview: string;
  approximateReceiveCount: number;
  sentTimestamp: number | undefined;
}

export interface DlqProcessorResult {
  inspected: number;
  archived: number;
  redriven: number;
  deleted: number;
  errors: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_MESSAGES_PER_RUN = 10;
const ARCHIVE_TTL_DAYS = 30;
const MAX_REDRIVE_RECEIVE_COUNT = 6;

/**
 * Base delay in seconds for redriven messages. Uses exponential backoff based
 * on the message's ApproximateReceiveCount. SQS DelaySeconds caps at 900 (15 min).
 */
const REDRIVE_BASE_DELAY_SECONDS = 30;
const REDRIVE_MAX_DELAY_SECONDS = 900;

/**
 * Maximum age (in ms) for a DLQ message to be eligible for redrive.
 * Messages older than 24 hours are treated as stale and archived instead.
 */
const REDRIVE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Error message substrings that indicate permanent (non-retryable) failures.
 * These are deterministic errors that will never succeed on retry.
 */
const PERMANENT_ERROR_PATTERNS: string[] = [
  'avatar not found',
  'avatar deleted',
  'invalid configuration',
  'config validation failed',
  'schema validation',
  'unauthorized',
  'forbidden',
  'access denied',
  'invalid api key',
  'account suspended',
  'account deactivated',
  'bot was blocked',
  'chat not found',
  'user is deactivated',
];

// ---------------------------------------------------------------------------
// Clients (lazy-init on cold start)
// ---------------------------------------------------------------------------

const sqsClient = new SQSClient({});
const cwClient = new CloudWatchClient({});
const dynamoClient = getDynamoClient();

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Required environment variable ${name} is not set`);
  return value;
}

function getDlqUrl(): string {
  return getRequiredEnv('DLQ_URL');
}

function getStateTable(): string {
  return getRequiredEnv('STATE_TABLE');
}

function getEnvironment(): string {
  return process.env.ENVIRONMENT || 'unknown';
}

function getMessageQueueUrl(): string | undefined {
  return process.env.MESSAGE_QUEUE_URL;
}

function getResponseQueueUrl(): string | undefined {
  return process.env.RESPONSE_QUEUE_URL;
}

function getMediaQueueUrl(): string | undefined {
  return process.env.MEDIA_QUEUE_URL;
}

function getPostQueueUrl(): string | undefined {
  return process.env.POST_QUEUE_URL;
}

/** Whether automatic redrive of transient failures is enabled. */
function isRedriveEnabled(): boolean {
  return process.env.DLQ_REDRIVE_ENABLED === 'true';
}

// ---------------------------------------------------------------------------
// Analysis helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Attempt to categorize a DLQ message by inspecting its body and attributes.
 *
 * Categorization priority:
 *   1. Unparseable JSON -> parse_error
 *   2. Unknown schema   -> schema_error
 *   3. Known permanent error patterns in embedded error fields -> permanent
 *   4. Structurally valid with no permanent signal -> transient
 */
export function categorizeMessage(body: string | undefined): FailureCategory {
  if (!body) return 'parse_error';

  // 1. Can we parse the JSON at all?
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return 'parse_error';
  }

  // 2. Does it look like a known envelope?
  if (typeof parsed !== 'object' || parsed === null) return 'schema_error';

  const obj = parsed as Record<string, unknown>;

  // Check for envelope-based messages (message queue, response queue)
  const hasEnvelope =
    typeof obj.envelope === 'object' && obj.envelope !== null;
  const hasAvatarId = typeof obj.avatarId === 'string';
  const hasActions = Array.isArray(obj.actions);

  if (!hasEnvelope && !hasAvatarId && !hasActions) {
    return 'schema_error';
  }

  // 3. Check for permanent error signals embedded in the message.
  //    Some processors annotate failed messages with error details before
  //    they land in the DLQ.
  if (containsPermanentErrorSignal(obj)) {
    return 'permanent';
  }

  // 4. Structurally valid messages without permanent error signals are
  //    assumed to have failed due to transient issues (timeout, rate
  //    limit, dependency outage, etc.).
  return 'transient';
}

/**
 * Scan known error fields in the message body for permanent failure patterns.
 *
 * Exported for testing.
 */
export function containsPermanentErrorSignal(obj: Record<string, unknown>): boolean {
  // Collect candidate strings from common error fields
  const candidates: string[] = [];

  const addIfString = (val: unknown) => {
    if (typeof val === 'string') candidates.push(val.toLowerCase());
  };

  addIfString(obj.error);
  addIfString(obj.errorMessage);
  addIfString(obj.failureReason);

  // Check nested error objects
  if (typeof obj.error === 'object' && obj.error !== null) {
    const errObj = obj.error as Record<string, unknown>;
    addIfString(errObj.message);
    addIfString(errObj.code);
  }

  // Check envelope-level error
  if (typeof obj.envelope === 'object' && obj.envelope !== null) {
    const envelope = obj.envelope as Record<string, unknown>;
    addIfString(envelope.error);
    addIfString(envelope.errorMessage);
  }

  for (const candidate of candidates) {
    for (const pattern of PERMANENT_ERROR_PATTERNS) {
      if (candidate.includes(pattern)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Extract identifying information from the message body.
 */
export function extractMessageContext(body: string | undefined): {
  avatarId: string | undefined;
  platform: string | undefined;
  conversationId: string | undefined;
} {
  const fallback = { avatarId: undefined, platform: undefined, conversationId: undefined };
  if (!body) return fallback;

  try {
    const parsed = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) return fallback;

    const obj = parsed as Record<string, unknown>;

    // Try envelope path first (message queue items)
    if (typeof obj.envelope === 'object' && obj.envelope !== null) {
      const envelope = obj.envelope as Record<string, unknown>;
      return {
        avatarId: typeof envelope.avatarId === 'string' ? envelope.avatarId : undefined,
        platform: typeof envelope.platform === 'string' ? envelope.platform : undefined,
        conversationId:
          typeof envelope.conversationId === 'string' ? envelope.conversationId : undefined,
      };
    }

    // Try flat response path (response queue items)
    return {
      avatarId: typeof obj.avatarId === 'string' ? obj.avatarId : undefined,
      platform: typeof obj.platform === 'string' ? obj.platform : undefined,
      conversationId:
        typeof obj.conversationId === 'string' ? obj.conversationId : undefined,
    };
  } catch {
    return fallback;
  }
}

/**
 * Determine which source queue a DLQ message likely came from based on
 * its body structure.
 */
export function inferSourceQueue(body: string | undefined): string | undefined {
  if (!body) return undefined;

  try {
    const parsed = JSON.parse(body);
    if (typeof parsed !== 'object' || parsed === null) return undefined;

    const obj = parsed as Record<string, unknown>;

    // Message queue items have envelope + enqueuedAt + attempts
    if (obj.envelope && typeof obj.enqueuedAt === 'number' && typeof obj.attempts === 'number') {
      return getMessageQueueUrl();
    }

    // Response queue items have actions array + platform
    if (Array.isArray(obj.actions) && typeof obj.platform === 'string') {
      return getResponseQueueUrl();
    }

    // Media queue items have action + callbackUrl
    if (
      typeof obj.action === 'object' &&
      obj.action !== null &&
      typeof obj.conversationId === 'string' &&
      typeof obj.jobId === 'string'
    ) {
      return getMediaQueueUrl();
    }

    // Post queue items
    if (typeof obj.tweetContent === 'string' || typeof obj.postType === 'string') {
      return getPostQueueUrl();
    }

    return undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Archive
// ---------------------------------------------------------------------------

async function archiveMessage(analysis: DlqMessageAnalysis, rawBody: string): Promise<void> {
  const now = Date.now();
  const ttl = Math.floor(now / 1000) + ARCHIVE_TTL_DAYS * 24 * 60 * 60;

  await dynamoClient.send(
    new PutCommand({
      TableName: getStateTable(),
      Item: {
        pk: 'DLQ#archive',
        sk: `${now}#${analysis.messageId}`,
        messageId: analysis.messageId,
        category: analysis.category,
        sourceQueue: analysis.sourceQueue,
        avatarId: analysis.avatarId,
        platform: analysis.platform,
        conversationId: analysis.conversationId,
        errorSummary: analysis.errorSummary,
        bodyPreview: analysis.bodyPreview,
        approximateReceiveCount: analysis.approximateReceiveCount,
        sentTimestamp: analysis.sentTimestamp,
        archivedAt: now,
        rawBody,
        ttl,
      },
    })
  );
}

// ---------------------------------------------------------------------------
// Redrive
// ---------------------------------------------------------------------------

/**
 * Calculate exponential backoff delay (in seconds) for a redrive attempt.
 *
 * Formula: min(base * 2^(receiveCount - 1), max)
 *
 * Exported for testing.
 */
export function calculateRedriveDelay(approximateReceiveCount: number): number {
  const exponent = Math.max(0, approximateReceiveCount - 1);
  const delay = REDRIVE_BASE_DELAY_SECONDS * Math.pow(2, exponent);
  return Math.min(delay, REDRIVE_MAX_DELAY_SECONDS);
}

async function redriveMessage(
  body: string,
  sourceQueueUrl: string,
  delaySeconds: number,
  messageGroupId?: string
): Promise<void> {
  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: sourceQueueUrl,
      MessageBody: body,
      // FIFO queues do not support per-message DelaySeconds; standard queues do.
      ...(sourceQueueUrl.endsWith('.fifo')
        ? {
            MessageGroupId: messageGroupId || 'dlq-redrive',
            MessageDeduplicationId: `redrive_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          }
        : { DelaySeconds: delaySeconds }),
    })
  );
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

async function publishMetrics(result: DlqProcessorResult, categoryCounts: Record<FailureCategory, number>): Promise<void> {
  const namespace = `Swarm/${getEnvironment()}`;
  const timestamp = new Date();

  const metricData: Array<{
    MetricName: string;
    Value: number;
    Timestamp: Date;
    Unit: 'Count' | 'Percent';
    Dimensions?: Array<{ Name: string; Value: string }>;
  }> = [
    {
      MetricName: 'DlqMessagesInspected',
      Value: result.inspected,
      Timestamp: timestamp,
      Unit: 'Count',
    },
    {
      MetricName: 'DlqMessagesArchived',
      Value: result.archived,
      Timestamp: timestamp,
      Unit: 'Count',
    },
    {
      MetricName: 'DlqMessagesRedriven',
      Value: result.redriven,
      Timestamp: timestamp,
      Unit: 'Count',
    },
    {
      MetricName: 'DlqMessagesDeleted',
      Value: result.deleted,
      Timestamp: timestamp,
      Unit: 'Count',
    },
    {
      MetricName: 'DlqProcessingErrors',
      Value: result.errors,
      Timestamp: timestamp,
      Unit: 'Count',
    },
    // Acceptance criteria: permanent failure count metric
    {
      MetricName: 'DlqPermanentFailures',
      Value: categoryCounts.permanent,
      Timestamp: timestamp,
      Unit: 'Count',
    },
  ];

  // Acceptance criteria: redrive success rate metric
  // Rate = redriven / (redriven + transient-not-redriven) expressed as a
  // percentage.  When there are no transient messages the rate is 100%.
  const transientTotal = categoryCounts.transient;
  const redriveSuccessRate = transientTotal > 0
    ? Math.round((result.redriven / transientTotal) * 100)
    : 100;
  metricData.push({
    MetricName: 'DlqRedriveSuccessRate',
    Value: redriveSuccessRate,
    Timestamp: timestamp,
    Unit: 'Percent',
  });

  // Add per-category metrics
  for (const [category, count] of Object.entries(categoryCounts)) {
    if (count > 0) {
      metricData.push({
        MetricName: 'DlqMessagesByCategory',
        Value: count,
        Timestamp: timestamp,
        Unit: 'Count',
        Dimensions: [{ Name: 'Category', Value: category }],
      });
    }
  }

  try {
    await cwClient.send(
      new PutMetricDataCommand({
        Namespace: namespace,
        MetricData: metricData,
      })
    );
  } catch (err) {
    logger.warn('Failed to publish DLQ metrics', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handler(
  _event: ScheduledEvent,
  context: Context
): Promise<DlqProcessorResult> {
  logger.setContext({
    subsystem: 'dlq-processor',
    requestId: context.awsRequestId,
  });

  const dlqUrl = getDlqUrl();

  // Check approximate message count first
  let approximateMessageCount = 0;
  try {
    const attrs = await sqsClient.send(
      new GetQueueAttributesCommand({
        QueueUrl: dlqUrl,
        AttributeNames: ['ApproximateNumberOfMessages'],
      })
    );
    approximateMessageCount = parseInt(
      attrs.Attributes?.ApproximateNumberOfMessages || '0',
      10
    );
  } catch (err) {
    logger.warn('Failed to get DLQ queue attributes', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  logger.info('DLQ processor started', {
    event: 'dlq_processor_started',
    dlqUrl,
    approximateMessageCount,
    redriveEnabled: isRedriveEnabled(),
  });

  if (approximateMessageCount === 0) {
    logger.info('DLQ is empty, nothing to process', {
      event: 'dlq_empty',
    });
    return { inspected: 0, archived: 0, redriven: 0, deleted: 0, errors: 0 };
  }

  const result: DlqProcessorResult = {
    inspected: 0,
    archived: 0,
    redriven: 0,
    deleted: 0,
    errors: 0,
  };

  const categoryCounts: Record<FailureCategory, number> = {
    parse_error: 0,
    schema_error: 0,
    transient: 0,
    permanent: 0,
    unknown: 0,
  };

  // Receive messages from DLQ
  let receiveResult;
  try {
    receiveResult = await sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: dlqUrl,
        MaxNumberOfMessages: MAX_MESSAGES_PER_RUN,
        WaitTimeSeconds: 5,
        AttributeNames: ['All'],
        MessageAttributeNames: ['All'],
      })
    );
  } catch (err) {
    logger.error('Failed to receive messages from DLQ', err instanceof Error ? err : undefined, {
      event: 'dlq_receive_error',
    });
    return { ...result, errors: 1 };
  }

  const messages = receiveResult.Messages || [];
  logger.info('Received DLQ messages', {
    event: 'dlq_messages_received',
    count: messages.length,
  });

  for (const message of messages) {
    result.inspected++;

    try {
      const body = message.Body;
      const receiptHandle = message.ReceiptHandle;
      const messageId = message.MessageId || 'unknown';
      const approximateReceiveCount = parseInt(
        message.Attributes?.ApproximateReceiveCount || '1',
        10
      );
      const sentTimestamp = message.Attributes?.SentTimestamp
        ? parseInt(message.Attributes.SentTimestamp, 10)
        : undefined;

      // Analyze the message
      const category = categorizeMessage(body);
      const msgContext = extractMessageContext(body);
      const sourceQueue = inferSourceQueue(body);

      categoryCounts[category]++;

      const analysis: DlqMessageAnalysis = {
        messageId,
        category,
        sourceQueue,
        avatarId: msgContext.avatarId,
        platform: msgContext.platform,
        conversationId: msgContext.conversationId,
        errorSummary: `${category}: message failed after ${approximateReceiveCount} attempts`,
        receivedAt: Date.now(),
        bodyPreview: (body || '').slice(0, 500),
        approximateReceiveCount,
        sentTimestamp,
      };

      logger.info('DLQ message analyzed', {
        event: 'dlq_message_analyzed',
        messageId,
        category,
        sourceQueue: sourceQueue ? 'identified' : 'unknown',
        avatarId: msgContext.avatarId,
        platform: msgContext.platform,
        approximateReceiveCount,
        ageMs: sentTimestamp ? Date.now() - sentTimestamp : undefined,
      });

      // Archive the message to DynamoDB
      try {
        await archiveMessage(analysis, body || '');
        result.archived++;
      } catch (archiveErr) {
        logger.error('Failed to archive DLQ message', archiveErr instanceof Error ? archiveErr : undefined, {
          event: 'dlq_archive_error',
          messageId,
        });
        result.errors++;
      }

      // Decide whether to redrive or delete
      let shouldRedrive = false;
      let shouldDelete = false;
      let redriveDelaySeconds = 0;

      if (category === 'parse_error' || category === 'schema_error') {
        // Poison pills: delete after archiving (no point retrying)
        shouldDelete = true;
      } else if (category === 'permanent') {
        // Permanent failures: deterministic errors that won't resolve on retry
        shouldDelete = true;
        logger.info('Permanent failure archived', {
          event: 'dlq_permanent_failure',
          messageId,
          avatarId: msgContext.avatarId,
        });
      } else if (category === 'transient' && isRedriveEnabled() && sourceQueue) {
        // Transient failures with known source: redrive if under threshold
        // and message is not too old (stale messages are unlikely to succeed).
        const isStale = sentTimestamp
          ? Date.now() - sentTimestamp > REDRIVE_MAX_AGE_MS
          : false;

        if (isStale) {
          shouldDelete = true;
          logger.warn('Transient message too old for redrive', {
            event: 'dlq_redrive_stale',
            messageId,
            ageMs: sentTimestamp ? Date.now() - sentTimestamp : undefined,
            maxAgeMs: REDRIVE_MAX_AGE_MS,
          });
        } else if (approximateReceiveCount < MAX_REDRIVE_RECEIVE_COUNT) {
          shouldRedrive = true;
          redriveDelaySeconds = calculateRedriveDelay(approximateReceiveCount);
        } else {
          // Too many retries, just archive and delete
          shouldDelete = true;
          logger.warn('Transient message exceeded redrive threshold', {
            event: 'dlq_redrive_threshold_exceeded',
            messageId,
            approximateReceiveCount,
            threshold: MAX_REDRIVE_RECEIVE_COUNT,
          });
        }
      } else {
        // Unknown or transient without redrive enabled: archive and delete
        shouldDelete = true;
      }

      if (shouldRedrive && sourceQueue && receiptHandle) {
        try {
          const messageGroupId = msgContext.avatarId
            ? `${msgContext.avatarId}#${msgContext.conversationId || 'unknown'}`
            : undefined;
          await redriveMessage(body || '', sourceQueue, redriveDelaySeconds, messageGroupId);
          result.redriven++;

          // Delete from DLQ after successful redrive
          await sqsClient.send(
            new DeleteMessageCommand({
              QueueUrl: dlqUrl,
              ReceiptHandle: receiptHandle,
            })
          );
          result.deleted++;

          logger.info('DLQ message redriven', {
            event: 'dlq_message_redriven',
            messageId,
            category,
            avatarId: msgContext.avatarId,
            delaySeconds: redriveDelaySeconds,
            approximateReceiveCount,
          });
        } catch (redriveErr) {
          logger.error('Failed to redrive DLQ message', redriveErr instanceof Error ? redriveErr : undefined, {
            event: 'dlq_redrive_error',
            messageId,
          });
          result.errors++;
        }
      } else if (shouldDelete && receiptHandle) {
        try {
          await sqsClient.send(
            new DeleteMessageCommand({
              QueueUrl: dlqUrl,
              ReceiptHandle: receiptHandle,
            })
          );
          result.deleted++;

          logger.info('DLQ message deleted after archive', {
            event: 'dlq_message_deleted',
            messageId,
            category,
          });
        } catch (deleteErr) {
          logger.error('Failed to delete DLQ message', deleteErr instanceof Error ? deleteErr : undefined, {
            event: 'dlq_delete_error',
            messageId,
          });
          result.errors++;
        }
      }
    } catch (err) {
      logger.error('Unexpected error processing DLQ message', err instanceof Error ? err : undefined, {
        event: 'dlq_processing_error',
        messageId: message.MessageId,
      });
      result.errors++;
    }
  }

  // Publish CloudWatch metrics
  await publishMetrics(result, categoryCounts);

  logger.info('DLQ processor completed', {
    event: 'dlq_processor_completed',
    ...result,
    categoryCounts,
  });

  return result;
}
