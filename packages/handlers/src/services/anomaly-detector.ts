/**
 * Anomaly Circuit Breaker
 *
 * Detects response loops (duplicate/rapid sends to same channel) and auto-pauses
 * avatars stuck in loops to prevent spam. Uses DynamoDB for windowed counting.
 *
 * Thresholds:
 * - 8 messages in 15 min → anomaly_warning
 * - 12 messages in 15 min → auto-pause
 * - 5 near-duplicate messages in 10 min → auto-pause
 */
import { GetCommand, PutCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { logger, type Platform } from '@swarm/core';
import { getDynamoClient } from './dynamo-client.js';

const dynamo = getDynamoClient();
const STATE_TABLE = process.env.STATE_TABLE!;
const WINDOW_15_MIN_MS = 15 * 60 * 1000;
const WINDOW_10_MIN_MS = 10 * 60 * 1000;
const WARNING_THRESHOLD = 8;
const PAUSE_THRESHOLD = 12;
const DUPLICATE_PAUSE_THRESHOLD = 5;

export interface AnomalyCheckResult {
  paused: boolean;
  reason?: string;
  metrics: {
    messageCount: number;
    duplicateCount: number;
    thresholdExceeded?: string;
  };
}

interface MessageRecord {
  timestamp: number;
  hash: string;
}

function simpleHash(text: string): string {
  let hash = 0;
  const prefix = text.slice(0, 20);
  for (let i = 0; i < prefix.length; i++) {
    const char = prefix.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

function hammingDistance(hash1: string, hash2: string): number {
  let distance = 0;
  const maxLen = Math.max(hash1.length, hash2.length);
  for (let i = 0; i < maxLen; i++) {
    if ((hash1[i] || '') !== (hash2[i] || '')) distance++;
  }
  return distance;
}

function isSimiliar(text1: string, text2: string): boolean {
  const len1 = text1.length;
  const len2 = text2.length;
  const minLen = Math.min(len1, len2);
  if (minLen < 3) return false;
  const similarity = minLen / Math.max(len1, len2);
  return similarity > 0.8;
}

async function getLoopKey(avatarId: string, channelId: string): Promise<string> {
  return `LOOP#${avatarId}#${channelId}`;
}

async function recordMessage(avatarId: string, channelId: string, text: string): Promise<void> {
  try {
    const loopKey = await getLoopKey(avatarId, channelId);
    const hash = simpleHash(text);
    const timestamp = Date.now();
    const ttl = Math.floor((timestamp + WINDOW_15_MIN_MS) / 1000);

    await dynamo.send(new UpdateCommand({
      TableName: STATE_TABLE,
      Key: {
        pk: `AVATAR#${avatarId}`,
        sk: loopKey,
      },
      UpdateExpression: 'SET #messages = if_not_exists(#messages, :emptyList) + :newMsg, #ttl = :ttl',
      ExpressionAttributeNames: {
        '#messages': 'messages',
        '#ttl': 'ttl',
      },
      ExpressionAttributeValues: {
        ':newMsg': [{ timestamp, hash }],
        ':ttl': ttl,
      },
    }));
  } catch (error) {
    logger.warn('Failed to record anomaly detector message', {
      error: error instanceof Error ? error.message : String(error),
      avatarId,
      channelId,
    });
  }
}

async function getMessages(avatarId: string, channelId: string): Promise<MessageRecord[]> {
  try {
    const loopKey = await getLoopKey(avatarId, channelId);
    const result = await dynamo.send(new GetCommand({
      TableName: STATE_TABLE,
      Key: {
        pk: `AVATAR#${avatarId}`,
        sk: loopKey,
      },
    }));

    const messages = (result.Item?.messages as MessageRecord[]) || [];
    return messages;
  } catch (error) {
    logger.warn('Failed to fetch anomaly detector messages', {
      error: error instanceof Error ? error.message : String(error),
      avatarId,
      channelId,
    });
    return [];
  }
}

function trimToWindow(messages: MessageRecord[], windowMs: number): MessageRecord[] {
  const now = Date.now();
  const cutoff = now - windowMs;
  return messages.filter(m => m.timestamp > cutoff);
}

async function checkAndRecord(
  avatarId: string,
  channelId: string,
  text: string
): Promise<AnomalyCheckResult> {
  try {
    const messages = await getMessages(avatarId, channelId);
    const now = Date.now();

    const messages15 = trimToWindow(messages, WINDOW_15_MIN_MS);
    const messages10 = trimToWindow(messages, WINDOW_10_MIN_MS);

    const currentHash = simpleHash(text);

    const duplicateCount = messages10.filter(m => {
      const hamming = hammingDistance(m.hash, currentHash);
      return hamming < 2;
    }).length;

    await recordMessage(avatarId, channelId, text);

    const result: AnomalyCheckResult = {
      paused: false,
      metrics: {
        messageCount: messages15.length + 1,
        duplicateCount: duplicateCount + 1,
      },
    };

    if (duplicateCount + 1 >= DUPLICATE_PAUSE_THRESHOLD) {
      result.paused = true;
      result.reason = `Too many near-duplicate messages (${duplicateCount + 1} in 10 min)`;
      result.metrics.thresholdExceeded = 'duplicate_messages';
      logger.info('Anomaly detector: duplicate threshold exceeded', {
        event: 'anomaly_paused',
        subsystem: 'anomaly_detector',
        avatarId,
        channelId,
        duplicateCount: duplicateCount + 1,
        reason: result.reason,
      });
      return result;
    }

    if (messages15.length + 1 >= PAUSE_THRESHOLD) {
      result.paused = true;
      result.reason = `Too many messages (${messages15.length + 1} in 15 min)`;
      result.metrics.thresholdExceeded = 'message_rate';
      logger.info('Anomaly detector: pause threshold exceeded', {
        event: 'anomaly_paused',
        subsystem: 'anomaly_detector',
        avatarId,
        channelId,
        messageCount: messages15.length + 1,
        reason: result.reason,
      });
      return result;
    }

    if (messages15.length + 1 >= WARNING_THRESHOLD && messages15.length < WARNING_THRESHOLD) {
      logger.info('Anomaly detector: warning threshold reached', {
        event: 'anomaly_warning',
        subsystem: 'anomaly_detector',
        avatarId,
        channelId,
        messageCount: messages15.length + 1,
      });
    }

    return result;
  } catch (error) {
    logger.warn('Anomaly detector check failed (failing open)', {
      error: error instanceof Error ? error.message : String(error),
      avatarId,
      channelId,
    });
    return {
      paused: false,
      metrics: {
        messageCount: 0,
        duplicateCount: 0,
      },
    };
  }
}

export async function shouldPauseAvatar(
  avatarId: string,
  channelId: string,
  text: string
): Promise<AnomalyCheckResult> {
  return checkAndRecord(avatarId, channelId, text);
}

export async function resetAnomalyState(avatarId: string, channelId: string): Promise<void> {
  try {
    const loopKey = await getLoopKey(avatarId, channelId);
    await dynamo.send(new DeleteCommand({
      TableName: STATE_TABLE,
      Key: {
        pk: `AVATAR#${avatarId}`,
        sk: loopKey,
      },
    }));
    logger.info('Reset anomaly state', {
      event: 'anomaly_reset',
      subsystem: 'anomaly_detector',
      avatarId,
      channelId,
    });
  } catch (error) {
    logger.warn('Failed to reset anomaly state', {
      error: error instanceof Error ? error.message : String(error),
      avatarId,
      channelId,
    });
  }
}
