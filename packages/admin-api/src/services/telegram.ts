/* eslint-disable no-console -- TODO: migrate to structured logger */
/**
 * Telegram Service
 * Handles Telegram API interactions for webhook registration
 *
 * Security: Uses secret_token for webhook verification as recommended by Telegram
 * https://core.telegram.org/bots/api#setwebhook
 */
import { randomBytes } from 'crypto';

function defaultDomainForEnv(env: string): string {
  const normalized = env.trim().toLowerCase();
  if (normalized === 'prod' || normalized === 'production') return 'swarm.rati.chat';
  if (normalized === 'staging') return 'staging-swarm.rati.chat';
  // For dev/local, callers should set API_DOMAIN/WEBHOOK_DOMAIN explicitly.
  return 'localhost';
}

const runtimeEnv = process.env.NODE_ENV?.trim()
  || process.env.ENVIRONMENT?.trim()
  || '';

const API_DOMAIN = process.env.API_DOMAIN?.trim() || defaultDomainForEnv(runtimeEnv);
const WEBHOOK_DOMAIN = process.env.TELEGRAM_WEBHOOK_DOMAIN?.trim()
  || process.env.WEBHOOK_DOMAIN?.trim()
  || API_DOMAIN;

// If WEBHOOK_DOMAIN ends up being a raw API Gateway host, the webhook will bypass CloudFront.
// That can make domain cutovers confusing (bots won't follow the CloudFront CNAME).
if (/execute-api\.[^.]+\.amazonaws\.com$/i.test(WEBHOOK_DOMAIN)) {
  console.warn('[telegram] WEBHOOK_DOMAIN is an API Gateway host; consider setting TELEGRAM_WEBHOOK_DOMAIN to your CloudFront domain', {
    WEBHOOK_DOMAIN,
    API_DOMAIN,
  });
}

export function getTelegramWebhookUrlForAvatar(avatarId: string): string {
  return `https://${WEBHOOK_DOMAIN}/webhook/telegram/${avatarId}`;
}

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
  avatarId: string,
  secretToken?: string
): Promise<{
  success: boolean;
  message: string;
  webhookUrl?: string;
  secretToken?: string;
  webhookInfo?: { url?: string; pending_update_count?: number };
  reRegistered?: boolean;
}> {
  const webhookUrl = getTelegramWebhookUrlForAvatar(avatarId);

  // Generate secret token if not provided
  const webhookSecret = secretToken || generateWebhookSecret();

  const url = `https://api.telegram.org/bot${botToken}/setWebhook`;

  const register = async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: webhookSecret,  // Telegram will send this in X-Telegram-Bot-Api-Secret-Token header
        // Include my_chat_member so we can detect when the bot is added/removed
        // and auto-register home channels from webhook events.
        allowed_updates: [
          'message',
          'edited_message',
          'channel_post',
          'edited_channel_post',
          'callback_query',
          'my_chat_member',
        ],
        drop_pending_updates: true,
        max_connections: 40,  // Default, can be tuned
      }),
    });

    return await response.json() as { ok: boolean; description?: string };
  };

  const result = await register();

  if (!result.ok) {
    console.error('Failed to register webhook:', result);
    return {
      success: false,
      message: result.description || 'Failed to register webhook',
    };
  }

  console.log(`Registered Telegram webhook for avatar ${avatarId}: ${webhookUrl}`);

  let webhookInfo: { url?: string; pending_update_count?: number } | undefined;
  let reRegistered = false;
  try {
    webhookInfo = await getTelegramWebhookInfo(botToken);
    if (webhookInfo.url && webhookInfo.url !== webhookUrl) {
      console.warn('Webhook URL mismatch after registration', {
        avatarId,
        expected: webhookUrl,
        actual: webhookInfo.url,
      });
      const retry = await register();
      if (retry.ok) {
        reRegistered = true;
        webhookInfo = await getTelegramWebhookInfo(botToken);
      } else {
        console.warn('Webhook re-registration failed', { avatarId, error: retry.description });
      }
    }

    if (webhookInfo.pending_update_count && webhookInfo.pending_update_count > 0) {
      console.warn('Telegram webhook has pending updates', {
        avatarId,
        pendingUpdateCount: webhookInfo.pending_update_count,
      });
    }
  } catch (error) {
    console.warn('Failed to fetch Telegram webhook info', {
      avatarId,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }

  return {
    success: true,
    message: 'Webhook registered successfully',
    webhookUrl,
    secretToken: webhookSecret,  // Caller must store this securely
    webhookInfo,
    reRegistered,
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

export interface TelegramWebhookInfoDetailed {
  url?: string;
  has_custom_certificate?: boolean;
  pending_update_count?: number;
  ip_address?: string;
  last_error_date?: number;
  last_error_message?: string;
  last_synchronization_error_date?: number;
  max_connections?: number;
  allowed_updates?: string[];
}

export async function getTelegramWebhookInfoDetailed(
  botToken: string
): Promise<TelegramWebhookInfoDetailed> {
  const url = `https://api.telegram.org/bot${botToken}/getWebhookInfo`;

  const response = await fetch(url);
  const result = await response.json() as {
    ok: boolean;
    result?: TelegramWebhookInfoDetailed;
    description?: string;
  };

  if (!result.ok) {
    throw new Error(result.description || 'Failed to fetch Telegram webhook info');
  }

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
  botInfo?: { id?: number; username?: string; firstName?: string };
}> {
  try {
    const url = `https://api.telegram.org/bot${botToken}/getMe`;
    const response = await fetch(url);
    const result = await response.json() as { 
      ok: boolean; 
      description?: string;
      result?: { id?: number; username?: string; first_name?: string } 
    };

    if (!result.ok || !result.result) {
      return { valid: false, error: result.description || 'Invalid token' };
    }

    return {
      valid: true,
      botInfo: {
        id: result.result.id,
        username: result.result.username,
        firstName: result.result.first_name,
      }
    };
  } catch (err) {
    return { valid: false, error: String(err) };
  }
}

// ============================================================================
// User Profile Photos
// ============================================================================

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

/**
 * Get a user's profile photos
 */
export async function getUserProfilePhotos(
  botToken: string,
  userId: number,
  options?: { offset?: number; limit?: number }
): Promise<{
  ok: boolean;
  totalCount: number;
  photos: TelegramPhotoSize[][];
}> {
  const url = `https://api.telegram.org/bot${botToken}/getUserProfilePhotos`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_id: userId,
      offset: options?.offset || 0,
      limit: Math.min(options?.limit || 10, 100),
    }),
  });
  
  const result = await response.json() as {
    ok: boolean;
    result?: {
      total_count: number;
      photos: TelegramPhotoSize[][];
    };
    description?: string;
  };
  
  if (!result.ok || !result.result) {
    throw new Error(result.description || 'Failed to get profile photos');
  }
  
  return {
    ok: true,
    totalCount: result.result.total_count,
    photos: result.result.photos,
  };
}

/**
 * Get a file download URL from Telegram
 */
export async function getFileUrl(
  botToken: string,
  fileId: string
): Promise<string> {
  const url = `https://api.telegram.org/bot${botToken}/getFile`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file_id: fileId }),
  });
  
  const result = await response.json() as {
    ok: boolean;
    result?: { file_path: string };
    description?: string;
  };
  
  if (!result.ok || !result.result?.file_path) {
    throw new Error(result.description || 'Failed to get file');
  }
  
  return `https://api.telegram.org/file/bot${botToken}/${result.result.file_path}`;
}

// ============================================================================
// Bot Profile Management
// ============================================================================

/**
 * Get the bot's current name
 */
export async function getBotName(
  botToken: string,
  languageCode?: string
): Promise<{ name: string }> {
  const url = `https://api.telegram.org/bot${botToken}/getMyName`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ language_code: languageCode }),
  });
  
  const result = await response.json() as {
    ok: boolean;
    result?: { name: string };
    description?: string;
  };
  
  if (!result.ok || !result.result) {
    throw new Error(result.description || 'Failed to get bot name');
  }
  
  return { name: result.result.name };
}

/**
 * Set the bot's name
 */
export async function setBotName(
  botToken: string,
  name: string,
  languageCode?: string
): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/setMyName`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: name || '',
      language_code: languageCode,
    }),
  });
  
  const result = await response.json() as { ok: boolean; description?: string };
  
  if (!result.ok) {
    throw new Error(result.description || 'Failed to set bot name');
  }
}

/**
 * Get the bot's description
 */
export async function getBotDescription(
  botToken: string,
  languageCode?: string
): Promise<{ description: string }> {
  const url = `https://api.telegram.org/bot${botToken}/getMyDescription`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ language_code: languageCode }),
  });
  
  const result = await response.json() as {
    ok: boolean;
    result?: { description: string };
    description?: string;
  };
  
  if (!result.ok || !result.result) {
    throw new Error(result.description || 'Failed to get bot description');
  }
  
  return { description: result.result.description };
}

/**
 * Set the bot's description
 */
export async function setBotDescription(
  botToken: string,
  description: string,
  languageCode?: string
): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/setMyDescription`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      description: description || '',
      language_code: languageCode,
    }),
  });
  
  const result = await response.json() as { ok: boolean; description?: string };
  
  if (!result.ok) {
    throw new Error(result.description || 'Failed to set bot description');
  }
}

/**
 * Get the bot's short description
 */
export async function getBotShortDescription(
  botToken: string,
  languageCode?: string
): Promise<{ shortDescription: string }> {
  const url = `https://api.telegram.org/bot${botToken}/getMyShortDescription`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ language_code: languageCode }),
  });
  
  const result = await response.json() as {
    ok: boolean;
    result?: { short_description: string };
    description?: string;
  };
  
  if (!result.ok || !result.result) {
    throw new Error(result.description || 'Failed to get bot short description');
  }
  
  return { shortDescription: result.result.short_description };
}

/**
 * Set the bot's short description
 */
export async function setBotShortDescription(
  botToken: string,
  shortDescription: string,
  languageCode?: string
): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/setMyShortDescription`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      short_description: shortDescription || '',
      language_code: languageCode,
    }),
  });
  
  const result = await response.json() as { ok: boolean; description?: string };
  
  if (!result.ok) {
    throw new Error(result.description || 'Failed to set bot short description');
  }
}

// ============================================================================
// Chat Actions
// ============================================================================

export type ChatAction = 
  | 'typing' | 'upload_photo' | 'record_video' | 'upload_video'
  | 'record_voice' | 'upload_voice' | 'upload_document' | 'choose_sticker'
  | 'find_location' | 'record_video_note' | 'upload_video_note';

/**
 * Send a chat action (typing indicator, etc.)
 */
export async function sendChatAction(
  botToken: string,
  chatId: number,
  action: ChatAction
): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/sendChatAction`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      action,
    }),
  });
  
  const result = await response.json() as { ok: boolean; description?: string };
  
  if (!result.ok) {
    throw new Error(result.description || 'Failed to send chat action');
  }
}

// ============================================================================
// Messaging
// ============================================================================

export interface SendMessageOptions {
  replyToMessageId?: number;
  disableWebPagePreview?: boolean;
}

export interface SendMessageResult {
  messageId: number;
}

/**
 * Send a text message.
 */
export async function sendMessage(
  botToken: string,
  chatId: number,
  text: string,
  options?: SendMessageOptions
): Promise<SendMessageResult> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      ...(typeof options?.replyToMessageId === 'number'
        ? { reply_to_message_id: options.replyToMessageId }
        : {}),
      ...(typeof options?.disableWebPagePreview === 'boolean'
        ? { disable_web_page_preview: options.disableWebPagePreview }
        : {}),
    }),
  });

  const result = await response.json() as {
    ok: boolean;
    result?: { message_id: number };
    description?: string;
  };

  if (!result.ok || !result.result) {
    throw new Error(result.description || 'Failed to send message');
  }

  return { messageId: result.result.message_id };
}

/**
 * React to a specific message with an emoji.
 */
export async function setMessageReaction(
  botToken: string,
  chatId: number,
  messageId: number,
  emoji: string
): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/setMessageReaction`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: 'emoji', emoji }],
    }),
  });

  const result = await response.json() as { ok: boolean; description?: string };

  if (!result.ok) {
    throw new Error(result.description || 'Failed to set message reaction');
  }
}

// ============================================================================
// Chat Modification (for voting system)
// ============================================================================

/**
 * Set chat photo (requires bot to be admin with can_change_info)
 */
export async function setChatPhoto(
  botToken: string,
  chatId: number,
  photoUrl: string
): Promise<void> {
  // First, we need to download the photo and upload it
  // Telegram requires multipart/form-data for photo uploads
  const photoResponse = await fetch(photoUrl);
  const photoBlob = await photoResponse.blob();
  
  const formData = new FormData();
  formData.append('chat_id', chatId.toString());
  formData.append('photo', photoBlob, 'photo.jpg');
  
  const url = `https://api.telegram.org/bot${botToken}/setChatPhoto`;
  
  const response = await fetch(url, {
    method: 'POST',
    body: formData,
  });
  
  const result = await response.json() as { ok: boolean; description?: string };
  
  if (!result.ok) {
    throw new Error(result.description || 'Failed to set chat photo');
  }
}

/**
 * Set chat description (requires bot to be admin with can_change_info)
 */
export async function setChatDescription(
  botToken: string,
  chatId: number,
  description: string
): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/setChatDescription`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      description: description || '',
    }),
  });
  
  const result = await response.json() as { ok: boolean; description?: string };
  
  if (!result.ok) {
    throw new Error(result.description || 'Failed to set chat description');
  }
}

/**
 * Set chat title (requires bot to be admin with can_change_info)
 */
export async function setChatTitle(
  botToken: string,
  chatId: number,
  title: string
): Promise<void> {
  const url = `https://api.telegram.org/bot${botToken}/setChatTitle`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      title,
    }),
  });
  
  const result = await response.json() as { ok: boolean; description?: string };
  
  if (!result.ok) {
    throw new Error(result.description || 'Failed to set chat title');
  }
}

/**
 * Get chat info by chat ID (numeric) or @username
 */
export async function getChat(
  botToken: string,
  chatId: number | string
): Promise<{
  id: number;
  type: string;
  title?: string;
  username?: string;
  description?: string;
  photo?: { small_file_id: string; big_file_id: string };
}> {
  const url = `https://api.telegram.org/bot${botToken}/getChat`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId }),
  });

  const result = await response.json() as {
    ok: boolean;
    result?: {
      id: number;
      type: string;
      title?: string;
      username?: string;
      description?: string;
      photo?: { small_file_id: string; big_file_id: string };
    };
    description?: string;
  };

  if (!result.ok || !result.result) {
    throw new Error(result.description || 'Failed to get chat');
  }

  return result.result;
}

/**
 * Resolve a @groupname to chat ID and title.
 * Works for public groups and channels that the bot has access to.
 *
 * @param botToken - Telegram bot token
 * @param username - Group username without @ prefix (e.g., "mycommunity")
 * @returns Chat info if found, null otherwise
 */
export async function resolveGroupUsername(
  botToken: string,
  username: string
): Promise<{ chatId: string; title: string; username?: string } | null> {
  try {
    // Telegram accepts @username format for getChat
    const normalizedUsername = username.startsWith('@') ? username : `@${username}`;
    const chat = await getChat(botToken, normalizedUsername);

    // Only allow groups, supergroups, and channels
    if (chat.type !== 'group' && chat.type !== 'supergroup' && chat.type !== 'channel') {
      return null;
    }

    return {
      chatId: String(chat.id),
      title: chat.title || username,
      username: chat.username,
    };
  } catch {
    // Group not found or bot doesn't have access
    return null;
  }
}
