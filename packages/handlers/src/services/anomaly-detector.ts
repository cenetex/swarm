/**
 * Anomaly Detector - Loop Detection Safety Primitive
 * Detects response loops by tracking message rate and content similarity
 */
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { logger } from '@swarm/core';
import { getDynamoClient } from './dynamo-client.js';

const STATE_TABLE = process.env.STATE_TABLE!;

interface LoopRecord {
  timestamp: number;
  contentHash: string;
}

interface AnomalyCheckResult {
  paused: boolean;
  reason?: string;
  metrics?: {
    messageCount: number;
    duplicateCount: number;
  };
}

function hashContentPrefix(text: string, prefixLength: number = 20): string {
  const prefix = text.slice(0, prefixLength).toLowerCase();
  let hash = 0;
  for (let i = 0; i < prefix.length; i++) {
    const char = prefix.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

function getLoopKey(avatarId: string, channelId: string): string {
  return `LOOP#${avatarId}#${channelId}`;
}

async function getLoopRecords(
  avatarId: string,
  channelId: string,
  windowMs: number
): Promise<LoopRecord[]> {
  const now = Date.now();
  const cutoff = now - windowMs;

  try {
    const result = await getDynamoClient().send(
      new GetCommand({
        TableName: STATE_TABLE,
        Key: {
          pk: 'ANOMALY',
          sk: getLoopKey(avatarId, channelId),
        },
      })
    );

    if (!result.Item) return [];

    const messages = (result.Item.messages as LoopRecord[]) || [];
    return messages.filter(msg => msg.timestamp > cutoff);
  } catch (error) {
    logger.warn('Failed to get loop records', {
      error: error instanceof Error ? error.message : String(error),
      avatarId,
      channelId,
    });
    return [];
  }
}

async function recordMessage(
  avatarId: string,
  channelId: string,
  contentHash: string
): Promise<void> {
  const key = getLoopKey(avatarId, channelId);
  const now = Date.now();
  const ttl = Math.floor((now + 15 * 60 * 1000) / 1000);

  try {
    await getDynamoClient().send(
      new UpdateCommand({
        TableName: STATE_TABLE,
        Key: {
          pk: 'ANOMALY',
          sk: key,
        },
        UpdateExpression: 'SET messages = list_append(if_not_exists(messages, :empty), :msg), #ttl = :ttl',
        ExpressionAttributeNames: {
          '#ttl': 'ttl',
        },
        ExpressionAttributeValues: {
          ':msg': [{ timestamp: now, contentHash }],
          ':empty': [],
          ':ttl': ttl,
        },
      })
    );
  } catch (error) {
    logger.warn('Failed to record message in loop tracker', {
      error: error instanceof Error ? error.message : String(error),
      avatarId,
      channelId,
    });
  }
}

async function clearLoopRecords(avatarId: string, channelId: string): Promise<void> {
  const key = getLoopKey(avatarId, channelId);

  try {
    await getDynamoClient().send(
      new UpdateCommand({
        TableName: STATE_TABLE,
        Key: {
          pk: 'ANOMALY',
          sk: key,
        },
        UpdateExpression: 'SET messages = :empty',
        ExpressionAttributeValues: {
          ':empty': [],
        },
      })
    );
  } catch (error) {
    logger.warn('Failed to clear loop records', {
      error: error instanceof Error ? error.message : String(error),
      avatarId,
      channelId,
    });
  }
}

/**
 * Check if avatar should be paused due to anomalies.
 * Returns paused status with optional reason and metrics.
 * Thresholds:
 * - 8 messages in 15 min → warning only
 * - 12 messages in 15 min → auto-pause
 * - 5 near-duplicate messages in 10 min → auto-pause
 */
export async function shouldPauseAvatar(
  avatarId: string,
  channelId: string
): Promise<AnomalyCheckResult> {
  const window15Min = 15 * 60 * 1000;
  const window10Min = 10 * 60 * 1000;

  try {
    const records15 = await getLoopRecords(avatarId, channelId, window15Min);

    if (records15.length >= 12) {
      return {
        paused: true,
        reason: 'excessive_message_rate',
        metrics: {
          messageCount: records15.length,
          duplicateCount: 0,
        },
      };
    }

    if (records15.length >= 8) {
      logger.warn('Anomaly alert: excessive message rate (warning)', {
        event: 'anomaly_warning',
        avatarId,
        channelId,
        messageCount: records15.length,
      });
    }

    const records10 = await getLoopRecords(avatarId, channelId, window10Min);
    const hashCounts = new Map<string, number>();

    for (const record of records10) {
      const count = hashCounts.get(record.contentHash) || 0;
      hashCounts.set(record.contentHash, count + 1);
    }

    const duplicateCounts = Array.from(hashCounts.values());
    const maxDuplicates = Math.max(...duplicateCounts, 0);

    if (maxDuplicates >= 5) {
      return {
        paused: true,
        reason: 'excessive_content_duplication',
        metrics: {
          messageCount: records15.length,
          duplicateCount: maxDuplicates,
        },
      };
    }

    return { paused: false };
  } catch (error) {
    logger.error('Error checking avatar pause status', error, {
      event: 'anomaly_check_failed',
      avatarId,
      channelId,
    });

    return { paused: false };
  }
}

/**
 * Record a response message for loop detection.
 * Returns true if message was recorded, false if detector failed.
 */
export async function recordResponse(
  avatarId: string,
  channelId: string,
  text: string
): Promise<void> {
  const contentHash = hashContentPrefix(text);
  await recordMessage(avatarId, channelId, contentHash);
}

/**
 * Clear loop detection records for manual reset.
 */
export async function resetAnomalyState(
  avatarId: string,
  channelId?: string
): Promise<void> {
  if (channelId) {
    await clearLoopRecords(avatarId, channelId);
  } else {
    // For avatar-wide reset, we'd need to scan all channels
    // For now, this is handled at the admin-api level by calling per-channel
    logger.info('Avatar-wide anomaly reset requested', { avatarId });
  }
}
