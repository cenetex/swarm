/**
 * Continuation Processor Handler
 *
 * Processes async job results and either:
 * 1. Re-triggers the avatar loop for actionable events (completed/failed)
 * 2. Sends progress updates directly to the user
 *
 * This enables avatars to act on async results like:
 * - Posting generated images to Twitter
 * - Summarizing research results
 * - Responding to code task completions
 */
import type { SQSEvent, Context, SQSBatchResponse } from 'aws-lambda';
import { sendSqsMessage } from '../services/sqs-send.js';
import { randomUUID } from 'node:crypto';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { logger, extractCorrelationIdFromSqsRecord } from '@swarm/core';
import type {
  ContinuationMessage,
} from '@swarm/core';
import {
  formatContinuationAsSystemMessage,
  shouldTriggerAvatarLoop,
  isProgressUpdate,
} from '@swarm/core';
import { getDynamoClient } from '../services/dynamo-client.js';
import { getAdminTable } from '../services/env-validation.js';

const dynamoClient = getDynamoClient();
const secretsClient = new SecretsManagerClient({});

// Environment variables — ADMIN_TABLE is validated lazily via getAdminTable()
const MESSAGE_QUEUE_URL = process.env.MESSAGE_QUEUE_URL;

// For direct responses (progress updates)
const TELEGRAM_TIMEOUT_MS = 10000;

// Secret cache
const secretCache = new Map<string, { value: string; expiresAt: number }>();
const SECRET_CACHE_TTL = 5 * 60 * 1000;

async function getSecret(secretArn: string): Promise<string | null> {
  const now = Date.now();
  const cached = secretCache.get(secretArn);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  try {
    const response = await secretsClient.send(new GetSecretValueCommand({
      SecretId: secretArn,
    }));
    const value = response.SecretString || '';
    secretCache.set(secretArn, { value, expiresAt: now + SECRET_CACHE_TTL });
    return value;
  } catch (error) {
    logger.error('Failed to get secret', error, { secretArn });
    return null;
  }
}

async function getTelegramToken(avatarId: string): Promise<string | null> {
  const result = await dynamoClient.send(new GetCommand({
    TableName: getAdminTable(),
    Key: { pk: `AVATAR#${avatarId}`, sk: 'SECRET#telegram_bot_token#default' },
  }));
  if (!result.Item?.secretArn) return null;
  return getSecret(result.Item.secretArn);
}

/**
 * Send a simple text message to Telegram (for progress updates)
 */
async function sendTelegramMessage(
  token: string,
  chatId: string,
  text: string,
  replyTo?: number
): Promise<boolean> {
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        reply_to_message_id: replyTo,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Format a progress update for the user
 */
function formatProgressForUser(msg: ContinuationMessage): string {
  switch (msg.type) {
    case 'media_progress':
      return `⏳ ${msg.data.mediaType} generation: ${msg.data.status}${msg.data.progress !== undefined ? ` (${msg.data.progress}%)` : ''}`;

    case 'research_progress':
      return `🔍 Property research: ${msg.data.stage}\n${msg.data.message}`;

    case 'code_progress': {
      const stageEmoji = {
        thinking: '🤔',
        coding: '💻',
        testing: '🧪',
        reviewing: '👀',
      }[msg.data.stage] || '⚙️';
      return `${stageEmoji} ${msg.data.message}${msg.data.currentFile ? `\n📄 ${msg.data.currentFile}` : ''}`;
    }

    case 'job_progress':
      return `⚙️ ${msg.data.jobType}: ${msg.data.message}`;

    default:
      return '⏳ Processing...';
  }
}

/**
 * Store the continuation context for the avatar to use in the next turn
 * This adds the async result to the conversation history
 */
async function storeContinuationContext(
  avatarId: string,
  conversationId: string,
  msg: ContinuationMessage
): Promise<void> {
  const key = {
    pk: `AVATAR#${avatarId}`,
    sk: `CONTINUATION#${conversationId}`,
  };

  // Store as a pending context that will be injected into the next avatar turn
  await dynamoClient.send(new UpdateCommand({
    TableName: getAdminTable(),
    Key: key,
    UpdateExpression: 'SET #context = list_append(if_not_exists(#context, :empty), :newContext), #updatedAt = :now, #ttl = :ttl',
    ExpressionAttributeNames: {
      '#context': 'pendingContext',
      '#updatedAt': 'updatedAt',
      '#ttl': 'ttl',
    },
    ExpressionAttributeValues: {
      ':newContext': [formatContinuationAsSystemMessage(msg)],
      ':empty': [],
      ':now': Date.now(),
      ':ttl': Math.floor(Date.now() / 1000) + 3600, // 1 hour TTL
    },
  }));

  logger.info('Stored continuation context', {
    avatarId,
    conversationId,
    messageType: msg.type,
  });
}

/**
 * Get and clear pending continuation context for a conversation
 */
export async function getPendingContinuationContext(
  avatarId: string,
  conversationId: string
): Promise<string[]> {
  const key = {
    pk: `AVATAR#${avatarId}`,
    sk: `CONTINUATION#${conversationId}`,
  };

  try {
    const result = await dynamoClient.send(new GetCommand({
      TableName: getAdminTable(),
      Key: key,
    }));

    const pending = result.Item?.pendingContext as string[] | undefined;
    if (!pending || pending.length === 0) {
      return [];
    }

    // Clear the pending context after retrieving
    await dynamoClient.send(new UpdateCommand({
      TableName: getAdminTable(),
      Key: key,
      UpdateExpression: 'SET #context = :empty, #updatedAt = :now',
      ExpressionAttributeNames: {
        '#context': 'pendingContext',
        '#updatedAt': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':empty': [],
        ':now': Date.now(),
      },
    }));

    return pending;
  } catch (error) {
    logger.error('Failed to get pending continuation context', error, {
      avatarId,
      conversationId,
    });
    return [];
  }
}

/**
 * Queue a message to trigger the avatar loop
 */
async function triggerAvatarLoop(
  msg: ContinuationMessage,
  systemMessage: string,
  traceId: string
): Promise<void> {
  if (!MESSAGE_QUEUE_URL) {
    logger.warn('MESSAGE_QUEUE_URL not configured, cannot trigger avatar loop');
    return;
  }

  // Create a synthetic "system" envelope that will trigger the avatar
  const envelope = {
    avatarId: msg.avatarId,
    platform: msg.platform,
    traceId,
    messageId: `continuation_${msg.jobId || Date.now()}`,
    conversationId: msg.conversationId,
    timestamp: msg.timestamp,
    sender: {
      id: 'system',
      username: 'system',
      displayName: 'System',
      isBot: true,
    },
    content: {
      text: systemMessage,
    },
    metadata: {
      isContinuation: true,
      continuationType: msg.type,
      originalJobId: msg.jobId,
      shouldRespond: true,
      responseReason: 'continuation',
      priority: 'high',
    },
    replyTo: msg.replyToMessageId,
  };

  await sendSqsMessage({
    QueueUrl: MESSAGE_QUEUE_URL,
    MessageAttributes: {
      traceId: {
        DataType: 'String',
        StringValue: traceId,
      },
    },
    MessageGroupId: msg.conversationId,
    MessageDeduplicationId: `cont_${msg.jobId || msg.timestamp}`,
  }, {
    envelope,
    enqueuedAt: Date.now(),
    attempts: 0,
    maxAttempts: 1, // Don't retry continuations
  });

  logger.info('Triggered avatar loop for continuation', {
    avatarId: msg.avatarId,
    conversationId: msg.conversationId,
    type: msg.type,
  });
}

/**
 * Process a continuation message
 */
async function processMessage(msg: ContinuationMessage, traceId: string): Promise<void> {
  const { avatarId, platform, conversationId, replyToMessageId } = msg;

  logger.info('Processing continuation', {
    type: msg.type,
    avatarId,
    platform,
    conversationId,
  });

  // Handle progress updates - send directly to user, don't trigger avatar
  if (isProgressUpdate(msg)) {
    if (platform === 'telegram') {
      const token = await getTelegramToken(avatarId);
      if (token) {
        const chatId = conversationId.startsWith('telegram:')
          ? conversationId.replace('telegram:', '')
          : conversationId;
        const replyTo = replyToMessageId && Number.isFinite(Number(replyToMessageId))
          ? Number(replyToMessageId)
          : undefined;

        const text = formatProgressForUser(msg);
        await sendTelegramMessage(token, chatId, text, replyTo);
      }
    }
    // For other platforms, just log for now
    return;
  }

  // Handle actionable events - trigger the avatar loop
  if (shouldTriggerAvatarLoop(msg)) {
    const systemMessage = formatContinuationAsSystemMessage(msg);

    // Store context for the avatar to use
    await storeContinuationContext(avatarId, conversationId, msg);

    // Trigger the avatar loop
    await triggerAvatarLoop(msg, systemMessage, traceId);
  }
}

/**
 * Lambda handler for continuation messages
 */
export async function handler(
  event: SQSEvent,
  context: Context
): Promise<SQSBatchResponse> {
  logger.setContext({
    subsystem: 'continuation',
    requestId: context.awsRequestId,
  });

  logger.info('Continuation processor triggered', { recordCount: event.Records.length });
  const batchItemFailures: SQSBatchResponse['batchItemFailures'] = [];

  for (const record of event.Records) {
    try {
      const recordTraceId = record.messageAttributes?.traceId?.stringValue;
      const traceId = recordTraceId || randomUUID();
      const correlationId = extractCorrelationIdFromSqsRecord(record);
      logger.setContext({ correlationId, traceId });

      let msg: ContinuationMessage;
      try {
        msg = JSON.parse(record.body);
      } catch (parseError) {
        logger.error('Failed to parse continuation message', parseError, {
          messageId: record.messageId,
          bodyPreview: record.body?.slice(0, 100),
        });
        batchItemFailures.push({ itemIdentifier: record.messageId });
        continue;
      }

      logger.setContext({
        avatarId: msg.avatarId,
        platform: msg.platform,
        conversationId: msg.conversationId,
      });

      await processMessage(msg, traceId);
    } catch (error) {
      logger.error('Failed to process continuation', error, {
        messageId: record.messageId,
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}
