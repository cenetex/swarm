/**
 * Shared Channel Service
 *
 * Manages the registry of avatars present in each Telegram channel.
 * Enables multi-avatar coordination by tracking which avatars are active
 * in a given chat.
 *
 * CONTROL-PLANE ONLY — this module is part of admin-api and provides the
 * avatar-in-channel registry for multi-avatar awareness. It is NOT used
 * for live turn-selection decisions. The authoritative runtime coordination
 * lives in packages/core/src/services/state/channel-state.ts.
 *
 * Retained for:
 *   - Avatar presence tracking (which avatars are in which channels)
 *   - Admin diagnostics (listing avatars per channel)
 *   - Future multi-avatar coordination (when migrated to core/handlers)
 *
 * @see docs/COORDINATION-OWNERSHIP.md for the full ownership model.
 */
import {
  PutCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { SharedChannelRecord } from '../types.js';
import { generateAvatarStats } from './avatar-stats.js';
import { getDynamoClient } from './dynamo-client.js';

const dynamoClient = getDynamoClient();

const ADMIN_TABLE = process.env.ADMIN_TABLE!;

// TTL: 7 days of inactivity before cleanup
const CHANNEL_AVATAR_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Register an avatar in a channel.
 * Called when an avatar first receives a message in a channel.
 *
 * @param chatId - Telegram chat ID
 * @param avatarId - Avatar ID
 * @param botUsername - Bot's Telegram username (for mention detection)
 * @param createdAt - Avatar's creation timestamp (for stat generation)
 */
export async function registerAvatarInChannel(
  chatId: number,
  avatarId: string,
  botUsername: string,
  createdAt: number
): Promise<SharedChannelRecord> {
  const now = Date.now();
  const stats = generateAvatarStats(createdAt, avatarId);

  const record: SharedChannelRecord = {
    pk: `SHARED_CHANNEL#${chatId}`,
    sk: `AVATAR#${avatarId}`,
    chatId,
    avatarId,
    botUsername,
    joinedAt: now,
    lastSeenAt: now,
    stats,
    ttl: Math.floor(now / 1000) + CHANNEL_AVATAR_TTL_SECONDS,
  };

  await dynamoClient.send(
    new PutCommand({
      TableName: ADMIN_TABLE,
      Item: record,
    })
  );

  return record;
}

/**
 * Get all avatars registered in a channel.
 *
 * @param chatId - Telegram chat ID
 * @returns Array of avatar records in this channel
 */
export async function getChannelAvatars(
  chatId: number
): Promise<SharedChannelRecord[]> {
  const result = await dynamoClient.send(
    new QueryCommand({
      TableName: ADMIN_TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': `SHARED_CHANNEL#${chatId}`,
      },
    })
  );

  return (result.Items || []) as SharedChannelRecord[];
}

/**
 * Get a specific avatar's record in a channel.
 *
 * @param chatId - Telegram chat ID
 * @param avatarId - Avatar ID
 * @returns Avatar's channel record or null if not found
 */
export async function getAvatarInChannel(
  chatId: number,
  avatarId: string
): Promise<SharedChannelRecord | null> {
  const result = await dynamoClient.send(
    new QueryCommand({
      TableName: ADMIN_TABLE,
      KeyConditionExpression: 'pk = :pk AND sk = :sk',
      ExpressionAttributeValues: {
        ':pk': `SHARED_CHANNEL#${chatId}`,
        ':sk': `AVATAR#${avatarId}`,
      },
    })
  );

  return (result.Items?.[0] as SharedChannelRecord) || null;
}

/**
 * Update an avatar's presence in a channel.
 * Called on each message to refresh TTL and lastSeenAt.
 *
 * @param chatId - Telegram chat ID
 * @param avatarId - Avatar ID
 */
export async function updateAvatarPresence(
  chatId: number,
  avatarId: string
): Promise<void> {
  const now = Date.now();

  await dynamoClient.send(
    new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: {
        pk: `SHARED_CHANNEL#${chatId}`,
        sk: `AVATAR#${avatarId}`,
      },
      UpdateExpression: 'SET lastSeenAt = :now, #ttl = :ttl',
      ExpressionAttributeNames: {
        '#ttl': 'ttl',
      },
      ExpressionAttributeValues: {
        ':now': now,
        ':ttl': Math.floor(now / 1000) + CHANNEL_AVATAR_TTL_SECONDS,
      },
    })
  );
}

/**
 * Ensure an avatar is registered in a channel, creating if needed.
 *
 * @param chatId - Telegram chat ID
 * @param avatarId - Avatar ID
 * @param botUsername - Bot's Telegram username
 * @param createdAt - Avatar's creation timestamp
 * @returns The avatar's channel record (existing or newly created)
 */
export async function ensureAvatarInChannel(
  chatId: number,
  avatarId: string,
  botUsername: string,
  createdAt: number
): Promise<SharedChannelRecord> {
  const existing = await getAvatarInChannel(chatId, avatarId);

  if (existing) {
    // Update presence and return existing
    await updateAvatarPresence(chatId, avatarId);
    return {
      ...existing,
      lastSeenAt: Date.now(),
    };
  }

  // Register new avatar in channel
  return registerAvatarInChannel(chatId, avatarId, botUsername, createdAt);
}

/**
 * Remove an avatar from a channel.
 * Called when an avatar is deleted or disabled.
 *
 * @param chatId - Telegram chat ID
 * @param avatarId - Avatar ID
 */
export async function removeAvatarFromChannel(
  chatId: number,
  avatarId: string
): Promise<void> {
  await dynamoClient.send(
    new DeleteCommand({
      TableName: ADMIN_TABLE,
      Key: {
        pk: `SHARED_CHANNEL#${chatId}`,
        sk: `AVATAR#${avatarId}`,
      },
    })
  );
}

/**
 * Check if a channel has multiple avatars.
 * Quick check for multi-avatar mode.
 *
 * @param chatId - Telegram chat ID
 * @returns True if channel has more than one avatar
 */
export async function isMultiAvatarChannel(chatId: number): Promise<boolean> {
  const avatars = await getChannelAvatars(chatId);
  return avatars.length > 1;
}

/**
 * Find which avatar (if any) is mentioned in a message.
 *
 * @param text - Message text
 * @param avatars - Avatars in the channel
 * @returns The mentioned avatar's record, or null if no mention
 */
export function findMentionedAvatar(
  text: string | undefined,
  avatars: SharedChannelRecord[]
): SharedChannelRecord | null {
  if (!text) return null;

  for (const avatar of avatars) {
    if (text.includes(`@${avatar.botUsername}`)) {
      return avatar;
    }
  }

  return null;
}
