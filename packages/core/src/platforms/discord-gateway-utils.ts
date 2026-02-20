/**
 * Discord Gateway Utilities
 *
 * Provides:
 * - Intent validation with operator-facing diagnostics
 * - Gateway close code interpretation for runbook-grade logging
 * - Reconnect strategy helpers
 *
 * @see https://discord.com/developers/docs/topics/opcodes-and-status-codes#gateway-close-event-codes
 * @see https://discord.com/developers/docs/topics/gateway#gateway-intents
 */
import { logger } from '../utils/logger.js';

// ─── Discord Gateway Intents ──────────────────────────────────────────────────

/** Discord gateway intent bit flags */
export const DiscordIntent = {
  GUILDS:                    1 << 0,
  GUILD_MEMBERS:             1 << 1,
  GUILD_MODERATION:          1 << 2,
  GUILD_EXPRESSIONS:         1 << 3,
  GUILD_INTEGRATIONS:        1 << 4,
  GUILD_WEBHOOKS:            1 << 5,
  GUILD_INVITES:             1 << 6,
  GUILD_VOICE_STATES:        1 << 7,
  GUILD_PRESENCES:           1 << 8,
  GUILD_MESSAGES:            1 << 9,
  GUILD_MESSAGE_REACTIONS:   1 << 10,
  GUILD_MESSAGE_TYPING:      1 << 11,
  DIRECT_MESSAGES:           1 << 12,
  DIRECT_MESSAGE_REACTIONS:  1 << 13,
  DIRECT_MESSAGE_TYPING:     1 << 14,
  MESSAGE_CONTENT:           1 << 15,
  GUILD_SCHEDULED_EVENTS:    1 << 16,
  AUTO_MODERATION_CONFIG:    1 << 20,
  AUTO_MODERATION_EXECUTION: 1 << 21,
} as const;

/** Human-readable names for intent bits */
const INTENT_NAMES: Record<number, string> = {
  [DiscordIntent.GUILDS]:                    'GUILDS',
  [DiscordIntent.GUILD_MEMBERS]:             'GUILD_MEMBERS (privileged)',
  [DiscordIntent.GUILD_MODERATION]:          'GUILD_MODERATION',
  [DiscordIntent.GUILD_EXPRESSIONS]:         'GUILD_EXPRESSIONS',
  [DiscordIntent.GUILD_INTEGRATIONS]:        'GUILD_INTEGRATIONS',
  [DiscordIntent.GUILD_WEBHOOKS]:            'GUILD_WEBHOOKS',
  [DiscordIntent.GUILD_INVITES]:             'GUILD_INVITES',
  [DiscordIntent.GUILD_VOICE_STATES]:        'GUILD_VOICE_STATES',
  [DiscordIntent.GUILD_PRESENCES]:           'GUILD_PRESENCES (privileged)',
  [DiscordIntent.GUILD_MESSAGES]:            'GUILD_MESSAGES',
  [DiscordIntent.GUILD_MESSAGE_REACTIONS]:   'GUILD_MESSAGE_REACTIONS',
  [DiscordIntent.GUILD_MESSAGE_TYPING]:      'GUILD_MESSAGE_TYPING',
  [DiscordIntent.DIRECT_MESSAGES]:           'DIRECT_MESSAGES',
  [DiscordIntent.DIRECT_MESSAGE_REACTIONS]:  'DIRECT_MESSAGE_REACTIONS',
  [DiscordIntent.DIRECT_MESSAGE_TYPING]:     'DIRECT_MESSAGE_TYPING',
  [DiscordIntent.MESSAGE_CONTENT]:           'MESSAGE_CONTENT (privileged)',
  [DiscordIntent.GUILD_SCHEDULED_EVENTS]:    'GUILD_SCHEDULED_EVENTS',
  [DiscordIntent.AUTO_MODERATION_CONFIG]:    'AUTO_MODERATION_CONFIG',
  [DiscordIntent.AUTO_MODERATION_EXECUTION]: 'AUTO_MODERATION_EXECUTION',
};

/** Intents required for basic message bot functionality */
export const REQUIRED_BOT_INTENTS = [
  DiscordIntent.GUILDS,
  DiscordIntent.GUILD_MESSAGES,
  DiscordIntent.MESSAGE_CONTENT,
] as const;

/** Recommended intents for full bot functionality */
export const RECOMMENDED_BOT_INTENTS = [
  ...REQUIRED_BOT_INTENTS,
  DiscordIntent.DIRECT_MESSAGES,
] as const;

/** Result of intent validation */
export interface IntentValidationResult {
  /** Whether all required intents are present */
  valid: boolean;
  /** Missing required intents */
  missingRequired: string[];
  /** Missing recommended (but not required) intents */
  missingRecommended: string[];
  /** All intents that are enabled */
  enabledIntents: string[];
  /** Operator-facing diagnostic messages */
  diagnostics: string[];
}

/**
 * Validate that the given intent bitmask includes all required intents
 * for bot operation. Returns diagnostic messages suitable for operator logging.
 */
export function validateIntents(intents: number): IntentValidationResult {
  const missingRequired: string[] = [];
  const missingRecommended: string[] = [];
  const enabledIntents: string[] = [];
  const diagnostics: string[] = [];

  // Check all known intents to build enabled list
  for (const [bit, name] of Object.entries(INTENT_NAMES)) {
    const bitNum = parseInt(bit, 10);
    if ((intents & bitNum) === bitNum) {
      enabledIntents.push(name);
    }
  }

  // Check required intents
  for (const requiredBit of REQUIRED_BOT_INTENTS) {
    if ((intents & requiredBit) !== requiredBit) {
      const name = INTENT_NAMES[requiredBit] ?? `UNKNOWN(${requiredBit})`;
      missingRequired.push(name);
    }
  }

  // Check recommended intents (only those not in required)
  const requiredSet = new Set(REQUIRED_BOT_INTENTS as readonly number[]);
  for (const recommendedBit of RECOMMENDED_BOT_INTENTS) {
    if (requiredSet.has(recommendedBit)) continue;
    if ((intents & recommendedBit) !== recommendedBit) {
      const name = INTENT_NAMES[recommendedBit] ?? `UNKNOWN(${recommendedBit})`;
      missingRecommended.push(name);
    }
  }

  // Build diagnostics
  if (missingRequired.length > 0) {
    diagnostics.push(
      `[CRITICAL] Missing required Discord gateway intents: ${missingRequired.join(', ')}`,
      'The bot will not receive messages without these intents.',
      'REMEDIATION: Go to https://discord.com/developers/applications/<app-id>/bot',
      '  1. Under "Privileged Gateway Intents", enable MESSAGE CONTENT INTENT',
      '  2. Update the bot\'s intent bitmask in the avatar config to include all required intents',
      `  Required bitmask: ${computeIntentBitmask(REQUIRED_BOT_INTENTS)} (decimal)`,
    );
  }

  if (missingRecommended.length > 0) {
    diagnostics.push(
      `[WARNING] Missing recommended Discord gateway intents: ${missingRecommended.join(', ')}`,
      'The bot may not function fully without these intents (e.g., no DM support).',
    );
  }

  if (missingRequired.length === 0 && missingRecommended.length === 0) {
    diagnostics.push('All required and recommended Discord gateway intents are present.');
  }

  return {
    valid: missingRequired.length === 0,
    missingRequired,
    missingRecommended,
    enabledIntents,
    diagnostics,
  };
}

/**
 * Log intent validation results with appropriate severity.
 */
export function logIntentValidation(intents: number): IntentValidationResult {
  const result = validateIntents(intents);

  if (!result.valid) {
    logger.error('Discord gateway intent validation FAILED', undefined, {
      event: 'discord_intent_validation_failed',
      subsystem: 'discord',
      missingRequired: result.missingRequired,
      missingRecommended: result.missingRecommended,
      enabledIntents: result.enabledIntents,
      diagnostics: result.diagnostics,
    });
  } else if (result.missingRecommended.length > 0) {
    logger.warn('Discord gateway intents partially configured', {
      event: 'discord_intent_validation_warning',
      subsystem: 'discord',
      missingRecommended: result.missingRecommended,
      enabledIntents: result.enabledIntents,
      diagnostics: result.diagnostics,
    });
  } else {
    logger.info('Discord gateway intents validated', {
      event: 'discord_intent_validation_ok',
      subsystem: 'discord',
      enabledIntents: result.enabledIntents,
    });
  }

  return result;
}

// ─── Gateway Close Code Interpretation ─────────────────────────────────────────

/** Discord gateway close event code meaning */
export interface CloseCodeInfo {
  /** Close code number */
  code: number;
  /** Short description */
  description: string;
  /** Whether reconnection should be attempted */
  reconnectable: boolean;
  /** Severity level for logging */
  severity: 'info' | 'warn' | 'error';
  /** Operator-facing remediation guidance */
  remediation: string;
}

/**
 * Map of Discord gateway close codes to their meanings and recommended actions.
 * @see https://discord.com/developers/docs/topics/opcodes-and-status-codes#gateway-close-event-codes
 */
const CLOSE_CODE_MAP: Record<number, Omit<CloseCodeInfo, 'code'>> = {
  1000: {
    description: 'Normal closure',
    reconnectable: true,
    severity: 'info',
    remediation: 'Normal shutdown. Reconnect if needed.',
  },
  1001: {
    description: 'Going away',
    reconnectable: true,
    severity: 'info',
    remediation: 'Server is going away (e.g., restart). Will reconnect automatically.',
  },
  1006: {
    description: 'Abnormal closure (no close frame)',
    reconnectable: true,
    severity: 'warn',
    remediation: 'Connection dropped without close frame. Check network stability. Will retry.',
  },
  4000: {
    description: 'Unknown error',
    reconnectable: true,
    severity: 'warn',
    remediation: 'Unknown Discord error. Will retry with fresh connection.',
  },
  4001: {
    description: 'Unknown opcode',
    reconnectable: true,
    severity: 'warn',
    remediation: 'Sent an invalid opcode. Check client implementation. Will retry.',
  },
  4002: {
    description: 'Decode error',
    reconnectable: true,
    severity: 'warn',
    remediation: 'Sent an invalid payload. Check JSON encoding. Will retry.',
  },
  4003: {
    description: 'Not authenticated',
    reconnectable: true,
    severity: 'error',
    remediation: 'Sent payload before identifying. This is a client bug. Will retry with fresh identify.',
  },
  4004: {
    description: 'Authentication failed',
    reconnectable: false,
    severity: 'error',
    remediation: 'INVALID BOT TOKEN. Go to https://discord.com/developers/applications/<app-id>/bot and regenerate the token. Update the token in Secrets Manager.',
  },
  4005: {
    description: 'Already authenticated',
    reconnectable: true,
    severity: 'warn',
    remediation: 'Sent identify twice. This is a client bug. Will retry with fresh connection.',
  },
  4007: {
    description: 'Invalid sequence',
    reconnectable: true,
    severity: 'warn',
    remediation: 'Invalid resume sequence. Will reconnect with fresh session.',
  },
  4008: {
    description: 'Rate limited',
    reconnectable: true,
    severity: 'warn',
    remediation: 'Sending payloads too quickly. Will reconnect with backoff.',
  },
  4009: {
    description: 'Session timed out',
    reconnectable: true,
    severity: 'info',
    remediation: 'Session expired. Will reconnect with fresh identify.',
  },
  4010: {
    description: 'Invalid shard',
    reconnectable: false,
    severity: 'error',
    remediation: 'Invalid shard configuration. Check shard count and ID.',
  },
  4011: {
    description: 'Sharding required',
    reconnectable: false,
    severity: 'error',
    remediation: 'Bot is in too many guilds. Enable sharding in the gateway configuration.',
  },
  4012: {
    description: 'Invalid API version',
    reconnectable: false,
    severity: 'error',
    remediation: 'Using an invalid API version. Update the gateway URL to use a supported version.',
  },
  4013: {
    description: 'Invalid intents',
    reconnectable: false,
    severity: 'error',
    remediation: 'Invalid intent value. Check that the intent bitmask only contains valid intent bits.',
  },
  4014: {
    description: 'Disallowed intents',
    reconnectable: false,
    severity: 'error',
    remediation: 'PRIVILEGED INTENT NOT ENABLED. Go to https://discord.com/developers/applications/<app-id>/bot and enable the required privileged intents (MESSAGE CONTENT, GUILD MEMBERS, PRESENCE). If the bot is in >100 guilds, these intents require Discord approval.',
  },
};

/**
 * Interpret a Discord gateway close code and return structured information
 * for logging and error handling.
 */
export function interpretCloseCode(code: number): CloseCodeInfo {
  const known = CLOSE_CODE_MAP[code];
  if (known) {
    return { code, ...known };
  }

  // Unknown close code
  return {
    code,
    description: `Unknown close code (${code})`,
    reconnectable: code < 4000, // Standard WebSocket codes are generally reconnectable
    severity: 'warn',
    remediation: `Received unknown close code ${code}. Check Discord API documentation for updates.`,
  };
}

/**
 * Log a gateway close event with structured diagnostics.
 */
export function logGatewayClose(
  code: number,
  reason: string,
  context?: {
    reconnectAttempt?: number;
    sessionId?: string;
    botUserId?: string;
    avatarCount?: number;
  }
): CloseCodeInfo {
  const info = interpretCloseCode(code);

  const logData = {
    event: 'discord_gateway_close',
    subsystem: 'discord',
    closeCode: code,
    closeDescription: info.description,
    closeReason: reason,
    reconnectable: info.reconnectable,
    remediation: info.remediation,
    ...context,
  };

  switch (info.severity) {
    case 'error':
      logger.error(`Discord gateway closed: ${info.description}`, undefined, logData);
      break;
    case 'warn':
      logger.warn(`Discord gateway closed: ${info.description}`, logData);
      break;
    case 'info':
      logger.info(`Discord gateway closed: ${info.description}`, logData);
      break;
  }

  return info;
}

/**
 * Compute the recommended reconnect delay based on close code and attempt count.
 * Non-reconnectable codes return -1.
 */
export function computeReconnectDelay(
  closeCode: number,
  attempt: number,
  options?: { baseDelayMs?: number; maxDelayMs?: number }
): number {
  const info = interpretCloseCode(closeCode);
  if (!info.reconnectable) {
    return -1;
  }

  const baseDelay = options?.baseDelayMs ?? 1_000;
  const maxDelay = options?.maxDelayMs ?? 30_000;

  // Exponential backoff: base * 2^attempt, capped at maxDelay
  const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);

  // Add jitter (up to 30% of delay)
  const jitter = delay * 0.3 * Math.random();

  return Math.round(delay + jitter);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function computeIntentBitmask(intents: readonly number[]): number {
  let mask = 0;
  for (const intent of intents) {
    mask |= intent;
  }
  return mask;
}
