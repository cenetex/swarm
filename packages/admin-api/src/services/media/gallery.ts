/**
 * Gallery Service
 * Tracks all generated media for reuse and management
 */
import {
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { GalleryItem } from '../../types.js';
import { getDynamoClient } from '../dynamo-client.js';

const dynamoClient = getDynamoClient();
const ADMIN_TABLE = process.env.ADMIN_TABLE!;

/**
 * Generate a gallery-compatible ID in the canonical format: `timestamp_randomId`.
 *
 * This is the authoritative ID format used across all generation paths (sync,
 * async, webhook). Downstream consumers such as the Twitter adapter validate
 * against this pattern so every generator MUST use this function instead of
 * raw UUIDs.
 *
 * Backward-compatible UUIDs from older gallery items are accepted by consumers
 * via a separate compatibility check.
 */
export function generateGalleryId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 10);
  return `${timestamp}_${random}`;
}

/**
 * Add a new item to the gallery
 */
export async function addToGallery(
  avatarId: string,
  item: Omit<GalleryItem, 'pk' | 'sk' | 'avatarId' | 'createdAt' | 'postedToTwitter' | 'convertedToSticker'>
): Promise<GalleryItem> {
  const now = Date.now();
  const galleryItem: GalleryItem = {
    pk: `AVATAR#${avatarId}`,
    sk: `GALLERY#${now}#${item.id}`,
    avatarId,
    ...item,
    postedToTwitter: false,
    convertedToSticker: false,
    createdAt: now,
  };

  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: galleryItem,
  }));

  return galleryItem;
}

/**
 * Get gallery items for an avatar
 */
export async function getGallery(
  avatarId: string,
  options: {
    limit?: number;
    type?: 'image' | 'video' | 'sticker';
    notPostedToTwitter?: boolean;
    notConvertedToSticker?: boolean;
  } = {}
): Promise<GalleryItem[]> {
  const { limit = 50, type, notPostedToTwitter, notConvertedToSticker } = options;

  const result = await dynamoClient.send(new QueryCommand({
    TableName: ADMIN_TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
    ExpressionAttributeValues: {
      ':pk': `AVATAR#${avatarId}`,
      ':sk': 'GALLERY#',
    },
    ScanIndexForward: false, // Most recent first
    Limit: limit * 2, // Fetch extra for filtering
  }));

  let items = (result.Items || []) as GalleryItem[];

  // Apply filters
  if (type) {
    items = items.filter(item => item.type === type);
  }
  if (notPostedToTwitter) {
    items = items.filter(item => !item.postedToTwitter);
  }
  if (notConvertedToSticker) {
    items = items.filter(item => !item.convertedToSticker);
  }

  return items.slice(0, limit);
}

/**
 * Back-compat helper: if an avatar predates `profileImage` being stored on the
 * avatar config record, we can infer a displayable profile image from the
 * gallery by taking the most recent image generated for the `profile` platform.
 */
export async function getLatestProfileImageFromGallery(avatarId: string): Promise<{
  url: string;
  s3Key: string;
  createdAt: number;
} | null> {
  const items = await getGallery(avatarId, { limit: 50, type: 'image' });
  const match = items.find(item => item.type === 'image' && item.platform === 'profile');
  if (!match?.url) return null;
  return { url: match.url, s3Key: match.s3Key, createdAt: match.createdAt };
}

/**
 * Get a specific gallery item
 */
export async function getGalleryItem(
  avatarId: string,
  itemId: string
): Promise<GalleryItem | null> {
  // Need to query since we don't know the timestamp part of SK
  // Note: DynamoDB applies Limit BEFORE FilterExpression, so we must scan
  // enough items to find the one we're looking for. We paginate if needed.
  let lastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const result = await dynamoClient.send(new QueryCommand({
      TableName: ADMIN_TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
      FilterExpression: 'id = :id',
      ExpressionAttributeValues: {
        ':pk': `AVATAR#${avatarId}`,
        ':sk': 'GALLERY#',
        ':id': itemId,
      },
      ExclusiveStartKey: lastEvaluatedKey,
      // Scan in batches; filter is applied after reading these items
      Limit: 100,
    }));

    if (result.Items && result.Items.length > 0) {
      return result.Items[0] as GalleryItem;
    }

    lastEvaluatedKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastEvaluatedKey);

  return null;
}

/**
 * Mark item as posted to Twitter
 */
export async function markPostedToTwitter(
  avatarId: string,
  _itemId: string,
  sk: string
): Promise<void> {
  await dynamoClient.send(new UpdateCommand({
    TableName: ADMIN_TABLE,
    Key: { pk: `AVATAR#${avatarId}`, sk },
    UpdateExpression: 'SET postedToTwitter = :val',
    ExpressionAttributeValues: { ':val': true },
  }));
}

/**
 * Mark item as converted to sticker with metadata
 */
export async function markConvertedToSticker(
  avatarId: string,
  _itemId: string,
  sk: string,
  stickerInfo?: {
    emoji: string;
    setName: string;
    fileId?: string;
    stickerUrl?: string;
  }
): Promise<void> {
  if (stickerInfo) {
    await dynamoClient.send(new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: { pk: `AVATAR#${avatarId}`, sk },
      UpdateExpression: 'SET convertedToSticker = :val, stickerInfo = :info',
      ExpressionAttributeValues: {
        ':val': true,
        ':info': {
          ...stickerInfo,
          convertedAt: Date.now(),
        },
      },
    }));
  } else {
    await dynamoClient.send(new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: { pk: `AVATAR#${avatarId}`, sk },
      UpdateExpression: 'SET convertedToSticker = :val',
      ExpressionAttributeValues: { ':val': true },
    }));
  }
}

/**
 * Find gallery items by description using simple matching
 * In production, could use vector embeddings for better search
 */
export async function findByDescription(
  avatarId: string,
  description: string,
  type?: 'image' | 'video' | 'sticker'
): Promise<GalleryItem[]> {
  const items = await getGallery(avatarId, { limit: 100, type });

  const searchTerms = description.toLowerCase().split(/\s+/);

  // Score items by how many search terms match
  const scored = items.map(item => {
    const text = `${item.prompt} ${item.caption || ''}`.toLowerCase();
    const score = searchTerms.reduce((acc, term) => {
      return acc + (text.includes(term) ? 1 : 0);
    }, 0);
    return { item, score };
  });

  // Return items with at least one match, sorted by score
  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(s => s.item);
}

/**
 * Get gallery statistics
 */
export async function getGalleryStats(avatarId: string): Promise<{
  totalImages: number;
  totalVideos: number;
  totalStickers: number;
  postedToTwitter: number;
}> {
  const items = await getGallery(avatarId, { limit: 1000 });

  return {
    totalImages: items.filter(i => i.type === 'image').length,
    totalVideos: items.filter(i => i.type === 'video').length,
    totalStickers: items.filter(i => i.type === 'sticker').length,
    postedToTwitter: items.filter(i => i.postedToTwitter).length,
  };
}
