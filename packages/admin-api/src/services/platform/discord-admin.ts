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
