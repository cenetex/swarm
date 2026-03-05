/**
 * Discord Admin Utilities
 *
 * Setup lifecycle for Discord bot integration.
 * Mirrors the pattern in telegram-admin.ts:setupTelegramIntegration.
 */
import type { UserSession } from '../../types.js';
import type { updateAvatar } from '../avatars.js';
import type { storeSecret } from '../secrets.js';
import type { validateBotToken, DiscordBotWarning } from './discord.js';

// =============================================================================
// Setup
// =============================================================================

export interface DiscordSetupResult {
  success: boolean;
  error?: string;
  botInfo?: { id: string; username: string };
  /** Actionable warnings about intents / permissions (present even when success=true) */
  warnings?: DiscordBotWarning[];
}

export interface DiscordSetupDeps {
  validateBotToken: typeof validateBotToken;
  updateAvatar: typeof updateAvatar;
  storeSecret: typeof storeSecret;
}

export async function setupDiscordIntegration(params: {
  avatarId: string;
  token: string;
  session: UserSession;
  deps: DiscordSetupDeps;
}): Promise<DiscordSetupResult> {
  const { avatarId, token, session, deps } = params;

  const validation = await deps.validateBotToken(token);
  if (!validation.valid) {
    return { success: false, error: validation.error || 'Invalid Discord bot token', warnings: [] };
  }

  await Promise.all([
    deps.updateAvatar(
      avatarId,
      {
        platforms: {
          discord: {
            enabled: true,
            mode: 'bot',
            botUsername: validation.botInfo?.username,
            botId: validation.botInfo?.id,
            respondToMentions: true,
            respondInDMs: true,
          },
        },
      },
      session
    ),
    deps.storeSecret(
      avatarId,
      'discord_bot_token',
      'default',
      token,
      session,
      `Discord bot token for ${avatarId}`
    ),
  ]);

  return {
    success: true,
    botInfo: validation.botInfo,
    warnings: validation.warnings,
  };
}

// =============================================================================
// Global Bot Setup (Two-Tier Architecture)
// =============================================================================

export interface GlobalBotSetupResult {
  success: boolean;
  error?: string;
  botId?: string;
  botUsername?: string;
}

/**
 * Set up the global Discord bot token.
 * Validates the token via Discord API, then stores it at the global secret path.
 */
export async function setupGlobalDiscordBot(params: {
  token: string;
  session: UserSession;
  deps: DiscordSetupDeps;
}): Promise<GlobalBotSetupResult> {
  const { token, session, deps } = params;

  const validation = await deps.validateBotToken(token);
  if (!validation.valid) {
    return { success: false, error: validation.error || 'Invalid Discord bot token' };
  }

  // Store at global path (avatarId = null → generates swarm/global/discord_bot_token/global-bot)
  await deps.storeSecret(
    null as unknown as string, // null avatarId = global path
    'discord_bot_token',
    'global-bot',
    token,
    session,
    'Global shared Discord bot token for two-tier architecture'
  );

  return {
    success: true,
    botId: validation.botInfo?.id,
    botUsername: validation.botInfo?.username,
  };
}

/**
 * Configure an avatar to use the global Discord bot (global mode).
 */
export async function setupGlobalModeAvatar(params: {
  avatarId: string;
  allowedChannels?: string[];
  allowedGuilds?: string[];
  session: UserSession;
  deps: Pick<DiscordSetupDeps, 'updateAvatar'>;
}): Promise<{ success: boolean; error?: string }> {
  const { avatarId, allowedChannels, allowedGuilds, session, deps } = params;

  await deps.updateAvatar(
    avatarId,
    {
      platforms: {
        discord: {
          enabled: true,
          mode: 'global',
          respondToMentions: true,
          respondInDMs: false, // Global mode is guild-only
          allowedChannels,
          allowedGuilds,
        },
      },
    },
    session
  );

  return { success: true };
}
