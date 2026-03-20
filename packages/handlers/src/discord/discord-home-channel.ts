/**
 * Discord Home Channel Bootstrap Module
 *
 * Mirrors the Telegram home-channel bootstrap pattern for Discord avatars.
 * Handles:
 * - Discovery: check if avatar already has a persisted home channel
 * - Creation: if not, select a channel from the guild and persist it
 * - Reuse: subsequent calls return the persisted channel (no duplicates)
 * - Error handling: log failures, fail closed (return null)
 *
 * Uses the same DynamoDB tables (STATE_TABLE, ADMIN_TABLE) and key patterns
 * as the Telegram home-channel module but scoped to Discord.
 */
import { GetCommand, PutCommand, UpdateCommand, QueryCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { logger, type AvatarConfig } from '@swarm/core';
import { getDynamoClient } from '../services/dynamo-client.js';

const dynamoClient = getDynamoClient();

const HOME_CHANNEL_CACHE_TTL_MS = 60_000;

function getStateTable(): string | undefined {
  return process.env.STATE_TABLE;
}

function getAdminTable(): string | undefined {
  return process.env.ADMIN_TABLE;
}

/**
 * Home channel record shape for Discord (minimal projection).
 */
interface DiscordHomeChannelEntry {
  sk: string; // channelId
  registeredAvatars?: Array<{ avatarId: string; botUsername: string }>;
}

// In-memory cache for Discord home channel entries
let homeChannelCache: { entries: DiscordHomeChannelEntry[]; expiresAt: number } | null = null;

/**
 * Result of resolving a Discord home channel.
 */
export interface DiscordHomeChannelResult {
  channelId: string;
  guildId?: string;
  channelName?: string;
  source: 'persisted' | 'discovered' | 'created' | 'fallback';
}

/**
 * Dependencies for Discord home channel operations (dependency injection for testing).
 */
export interface DiscordHomeChannelDeps {
  getDynamo: () => { send: (cmd: unknown) => Promise<unknown> };
  logger?: {
    info: (message: string, meta?: Record<string, unknown>) => void;
    warn: (message: string, meta?: Record<string, unknown>) => void;
  };
}

const defaultDeps: DiscordHomeChannelDeps = {
  getDynamo: () => dynamoClient as unknown as { send: (cmd: unknown) => Promise<unknown> },
  logger,
};

/**
 * Invalidate the home channel cache. Exposed for testing.
 */
export function invalidateDiscordHomeChannelCache(): void {
  homeChannelCache = null;
}

/**
 * Resolve a Discord home channel for an avatar.
 *
 * Resolution order:
 * 1. Check avatar config for persisted homeChannelId -> return immediately
 * 2. Check ADMIN_TABLE for a registered Discord home channel for this avatar
 * 3. If a fallbackChannelId is provided, persist and return it
 * 4. Return null (fail closed)
 */
export async function resolveDiscordHomeChannel(
  params: {
    avatarId: string;
    avatarConfig: AvatarConfig;
    fallbackChannelId?: string;
    fallbackGuildId?: string;
    fallbackChannelName?: string;
  },
  deps: DiscordHomeChannelDeps = defaultDeps
): Promise<DiscordHomeChannelResult | null> {
  const { avatarId, avatarConfig, fallbackChannelId, fallbackGuildId, fallbackChannelName } = params;
  const log = deps.logger || logger;
  const discordConfig = avatarConfig.platforms?.discord;

  // 1. Fast path: persisted in avatar config
  if (discordConfig?.homeChannelId) {
    log.info('Discord home channel resolved from config', {
      event: 'discord_home_channel_resolved',
      avatarId,
      channelId: discordConfig.homeChannelId,
      source: 'persisted',
    });
    return {
      channelId: discordConfig.homeChannelId,
      guildId: discordConfig.homeGuildId,
      channelName: discordConfig.homeChannelName,
      source: 'persisted',
    };
  }

  // 2. Check ADMIN_TABLE registry for existing Discord home channel
  if (getAdminTable()) {
    try {
      const channelIds = await getDiscordHomeChannelIdsForAvatar(avatarId, deps);
      if (channelIds.size > 0) {
        const channelId = channelIds.values().next().value!;
        log.info('Discord home channel discovered from registry', {
          event: 'discord_home_channel_resolved',
          avatarId,
          channelId,
          source: 'discovered',
        });
        return {
          channelId,
          source: 'discovered',
        };
      }
    } catch (err) {
      log.warn('Failed to query Discord home channel registry', {
        event: 'discord_home_channel_registry_error',
        avatarId,
        error: err instanceof Error ? err.message : String(err),
      });
      // Fall through to fallback
    }
  }

  // 3. Use fallback channel if provided
  if (fallbackChannelId) {
    try {
      await registerDiscordHomeChannel(avatarId, fallbackChannelId, discordConfig?.botUsername || '', fallbackGuildId, fallbackChannelName, deps);
      await updateAvatarDiscordHomeChannel(avatarId, fallbackChannelId, fallbackGuildId, fallbackChannelName, deps);

      log.info('Discord home channel created from fallback', {
        event: 'discord_home_channel_resolved',
        avatarId,
        channelId: fallbackChannelId,
        source: 'fallback',
      });
      return {
        channelId: fallbackChannelId,
        guildId: fallbackGuildId,
        channelName: fallbackChannelName,
        source: 'fallback',
      };
    } catch (err) {
      log.warn('Failed to persist fallback Discord home channel', {
        event: 'discord_home_channel_fallback_error',
        avatarId,
        channelId: fallbackChannelId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // 4. Fail closed
  log.warn('No Discord home channel found and no fallback provided', {
    event: 'discord_home_channel_missing',
    avatarId,
  });
  return null;
}

/**
 * Bootstrap a Discord home channel from guild engagement (e.g., first mention in a guild channel).
 * Mirrors maybeBootstrapHomeChannelFromGroupEngagement for Telegram.
 *
 * Returns true if a home channel was bootstrapped, false otherwise.
 */
export async function maybeBootstrapDiscordHomeChannel(
  params: {
    avatarId: string;
    avatarConfig: AvatarConfig;
    channelId: string;
    guildId?: string;
    channelName?: string;
    isMention?: boolean;
    isReplyToBot?: boolean;
  },
  deps: DiscordHomeChannelDeps = defaultDeps
): Promise<boolean> {
  const { avatarId, avatarConfig, channelId, guildId, channelName, isMention, isReplyToBot } = params;
  const log = deps.logger || logger;

  if (!getAdminTable() || !getStateTable()) return false;

  // Only bootstrap from engaged interactions
  const isEngaged = Boolean(isMention || isReplyToBot);
  if (!isEngaged) return false;

  // Skip if already has a home channel
  const discordConfig = avatarConfig.platforms?.discord;
  if (discordConfig?.homeChannelId) return false;

  // Must be in a guild channel (not DM)
  if (!guildId) return false;

  const botUsername = discordConfig?.botUsername || '';

  try {
    await registerDiscordHomeChannel(avatarId, channelId, botUsername, guildId, channelName, deps);
    await updateAvatarDiscordHomeChannel(avatarId, channelId, guildId, channelName, deps);

    log.info('Bootstrapped Discord home channel from guild engagement', {
      event: 'discord_home_channel_bootstrapped',
      avatarId,
      channelId,
      guildId,
    });
    return true;
  } catch (err) {
    log.warn('Failed to bootstrap Discord home channel from guild engagement', {
      event: 'discord_home_channel_bootstrap_failed',
      avatarId,
      channelId,
      guildId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Register a Discord home channel in the ADMIN_TABLE registry.
 * Creates or updates the home channel record with avatar membership.
 */
export async function registerDiscordHomeChannel(
  avatarId: string,
  channelId: string,
  botUsername: string,
  guildId?: string,
  channelName?: string,
  deps: DiscordHomeChannelDeps = defaultDeps
): Promise<void> {
  const adminTable = getAdminTable();
  if (!adminTable) return;

  const now = Date.now();
  const newMember = { avatarId, botUsername };
  const dynamo = deps.getDynamo();

  // Check if the home channel record already exists
  const existing = await dynamo.send(new GetCommand({
    TableName: adminTable,
    Key: { pk: 'DISCORD_HOME_CHANNELS', sk: channelId },
    ProjectionExpression: 'registeredAvatars',
  })) as { Item?: { registeredAvatars?: Array<{ avatarId: string; botUsername: string }> } };

  if (existing.Item) {
    const registeredAvatars = existing.Item.registeredAvatars || [];
    const alreadyRegistered = registeredAvatars.some((a) => a.avatarId === avatarId);
    if (!alreadyRegistered) {
      await dynamo.send(new UpdateCommand({
        TableName: adminTable,
        Key: { pk: 'DISCORD_HOME_CHANNELS', sk: channelId },
        UpdateExpression: 'SET registeredAvatars = list_append(if_not_exists(registeredAvatars, :empty), :newMember), updatedAt = :now',
        ExpressionAttributeValues: {
          ':newMember': [newMember],
          ':empty': [],
          ':now': now,
        },
      }));
    }
  } else {
    await dynamo.send(new PutCommand({
      TableName: adminTable,
      Item: {
        pk: 'DISCORD_HOME_CHANNELS',
        sk: channelId,
        channelId,
        avatarId,
        botUsername,
        guildId,
        channelName,
        registeredAvatars: [newMember],
        registeredAt: now,
        updatedAt: now,
      },
    }));
  }

  // Invalidate cache
  homeChannelCache = null;
}

/**
 * Update avatar config with Discord home channel info.
 * Writes to both STATE_TABLE and ADMIN_TABLE.
 */
export async function updateAvatarDiscordHomeChannel(
  avatarId: string,
  channelId: string,
  guildId?: string,
  channelName?: string,
  deps: DiscordHomeChannelDeps = defaultDeps
): Promise<void> {
  const stateTable = getStateTable();
  if (!stateTable) return;

  const dynamo = deps.getDynamo();

  const stateUpdateParts: string[] = [
    '#config.#platforms.#discord.#homeChannelId = :channelId',
  ];
  const stateExprNames: Record<string, string> = {
    '#config': 'config',
    '#platforms': 'platforms',
    '#discord': 'discord',
    '#homeChannelId': 'homeChannelId',
  };
  const expressionValues: Record<string, unknown> = {
    ':channelId': channelId,
  };

  const adminUpdateParts: string[] = [
    '#platforms.#discord.#homeChannelId = :channelId',
  ];
  const adminExprNames: Record<string, string> = {
    '#platforms': 'platforms',
    '#discord': 'discord',
    '#homeChannelId': 'homeChannelId',
  };

  if (guildId) {
    stateUpdateParts.push('#config.#platforms.#discord.#homeGuildId = :guildId');
    stateExprNames['#homeGuildId'] = 'homeGuildId';
    expressionValues[':guildId'] = guildId;

    adminUpdateParts.push('#platforms.#discord.#homeGuildId = :guildId');
    adminExprNames['#homeGuildId'] = 'homeGuildId';
  }

  if (channelName) {
    stateUpdateParts.push('#config.#platforms.#discord.#homeChannelName = :channelName');
    stateExprNames['#homeChannelName'] = 'homeChannelName';
    expressionValues[':channelName'] = channelName;

    adminUpdateParts.push('#platforms.#discord.#homeChannelName = :channelName');
    adminExprNames['#homeChannelName'] = 'homeChannelName';
  }

  await dynamo.send(new UpdateCommand({
    TableName: stateTable,
    Key: {
      pk: `AVATAR#${avatarId}`,
      sk: 'CONFIG',
    },
    UpdateExpression: `SET ${stateUpdateParts.join(', ')}`,
    ExpressionAttributeNames: stateExprNames,
    ExpressionAttributeValues: expressionValues,
  }));

  // Propagate to ADMIN_TABLE
  const adminTable = getAdminTable();
  if (adminTable) {
    try {
      await dynamo.send(new UpdateCommand({
        TableName: adminTable,
        Key: {
          pk: `AVATAR#${avatarId}`,
          sk: 'CONFIG',
        },
        UpdateExpression: `SET ${adminUpdateParts.join(', ')}`,
        ExpressionAttributeNames: adminExprNames,
        ExpressionAttributeValues: expressionValues,
      }));
    } catch (err) {
      const log = deps.logger || logger;
      log.warn('Failed to propagate Discord home channel to ADMIN_TABLE', {
        avatarId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Get all Discord home channel entries from the registry.
 * Uses in-memory caching with 60 second TTL.
 */
async function getDiscordHomeChannelEntries(
  deps: DiscordHomeChannelDeps = defaultDeps
): Promise<DiscordHomeChannelEntry[]> {
  const adminTable = getAdminTable();
  if (!adminTable) return [];

  const now = Date.now();
  if (homeChannelCache && homeChannelCache.entries && homeChannelCache.expiresAt > now) {
    return homeChannelCache.entries;
  }

  try {
    const dynamo = deps.getDynamo();
    const result = await dynamo.send(new QueryCommand({
      TableName: adminTable,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': 'DISCORD_HOME_CHANNELS',
      },
      ProjectionExpression: 'sk, registeredAvatars',
    })) as { Items?: Array<{ sk: string; registeredAvatars?: DiscordHomeChannelEntry['registeredAvatars'] }> };

    const entries: DiscordHomeChannelEntry[] = (result.Items || []).map((item) => ({
      sk: item.sk,
      registeredAvatars: item.registeredAvatars,
    }));

    homeChannelCache = { entries, expiresAt: now + HOME_CHANNEL_CACHE_TTL_MS };
    return entries;
  } catch (err) {
    const log = deps.logger || logger;
    log.warn('Failed to fetch Discord home channels', { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
}

/**
 * Get Discord home channel IDs where a specific avatar has explicit membership.
 */
export async function getDiscordHomeChannelIdsForAvatar(
  avatarId: string,
  deps: DiscordHomeChannelDeps = defaultDeps
): Promise<Set<string>> {
  const entries = await getDiscordHomeChannelEntries(deps);
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.sk && entry.registeredAvatars?.some((a) => a.avatarId === avatarId)) {
      ids.add(entry.sk);
    }
  }
  return ids;
}

/**
 * Get avatar IDs registered in a specific Discord channel.
 */
export async function getDiscordChannelAvatarIds(
  channelId: string,
  deps: DiscordHomeChannelDeps = defaultDeps
): Promise<string[]> {
  const entries = await getDiscordHomeChannelEntries(deps);
  const entry = entries.find((e) => e.sk === channelId);
  if (!entry?.registeredAvatars) return [];
  return entry.registeredAvatars.map((a) => a.avatarId);
}

/**
 * Remove an avatar's membership from a Discord home channel.
 */
export async function removeDiscordHomeChannelMembership(
  avatarId: string,
  channelId: string,
  deps: DiscordHomeChannelDeps = defaultDeps
): Promise<void> {
  const adminTable = getAdminTable();
  if (!adminTable) return;

  const dynamo = deps.getDynamo();
  const existing = await dynamo.send(new GetCommand({
    TableName: adminTable,
    Key: { pk: 'DISCORD_HOME_CHANNELS', sk: channelId },
    ProjectionExpression: 'registeredAvatars',
  })) as { Item?: { registeredAvatars?: Array<{ avatarId: string; botUsername: string }> } };

  if (!existing.Item) return;

  const registeredAvatars = existing.Item.registeredAvatars || [];
  const filtered = registeredAvatars.filter((a) => a.avatarId !== avatarId);

  await dynamo.send(new UpdateCommand({
    TableName: adminTable,
    Key: { pk: 'DISCORD_HOME_CHANNELS', sk: channelId },
    UpdateExpression: 'SET registeredAvatars = :filtered, updatedAt = :now',
    ExpressionAttributeValues: {
      ':filtered': filtered,
      ':now': Date.now(),
    },
  }));

  homeChannelCache = null;
}

/**
 * Clean up Discord channel state when bot is removed.
 */
export async function cleanupDiscordChannelState(
  avatarId: string,
  channelId: string,
  deps: DiscordHomeChannelDeps = defaultDeps
): Promise<void> {
  const dynamo = deps.getDynamo();
  const deletePromises: Promise<unknown>[] = [];
  const log = deps.logger || logger;
  const stateTable = getStateTable();
  const adminTable = getAdminTable();

  if (stateTable) {
    deletePromises.push(
      dynamo.send(new DeleteCommand({
        TableName: stateTable,
        Key: {
          pk: `AVATAR#${avatarId}`,
          sk: `CHANNEL#${channelId}#STATE`,
        },
      })).catch((err: unknown) => {
        log.warn('Failed to delete Discord channel state from STATE_TABLE', {
          avatarId,
          channelId,
          error: err instanceof Error ? err.message : String(err),
        });
      })
    );
  }

  if (adminTable) {
    deletePromises.push(
      dynamo.send(new DeleteCommand({
        TableName: adminTable,
        Key: {
          pk: `CHANNEL#${avatarId}#${channelId}`,
          sk: 'STATE',
        },
      })).catch((err: unknown) => {
        log.warn('Failed to delete Discord channel state from ADMIN_TABLE', {
          avatarId,
          channelId,
          error: err instanceof Error ? err.message : String(err),
        });
      })
    );
  }

  await Promise.all(deletePromises);
  log.info('Cleaned up Discord channel state', { avatarId, channelId });
}
