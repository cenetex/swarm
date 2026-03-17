/**
 * Discord Chat Access Module
 *
 * Mirrors Telegram's webhook-chat-access.ts to enforce consistent
 * entitlement and channel/role gating for Discord interactions.
 *
 * Access rules:
 * - Guild messages: checked against allowedGuilds and allowedChannels
 * - DMs: checked against respondInDMs config flag
 * - Role gating: if allowedRoleIds is configured, sender must hold at least one
 *
 * Denied interactions are logged and blocked predictably.
 */
import { logger } from '@swarm/core';
import type { DiscordConfig } from '@swarm/core';

export interface DiscordAccessContext {
  /** The Discord channel ID where the message was sent */
  channelId: string;
  /** The guild ID (undefined for DMs) */
  guildId?: string;
  /** Whether this is a DM (no guild) */
  isDm: boolean;
  /** The sender's user ID */
  senderId: string;
  /** The sender's username */
  senderUsername?: string;
  /** The sender's roles in the guild (empty for DMs) */
  senderRoleIds?: string[];
}

export interface DiscordAccessResult {
  /** Whether the interaction is allowed */
  allowed: boolean;
  /** Human-readable reason for the decision */
  reason: string;
}

/**
 * Check if a Discord interaction is allowed for this avatar.
 *
 * Policy semantics aligned with Telegram's isTelegramChatAllowed:
 * - For DMs: controlled by respondInDMs flag (default: false)
 * - For guild messages: guild must be in allowedGuilds (if configured),
 *   channel must be in allowedChannels (if configured)
 * - If no guild/channel restrictions are configured, all guild messages are allowed
 */
export function isDiscordChatAllowed(
  ctx: DiscordAccessContext,
  discordCfg: DiscordConfig | undefined
): DiscordAccessResult {
  if (!discordCfg || !discordCfg.enabled) {
    return { allowed: false, reason: 'discord_not_enabled' };
  }

  // DM handling
  if (ctx.isDm) {
    // respondInDMs defaults to false for safety (matches Telegram's strict default)
    if (discordCfg.respondInDMs === true) {
      return { allowed: true, reason: 'dm_allowed' };
    }
    return { allowed: false, reason: 'dm_not_allowed' };
  }

  // Guild message handling
  // Check guild allowlist
  if (discordCfg.allowedGuilds && discordCfg.allowedGuilds.length > 0) {
    if (!ctx.guildId || !discordCfg.allowedGuilds.includes(ctx.guildId)) {
      return { allowed: false, reason: 'guild_not_allowed' };
    }
  }

  // Check channel allowlist
  if (discordCfg.allowedChannels && discordCfg.allowedChannels.length > 0) {
    if (!discordCfg.allowedChannels.includes(ctx.channelId)) {
      return { allowed: false, reason: 'channel_not_allowed' };
    }
  }

  // Check role allowlist
  if (discordCfg.allowedRoleIds && discordCfg.allowedRoleIds.length > 0) {
    const senderRoleIds = ctx.senderRoleIds || [];
    if (!senderRoleIds.some(roleId => discordCfg.allowedRoleIds!.includes(roleId))) {
      return { allowed: false, reason: 'role_not_allowed' };
    }
  }

  return { allowed: true, reason: 'allowed' };
}

/**
 * Log an access control decision with structured fields for observability.
 */
export function logAccessDecision(
  avatarId: string,
  ctx: DiscordAccessContext,
  result: DiscordAccessResult
): void {
  const logFields = {
    event: result.allowed ? 'discord_access_allowed' : 'discord_access_denied',
    subsystem: 'discord',
    avatarId,
    channelId: ctx.channelId,
    guildId: ctx.guildId,
    isDm: ctx.isDm,
    senderId: ctx.senderId,
    reason: result.reason,
  };

  if (result.allowed) {
    logger.info('Discord access allowed', logFields);
  } else {
    logger.info('Discord access denied', logFields);
  }
}
