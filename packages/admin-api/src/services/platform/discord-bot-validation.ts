/**
 * Discord Bot Configuration Validation
 *
 * Pure functions for validating Discord bot intents and permissions.
 * Extracted from discord.ts to enable testing without AWS SDK dependencies.
 *
 * @see https://discord.com/developers/docs/resources/application#application-object-application-flags
 */

/**
 * Discord Application flags that indicate privileged intents are enabled.
 * @see https://discord.com/developers/docs/resources/application#application-object-application-flags
 */
export const DiscordApplicationFlag = {
  /** Bot can receive GUILD_PRESENCES events */
  GATEWAY_PRESENCE:                 1 << 12,
  /** Bot can receive GUILD_PRESENCES events (limited to <100 guilds) */
  GATEWAY_PRESENCE_LIMITED:         1 << 13,
  /** Bot can receive GUILD_MEMBERS events */
  GATEWAY_GUILD_MEMBERS:            1 << 14,
  /** Bot can receive GUILD_MEMBERS events (limited to <100 guilds) */
  GATEWAY_GUILD_MEMBERS_LIMITED:    1 << 15,
  /** Bot can receive MESSAGE_CONTENT events */
  GATEWAY_MESSAGE_CONTENT:          1 << 18,
  /** Bot can receive MESSAGE_CONTENT events (limited to <100 guilds) */
  GATEWAY_MESSAGE_CONTENT_LIMITED:  1 << 19,
} as const;

/** Single warning from bot configuration validation */
export interface DiscordBotWarning {
  /** Warning severity: 'error' blocks functionality, 'warning' is advisory */
  severity: 'error' | 'warning';
  /** Short code for programmatic handling */
  code: string;
  /** Human-readable message with actionable remediation */
  message: string;
}

/** Extended result from bot token + configuration validation */
export interface DiscordBotValidationResult {
  valid: boolean;
  error?: string;
  botInfo?: { id: string; username: string };
  /** Actionable warnings about intents / permissions (present even when valid=true) */
  warnings: DiscordBotWarning[];
}

/**
 * Privileged intent check descriptor -- used to produce actionable warnings.
 */
interface PrivilegedIntentCheck {
  /** Human-readable intent name */
  name: string;
  /** Full flag (approved for all guilds) */
  fullFlag: number;
  /** Limited flag (approved for <100 guilds) */
  limitedFlag: number;
  /** Whether this intent is required (blocks functionality) vs recommended */
  required: boolean;
  /** Developer Portal toggle label */
  portalLabel: string;
}

const PRIVILEGED_INTENT_CHECKS: PrivilegedIntentCheck[] = [
  {
    name: 'Message Content Intent',
    fullFlag: DiscordApplicationFlag.GATEWAY_MESSAGE_CONTENT,
    limitedFlag: DiscordApplicationFlag.GATEWAY_MESSAGE_CONTENT_LIMITED,
    required: true,
    portalLabel: 'MESSAGE CONTENT INTENT',
  },
  {
    name: 'Server Members Intent',
    fullFlag: DiscordApplicationFlag.GATEWAY_GUILD_MEMBERS,
    limitedFlag: DiscordApplicationFlag.GATEWAY_GUILD_MEMBERS_LIMITED,
    required: false,
    portalLabel: 'SERVER MEMBERS INTENT',
  },
  {
    name: 'Presence Intent',
    fullFlag: DiscordApplicationFlag.GATEWAY_PRESENCE,
    limitedFlag: DiscordApplicationFlag.GATEWAY_PRESENCE_LIMITED,
    required: false,
    portalLabel: 'PRESENCE INTENT',
  },
];

/**
 * Check application flags for privileged intents.
 * Returns actionable warnings for any missing intents.
 */
export function checkPrivilegedIntents(flags: number): DiscordBotWarning[] {
  const warnings: DiscordBotWarning[] = [];

  for (const check of PRIVILEGED_INTENT_CHECKS) {
    const hasFullFlag = (flags & check.fullFlag) === check.fullFlag;
    const hasLimitedFlag = (flags & check.limitedFlag) === check.limitedFlag;

    if (!hasFullFlag && !hasLimitedFlag) {
      warnings.push({
        severity: check.required ? 'error' : 'warning',
        code: `missing_intent_${check.name.toLowerCase().replace(/\s+/g, '_')}`,
        message:
          `${check.name} is not enabled. ` +
          'Go to https://discord.com/developers/applications → select your app → Bot → ' +
          `Privileged Gateway Intents → enable ${check.portalLabel}.` +
          (check.required
            ? ' This intent is REQUIRED — the bot will not receive message content without it.'
            : ''),
      });
    }
  }

  return warnings;
}

/** Minimum required Discord permissions for a message bot */
const REQUIRED_PERMISSIONS = {
  SEND_MESSAGES:       BigInt(1) << BigInt(11),
  READ_MESSAGE_HISTORY: BigInt(1) << BigInt(16),
  VIEW_CHANNEL:        BigInt(1) << BigInt(10),
} as const;

/** Recommended permissions for full bot functionality */
const RECOMMENDED_PERMISSIONS = {
  EMBED_LINKS:         BigInt(1) << BigInt(14),
  ATTACH_FILES:        BigInt(1) << BigInt(15),
  USE_EXTERNAL_EMOJIS: BigInt(1) << BigInt(18),
} as const;

/**
 * Check guild permissions for the bot.
 * Only reports warnings for guilds where the bot is missing critical permissions.
 */
export function checkGuildPermissions(
  guilds: Array<{ id: string; name: string; permissions: string }>
): DiscordBotWarning[] {
  const warnings: DiscordBotWarning[] = [];

  for (const guild of guilds) {
    const perms = BigInt(guild.permissions);

    // Check if bot is admin -- admin overrides all permissions
    const ADMINISTRATOR = BigInt(1) << BigInt(3);
    if ((perms & ADMINISTRATOR) === ADMINISTRATOR) {
      continue; // Admin has all permissions
    }

    const missingRequired: string[] = [];
    for (const [name, bit] of Object.entries(REQUIRED_PERMISSIONS)) {
      if ((perms & bit) !== bit) {
        missingRequired.push(name.replace(/_/g, ' '));
      }
    }

    if (missingRequired.length > 0) {
      warnings.push({
        severity: 'error',
        code: 'missing_guild_permissions',
        message:
          `Bot is missing required permissions in server "${guild.name}": ${missingRequired.join(', ')}. ` +
          'Re-invite the bot with the correct permissions or update the bot\'s role in Server Settings > Roles.',
      });
    }

    const missingRecommended: string[] = [];
    for (const [name, bit] of Object.entries(RECOMMENDED_PERMISSIONS)) {
      if ((perms & bit) !== bit) {
        missingRecommended.push(name.replace(/_/g, ' '));
      }
    }

    if (missingRecommended.length > 0 && missingRequired.length === 0) {
      warnings.push({
        severity: 'warning',
        code: 'missing_recommended_permissions',
        message:
          `Bot is missing recommended permissions in server "${guild.name}": ${missingRecommended.join(', ')}. ` +
          'These are not required but enable richer bot responses (embeds, files, emojis).',
      });
    }
  }

  return warnings;
}

/**
 * Check privileged intents via GET /applications/@me and bot permissions
 * via GET /users/@me/guilds.
 *
 * This is a best-effort check: if the API calls fail, we return a
 * non-blocking warning rather than treating it as a validation failure.
 */
export async function checkBotIntentsAndPermissions(
  token: string,
  apiBase = 'https://discord.com/api/v10',
): Promise<DiscordBotWarning[]> {
  const warnings: DiscordBotWarning[] = [];

  // -- Check privileged intents via /applications/@me ---
  try {
    const appResponse = await fetch(`${apiBase}/applications/@me`, {
      headers: { Authorization: `Bot ${token}` },
    });

    if (appResponse.ok) {
      const app = (await appResponse.json()) as { id: string; flags: number };
      const intentWarnings = checkPrivilegedIntents(app.flags);
      warnings.push(...intentWarnings);
    } else {
      // API call failed -- might be an older bot or restricted endpoint.
      // Add an informational warning but do not block.
      warnings.push({
        severity: 'warning',
        code: 'intents_check_unavailable',
        message:
          'Could not verify privileged intents (GET /applications/@me returned ' +
          `${appResponse.status}). Please manually verify that Message Content Intent is enabled ` +
          'in the Discord Developer Portal under Bot > Privileged Gateway Intents.',
      });
    }
  } catch {
    warnings.push({
      severity: 'warning',
      code: 'intents_check_failed',
      message:
        'Could not verify privileged intents due to a network error. ' +
        'Please manually verify that Message Content Intent is enabled ' +
        'in the Discord Developer Portal under Bot > Privileged Gateway Intents.',
    });
  }

  // -- Check bot guild membership ---
  try {
    const guildsResponse = await fetch(`${apiBase}/users/@me/guilds`, {
      headers: { Authorization: `Bot ${token}` },
    });

    if (guildsResponse.ok) {
      const guilds = (await guildsResponse.json()) as Array<{
        id: string;
        name: string;
        permissions: string;
      }>;

      if (guilds.length === 0) {
        warnings.push({
          severity: 'warning',
          code: 'no_guilds',
          message:
            'This bot is not a member of any Discord servers. ' +
            'Invite the bot to a server using the OAuth2 URL from the Discord Developer Portal ' +
            '(Applications > OAuth2 > URL Generator — select "bot" scope with required permissions).',
        });
      } else {
        // Check permissions in each guild
        const permissionWarnings = checkGuildPermissions(guilds);
        warnings.push(...permissionWarnings);
      }
    }
    // If guilds call fails, we skip silently -- it is non-critical
  } catch {
    // Network error on guild check -- skip silently
  }

  return warnings;
}
