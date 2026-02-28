/**
 * MCP Adapter Helpers
 *
 * Shared utility functions used by MCP service modules.
 */
import type { ServiceContainer } from '../service-container.js';

/** Timeout for external API calls */
export const API_TIMEOUT_MS = 10_000;

/**
 * Get bot token from secrets for a given avatar
 */
export function getBotToken(svc: ServiceContainer, avatarId: string): Promise<string> {
  return svc.secrets._getSecretValueInternal(avatarId, 'telegram_bot_token', 'default').then(
    (botToken) => {
      if (!botToken) {
        throw new Error('No Telegram bot token configured');
      }
      return botToken;
    }
  );
}

/**
 * Fetch with timeout using AbortController
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}
