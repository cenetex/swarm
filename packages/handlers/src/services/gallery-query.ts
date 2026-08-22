/**
 * Gallery Query Service (handlers-side)
 *
 * Lightweight read-only gallery query for the handlers package.
 * Queries ADMIN_TABLE for unposted gallery images and marks them as posted.
 * Gracefully degrades when ADMIN_TABLE is not configured.
 */
import { QueryCommand, UpdateCommand } from '@swarm/core';
import { getDynamoClient } from './dynamo-client.js';
import { logger } from '@swarm/core';

export interface GalleryImage {
  id: string;
  url: string;
  s3Key: string;
  prompt: string;
  caption?: string;
  model: string;
  platform?: string;
  createdAt: number;
  /** The DynamoDB sort key, needed for markPostedToTwitter */
  sk: string;
}

/**
 * Query unposted gallery images for an avatar.
 * Returns images sorted most-recent-first that have not yet been posted to Twitter.
 *
 * Returns empty array if ADMIN_TABLE is not configured.
 */
export async function getUnpostedGalleryImages(
  avatarId: string,
  options: { limit?: number; adminTable?: string } = {}
): Promise<GalleryImage[]> {
  const tableName = options.adminTable || process.env.ADMIN_TABLE;
  if (!tableName) {
    logger.debug('Gallery query skipped: ADMIN_TABLE not configured', { avatarId });
    return [];
  }

  const limit = options.limit || 10;
  const matched: GalleryImage[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  const MAX_ROWS_SCANNED = 500;
  let rowsScanned = 0;

  try {
    do {
      const result = await getDynamoClient().send(new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
        ExpressionAttributeValues: {
          ':pk': `AVATAR#${avatarId}`,
          ':sk': 'GALLERY#',
        },
        ScanIndexForward: false, // Most recent first
        Limit: 100,
        ExclusiveStartKey: lastEvaluatedKey,
      }));

      const items = (result.Items || []) as Record<string, unknown>[];
      rowsScanned += items.length;

      for (const item of items) {
        // Filter: only images not yet posted to Twitter
        if (item.type !== 'image') continue;
        if (item.postedToTwitter === true) continue;
        if (!item.url || !item.s3Key) continue;

        matched.push({
          id: item.id as string,
          url: item.url as string,
          s3Key: item.s3Key as string,
          prompt: (item.prompt as string) || '',
          caption: item.caption as string | undefined,
          model: (item.model as string) || 'unknown',
          platform: item.platform as string | undefined,
          createdAt: (item.createdAt as number) || 0,
          sk: item.sk as string,
        });

        if (matched.length >= limit) break;
      }

      lastEvaluatedKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (
      matched.length < limit &&
      lastEvaluatedKey &&
      rowsScanned < MAX_ROWS_SCANNED
    );

    logger.debug('Gallery query completed', {
      avatarId,
      found: matched.length,
      rowsScanned,
    });

    return matched;
  } catch (error) {
    logger.warn('Gallery query failed, continuing without gallery images', {
      avatarId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Mark a gallery image as posted to Twitter.
 * No-op if ADMIN_TABLE is not configured.
 */
export async function markGalleryImagePosted(
  avatarId: string,
  sk: string,
  options: { adminTable?: string } = {}
): Promise<void> {
  const tableName = options.adminTable || process.env.ADMIN_TABLE;
  if (!tableName) return;

  try {
    await getDynamoClient().send(new UpdateCommand({
      TableName: tableName,
      Key: { pk: `AVATAR#${avatarId}`, sk },
      UpdateExpression: 'SET postedToTwitter = :val',
      ExpressionAttributeValues: { ':val': true },
    }));

    logger.info('Gallery image marked as posted to Twitter', {
      event: 'gallery_image_marked_posted',
      avatarId,
      sk,
    });
  } catch (error) {
    logger.warn('Failed to mark gallery image as posted', {
      avatarId,
      sk,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Get recent gallery image metadata (prompts/captions) for creative context.
 * Returns up to `limit` recent image descriptions regardless of posted status.
 */
export async function getRecentGalleryMetadata(
  avatarId: string,
  options: { limit?: number; adminTable?: string } = {}
): Promise<Array<{ prompt: string; caption?: string; createdAt: number }>> {
  const tableName = options.adminTable || process.env.ADMIN_TABLE;
  if (!tableName) return [];

  const limit = options.limit || 5;

  try {
    const result = await getDynamoClient().send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
      ExpressionAttributeValues: {
        ':pk': `AVATAR#${avatarId}`,
        ':sk': 'GALLERY#',
      },
      ScanIndexForward: false,
      Limit: limit,
    }));

    return ((result.Items || []) as Record<string, unknown>[])
      .filter(item => item.type === 'image' && item.prompt)
      .map(item => ({
        prompt: item.prompt as string,
        caption: item.caption as string | undefined,
        createdAt: (item.createdAt as number) || 0,
      }));
  } catch (error) {
    logger.warn('Gallery metadata query failed', {
      avatarId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
