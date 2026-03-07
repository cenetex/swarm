/**
 * Room Key Utilities
 *
 * Generates and parses deterministic room keys for shared channels
 * across platforms.
 *
 * Format:
 *   telegram:<chatId>
 *   discord:<guildId>:<channelId>
 *   shared-chat:<channelId>
 *   <platform>:<channelId>        (fallback for other platforms)
 */
import type { Platform } from '../types/platform.js';

// =============================================================================
// TYPES
// =============================================================================

export interface ParsedRoomKey {
  platform: Platform;
  channelId: string;
  guildId?: string;
}

// =============================================================================
// GENERATION
// =============================================================================

/**
 * Build a canonical room key from platform identifiers.
 *
 * @param platform  - The platform enum value
 * @param channelId - Chat / channel identifier
 * @param guildId   - Discord guild (server) ID; ignored for non-Discord platforms
 */
export function generateRoomKey(
  platform: Platform,
  channelId: string,
  guildId?: string,
): string {
  if (!channelId) {
    throw new Error('channelId is required for room key generation');
  }

  switch (platform) {
    case 'telegram':
      return `telegram:${channelId}`;
    case 'discord':
      if (!guildId) {
        throw new Error('guildId is required for Discord room keys');
      }
      return `discord:${guildId}:${channelId}`;
    case 'shared-chat':
      return `shared-chat:${channelId}`;
    default:
      return `${platform}:${channelId}`;
  }
}

// =============================================================================
// PARSING
// =============================================================================

/**
 * Parse a room key back into its constituent parts.
 *
 * @throws Error if the key format is invalid
 */
export function parseRoomKey(key: string): ParsedRoomKey {
  if (!key) {
    throw new Error('Room key cannot be empty');
  }

  const parts = key.split(':');
  if (parts.length < 2) {
    throw new Error(`Invalid room key format: "${key}"`);
  }

  const platform = parts[0] as Platform;

  if (platform === 'discord') {
    if (parts.length < 3) {
      throw new Error(`Discord room key requires guildId: "${key}"`);
    }
    return {
      platform,
      guildId: parts[1],
      channelId: parts[2],
    };
  }

  return {
    platform,
    channelId: parts.slice(1).join(':'),
  };
}
