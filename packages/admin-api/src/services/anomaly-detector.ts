/**
 * Anomaly Detector Service
 *
 * Admin-side interface for anomaly detection and reset.
 * Delegates to the core anomaly detector in the handlers package.
 */
import { DynamoDBDocumentClient, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { logger } from '@swarm/core';

const STATE_TABLE = process.env.STATE_TABLE!;

export async function resetAnomalyState(avatarId: string, channelId?: string): Promise<void> {
  const client = new DynamoDBClient({ region: 'us-east-1' });
  const docClient = DynamoDBDocumentClient.from(client, {
    marshallOptions: {
      removeUndefinedValues: true,
    },
  });

  try {
    if (channelId) {
      const loopKey = `LOOP#${avatarId}#${channelId}`;
      await docClient.send(new DeleteCommand({
        TableName: STATE_TABLE,
        Key: {
          pk: `AVATAR#${avatarId}`,
          sk: loopKey,
        },
      }));
      logger.info('Reset anomaly state for channel', {
        event: 'anomaly_reset',
        subsystem: 'admin_api',
        avatarId,
        channelId,
      });
    } else {
      logger.info('Reset anomaly state for all channels', {
        event: 'anomaly_reset_all',
        subsystem: 'admin_api',
        avatarId,
      });
    }
  } catch (error) {
    logger.error('Failed to reset anomaly state', error, {
      avatarId,
      channelId,
    });
    throw error;
  }
}
