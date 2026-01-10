/**
 * Telegram Service
 * Handles Telegram API interactions for webhook registration
 *
 * Security: Uses secret_token for webhook verification as recommended by Telegram
 * https://core.telegram.org/bots/api#setwebhook
 */
import { randomBytes } from 'crypto';

const API_DOMAIN = process.env.API_DOMAIN || 'api-staging.rati.chat';

// Telegram webhook IP ranges (for additional verification)
// https://core.telegram.org/bots/webhooks#the-short-version
export const TELEGRAM_IP_RANGES = [
  '149.154.160.0/20',  // 149.154.160.0 - 149.154.175.255
  '91.108.4.0/22',     // 91.108.4.0 - 91.108.7.255
];

/**
 * Generate a cryptographically secure webhook secret token
 * Telegram accepts 1-256 characters, A-Za-z0-9_-
 */
export function generateWebhookSecret(): string {
  // Generate 32 bytes = 256 bits of entropy, encode as base64url
  return randomBytes(32).toString('base64url');
}

/**
 * Check if an IP is in Telegram's webhook IP ranges
 */
export function isValidTelegramIP(ip: string): boolean {
  // Parse IP to number for range checking
  const ipParts = ip.split('.').map(Number);
  if (ipParts.length !== 4 || ipParts.some(p => isNaN(p) || p < 0 || p > 255)) {
    return false;
  }

  const ipNum = (ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3];

  // Check against Telegram ranges
  // 149.154.160.0/20 = 149.154.160.0 - 149.154.175.255
  const range1Start = (149 << 24) | (154 << 16) | (160 << 8) | 0;
  const range1End = (149 << 24) | (154 << 16) | (175 << 8) | 255;

  // 91.108.4.0/22 = 91.108.4.0 - 91.108.7.255
  const range2Start = (91 << 24) | (108 << 16) | (4 << 8) | 0;
  const range2End = (91 << 24) | (108 << 16) | (7 << 8) | 255;

  return (ipNum >= range1Start && ipNum <= range1End) ||
         (ipNum >= range2Start && ipNum <= range2End);
}

/**
 * Register a webhook with Telegram
 * Returns the secret token that must be stored and used for verification
 */
export async function registerTelegramWebhook(
  botToken: string,
  agentId: string,
  secretToken?: string
): Promise<{ success: boolean; message: string; webhookUrl?: string; secretToken?: string }> {
  const webhookUrl = `https://${API_DOMAIN}/webhook/telegram/${agentId}`;

  // Generate secret token if not provided
  const webhookSecret = secretToken || generateWebhookSecret();

  const url = `https://api.telegram.org/bot${botToken}/setWebhook`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: webhookSecret,  // Telegram will send this in X-Telegram-Bot-Api-Secret-Token header
      allowed_updates: ['message', 'edited_message', 'callback_query'],
      drop_pending_updates: true,
      max_connections: 40,  // Default, can be tuned
    }),
  });

  const result = await response.json() as { ok: boolean; description?: string };

  if (!result.ok) {
    console.error('Failed to register webhook:', result);
    return {
      success: false,
      message: result.description || 'Failed to register webhook',
    };
  }

  console.log(`Registered Telegram webhook for agent ${agentId}: ${webhookUrl}`);

  return {
    success: true,
    message: 'Webhook registered successfully',
    webhookUrl,
    secretToken: webhookSecret,  // Caller must store this securely
  };
}

/**
 * Get webhook info from Telegram
 */
export async function getTelegramWebhookInfo(
  botToken: string
): Promise<{ url?: string; pending_update_count?: number }> {
  const url = `https://api.telegram.org/bot${botToken}/getWebhookInfo`;
  
  const response = await fetch(url);
  const result = await response.json() as { 
    ok: boolean; 
    result?: { url?: string; pending_update_count?: number } 
  };

  return result.result || {};
}

/**
 * Delete webhook (for cleanup)
 */
export async function deleteTelegramWebhook(
  botToken: string
): Promise<boolean> {
  const url = `https://api.telegram.org/bot${botToken}/deleteWebhook`;
  
  const response = await fetch(url, { method: 'POST' });
  const result = await response.json() as { ok: boolean };

  return result.ok;
}

/**
 * Validate a bot token by calling getMe
 */
export async function validateTelegramToken(
  botToken: string
): Promise<{ 
  valid: boolean; 
  error?: string;
  botInfo?: { username?: string; firstName?: string };
}> {
  try {
    const url = `https://api.telegram.org/bot${botToken}/getMe`;
    const response = await fetch(url);
    const result = await response.json() as { 
      ok: boolean; 
      description?: string;
      result?: { username?: string; first_name?: string } 
    };

    if (!result.ok || !result.result) {
      return { valid: false, error: result.description || 'Invalid token' };
    }

    return {
      valid: true,
      botInfo: {
        username: result.result.username,
        firstName: result.result.first_name,
      }
    };
  } catch (err) {
    return { valid: false, error: String(err) };
  }
}
