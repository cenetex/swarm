/**
 * Response Sender Handler
 * Sends media (images/videos) back to Telegram after async generation completes
 * 
 * Triggered by SQS messages from the Replicate webhook handler
 */
import type { SQSEvent, SQSHandler, Context } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { logger } from '@swarm/core';

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const secretsClient = new SecretsManagerClient({});

const ADMIN_TABLE = process.env.ADMIN_TABLE!;

// Telegram API timeouts
const TELEGRAM_TIMEOUT_MS = 30000;
const TELEGRAM_RETRY_COUNT = 2;

// Secret cache (in-memory, per Lambda instance)
const secretCache = new Map<string, { value: string; expiresAt: number }>();
const SECRET_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

interface MediaCompleteMessage {
  type: 'image_complete' | 'video_complete' | 'sticker_complete';
  agentId: string;
  platform: string;
  conversationId: string;
  replyToMessageId?: string;
  result: {
    success: boolean;
    mediaUrl?: string;
    mediaType?: string;
    prompt?: string;
    error?: string;
  };
}

interface MediaFailedMessage {
  type: 'image_failed' | 'video_failed' | 'sticker_failed';
  agentId: string;
  platform: string;
  conversationId: string;
  replyToMessageId?: string;
  result: {
    success: false;
    error: string;
    prompt?: string;
  };
}

type ResponseMessage = MediaCompleteMessage | MediaFailedMessage;

/**
 * Get secret value with caching
 */
async function getSecret(secretArn: string): Promise<string | null> {
  const now = Date.now();
  const cached = secretCache.get(secretArn);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  try {
    const response = await secretsClient.send(new GetSecretValueCommand({
      SecretId: secretArn,
    }));
    const value = response.SecretString || '';
    secretCache.set(secretArn, { value, expiresAt: now + SECRET_CACHE_TTL });
    return value;
  } catch (error) {
    logger.error('Failed to get secret', error, { secretArn });
    return null;
  }
}

/**
 * Get Telegram bot token for an agent
 */
async function getTelegramToken(agentId: string): Promise<string | null> {
  const result = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: { pk: `AGENT#${agentId}`, sk: 'SECRET#telegram_bot_token#default' },
  }));
  if (!result.Item?.secretArn) return null;
  return getSecret(result.Item.secretArn);
}

/**
 * Fetch with timeout and retry
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  timeoutMs: number,
  maxRetries: number
): Promise<Response> {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      return response;
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxRetries) {
        // Exponential backoff
        await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }
  }
  
  throw lastError;
}

/**
 * Escape special characters for Telegram MarkdownV2
 */
function escapeTelegramMarkdownV2(text: string): string {
  // Characters that need escaping in MarkdownV2 (outside of code blocks)
  // eslint-disable-next-line no-useless-escape
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

/**
 * Send a photo to Telegram
 */
async function sendTelegramPhoto(
  token: string,
  chatId: string | number,
  photoUrl: string,
  caption?: string,
  replyTo?: number
): Promise<boolean> {
  logger.info('Sending photo to Telegram', { chatId, photoUrlPreview: photoUrl.slice(0, 80) });

  try {
    // Download the photo first, then send as buffer
    // This is more reliable for CDN URLs that might require specific headers
    const imageResponse = await fetchWithRetry(
      photoUrl,
      { method: 'GET' },
      TELEGRAM_TIMEOUT_MS,
      TELEGRAM_RETRY_COUNT
    );
    
    if (!imageResponse.ok) {
      logger.error('Failed to download image', undefined, { status: imageResponse.status });
      
      // Fall back to URL-based send (might work for public CDN URLs)
      const response = await fetchWithRetry(
        `https://api.telegram.org/bot${token}/sendPhoto`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            photo: photoUrl,
            caption: caption ? escapeTelegramMarkdownV2(caption.slice(0, 1024)) : undefined,
            parse_mode: 'MarkdownV2',
            reply_to_message_id: replyTo,
          }),
        },
        TELEGRAM_TIMEOUT_MS,
        TELEGRAM_RETRY_COUNT
      );
      
      if (!response.ok) {
        logger.error('sendPhoto (URL fallback) failed', undefined, { status: response.status });
        return false;
      }
      return true;
    }

    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
    logger.info('Downloaded image, sending as buffer', { byteCount: imageBuffer.length });

    // Use native FormData (Node.js 18+) with Blob
    const form = new FormData();
    form.append('chat_id', chatId.toString());
    form.append('photo', new Blob([imageBuffer], { type: 'image/png' }), 'image.png');
    if (caption) {
      form.append('caption', escapeTelegramMarkdownV2(caption.slice(0, 1024)));
      form.append('parse_mode', 'MarkdownV2');
    }
    if (replyTo) {
      form.append('reply_to_message_id', replyTo.toString());
    }

    const response = await fetchWithRetry(
      `https://api.telegram.org/bot${token}/sendPhoto`,
      {
        method: 'POST',
        body: form,
      },
      TELEGRAM_TIMEOUT_MS,
      TELEGRAM_RETRY_COUNT
    );

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('sendPhoto failed', undefined, { status: response.status, errorText });
      return false;
    }
    
    logger.info('Photo sent successfully', { chatId });
    return true;
  } catch (err) {
    logger.error('Error sending photo', err);
    return false;
  }
}

/**
 * Send a video to Telegram
 */
async function sendTelegramVideo(
  token: string,
  chatId: string | number,
  videoUrl: string,
  caption?: string,
  replyTo?: number
): Promise<boolean> {
  logger.info('Sending video to Telegram', { chatId, videoUrlPreview: videoUrl.slice(0, 80) });

  try {
    // Download the video first
    const videoResponse = await fetchWithRetry(
      videoUrl,
      { method: 'GET' },
      TELEGRAM_TIMEOUT_MS * 2, // Videos can be larger
      TELEGRAM_RETRY_COUNT
    );
    
    if (!videoResponse.ok) {
      logger.error('Failed to download video', undefined, { status: videoResponse.status });
      return false;
    }

    const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());
    logger.info('Downloaded video, sending as buffer', { byteCount: videoBuffer.length });

    // Use native FormData with Blob
    const form = new FormData();
    form.append('chat_id', chatId.toString());
    form.append('video', new Blob([videoBuffer], { type: 'video/mp4' }), 'video.mp4');
    if (caption) {
      form.append('caption', escapeTelegramMarkdownV2(caption.slice(0, 1024)));
      form.append('parse_mode', 'MarkdownV2');
    }
    if (replyTo) {
      form.append('reply_to_message_id', replyTo.toString());
    }

    const response = await fetchWithRetry(
      `https://api.telegram.org/bot${token}/sendVideo`,
      {
        method: 'POST',
        body: form,
      },
      TELEGRAM_TIMEOUT_MS * 2,
      TELEGRAM_RETRY_COUNT
    );

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('sendVideo failed', undefined, { status: response.status, errorText });
      return false;
    }
    
    logger.info('Video sent successfully', { chatId });
    return true;
  } catch (err) {
    logger.error('Error sending video', err);
    return false;
  }
}

/**
 * Send a text message to Telegram
 */
async function sendTelegramMessage(
  token: string,
  chatId: string | number,
  text: string,
  replyTo?: number
): Promise<boolean> {
  try {
    const response = await fetchWithRetry(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: escapeTelegramMarkdownV2(text),
          parse_mode: 'MarkdownV2',
          reply_to_message_id: replyTo,
        }),
      },
      TELEGRAM_TIMEOUT_MS,
      TELEGRAM_RETRY_COUNT
    );

    if (!response.ok) {
      logger.error('sendMessage failed', undefined, { status: response.status });
      return false;
    }
    
    return true;
  } catch (err) {
    logger.error('Error sending message', err);
    return false;
  }
}

/**
 * Process a single response message
 */
async function processMessage(message: ResponseMessage): Promise<void> {
  const { agentId, platform, conversationId, replyToMessageId, result } = message;
  
  logger.setContext({ agentId, platform, conversationId });
  logger.info('Processing response message', { type: message.type, success: result.success });

  // Only handle Telegram for now
  if (platform !== 'telegram') {
    logger.warn('Unsupported platform for response sender', { platform });
    return;
  }

  // Get bot token
  const token = await getTelegramToken(agentId);
  if (!token) {
    logger.error('No Telegram token found for agent', undefined, { agentId });
    return;
  }

  // Parse chat ID from conversationId (format: "telegram:{chatId}")
  const chatId = conversationId.replace('telegram:', '');
  const replyTo = replyToMessageId ? parseInt(replyToMessageId, 10) : undefined;

  if (message.type.includes('failed') || !result.success) {
    // Send error message
    const errorMessage = result.error || 'Media generation failed';
    await sendTelegramMessage(token, chatId, `❌ ${errorMessage}`, replyTo);
    return;
  }

  // Handle successful media
  if (!result.mediaUrl) {
    logger.error('No media URL in success response');
    return;
  }

  // Simple caption from prompt
  const caption = result.prompt 
    ? `🎨 ${result.prompt.slice(0, 200)}${result.prompt.length > 200 ? '...' : ''}`
    : undefined;

  if (message.type === 'image_complete' || result.mediaType === 'image') {
    await sendTelegramPhoto(token, chatId, result.mediaUrl, caption, replyTo);
  } else if (message.type === 'video_complete' || result.mediaType === 'video') {
    await sendTelegramVideo(token, chatId, result.mediaUrl, caption, replyTo);
  } else if (message.type === 'sticker_complete' || result.mediaType === 'sticker') {
    // Stickers are sent as photos for now
    await sendTelegramPhoto(token, chatId, result.mediaUrl, undefined, replyTo);
  } else {
    logger.warn('Unknown media type', { type: message.type, mediaType: result.mediaType });
  }
}

/**
 * Lambda handler for SQS-triggered response sending
 */
export const handler: SQSHandler = async (event: SQSEvent, context: Context) => {
  logger.setContext({
    subsystem: 'response-sender',
    requestId: context.awsRequestId,
  });

  logger.info('Response sender triggered', { recordCount: event.Records.length });

  const errors: Error[] = [];

  for (const record of event.Records) {
    try {
      const message: ResponseMessage = JSON.parse(record.body);
      await processMessage(message);
    } catch (error) {
      logger.error('Failed to process message', error, { messageId: record.messageId });
      errors.push(error as Error);
    }
  }

  // If any messages failed, throw to trigger DLQ
  if (errors.length > 0) {
    throw new Error(`Failed to process ${errors.length} of ${event.Records.length} messages`);
  }
};
