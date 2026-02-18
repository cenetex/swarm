/**
 * Webhook Home Channel Module
 * Handles home channel registration, cleanup, channel state management,
 * and bootstrap logic for the Telegram webhook handler.
 */
import { QueryCommand, DeleteCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { logger, type AvatarConfig } from '@swarm/core';
import { getDynamoClient } from '../services/dynamo-client.js';
import { mergeAllowedChats } from './webhook-chat-access.js';

const dynamoClient = getDynamoClient();

const STATE_TABLE = process.env.STATE_TABLE!;
const ADMIN_TABLE = process.env.ADMIN_TABLE;

const HOME_CHANNEL_CACHE_TTL_MS = 60_000;

// Home channel cache (set of chat IDs that are home channels)
let homeChannelCache: { ids: Set<string>; expiresAt: number } | null = null;

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
      registeredAvatars: [{ avatarId, botUsername }],
      registeredAt: now,
      updatedAt: now,
    },
  }));
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
 * Get all home channel IDs from the registry.
 * Uses in-memory caching with 60 second TTL.
 */
export async function getHomeChannelIds(): Promise<Set<string>> {
  if (!ADMIN_TABLE) {
    // ADMIN_TABLE not configured, home channel feature disabled
    return new Set();
  }

  const now = Date.now();
  if (homeChannelCache && homeChannelCache.expiresAt > now) {
    return homeChannelCache.ids;
  }

  try {
    const result = await dynamoClient.send(new QueryCommand({
      TableName: ADMIN_TABLE,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': 'HOME_CHANNELS',
      },
      ProjectionExpression: 'sk', // sk = chatId
    }));

    const ids = new Set<string>();
    for (const item of result.Items || []) {
      if (item.sk) {
        ids.add(item.sk as string);
      }
    }

    homeChannelCache = { ids, expiresAt: now + HOME_CHANNEL_CACHE_TTL_MS };
    return ids;
  } catch (err) {
    logger.warn('Failed to fetch home channels', { error: err instanceof Error ? err.message : String(err) });
    return new Set();
  }
}

/**
 * Interface for home channel checking (dependency injection).
 * Re-exported from webhook-chat-access for convenience.
 */
export type { HomeChannelChecker } from './webhook-chat-access.js';

/**
 * Create a home channel checker for a specific avatar.
 * Checks if a chat ID is a registered home channel.
 */
export function createHomeChannelChecker(): import('./webhook-chat-access.js').HomeChannelChecker {
  return {
    async isHomeChannel(chatId: string, avatarHomeChannelId?: string): Promise<boolean> {
      // Fast path: check if it's the avatar's own home channel
      if (avatarHomeChannelId && chatId === avatarHomeChannelId) {
        return true;
      }

      // Check against all registered home channels
      const homeChannelIds = await getHomeChannelIds();
      if (homeChannelIds.has(chatId)) {
        return true;
      }

      return false;
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
