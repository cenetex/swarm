/**
 * Webhook Home Channel Module
 * Handles home channel registration, cleanup, channel state management,
 * and bootstrap logic for the Telegram webhook handler.
 */
import { QueryCommand, DeleteCommand, PutCommand, UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { logger, type AvatarConfig } from '@swarm/core';
import { getDynamoClient } from '../services/dynamo-client.js';
import { mergeAllowedChats } from './webhook-chat-access.js';

const dynamoClient = getDynamoClient();

const STATE_TABLE = process.env.STATE_TABLE!;
const ADMIN_TABLE = process.env.ADMIN_TABLE;

const HOME_CHANNEL_CACHE_TTL_MS = 60_000;

/**
 * Home channel record shape (minimal projection for the webhook layer).
 */
interface HomeChannelEntry {
  sk: string; // chatId
  registeredAvatars?: Array<{ avatarId: string; botUsername: string }>;
}

// Home channel cache (entries with per-avatar membership info)
let homeChannelCache: { entries: HomeChannelEntry[]; expiresAt: number } | null = null;

/**
 * Clean up channel state when bot is removed from a channel.
 * Deletes the channel state record from both STATE_TABLE and ADMIN_TABLE.
 */
export async function cleanupChannelState(avatarId: string, chatId: string): Promise<void> {
  const deletePromises: Promise<unknown>[] = [];

  // Delete from STATE_TABLE (core channel state)
  if (STATE_TABLE) {
    deletePromises.push(
      dynamoClient.send(new DeleteCommand({
        TableName: STATE_TABLE,
        Key: {
          pk: `AVATAR#${avatarId}`,
          sk: `CHANNEL#${chatId}#STATE`,
        },
      })).catch((err: unknown) => {
        logger.warn('Failed to delete channel state from STATE_TABLE', {
          avatarId,
          chatId,
          error: err instanceof Error ? err.message : String(err),
        });
      })
    );
  }

  // Delete from ADMIN_TABLE (admin-api channel state)
  if (ADMIN_TABLE) {
    deletePromises.push(
      dynamoClient.send(new DeleteCommand({
        TableName: ADMIN_TABLE,
        Key: {
          pk: `CHANNEL#${avatarId}#${chatId}`,
          sk: 'STATE',
        },
      })).catch((err: unknown) => {
        logger.warn('Failed to delete channel state from ADMIN_TABLE', {
          avatarId,
          chatId,
          error: err instanceof Error ? err.message : String(err),
        });
      })
    );
  }

  await Promise.all(deletePromises);
  logger.info('Cleaned up channel state after bot removal', { avatarId, chatId });
}

/**
 * Register a home channel from the webhook handler.
 * This is a lightweight version that writes directly to ADMIN_TABLE.
 */
export async function registerHomeChannelFromWebhook(
  avatarId: string,
  chatId: string,
  botUsername: string,
  channelUsername?: string,
  channelTitle?: string
): Promise<void> {
  if (!ADMIN_TABLE) return;

  const now = Date.now();
  const newMember = { avatarId, botUsername };

  // Check if the home channel record already exists
  const existing = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: { pk: 'HOME_CHANNELS', sk: chatId },
    ProjectionExpression: 'registeredAvatars',
  }));

  if (existing.Item) {
    // Channel exists — add this avatar to registeredAvatars if not already present
    const registeredAvatars = (existing.Item.registeredAvatars as Array<{ avatarId: string; botUsername: string }>) || [];
    const alreadyRegistered = registeredAvatars.some((a) => a.avatarId === avatarId);
    if (!alreadyRegistered) {
      await dynamoClient.send(new UpdateCommand({
        TableName: ADMIN_TABLE,
        Key: { pk: 'HOME_CHANNELS', sk: chatId },
        UpdateExpression: 'SET registeredAvatars = list_append(if_not_exists(registeredAvatars, :empty), :newMember), updatedAt = :now',
        ExpressionAttributeValues: {
          ':newMember': [newMember],
          ':empty': [],
          ':now': now,
        },
      }));
    }
  } else {
    // New channel — create the record
    await dynamoClient.send(new PutCommand({
      TableName: ADMIN_TABLE,
      Item: {
        pk: 'HOME_CHANNELS',
        sk: chatId,
        chatId,
        avatarId,
        botUsername,
        channelUsername,
        channelTitle,
        registeredAvatars: [newMember],
        registeredAt: now,
        updatedAt: now,
      },
    }));
  }

  // Invalidate cache so the new membership is immediately visible
  homeChannelCache = null;
}

/**
 * Update avatar config with home channel info.
 * Uses UpdateCommand to only modify the home channel fields.
 */
export async function updateAvatarHomeChannel(
  avatarId: string,
  chatId: string,
  channelUsername?: string,
  _channelTitle?: string // Unused but kept for potential future use
): Promise<void> {
  if (!STATE_TABLE) return;

  // Build the update expression dynamically for STATE_TABLE (config is nested under `config` attr)
  const stateUpdateParts: string[] = [
    '#config.#platforms.#telegram.#homeChannelId = :chatId',
  ];
  const stateExprNames: Record<string, string> = {
    '#config': 'config',
    '#platforms': 'platforms',
    '#telegram': 'telegram',
    '#homeChannelId': 'homeChannelId',
  };
  const expressionValues: Record<string, unknown> = {
    ':chatId': chatId,
  };

  // ADMIN_TABLE update parts (no `config` nesting)
  const adminUpdateParts: string[] = [
    '#platforms.#telegram.#homeChannelId = :chatId',
  ];
  const adminExprNames: Record<string, string> = {
    '#platforms': 'platforms',
    '#telegram': 'telegram',
    '#homeChannelId': 'homeChannelId',
  };

  if (channelUsername) {
    stateUpdateParts.push('#config.#platforms.#telegram.#homeChannelUsername = :username');
    stateExprNames['#homeChannelUsername'] = 'homeChannelUsername';
    expressionValues[':username'] = channelUsername;

    stateUpdateParts.push('#config.#platforms.#telegram.#homeChannelUrl = :url');
    stateExprNames['#homeChannelUrl'] = 'homeChannelUrl';
    expressionValues[':url'] = `https://t.me/${channelUsername}`;

    adminUpdateParts.push('#platforms.#telegram.#homeChannelUsername = :username');
    adminExprNames['#homeChannelUsername'] = 'homeChannelUsername';

    adminUpdateParts.push('#platforms.#telegram.#homeChannelUrl = :url');
    adminExprNames['#homeChannelUrl'] = 'homeChannelUrl';
  }

  await dynamoClient.send(new UpdateCommand({
    TableName: STATE_TABLE,
    Key: {
      pk: `AVATAR#${avatarId}`,
      sk: 'CONFIG',
    },
    UpdateExpression: `SET ${stateUpdateParts.join(', ')}`,
    ExpressionAttributeNames: stateExprNames,
    ExpressionAttributeValues: expressionValues,
  }));

  // Propagate to ADMIN_TABLE (stores fields at platforms.telegram.* directly)
  if (ADMIN_TABLE) {
    try {
      await dynamoClient.send(new UpdateCommand({
        TableName: ADMIN_TABLE,
        Key: {
          pk: `AVATAR#${avatarId}`,
          sk: 'CONFIG',
        },
        UpdateExpression: `SET ${adminUpdateParts.join(', ')}`,
        ExpressionAttributeNames: adminExprNames,
        ExpressionAttributeValues: expressionValues,
      }));
    } catch (err) {
      logger.warn('Failed to propagate home channel to ADMIN_TABLE', {
        avatarId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Get all home channel entries from the registry.
 * Uses in-memory caching with 60 second TTL.
 */
async function getHomeChannelEntries(): Promise<HomeChannelEntry[]> {
  if (!ADMIN_TABLE) {
    return [];
  }

  const now = Date.now();
  if (homeChannelCache && homeChannelCache.entries && homeChannelCache.expiresAt > now) {
    return homeChannelCache.entries;
  }

  try {
    const result = await dynamoClient.send(new QueryCommand({
      TableName: ADMIN_TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': 'HOME_CHANNELS',
      },
      ProjectionExpression: 'sk, registeredAvatars',
    }));

    const entries: HomeChannelEntry[] = (result.Items || []).map((item) => ({
      sk: item.sk as string,
      registeredAvatars: item.registeredAvatars as HomeChannelEntry['registeredAvatars'],
    }));

    homeChannelCache = { entries, expiresAt: now + HOME_CHANNEL_CACHE_TTL_MS };
    return entries;
  } catch (err) {
    logger.warn('Failed to fetch home channels', { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

/**
 * Get home channel IDs where a specific avatar has explicit membership.
 * Only returns channels where the avatar appears in `registeredAvatars`.
 */
export async function getHomeChannelIdsForAvatar(avatarId: string): Promise<Set<string>> {
  const entries = await getHomeChannelEntries();
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.sk && entry.registeredAvatars?.some((a) => a.avatarId === avatarId)) {
      ids.add(entry.sk);
    }
  }
  return ids;
}

/**
 * Get avatar IDs registered in a specific channel.
 * Returns an empty array if the channel is not found or has no registered avatars.
 */
export async function getChannelAvatarIds(chatId: string): Promise<string[]> {
  const entries = await getHomeChannelEntries();
  const entry = entries.find((e) => e.sk === chatId);
  if (!entry?.registeredAvatars) return [];
  return entry.registeredAvatars.map((a) => a.avatarId);
}

/**
 * Get the {avatarId, botUsername} pairs registered in a specific channel.
 * Used by the shared-room dispatcher to route an @-mention to the correct
 * avatar when several bots receive the same Telegram update.
 */
export async function getChannelRegisteredAvatars(
  chatId: string
): Promise<Array<{ avatarId: string; botUsername: string }>> {
  const entries = await getHomeChannelEntries();
  const entry = entries.find((e) => e.sk === chatId);
  return entry?.registeredAvatars ?? [];
}

/**
 * Find which registered avatar a message text @-mentions, by scanning for
 * `@<botUsername>` (case-insensitive) against the channel's registered bots.
 * Returns the first match, or null if no registered bot is mentioned.
 */
export function resolveMentionedAvatar(
  text: string,
  registered: Array<{ avatarId: string; botUsername: string }>
): { avatarId: string; botUsername: string } | null {
  if (!text || registered.length === 0) return null;
  const lower = text.toLowerCase();
  // Iterate in registration order so the result is stable when several bots
  // are mentioned in the same message.
  for (const r of registered) {
    if (!r.botUsername) continue;
    const needle = `@${r.botUsername.toLowerCase()}`;
    const idx = lower.indexOf(needle);
    if (idx === -1) continue;
    // Require a word boundary after the username (whitespace, punctuation, or EOL)
    // so `@NyxRatiBot` does not match `@NyxRatiBotter`.
    const after = lower[idx + needle.length];
    if (after === undefined || !/[a-z0-9_]/.test(after)) {
      return { avatarId: r.avatarId, botUsername: r.botUsername };
    }
  }
  return null;
}

/**
 * Get all home channel IDs from the registry (global, for backward compatibility).
 * Uses in-memory caching with 60 second TTL.
 * @deprecated Prefer getHomeChannelIdsForAvatar for per-avatar scoping.
 */
export async function getHomeChannelIds(): Promise<Set<string>> {
  const entries = await getHomeChannelEntries();
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.sk) {
      ids.add(entry.sk);
    }
  }
  return ids;
}

/**
 * Add an avatar as an explicit member of a shared home channel.
 * If the channel record does not exist yet, it is created.
 */
export async function addSharedChannelMembership(
  avatarId: string,
  chatId: string,
  botUsername: string,
  channelTitle?: string
): Promise<void> {
  // Delegate to registerHomeChannelFromWebhook which already handles upsert
  await registerHomeChannelFromWebhook(avatarId, chatId, botUsername, undefined, channelTitle);
}

/**
 * Remove an avatar's membership from a shared home channel.
 * Removes the avatar from `registeredAvatars` on the home channel record.
 */
export async function removeSharedChannelMembership(
  avatarId: string,
  chatId: string
): Promise<void> {
  if (!ADMIN_TABLE) return;

  const existing = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: { pk: 'HOME_CHANNELS', sk: chatId },
    ProjectionExpression: 'registeredAvatars',
  }));

  if (!existing.Item) return;

  const registeredAvatars = (existing.Item.registeredAvatars as Array<{ avatarId: string; botUsername: string }>) || [];
  const filtered = registeredAvatars.filter((a) => a.avatarId !== avatarId);

  await dynamoClient.send(new UpdateCommand({
    TableName: ADMIN_TABLE,
    Key: { pk: 'HOME_CHANNELS', sk: chatId },
    UpdateExpression: 'SET registeredAvatars = :filtered, updatedAt = :now',
    ExpressionAttributeValues: {
      ':filtered': filtered,
      ':now': Date.now(),
    },
  }));

  // Invalidate cache
  homeChannelCache = null;
}

/**
 * Interface for home channel checking (dependency injection).
 * Re-exported from webhook-chat-access for convenience.
 */
export type { HomeChannelChecker } from './webhook-chat-access.js';

/**
 * Create a home channel checker for a specific avatar.
 * Only allows channels where the avatar has explicit membership
 * (appears in registeredAvatars) or is the avatar's own homeChannelId.
 *
 * @param avatarId - The avatar to scope the check to
 */
export function createHomeChannelChecker(avatarId: string): import('./webhook-chat-access.js').HomeChannelChecker {
  return {
    async isHomeChannel(chatId: string, avatarHomeChannelId?: string): Promise<boolean> {
      // Fast path: check if it's the avatar's own home channel
      if (avatarHomeChannelId && chatId === avatarHomeChannelId) {
        return true;
      }

      // Check against home channels where this avatar has explicit membership
      const avatarHomeChannelIds = await getHomeChannelIdsForAvatar(avatarId);
      return avatarHomeChannelIds.has(chatId);
    },
  };
}

/**
 * Activate an avatar in a chat by adding the chat to the allowlist.
 * Needs getAvatarConfig and avatarConfigCache from the caller.
 */
export async function activateAvatarInChatFromWebhook(
  avatarId: string,
  chat: { chatId: string; username?: string; title?: string },
  deps: {
    getAvatarConfig: (avatarId: string) => Promise<AvatarConfig | null>;
    invalidateAvatarConfigCache: (avatarId: string) => void;
  }
): Promise<void> {
  if (!STATE_TABLE) return;

  const avatarConfig = await deps.getAvatarConfig(avatarId);
  if (!avatarConfig) throw new Error(`Avatar not found: ${avatarId}`);

  const telegramCfg = avatarConfig.platforms.telegram;
  const merged = mergeAllowedChats({
    existingAllowedChats: telegramCfg?.allowedChats,
    existingAllowedChatIds: telegramCfg?.allowedChatIds,
    add: { chatId: chat.chatId, username: chat.username, title: chat.title },
  });

  await dynamoClient.send(
    new UpdateCommand({
      TableName: STATE_TABLE,
      Key: {
        pk: `AVATAR#${avatarId}`,
        sk: 'CONFIG',
      },
      UpdateExpression: 'SET #config.#platforms.#telegram.#allowedChats = :allowedChats, #config.#platforms.#telegram.#allowedChatIds = :allowedChatIds',
      ExpressionAttributeNames: {
        '#config': 'config',
        '#platforms': 'platforms',
        '#telegram': 'telegram',
        '#allowedChats': 'allowedChats',
        '#allowedChatIds': 'allowedChatIds',
      },
      ExpressionAttributeValues: {
        ':allowedChats': merged.allowedChats,
        ':allowedChatIds': merged.allowedChatIds,
      },
    })
  );

  // Propagate to ADMIN_TABLE (stores fields at platforms.telegram.* directly)
  if (ADMIN_TABLE) {
    try {
      await dynamoClient.send(
        new UpdateCommand({
          TableName: ADMIN_TABLE,
          Key: {
            pk: `AVATAR#${avatarId}`,
            sk: 'CONFIG',
          },
          UpdateExpression: 'SET #platforms.#telegram.#allowedChats = :allowedChats, #platforms.#telegram.#allowedChatIds = :allowedChatIds',
          ExpressionAttributeNames: {
            '#platforms': 'platforms',
            '#telegram': 'telegram',
            '#allowedChats': 'allowedChats',
            '#allowedChatIds': 'allowedChatIds',
          },
          ExpressionAttributeValues: {
            ':allowedChats': merged.allowedChats,
            ':allowedChatIds': merged.allowedChatIds,
          },
        })
      );
    } catch (err) {
      logger.warn('Failed to propagate allowedChats to ADMIN_TABLE', {
        avatarId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  deps.invalidateAvatarConfigCache(avatarId);
}

export async function maybeBootstrapHomeChannelFromGroupEngagement(
  params: {
  avatarId: string;
  avatarConfig: AvatarConfig;
  envelope: {
    conversationId: string;
    metadata: {
      chatType?: string;
      chatTitle?: string;
      isMention?: boolean;
      isReplyToBot?: boolean;
    };
  };
  },
  deps: {
    registerHomeChannelFromWebhook: typeof registerHomeChannelFromWebhook;
    updateAvatarHomeChannel: typeof updateAvatarHomeChannel;
    logger?: {
      info: (message: string, meta?: Record<string, unknown>) => void;
      warn: (message: string, meta?: Record<string, unknown>) => void;
    };
  } = {
    registerHomeChannelFromWebhook,
    updateAvatarHomeChannel,
    logger,
  }
): Promise<boolean> {
  const { avatarId, avatarConfig, envelope } = params;
  const log = deps.logger || logger;

  const adminTable = process.env.ADMIN_TABLE;
  const stateTable = process.env.STATE_TABLE;
  if (!adminTable || !stateTable) return false;
  const chatType = envelope.metadata.chatType;
  if (chatType !== 'group' && chatType !== 'supergroup' && chatType !== 'channel') return false;

  const isEngaged = Boolean(envelope.metadata.isMention || envelope.metadata.isReplyToBot);
  if (!isEngaged) return false;

  const hasHomeChannel = Boolean(avatarConfig.platforms.telegram?.homeChannelId);
  if (hasHomeChannel) return false;

  const botUsername = avatarConfig.platforms.telegram?.botUsername || '';
  if (!botUsername) return false;

  try {
    await deps.registerHomeChannelFromWebhook(
      avatarId,
      envelope.conversationId,
      botUsername,
      undefined,
      envelope.metadata.chatTitle
    );

    await deps.updateAvatarHomeChannel(
      avatarId,
      envelope.conversationId,
      undefined,
      envelope.metadata.chatTitle
    );

    log.info('Bootstrapped home channel from group engagement', {
      event: 'home_channel_bootstrapped',
      avatarId,
      chatId: envelope.conversationId,
      chatType,
    });
    return true;
  } catch (err) {
    log.warn('Failed to bootstrap home channel from group engagement', {
      event: 'home_channel_bootstrap_failed',
      avatarId,
      chatId: envelope.conversationId,
      chatType,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
