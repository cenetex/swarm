/**
 * Webhook Chat Access Module
 * Handles DM allowlist logic, superadmin helpers, username resolution,
 * chat-allowed checks, and redirect messages for Telegram webhook handler.
 */
import { GetCommand, PutCommand } from '@swarm/core';
import { logger } from '@swarm/core';
import { getDynamoClient } from '../services/dynamo-client.js';

const dynamoClient = getDynamoClient();

// Default values for redirect message
const DEFAULT_HOME_CHANNEL_URL = 'https://t.me/ratichat';
const DEFAULT_COIN_SYMBOL = '$RATiOS';
const DEFAULT_COIN_ADDRESS = '281Qdc3ZcPQtn8odD9p4GyhzBSko1r5jmQrNU1dQBAGS';

const DEFAULT_SUPERADMIN_TELEGRAM_USERNAMES = ['ratimics'];

export function getSuperadminTelegramUsernames(): string[] {
  const raw = process.env.TELEGRAM_SUPERADMIN_USERNAMES;
  if (!raw) return DEFAULT_SUPERADMIN_TELEGRAM_USERNAMES;
  const parsed = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^@/, '').toLowerCase());
  return parsed.length > 0 ? parsed : DEFAULT_SUPERADMIN_TELEGRAM_USERNAMES;
}

export function isTelegramSuperadmin(username?: string): boolean {
  if (!username) return false;
  const u = username.replace(/^@/, '').toLowerCase();
  return getSuperadminTelegramUsernames().includes(u);
}

export function getAllowedDmUserIdsForAdmin(telegramCfg: {
  allowedDmUserIds?: string[];
  allowedDmUsers?: Array<{ userId: string | number }>;
} | undefined): string[] {
  if (!telegramCfg) return [];

  // New format takes precedence if present (even if empty).
  if ('allowedDmUsers' in telegramCfg) {
    return telegramCfg.allowedDmUsers?.map((u) => String(u.userId)) || [];
  }

  return telegramCfg.allowedDmUserIds || [];
}

/**
 * Check if a user ID is in the allowed DM users list.
 * Used by response-sender for defense-in-depth when we don't have the sender's username.
 * Handles both numeric user IDs and usernames in the allowlist by resolving usernames to IDs.
 */
export async function isAllowedDmUserById(
  userId: string,
  telegramCfg: {
    allowedDmUserIds?: string[];
    allowedDmUsers?: Array<{ userId: string | number }>;
  } | undefined
): Promise<boolean> {
  const allowedDmUserIds = getAllowedDmUserIdsForAdmin(telegramCfg);

  logger.info('DM allowlist check (response-sender)', {
    event: 'dm_allowlist_check_response_sender',
    userId,
    allowedDmUserIds,
    hasAdminTable: !!process.env.ADMIN_TABLE,
  });

  // Fast path: check if user ID is directly in the list
  if (allowedDmUserIds.includes(userId)) {
    return true;
  }

  // Slow path: resolve non-numeric entries (usernames) to user IDs
  for (const entry of allowedDmUserIds) {
    // Skip numeric entries (already checked above)
    if (/^\d+$/.test(entry)) continue;

    // Try to resolve username to user ID
    const resolvedUserId = await resolveTelegramUsername(entry);
    logger.info('Username resolution attempt', {
      event: 'username_resolution',
      username: entry,
      resolvedUserId,
      targetUserId: userId,
      matched: resolvedUserId === userId,
    });
    if (resolvedUserId && resolvedUserId === userId) {
      return true;
    }
  }

  return false;
}

export async function isTelegramUserOwnerOfAvatar(telegramUserId: string, avatarId: string): Promise<boolean> {
  // Read at runtime to support response-sender
  const adminTable = process.env.ADMIN_TABLE;
  if (!adminTable) return false;

  // New format: one record per avatar.
  // Key: pk=TELEGRAM_USER#{telegramUserId}, sk=CREATED_BOT#{avatarId}
  // Legacy format (back-compat): pk=TELEGRAM_USER#{telegramUserId}, sk=CREATED_BOT
  const newKeyResult = await dynamoClient.send(
    new GetCommand({
      TableName: adminTable,
      Key: {
        pk: `TELEGRAM_USER#${telegramUserId}`,
        sk: `CREATED_BOT#${avatarId}`,
      },
      ProjectionExpression: 'avatarId, avatarIds',
    })
  );

  if (newKeyResult.Item) return true;

  const legacyResult = await dynamoClient.send(
    new GetCommand({
      TableName: adminTable,
      Key: {
        pk: `TELEGRAM_USER#${telegramUserId}`,
        sk: 'CREATED_BOT',
      },
      ProjectionExpression: 'avatarId, avatarIds',
    })
  );

  const legacy = legacyResult.Item as { avatarId?: string; avatarIds?: string[] } | undefined;
  if (!legacy) return false;

  if (legacy.avatarId) return legacy.avatarId === avatarId;
  if (Array.isArray(legacy.avatarIds)) return legacy.avatarIds.includes(avatarId);
  return false;
}

/**
 * Store a mapping from Telegram username to user ID.
 * This allows the system to resolve usernames entered in the admin UI to actual user IDs.
 * Record format: pk=TELEGRAM_USERNAME#{lowercase_username}, sk=IDENTITY
 */
export async function upsertTelegramUserMapping(userId: string, username?: string, displayName?: string): Promise<void> {
  const adminTable = process.env.ADMIN_TABLE;
  if (!adminTable || !username) return;

  const normalizedUsername = username.replace(/^@/, '').toLowerCase();
  if (!normalizedUsername) return;

  try {
    await dynamoClient.send(new PutCommand({
      TableName: adminTable,
      Item: {
        pk: `TELEGRAM_USERNAME#${normalizedUsername}`,
        sk: 'IDENTITY',
        userId: userId,
        username: username.replace(/^@/, ''),  // Store original case
        displayName: displayName || username,
        updatedAt: Date.now(),
      },
    }));
  } catch (err) {
    // Non-critical, log and continue
    logger.warn('Failed to upsert Telegram user mapping', {
      userId,
      username,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Resolve a Telegram username to a user ID.
 * Returns the user ID if found, or null if not found.
 */
export async function resolveTelegramUsername(username: string): Promise<string | null> {
  // Read at runtime to support response-sender which may set ADMIN_TABLE after module load
  const adminTable = process.env.ADMIN_TABLE;
  if (!adminTable) {
    logger.warn('ADMIN_TABLE not set, cannot resolve username', { username });
    return null;
  }

  const normalizedUsername = username.replace(/^@/, '').toLowerCase();
  if (!normalizedUsername) return null;

  try {
    const result = await dynamoClient.send(new GetCommand({
      TableName: adminTable,
      Key: {
        pk: `TELEGRAM_USERNAME#${normalizedUsername}`,
        sk: 'IDENTITY',
      },
      ProjectionExpression: 'userId',
    }));

    return (result.Item?.userId as string) || null;
  } catch (err) {
    logger.warn('Failed to resolve Telegram username', {
      username,
      adminTable,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Check if a sender is in the allowed DM users list.
 * Handles both numeric user IDs and usernames in the allowlist.
 */
export async function isAllowedDmUser(
  senderId: string,
  senderUsername: string | undefined,
  allowedDmUserIds: string[]
): Promise<boolean> {
  // Fast path: check if sender ID is directly in the list
  if (allowedDmUserIds.includes(senderId)) {
    return true;
  }

  // Check if sender's username (lowercase) matches any entry that looks like a username
  if (senderUsername) {
    const normalizedSenderUsername = senderUsername.replace(/^@/, '').toLowerCase();
    for (const entry of allowedDmUserIds) {
      // If entry is non-numeric, it might be a username
      if (!/^\d+$/.test(entry)) {
        const normalizedEntry = entry.replace(/^@/, '').toLowerCase();
        if (normalizedEntry === normalizedSenderUsername) {
          return true;
        }
      }
    }
  }

  // Slow path: resolve non-numeric entries (usernames) to user IDs
  for (const entry of allowedDmUserIds) {
    // Skip numeric entries (already checked above)
    if (/^\d+$/.test(entry)) continue;

    // Try to resolve username to user ID
    const resolvedUserId = await resolveTelegramUsername(entry);
    if (resolvedUserId && resolvedUserId === senderId) {
      return true;
    }
  }

  return false;
}

export function mergeAllowedChats(
  params: {
    existingAllowedChats?: Array<{ chatId: string; username?: string; title?: string }>;
    existingAllowedChatIds?: string[];
    add: { chatId: string; username?: string; title?: string };
  }
): {
  allowedChats: Array<{ chatId: string; username?: string; title?: string }>;
  allowedChatIds: string[];
} {
  const seen = new Map<string, { chatId: string; username?: string; title?: string }>();

  for (const id of params.existingAllowedChatIds || []) {
    const chatId = String(id);
    if (!seen.has(chatId)) seen.set(chatId, { chatId });
  }

  for (const c of params.existingAllowedChats || []) {
    const chatId = String(c.chatId);
    const existing = seen.get(chatId);
    if (existing) {
      seen.set(chatId, {
        chatId,
        username: existing.username ?? c.username,
        title: existing.title ?? c.title,
      });
    } else {
      seen.set(chatId, { chatId, username: c.username, title: c.title });
    }
  }

  {
    const chatId = String(params.add.chatId);
    const existing = seen.get(chatId);
    if (existing) {
      seen.set(chatId, {
        chatId,
        username: params.add.username ?? existing.username,
        title: params.add.title ?? existing.title,
      });
    } else {
      seen.set(chatId, { chatId, username: params.add.username, title: params.add.title });
    }
  }

  const allowedChats = Array.from(seen.values());
  const allowedChatIds = allowedChats.map((c) => c.chatId);
  return { allowedChats, allowedChatIds };
}

/**
 * Build redirect message for blocked channels.
 * Uses avatar-specific config if available, otherwise falls back to defaults.
 */
export function buildRedirectMessage(telegramCfg?: {
  homeChannelUrl?: string;
  homeChannelUsername?: string;
  coinSymbol?: string;
  coinAddress?: string;
}): string {
  const homeChannelUrl = telegramCfg?.homeChannelUrl
    || (telegramCfg?.homeChannelUsername ? `https://t.me/${telegramCfg.homeChannelUsername}` : DEFAULT_HOME_CHANNEL_URL);
  const coinSymbol = telegramCfg?.coinSymbol || DEFAULT_COIN_SYMBOL;
  const coinAddress = telegramCfg?.coinAddress || DEFAULT_COIN_ADDRESS;

  return `I can only chat in my home channel! Join us:

🌐 https://swarm.rati.chat/
💬 ${homeChannelUrl}
🪙 ${coinSymbol}: ${coinAddress}`;
}

export function buildDmRedirectMessage(telegramCfg?: {
  homeChannelUrl?: string;
  homeChannelUsername?: string;
}): {
  text: string;
  replyMarkup: {
    inline_keyboard: Array<Array<{ text: string; url: string }>>;
  };
} {
  const homeChannelUrl = telegramCfg?.homeChannelUrl
    || (telegramCfg?.homeChannelUsername
      ? `https://t.me/${telegramCfg.homeChannelUsername}`
      : DEFAULT_HOME_CHANNEL_URL);

  return {
    text: `I can't chat in DMs.

Use RATi Chat to create a new bot or manage your account:
${homeChannelUrl}`,
    replyMarkup: {
      inline_keyboard: [
        [{ text: 'Open RATi Chat', url: homeChannelUrl }],
        [{ text: 'New Bot', url: `${homeChannelUrl}?start=new_bot` }],
      ],
    },
  };
}

/**
 * Interface for home channel checking (dependency injection).
 * This allows the webhook handler to check home channels without depending on admin-api.
 */
export interface HomeChannelChecker {
  isHomeChannel: (chatId: string, avatarHomeChannelId?: string) => Promise<boolean>;
}

/**
 * Check if a Telegram chat is allowed for this avatar.
 *
 * For DMs (private chats): Uses allowedDmUserIds allowlist, or allowAllDms for admin bots.
 * For groups/channels: Uses home channel logic if homeChannelChecker is provided.
 *                      If allowedChatIds is configured, those chats are treated as home channels.
 *                      If homeChannelChecker is not provided, falls back to allowedChatIds allowlist.
 *
 * @param envelope - The message envelope with chat info
 * @param telegramCfg - The avatar's Telegram configuration
 * @param homeChannelChecker - Optional: checker for home channel validation
 * @returns true if the chat is allowed, false otherwise
 */
export function isTelegramChatAllowed(
  envelope: {
    conversationId: string;
    sender: { id: string | number; platformUserId?: string | number; username?: string };
    metadata: { chatType?: string };
  },
  telegramCfg: {
    allowedChatIds?: string[];
    allowedChats?: Array<{ chatId: string }>;
    homeChannelId?: string;
    /** Allow all DMs (intended for admin/system bots only). */
    allowAllDms?: boolean;
    /** @deprecated Prefer allowedDmUsers for richer display info */
    allowedDmUserIds?: string[];
    allowedDmUsers?: Array<{ userId: string | number }>;
  } | undefined,
  homeChannelChecker?: HomeChannelChecker
): boolean | Promise<boolean> {
  const getAllowedChatIds = (): string[] | undefined => {
    // New format takes precedence if present (even if empty).
    if (telegramCfg && 'allowedChats' in telegramCfg) {
      return telegramCfg.allowedChats?.map((c) => String(c.chatId)) || [];
    }
    return telegramCfg?.allowedChatIds;
  };

  const getAllowedDmUserIds = (): string[] | undefined => {
    // New format takes precedence if present (even if empty).
    if (telegramCfg && 'allowedDmUsers' in telegramCfg) {
      return telegramCfg.allowedDmUsers?.map((u) => String(u.userId)) || [];
    }
    return telegramCfg?.allowedDmUserIds;
  };

  if (envelope.metadata.chatType === 'private') {
    if (telegramCfg?.allowAllDms) return true;

    const allowedDmUserIds = getAllowedDmUserIds();
    const senderId = String(envelope.sender.platformUserId ?? envelope.sender.id);
    const senderUsername = envelope.sender.username;

    if (!allowedDmUserIds || allowedDmUserIds.length === 0) {
      return false;
    }

    // Use the async isAllowedDmUser which handles username resolution
    return isAllowedDmUser(senderId, senderUsername, allowedDmUserIds);
  }

  // Groups/channels: use home channel logic if checker is provided
  if (homeChannelChecker) {
    const allowedChatIds = getAllowedChatIds();
    if (allowedChatIds && allowedChatIds.length > 0 && allowedChatIds.includes(envelope.conversationId)) {
      return true;
    }

    return homeChannelChecker.isHomeChannel(
      envelope.conversationId,
      telegramCfg?.homeChannelId
    );
  }

  // Fallback: optional allowlist by chat ID (legacy behavior)
  const allowedChatIds = getAllowedChatIds();
  if (allowedChatIds && allowedChatIds.length > 0) {
    return allowedChatIds.includes(envelope.conversationId);
  }

  return true;
}
