/**
 * Home Channel Registry Service
 *
 * Manages the registry of "home channels" for Telegram avatars.
 * Avatars can only respond in their own home channel OR in home channels of other ratibots.
 * This prevents bots from responding in random/spam channels.
 *
 * Database schema:
 *   pk: "HOME_CHANNELS"
 *   sk: "{chatId}" (e.g., "-1001234567890")
 */
import {
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import type { HomeChannelRecord } from '../types.js';
import { getDynamoClient, _setDynamoClient as _setSharedDynamoClient } from './dynamo-client.js';

let dynamoClient: DynamoDBDocumentClient = getDynamoClient();
const ADMIN_TABLE = process.env.ADMIN_TABLE!;

/** @internal Test-only: inject a mock DynamoDB client. Pass null to restore the default. */
export function _setDynamoClient(client: DynamoDBDocumentClient | null): void {
  if (client) {
    dynamoClient = client;
  } else {
    dynamoClient = getDynamoClient();
  }
}

// In-memory cache for home channels (60 second TTL)
const HOME_CHANNEL_CACHE_TTL_MS = 60_000;
let homeChannelCache: {
  channels: Map<string, HomeChannelRecord>;
  expiresAt: number;
} | null = null;

/**
 * Register a home channel for an avatar.
 * Upserts the record if it already exists.
 */
export async function registerHomeChannel(
  avatarId: string,
  chatId: string,
  botUsername: string,
  channelUsername?: string,
  channelTitle?: string
): Promise<HomeChannelRecord> {
  const now = Date.now();

  // Check if record already exists
  const existing = await getHomeChannelByChatId(chatId);

  const existingRegistered = existing?.registeredAvatars ?? [];
  const registeredMap = new Map(existingRegistered.map((a) => [a.avatarId, a] as const));
  registeredMap.set(avatarId, { avatarId, botUsername });
  const registeredAvatars = Array.from(registeredMap.values());

  const record: HomeChannelRecord = {
    pk: 'HOME_CHANNELS',
    sk: chatId,
    chatId,
    // Do not overwrite the owner if the chatId was already registered.
    // This prevents metadata flapping when multiple avatars register the same allowedChatIds.
    avatarId: existing?.avatarId ?? avatarId,
    botUsername: existing?.botUsername ?? botUsername,
    // Prefer existing optional metadata if already known.
    channelUsername: existing?.channelUsername ?? channelUsername,
    channelTitle: existing?.channelTitle ?? channelTitle,
    registeredAvatars,
    registeredAt: existing?.registeredAt || now,
    updatedAt: now,
  };

  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: record,
  }));

  // Invalidate cache
  homeChannelCache = null;

  console.log('[HomeChannel] Registered home channel:', {
    avatarId,
    chatId,
    botUsername,
    channelUsername,
  });

  return record;
}

/**
 * Unregister a home channel by chat ID.
 */
export async function unregisterHomeChannel(chatId: string): Promise<void> {
  await dynamoClient.send(new DeleteCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: 'HOME_CHANNELS',
      sk: chatId,
    },
  }));

  // Invalidate cache
  homeChannelCache = null;

  console.log('[HomeChannel] Unregistered home channel:', { chatId });
}

/**
 * Unregister home channel for a specific avatar.
 * Finds and removes the home channel record for the given avatar.
 */
export async function unregisterHomeChannelForAvatar(avatarId: string): Promise<void> {
  const homeChannel = await getHomeChannelForAvatar(avatarId);
  if (homeChannel) {
    await unregisterHomeChannel(homeChannel.chatId);
  }
}

/**
 * Remove an avatar from all home channel records.
 *
 * If the avatar is the owner of a chatId and other avatars are registered,
 * ownership is transferred to the next registered avatar.
 * If no other avatars remain, the record is deleted.
 */
export async function removeAvatarFromAllHomeChannels(avatarId: string): Promise<void> {
  const channels = await getAllHomeChannels();

  const updates = channels
    .filter((c) => c.avatarId === avatarId || (c.registeredAvatars ?? []).some((a) => a.avatarId === avatarId))
    .map(async (record) => {
      const remaining = (record.registeredAvatars ?? [])
        .filter((a) => a.avatarId !== avatarId);

      // If record had no registeredAvatars, treat owner as the only registrant.
      const normalizedRemaining = remaining.length > 0
        ? remaining
        : (record.avatarId === avatarId ? [] : [{ avatarId: record.avatarId, botUsername: record.botUsername }]);

      if (record.avatarId === avatarId) {
        if (normalizedRemaining.length === 0) {
          await unregisterHomeChannel(record.chatId);
          return;
        }

        const newOwner = normalizedRemaining[0];
        const updated: HomeChannelRecord = {
          ...record,
          avatarId: newOwner.avatarId,
          botUsername: newOwner.botUsername,
          registeredAvatars: normalizedRemaining,
          updatedAt: Date.now(),
        };

        await dynamoClient.send(new PutCommand({
          TableName: ADMIN_TABLE,
          Item: updated,
        }));
        homeChannelCache = null;
        return;
      }

      // Not owner: just remove from registeredAvatars and update.
      const updated: HomeChannelRecord = {
        ...record,
        registeredAvatars: normalizedRemaining,
        updatedAt: Date.now(),
      };

      await dynamoClient.send(new PutCommand({
        TableName: ADMIN_TABLE,
        Item: updated,
      }));
      homeChannelCache = null;
    });

  await Promise.allSettled(updates);
}

/**
 * Get a specific home channel record by chat ID.
 */
export async function getHomeChannelByChatId(chatId: string): Promise<HomeChannelRecord | null> {
  try {
    const result = await dynamoClient.send(new GetCommand({
      TableName: ADMIN_TABLE,
      Key: {
        pk: 'HOME_CHANNELS',
        sk: chatId,
      },
    }));

    return (result.Item as HomeChannelRecord) || null;
  } catch (err) {
    console.warn('[HomeChannel] Failed to get home channel:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Get all registered home channels.
 * Uses in-memory caching with 60 second TTL for performance.
 */
export async function getAllHomeChannels(): Promise<HomeChannelRecord[]> {
  const now = Date.now();

  // Check cache
  if (homeChannelCache && homeChannelCache.expiresAt > now) {
    return Array.from(homeChannelCache.channels.values());
  }

  try {
    const result = await dynamoClient.send(new QueryCommand({
      TableName: ADMIN_TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': 'HOME_CHANNELS',
      },
    }));

    const records = (result.Items as HomeChannelRecord[]) || [];

    // Update cache
    const channelMap = new Map<string, HomeChannelRecord>();
    for (const record of records) {
      channelMap.set(record.chatId, record);
    }
    homeChannelCache = {
      channels: channelMap,
      expiresAt: now + HOME_CHANNEL_CACHE_TTL_MS,
    };

    return records;
  } catch (err) {
    console.warn('[HomeChannel] Failed to get all home channels:', err instanceof Error ? err.message : String(err));
    return [];
  }
}

/**
 * Get the home channel for a specific avatar.
 */
export async function getHomeChannelForAvatar(avatarId: string): Promise<HomeChannelRecord | null> {
  const channels = await getAllHomeChannels();
  return channels.find((c) => c.avatarId === avatarId) || null;
}

/**
 * Check if a chat ID is a home channel for any ratibot avatar.
 *
 * @param chatId - The chat ID to check
 * @param avatarHomeChannelId - Optional: the avatar's own home channel ID.
 *                              If provided, also returns true if chatId matches this.
 * @returns true if the chat is a registered home channel
 */
export async function isHomeChannel(
  chatId: string,
  avatarHomeChannelId?: string
): Promise<boolean> {
  // Fast path: check if it's the avatar's own home channel
  if (avatarHomeChannelId && chatId === avatarHomeChannelId) {
    return true;
  }

  // Check against all registered home channels
  const channels = await getAllHomeChannels();
  return channels.some((c) => c.chatId === chatId);
}

/**
 * Get the set of all home channel chat IDs.
 * Useful for efficient batch checking.
 */
export async function getHomeChannelIds(): Promise<Set<string>> {
  const channels = await getAllHomeChannels();
  return new Set(channels.map((c) => c.chatId));
}

/**
 * Invalidate the home channel cache.
 * Call this when you know the data has changed externally.
 */
export function invalidateHomeChannelCache(): void {
  homeChannelCache = null;
}
