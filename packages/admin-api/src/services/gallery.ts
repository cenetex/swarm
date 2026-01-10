/**
 * Gallery Service
 * Tracks all generated media for reuse and management
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { GalleryItem } from '../types.js';

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const ADMIN_TABLE = process.env.ADMIN_TABLE!;

/**
 * Add a new item to the gallery
 */
export async function addToGallery(
  agentId: string,
  item: Omit<GalleryItem, 'pk' | 'sk' | 'agentId' | 'createdAt' | 'postedToTwitter' | 'convertedToSticker'>
): Promise<GalleryItem> {
  const now = Date.now();
  const galleryItem: GalleryItem = {
    pk: `AGENT#${agentId}`,
    sk: `GALLERY#${now}#${item.id}`,
    agentId,
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
 * Get gallery items for an agent
 */
export async function getGallery(
  agentId: string,
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
      ':pk': `AGENT#${agentId}`,
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
 * Get a specific gallery item
 */
export async function getGalleryItem(
  agentId: string,
  itemId: string
): Promise<GalleryItem | null> {
  // Need to query since we don't know the timestamp part of SK
  const result = await dynamoClient.send(new QueryCommand({
    TableName: ADMIN_TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
    FilterExpression: 'id = :id',
    ExpressionAttributeValues: {
      ':pk': `AGENT#${agentId}`,
      ':sk': 'GALLERY#',
      ':id': itemId,
    },
    Limit: 1,
  }));

  return (result.Items?.[0] as GalleryItem) || null;
}

/**
 * Mark item as posted to Twitter
 */
export async function markPostedToTwitter(
  agentId: string,
  _itemId: string,
  sk: string
): Promise<void> {
  await dynamoClient.send(new UpdateCommand({
    TableName: ADMIN_TABLE,
    Key: { pk: `AGENT#${agentId}`, sk },
    UpdateExpression: 'SET postedToTwitter = :val',
    ExpressionAttributeValues: { ':val': true },
  }));
}

/**
 * Mark item as converted to sticker
 */
export async function markConvertedToSticker(
  agentId: string,
  _itemId: string,
  sk: string
): Promise<void> {
  await dynamoClient.send(new UpdateCommand({
    TableName: ADMIN_TABLE,
    Key: { pk: `AGENT#${agentId}`, sk },
    UpdateExpression: 'SET convertedToSticker = :val',
    ExpressionAttributeValues: { ':val': true },
  }));
}

/**
 * Find gallery items by description using simple matching
 * In production, could use vector embeddings for better search
 */
export async function findByDescription(
  agentId: string,
  description: string,
  type?: 'image' | 'video' | 'sticker'
): Promise<GalleryItem[]> {
  const items = await getGallery(agentId, { limit: 100, type });

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
export async function getGalleryStats(agentId: string): Promise<{
  totalImages: number;
  totalVideos: number;
  totalStickers: number;
  postedToTwitter: number;
}> {
  const items = await getGallery(agentId, { limit: 1000 });

  return {
    totalImages: items.filter(i => i.type === 'image').length,
    totalVideos: items.filter(i => i.type === 'video').length,
    totalStickers: items.filter(i => i.type === 'sticker').length,
    postedToTwitter: items.filter(i => i.postedToTwitter).length,
  };
}
