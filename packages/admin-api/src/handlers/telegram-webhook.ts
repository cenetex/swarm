/**
 * Shared Telegram Webhook Handler
 * Full-featured agent with conversation history and tool support
 *
 * Features:
 * - Conversation history per chat (stored in DynamoDB)
 * - Tool support: image/video generation, wallet info, gallery
 * - Attention tracking for selective responses
 * - Media sending (photos, videos, stickers)
 */
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { z } from 'zod';
import { isValidTelegramIP } from '../services/telegram.js';
import { timingSafeEqual } from 'crypto';
import * as channelState from '../services/channel-state.js';
import * as credits from '../services/credits.js';
import { getPlatformPromptSection } from '../services/platform-prompts.js';
import {
  ToolRegistry,
  createToolClient,
  registerAllTools,
} from '@swarm/mcp-server';
import { createTelegramMCPServices } from '../services/mcp-adapter.js';
import type { BufferedMessage, ChannelStateRecord } from '../types.js';

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const secretsClient = new SecretsManagerClient({});

const ADMIN_TABLE = process.env.ADMIN_TABLE!;
const LLM_API_KEY_SECRET_ARN = process.env.LLM_API_KEY_SECRET_ARN;
const LLM_ENDPOINT = process.env.LLM_ENDPOINT || 'https://openrouter.ai/api/v1/chat/completions';
const LLM_MODEL = process.env.LLM_MODEL || 'anthropic/claude-sonnet-4';
const ENFORCE_IP_CHECK = process.env.ENFORCE_TELEGRAM_IP_CHECK !== 'false';

// === CONFIG ===
// NOTE: Channel-aware config is in services/channel-state.ts (CHANNEL_CONFIG)
const DEDUP_TTL_SECONDS = 300; // 5 minutes - prevent reprocessing same message on retries
const PROCESSING_TTL_SECONDS = 60; // 1 minute - allow retries after short processing failures
const TELEGRAM_TIMEOUT_MS = 10_000;
const TELEGRAM_RETRY_COUNT = 1;
const LLM_TIMEOUT_MS = 20_000;
const LLM_RETRY_COUNT = 2;

// === SCHEMAS ===
const TelegramUserSchema = z.object({
  id: z.number(),
  first_name: z.string(),
  last_name: z.string().optional(),
  username: z.string().optional(),
});

const TelegramChatSchema = z.object({
  id: z.number(),
  type: z.enum(['private', 'group', 'supergroup', 'channel']),
  title: z.string().optional(),
});

const TelegramMessageSchema = z.object({
  message_id: z.number(),
  from: TelegramUserSchema.optional(),
  chat: TelegramChatSchema,
  date: z.number(),
  text: z.string().optional(),
  caption: z.string().optional(),
  photo: z.unknown().optional(),
  video: z.unknown().optional(),
  animation: z.unknown().optional(),
  document: z.unknown().optional(),
  sticker: z.object({ emoji: z.string().optional() }).optional(),
  reply_to_message: z.object({
    message_id: z.number(),
    text: z.string().optional(),
    from: z.object({ id: z.number(), username: z.string().optional() }).optional(),
  }).optional(),
});

const TelegramUpdateSchema = z.object({
  update_id: z.number(),
  message: TelegramMessageSchema.optional(),
});

type TelegramUpdate = z.infer<typeof TelegramUpdateSchema>;

// Agent config (internal use)
interface AgentConfig {
  agentId: string;
  name: string;
  persona?: string;
  platforms: {
    telegram?: { enabled: boolean; botUsername?: string; botId?: number };
    twitter?: { enabled: boolean };
  };
  llmConfig: { provider: string; model: string; temperature: number; maxTokens: number };
  wallets?: Array<{ name: string; publicKey: string }>;
  profileImage?: { url: string };
}

const ToolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({ name: z.string(), arguments: z.string() }),
});

const _ChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'tool']),
  content: z.string(),
  tool_calls: z.array(ToolCallSchema).optional(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
});

type ChatMessage = z.infer<typeof _ChatMessageSchema>;
type ToolCall = z.infer<typeof ToolCallSchema>;

// === MCP TOOL CLIENT SETUP ===

/**
 * Create a ToolClient for Telegram with context-enhanced descriptions
 */
async function createTelegramToolClient(agentId: string) {
  const registry = new ToolRegistry();
  const services = createTelegramMCPServices(agentId);
  registerAllTools(registry, services);
  return createToolClient(registry, 'telegram');
}

// === CACHES ===
const secretsCache = new Map<string, string>();

// === FETCH HELPERS ===
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithTimeout(
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

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  timeoutMs: number,
  retries: number
): Promise<Response> {
  let attempt = 0;
  let lastError: unknown;

  while (attempt <= retries) {
    try {
      const response = await fetchWithTimeout(url, options, timeoutMs);
      if (response.ok) {
        return response;
      }

      const shouldRetry = response.status === 429 || response.status >= 500;
      if (!shouldRetry) {
        return response;
      }

      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    attempt += 1;
    if (attempt > retries) {
      break;
    }
    await sleep(250 * attempt);
  }

  throw lastError instanceof Error ? lastError : new Error('Fetch failed');
}

// === HELPER FUNCTIONS ===
async function getSecret(secretArn: string): Promise<string | null> {
  if (secretsCache.has(secretArn)) return secretsCache.get(secretArn)!;
  try {
    const response = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretArn }));
    const value = response.SecretString || null;
    if (value) secretsCache.set(secretArn, value);
    return value;
  } catch (error) {
    console.error('Failed to get secret:', error);
    return null;
  }
}

async function getAgentConfig(agentId: string): Promise<AgentConfig | null> {
  const result = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: { pk: `AGENT#${agentId}`, sk: 'CONFIG' },
  }));
  if (!result.Item) return null;
  const config = result.Item as AgentConfig;

  // Fetch wallets
  const walletsResult = await dynamoClient.send(new QueryCommand({
    TableName: ADMIN_TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
    ExpressionAttributeValues: { ':pk': `AGENT#${agentId}`, ':sk': 'WALLET#' },
  }));
  if (walletsResult.Items?.length) {
    config.wallets = walletsResult.Items.map(w => ({ name: w.name, publicKey: w.publicKey }));
  }

  return config;
}

async function getTelegramToken(agentId: string): Promise<string | null> {
  const result = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: { pk: `AGENT#${agentId}`, sk: 'SECRET#telegram_bot_token#default' },
  }));
  if (!result.Item?.secretArn) return null;
  return getSecret(result.Item.secretArn);
}

async function getWebhookSecret(agentId: string): Promise<string | null> {
  const result = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: { pk: `AGENT#${agentId}`, sk: 'SECRET#telegram_webhook_secret#default' },
  }));
  if (!result.Item?.secretArn) return null;
  return getSecret(result.Item.secretArn);
}

async function getLlmApiKey(): Promise<string> {
  if (!LLM_API_KEY_SECRET_ARN) throw new Error('LLM_API_KEY_SECRET_ARN not configured');
  const value = await getSecret(LLM_API_KEY_SECRET_ARN);
  if (!value) throw new Error('Failed to get LLM API key');
  try {
    const parsed = JSON.parse(value);
    return parsed.api_key || parsed.apiKey || value;
  } catch {
    return value;
  }
}

// === MESSAGE DEDUPLICATION ===
// Prevents reprocessing the same message when Telegram retries due to Lambda timeout
// Handles stale "processing" markers from timed-out Lambda invocations
async function startMessageProcessing(agentId: string, updateId: number): Promise<boolean> {
  const now = Date.now();
  const ttl = Math.floor(now / 1000) + PROCESSING_TTL_SECONDS;
  const pk = `TELEGRAM#${agentId}`;
  const sk = `PROCESSED#${updateId}`;

  try {
    // Try to insert new processing marker
    await dynamoClient.send(new PutCommand({
      TableName: ADMIN_TABLE,
      Item: {
        pk,
        sk,
        status: 'processing',
        ttl,
        startedAt: now,
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
    return true;
  } catch (err: unknown) {
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') {
      throw err;
    }

    // Record exists - check if it's stale or already processed
    const existing = await dynamoClient.send(new GetCommand({
      TableName: ADMIN_TABLE,
      Key: { pk, sk },
    }));

    if (!existing.Item) {
      // Race condition - record was deleted, try again
      return startMessageProcessing(agentId, updateId);
    }

    const { status, startedAt } = existing.Item;

    // Already successfully processed - skip
    if (status === 'processed') {
      return false;
    }

    // Check if processing marker is stale (older than PROCESSING_TTL_SECONDS)
    const staleThreshold = now - (PROCESSING_TTL_SECONDS * 1000);
    if (status === 'processing' && startedAt && startedAt < staleThreshold) {
      console.log(`[Telegram] Taking over stale processing marker (started ${Math.round((now - startedAt) / 1000)}s ago)`);
      // Take over the stale processing marker
      try {
        await dynamoClient.send(new UpdateCommand({
          TableName: ADMIN_TABLE,
          Key: { pk, sk },
          UpdateExpression: 'SET startedAt = :startedAt, #ttl = :ttl',
          ConditionExpression: '#status = :processing AND startedAt = :oldStartedAt',
          ExpressionAttributeNames: { '#status': 'status', '#ttl': 'ttl' },
          ExpressionAttributeValues: {
            ':startedAt': now,
            ':ttl': ttl,
            ':processing': 'processing',
            ':oldStartedAt': startedAt,
          },
        }));
        return true;
      } catch (updateErr: unknown) {
        if ((updateErr as { name?: string }).name === 'ConditionalCheckFailedException') {
          // Another process took over - skip
          return false;
        }
        throw updateErr;
      }
    }

    // Processing marker is fresh - another Lambda is handling it
    return false;
  }
}

async function markMessageProcessed(agentId: string, updateId: number): Promise<void> {
  const ttl = Math.floor(Date.now() / 1000) + DEDUP_TTL_SECONDS;
  try {
    await dynamoClient.send(new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: { pk: `TELEGRAM#${agentId}`, sk: `PROCESSED#${updateId}` },
      UpdateExpression: 'SET #status = :status, processedAt = :processedAt, #ttl = :ttl',
      ExpressionAttributeNames: { '#status': 'status', '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ':status': 'processed',
        ':processedAt': Date.now(),
        ':ttl': ttl,
      },
    }));
  } catch (err) {
    console.warn('Failed to mark message as processed:', err);
  }
}

async function clearMessageProcessing(agentId: string, updateId: number): Promise<void> {
  try {
    await dynamoClient.send(new DeleteCommand({
      TableName: ADMIN_TABLE,
      Key: { pk: `TELEGRAM#${agentId}`, sk: `PROCESSED#${updateId}` },
    }));
  } catch (err) {
    console.warn('Failed to clear message processing marker:', err);
  }
}

// === TELEGRAM API ===
async function sendTelegramMessage(token: string, agentId: string, chatId: number, text: string, replyTo?: number): Promise<number | null> {
  const canUse = await credits.canUseTool(agentId, 'send_message');
  if (!canUse.allowed) {
    console.warn(`[Credits] send_message rate limit hit for agent=${agentId}: ${canUse.reason}`);
    return null;
  }

  const energyCheck = await credits.canUseEnergy(agentId, credits.ENERGY_COSTS.text);
  if (!energyCheck.allowed) {
    console.warn(`[Credits] Energy limit hit for send_message (agent=${agentId}): ${energyCheck.reason}`);
    return null;
  }

  try {
    const response = await fetchWithRetry(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'Markdown',
          reply_to_message_id: replyTo,
        }),
      },
      TELEGRAM_TIMEOUT_MS,
      TELEGRAM_RETRY_COUNT
    );
    if (!response.ok) {
      console.error('Telegram sendMessage error:', await response.text());
      return null;
    }
    await credits.consumeCredit(agentId, 'send_message');
    const energyConsumed = await credits.consumeEnergy(agentId, credits.ENERGY_COSTS.text);
    if (!energyConsumed) {
      console.warn(`[Credits] Failed to consume energy for send_message: agent=${agentId}`);
    }
    const data = await response.json() as { result?: { message_id: number } };
    return data.result?.message_id || null;
  } catch (error) {
    console.error('Telegram sendMessage failed:', error);
    return null;
  }
}

async function sendTelegramPhoto(token: string, chatId: number, photoUrl: string, caption?: string, replyTo?: number): Promise<void> {
  console.log(`[Telegram] Sending photo to chat ${chatId}: ${photoUrl.slice(0, 80)}...`);

  // Download the image first, then send as buffer
  // This is more reliable than letting Telegram fetch the URL (which may be private S3)
  // Same approach as solanafirehorse implementation
  try {
    const imageResponse = await fetchWithRetry(
      photoUrl,
      { method: 'GET' },
      TELEGRAM_TIMEOUT_MS,
      TELEGRAM_RETRY_COUNT
    );
    if (!imageResponse.ok) {
      console.error(`[Telegram] Failed to download image: ${imageResponse.status}`);
      // Fall back to URL-based send (might work for public CDN URLs)
      try {
        const response = await fetchWithRetry(
          `https://api.telegram.org/bot${token}/sendPhoto`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              photo: photoUrl,
              caption: caption?.slice(0, 1024),
              parse_mode: 'Markdown',
              reply_to_message_id: replyTo,
            }),
          },
          TELEGRAM_TIMEOUT_MS,
          TELEGRAM_RETRY_COUNT
        );
        if (!response.ok) {
          console.error(`[Telegram] sendPhoto (URL fallback) failed: ${response.status}`, await response.text());
        }
      } catch (error) {
        console.error('[Telegram] sendPhoto (URL fallback) failed:', error);
      }
      return;
    }

    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
    console.log(`[Telegram] Downloaded image: ${imageBuffer.length} bytes, sending as buffer`);

    // Use native FormData (Node.js 18+) with Blob
    const form = new FormData();
    form.append('chat_id', chatId.toString());
    form.append('photo', new Blob([imageBuffer], { type: 'image/png' }), 'image.png');
    if (caption) {
      form.append('caption', caption.slice(0, 1024));
      form.append('parse_mode', 'Markdown');
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
      console.error(`[Telegram] sendPhoto (buffer) failed: ${response.status} ${errorText}`);
    } else {
      console.log(`[Telegram] Photo sent successfully to chat ${chatId}`);
    }
  } catch (err) {
    console.error(`[Telegram] Error sending photo:`, err);
  }
}

async function sendTelegramVideo(token: string, chatId: number, videoUrl: string, caption?: string, replyTo?: number): Promise<void> {
  console.log(`[Telegram] Sending video to chat ${chatId}: ${videoUrl.slice(0, 80)}...`);

  // Download the video first, then send as buffer
  // This is more reliable than letting Telegram fetch the URL (which may be private S3)
  // Same approach as photo sending
  try {
    const videoResponse = await fetchWithRetry(
      videoUrl,
      { method: 'GET' },
      TELEGRAM_TIMEOUT_MS * 2, // Videos may be larger, give more time
      TELEGRAM_RETRY_COUNT
    );
    if (!videoResponse.ok) {
      console.error(`[Telegram] Failed to download video: ${videoResponse.status}`);
      // Fall back to URL-based send (might work for public CDN URLs)
      try {
        const response = await fetchWithRetry(
          `https://api.telegram.org/bot${token}/sendVideo`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              video: videoUrl,
              caption: caption?.slice(0, 1024),
              parse_mode: 'Markdown',
              reply_to_message_id: replyTo,
            }),
          },
          TELEGRAM_TIMEOUT_MS,
          TELEGRAM_RETRY_COUNT
        );
        if (!response.ok) {
          console.error(`[Telegram] sendVideo (URL fallback) failed: ${response.status}`, await response.text());
        }
      } catch (error) {
        console.error('[Telegram] sendVideo (URL fallback) failed:', error);
      }
      return;
    }

    const videoBuffer = Buffer.from(await videoResponse.arrayBuffer());
    console.log(`[Telegram] Downloaded video: ${videoBuffer.length} bytes, sending as buffer`);

    // Use native FormData (Node.js 18+) with Blob
    const form = new FormData();
    form.append('chat_id', chatId.toString());
    form.append('video', new Blob([videoBuffer], { type: 'video/mp4' }), 'video.mp4');
    if (caption) {
      form.append('caption', caption.slice(0, 1024));
      form.append('parse_mode', 'Markdown');
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
      TELEGRAM_TIMEOUT_MS * 2, // Videos may be larger
      TELEGRAM_RETRY_COUNT
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Telegram] sendVideo (buffer) failed: ${response.status} ${errorText}`);
    } else {
      console.log(`[Telegram] Video sent successfully to chat ${chatId}`);
    }
  } catch (err) {
    console.error(`[Telegram] Error sending video:`, err);
  }
}

/**
 * Send a sticker to Telegram chat
 * Telegram supports .webp (static), .tgs (animated), .webm (video sticker) formats
 * Note: sendSticker does NOT support captions
 */
async function sendTelegramSticker(token: string, chatId: number, stickerUrl: string, replyTo?: number): Promise<void> {
  console.log(`[Telegram] Sending sticker to chat ${chatId}: ${stickerUrl.slice(0, 80)}...`);

  try {
    // Download the sticker first, then send as buffer
    const stickerResponse = await fetchWithRetry(
      stickerUrl,
      { method: 'GET' },
      TELEGRAM_TIMEOUT_MS,
      TELEGRAM_RETRY_COUNT
    );
    if (!stickerResponse.ok) {
      console.error(`[Telegram] Failed to download sticker: ${stickerResponse.status}`);
      // Fall back to URL-based send
      try {
        const response = await fetchWithRetry(
          `https://api.telegram.org/bot${token}/sendSticker`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              sticker: stickerUrl,
              reply_to_message_id: replyTo,
            }),
          },
          TELEGRAM_TIMEOUT_MS,
          TELEGRAM_RETRY_COUNT
        );
        if (!response.ok) {
          console.error(`[Telegram] sendSticker (URL fallback) failed: ${response.status}`, await response.text());
        }
      } catch (error) {
        console.error('[Telegram] sendSticker (URL fallback) failed:', error);
      }
      return;
    }

    const stickerBuffer = Buffer.from(await stickerResponse.arrayBuffer());
    console.log(`[Telegram] Downloaded sticker: ${stickerBuffer.length} bytes, sending as buffer`);

    // Determine content type from URL extension
    const isWebm = /\.webm(\?.*)?$/i.test(stickerUrl);
    const isTgs = /\.tgs(\?.*)?$/i.test(stickerUrl);
    const contentType = isWebm ? 'video/webm' : isTgs ? 'application/gzip' : 'image/webp';
    const filename = isWebm ? 'sticker.webm' : isTgs ? 'sticker.tgs' : 'sticker.webp';

    // Use native FormData (Node.js 18+) with Blob
    const form = new FormData();
    form.append('chat_id', chatId.toString());
    form.append('sticker', new Blob([stickerBuffer], { type: contentType }), filename);
    if (replyTo) {
      form.append('reply_to_message_id', replyTo.toString());
    }

    const response = await fetchWithRetry(
      `https://api.telegram.org/bot${token}/sendSticker`,
      {
        method: 'POST',
        body: form,
      },
      TELEGRAM_TIMEOUT_MS,
      TELEGRAM_RETRY_COUNT
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Telegram] sendSticker (buffer) failed: ${response.status} ${errorText}`);
    } else {
      console.log(`[Telegram] Sticker sent successfully to chat ${chatId}`);
    }
  } catch (err) {
    console.error(`[Telegram] Error sending sticker:`, err);
  }
}

/**
 * Send sticker or photo based on file format
 * Uses sendSticker for .webp/.tgs/.webm formats, falls back to sendPhoto for others (e.g., PNG)
 * Since Telegram stickers don't support captions, sends caption as separate message if needed
 */
async function sendTelegramStickerOrPhoto(
  token: string,
  agentId: string,
  chatId: number,
  mediaUrl: string,
  caption?: string,
  replyTo?: number
): Promise<void> {
  const isStickerFormat = /\.(webp|tgs|webm)(\?.*)?$/i.test(mediaUrl);

  if (isStickerFormat) {
    await sendTelegramSticker(token, chatId, mediaUrl, replyTo);
    // Telegram stickers don't support captions, send as separate message
    if (caption) {
      await sendTelegramMessage(token, agentId, chatId, caption);
    }
    return;
  }

  // Non-sticker format (e.g., PNG) - send as photo
  console.log(`[Telegram] Sticker URL is not a sticker format, sending as photo: ${mediaUrl.slice(0, 60)}...`);
  await sendTelegramPhoto(token, chatId, mediaUrl, caption, replyTo);
}

async function sendChatAction(token: string, chatId: number, action: string): Promise<void> {
  try {
    await fetchWithRetry(
      `https://api.telegram.org/bot${token}/sendChatAction`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, action }),
      },
      TELEGRAM_TIMEOUT_MS,
      TELEGRAM_RETRY_COUNT
    );
  } catch (error) {
    console.warn('Telegram sendChatAction failed:', error);
  }
}

// === TOOL EXECUTION ===
interface ToolResult {
  success: boolean;
  result?: unknown;
  error?: string;
  media?: { type: 'image' | 'video' | 'sticker'; url: string; caption?: string };
}

function parseToolArgs(raw: string | undefined, toolName: string): { ok: boolean; args: Record<string, unknown>; error?: string } {
  if (!raw) {
    return { ok: true, args: {} };
  }

  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return { ok: true, args: parsed as Record<string, unknown> };
    }
    return { ok: true, args: {} };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, args: {}, error: `Invalid JSON for ${toolName}: ${message}` };
  }
}

/**
 * Execute a tool using the MCP ToolClient
 * Converts MCP result format to Telegram handler format
 */
async function executeTool(
  agentId: string,
  toolName: string,
  args: Record<string, unknown>,
  token: string,
  chatId: number,
  toolClient: ReturnType<typeof createToolClient>
): Promise<ToolResult> {
  try {
    // Send typing indicator for media-heavy tools
    if (toolName === 'generate_image') {
      await sendChatAction(token, chatId, 'upload_photo');
    } else if (toolName === 'generate_video') {
      await sendChatAction(token, chatId, 'upload_video');
    }

    // Execute via MCP ToolClient with conversationId for async callbacks
    // Note: conversationId is raw chatId (not prefixed) for compatibility with Telegram API
    const mcpResult = await toolClient.execute(toolName, args, { 
      agentId,
      conversationId: String(chatId),
      replyToMessageId: undefined, // Will be set by response queue handler
    });

    // Convert MCP result to Telegram handler format
    if (!mcpResult.success) {
      return { success: false, error: mcpResult.error || 'Unknown error' };
    }

    const result: ToolResult = {
      success: true,
      result: mcpResult.data,
    };

    // Handle media from MCP result
    if (mcpResult.media) {
      const mediaType = mcpResult.media.type;
      result.media = {
        type: mediaType === 'video' ? 'video' : mediaType === 'sticker' ? 'sticker' : 'image',
        url: mcpResult.media.url,
        caption: mcpResult.media.caption,
      };
    }

    return result;
  } catch (error) {
    console.error(`[Telegram] Tool ${toolName} error:`, error);
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

// OpenAI tool type for LLM calls
type OpenAITool = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

// === LLM CALL WITH TOOLS ===
async function callLLM(
  messages: ChatMessage[],
  agent: AgentConfig,
  tools?: OpenAITool[]
): Promise<{ content?: string; toolCalls?: ToolCall[] }> {
  const apiKey = await getLlmApiKey();

  const response = await fetchWithRetry(
    LLM_ENDPOINT,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://swarm.telegram',
        'X-Title': `Swarm Agent: ${agent.name}`,
      },
      body: JSON.stringify({
        model: agent.llmConfig.model || LLM_MODEL,
        messages,
        tools: tools?.length ? tools : undefined,
        max_tokens: agent.llmConfig.maxTokens || 1024,
        temperature: agent.llmConfig.temperature || 0.8,
      }),
    },
    LLM_TIMEOUT_MS,
    LLM_RETRY_COUNT
  );

  if (!response.ok) {
    throw new Error(`LLM API error: ${await response.text()}`);
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string; tool_calls?: ToolCall[] } }>;
  };

  const choice = data.choices?.[0]?.message;
  return { content: choice?.content || undefined, toolCalls: choice?.tool_calls };
}

// === CHANNEL-AWARE PROCESSING ===

/**
 * Process a message using channel-aware architecture
 * - Buffers message in channel state
 * - Evaluates if response should be triggered
 * - Responds to CHANNEL with full context (not individual messages)
 */
async function processChannelMessage(
  agentId: string,
  agent: AgentConfig,
  message: NonNullable<TelegramUpdate['message']>,
  token: string
): Promise<{ responded: boolean; reason: string }> {
  const chatId = message.chat.id;
  const chatType = message.chat.type;
  const messageId = message.message_id;
  const text = message.text || message.caption || '';
  const hasMedia = Boolean(
    message.photo ||
    message.video ||
    message.animation ||
    message.document ||
    message.sticker
  );
  const contentText = text || (hasMedia ? '[media]' : '');
  const userId = message.from?.id || 0;
  const userName = message.from?.first_name || 'User';
  const username = message.from?.username;
  const botUsername = agent.platforms.telegram?.botUsername;
  const botId = agent.platforms.telegram?.botId;

  // Check if this is a mention or reply to bot
  const isMention = botUsername ? new RegExp(`@${botUsername}\\b`, 'i').test(text) : false;
  const isReplyToBot = !!(message.reply_to_message?.from?.id === botId ||
    (botUsername && message.reply_to_message?.from?.username === botUsername));

  // Create buffered message
  const bufferedMessage: BufferedMessage = {
    messageId,
    userId,
    userName,
    username,
    text: contentText,
    timestamp: Date.now(),
    replyToMessageId: message.reply_to_message?.message_id,
    replyToUserId: message.reply_to_message?.from?.id,
    isMention,
    isReplyToBot,
  };

  // Add message to buffer and get updated state
  const updatedState = await channelState.addMessageToBuffer(
    agentId,
    chatId,
    chatType,
    message.chat.title,
    bufferedMessage
  );

  console.log('[Telegram] Channel state:', {
    agentId,
    chatId,
    chatType,
    state: updatedState.state,
    bufferSize: updatedState.bufferSize,
    isMention,
    isReplyToBot,
  });

  // Evaluate if we should respond
  const decision = channelState.evaluateResponseTrigger(updatedState, botUsername, botId);

  console.log('[Telegram] Response decision:', {
    chatId,
    shouldRespond: decision.shouldRespond,
    trigger: decision.trigger,
    delay: decision.delay,
    priority: decision.priority,
  });

  if (!decision.shouldRespond) {
    return { responded: false, reason: `no_trigger:${updatedState.state}` };
  }

  // Apply delay if specified (makes responses feel more natural)
  if (decision.delay > 0) {
    await new Promise(resolve => setTimeout(resolve, decision.delay));
  }

  // Transition to ACTIVE state
  await channelState.transitionState(agentId, chatId, 'ACTIVE');

  // Process and respond to the channel
  const responseMessageId = await processChannelResponse(
    agentId,
    agent,
    updatedState,
    token,
    decision.trigger
  );

  if (responseMessageId) {
    // Mark response sent and transition to COOLDOWN
    await channelState.markResponseSent(agentId, chatId, responseMessageId);
    return { responded: true, reason: decision.trigger };
  }

  return { responded: false, reason: 'response_failed' };
}

/**
 * Generate and send response to the channel
 * Uses full channel context (all buffered messages)
 */
async function processChannelResponse(
  agentId: string,
  agent: AgentConfig,
  state: ChannelStateRecord,
  token: string,
  trigger: string
): Promise<number | null> {
  const chatId = state.chatId;

  // === CREATE MCP TOOL CLIENT ===
  // Tools get context injected into descriptions automatically
  const toolClient = await createTelegramToolClient(agentId);
  const contextualTools = await toolClient.getOpenAIToolsWithContext(agentId);

  // Build conversation context from buffered messages
  const conversationContext = channelState.buildConversationContext(state);
  const participants = channelState.getActiveParticipants(state);
  const responseTarget = channelState.getResponseTarget(state);

  // Build system prompt
  let systemPrompt = agent.persona || `You are ${agent.name}, a helpful AI assistant on Telegram.`;
  
  // Add platform-specific prompt from markdown file
  systemPrompt += getPlatformPromptSection('telegram');

  // Add channel context
  systemPrompt += `\n\n## Current Conversation`;
  systemPrompt += `\nYou're in a ${state.chatType === 'private' ? 'private chat' : `group chat${state.chatTitle ? ` called "${state.chatTitle}"` : ''}`}.`;

  if (participants.length > 0) {
    systemPrompt += `\n\nActive participants:`;
    for (const p of participants.slice(0, 5)) {
      systemPrompt += `\n- ${p.username ? `@${p.username}` : p.userName} (${p.messageCount} messages)`;
    }
  }

  if (trigger === 'direct_engagement') {
    systemPrompt += `\n\nSomeone just mentioned you or replied to you - respond to them directly!`;
  } else if (trigger === 'message_threshold') {
    systemPrompt += `\n\nThe conversation has been active - feel free to chime in naturally if you have something to add.`;
  }

  if (agent.wallets?.length) {
    systemPrompt += `\n\n## Your Solana Wallets\n`;
    agent.wallets.forEach(w => { systemPrompt += `- ${w.name}: ${w.publicKey}\n`; });
  }

  if (agent.profileImage?.url) {
    systemPrompt += `\n\n## Your Profile Image\n${agent.profileImage.url}`;
  }

  // Build messages array with conversation context
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
  ];

  // Add conversation history as a single user message with context
  if (conversationContext) {
    messages.push({
      role: 'user',
      content: `Here's the recent conversation:\n\n${conversationContext}\n\nRespond to the conversation naturally. If someone asked you a question or mentioned you, address them directly.`,
    });
  } else {
    messages.push({
      role: 'user',
      content: 'Start a conversation!',
    });
  }

  // Determine which message to reply to
  const replyToMessageId = responseTarget?.messageId;

  // Tool loop
  let iterations = 0;
  const maxIterations = 5;
  const mediasToSend: Array<{ type: 'image' | 'video' | 'sticker'; url: string; caption?: string }> = [];
  const failedTools = new Set<string>();
  let responseMessageId: number | null = null;

  while (iterations++ < maxIterations) {
    await sendChatAction(token, chatId, 'typing');

    const llmResponse = await callLLM(messages, agent, contextualTools);

    if (llmResponse.toolCalls?.length) {
      messages.push({ role: 'assistant', content: '', tool_calls: llmResponse.toolCalls });

      for (const tc of llmResponse.toolCalls) {
        const toolName = tc.function.name;

        if (failedTools.has(toolName)) {
          console.log(`[Telegram] Skipping retry of failed tool: ${toolName}`);
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            name: toolName,
            content: JSON.stringify({ error: 'This tool already failed. Please inform the user and do not retry.' }),
          });
          continue;
        }

        const parsedArgs = parseToolArgs(tc.function.arguments, toolName);
        if (!parsedArgs.ok) {
          failedTools.add(toolName);
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            name: toolName,
            content: JSON.stringify({ error: parsedArgs.error, doNotRetry: true }),
          });
          continue;
        }

        const result = await executeTool(agentId, toolName, parsedArgs.args, token, chatId, toolClient);

        // Only add to failedTools for permanent failures, not rate limits or transient errors
        // Rate limits and "not found" errors should not block future attempts
        if (!result.success && result.error) {
          const isTransientError = 
            result.error.includes('Rate limited') ||
            result.error.includes('not found') ||
            result.error.includes('Gallery is empty');
          
          if (!isTransientError) {
            failedTools.add(toolName);
            console.log(`[Telegram] Tool ${toolName} added to failedTools: ${result.error}`);
          } else {
            console.log(`[Telegram] Tool ${toolName} failed with transient error (not blocking): ${result.error}`);
          }
        }

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: toolName,
          content: JSON.stringify(result.success ? result.result : { error: result.error }),
        });

        if (result.media) {
          mediasToSend.push(result.media);
        }
      }
      continue;
    }

    // Final response
    if (llmResponse.content) {
      messages.push({ role: 'assistant', content: llmResponse.content });
      responseMessageId = await sendTelegramMessage(token, agentId, chatId, llmResponse.content, replyToMessageId);
    }

    // Send media
    for (const m of mediasToSend) {
      if (m.type === 'image') {
        await sendTelegramPhoto(token, chatId, m.url, m.caption);
      } else if (m.type === 'video') {
        await sendTelegramVideo(token, chatId, m.url, m.caption);
      } else if (m.type === 'sticker') {
        // Route by format: .webp/.tgs/.webm → sendSticker, else → sendPhoto
        await sendTelegramStickerOrPhoto(token, agentId, chatId, m.url, m.caption);
      }
    }
    mediasToSend.length = 0;
    break;
  }

  // Fallback if max iterations reached
  if (!responseMessageId && iterations >= maxIterations) {
    console.warn(`[Telegram] Max iterations reached for chat ${chatId}`);
    responseMessageId = await sendTelegramMessage(
      token,
      agentId,
      chatId,
      "Sorry, I ran into some issues processing your request. Please try again!",
      replyToMessageId
    );
    for (const m of mediasToSend) {
      if (m.type === 'image') {
        await sendTelegramPhoto(token, chatId, m.url, m.caption);
      } else if (m.type === 'video') {
        await sendTelegramVideo(token, chatId, m.url, m.caption);
      } else if (m.type === 'sticker') {
        await sendTelegramStickerOrPhoto(token, agentId, chatId, m.url, m.caption);
      }
    }
  }

  return responseMessageId;
}

// === SECURITY ===
function verifySecretToken(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

function getClientIP(event: APIGatewayProxyEventV2): string | null {
  return event.headers['cf-connecting-ip'] ||
    event.headers['x-forwarded-for']?.split(',')[0].trim() ||
    event.requestContext.http.sourceIp || null;
}

// === HANDLER ===
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const agentId = event.pathParameters?.agentId;
  const clientIP = getClientIP(event);
  const requestId = event.requestContext.requestId;

  // Structured log for request entry - queryable by /logs API
  console.log(JSON.stringify({
    level: 'INFO',
    subsystem: 'telegram',
    event: 'request_received',
    agentId,
    clientIP,
    method: event.requestContext.http.method,
    requestId,
  }));

  const ok = () => ({ statusCode: 200, body: 'OK' });

  try {
    if (!agentId || !/^[a-zA-Z0-9_-]+$/.test(agentId)) {
      console.warn('Invalid agent ID');
      return ok();
    }

    if (ENFORCE_IP_CHECK) {
      if (!clientIP || !isValidTelegramIP(clientIP)) {
        console.warn(`Rejecting non-Telegram IP: ${clientIP || 'unknown'}`);
        return { statusCode: 403, body: 'Forbidden' };
      }
    }

    // Verify webhook secret
    const webhookSecret = await getWebhookSecret(agentId);
    const providedSecret = event.headers['x-telegram-bot-api-secret-token'];
    if (webhookSecret && !verifySecretToken(providedSecret, webhookSecret)) {
      console.warn(`Invalid secret for: ${agentId}`);
      return ok();
    }

    // Load agent
    const agent = await getAgentConfig(agentId);
    if (!agent || !agent.platforms.telegram?.enabled) {
      console.warn(`Agent not found or Telegram disabled: ${agentId}`);
      return ok();
    }

    // Get token
    const token = await getTelegramToken(agentId);
    if (!token) {
      console.error(`No Telegram token for: ${agentId}`);
      return ok();
    }

    // Parse and validate update
    const parseResult = TelegramUpdateSchema.safeParse(
      event.body ? JSON.parse(event.body) : {}
    );
    if (!parseResult.success) {
      console.warn('Invalid Telegram update:', parseResult.error.message);
      return ok();
    }
    const update = parseResult.data;
    const message = update.message;
    if (!message) return ok();

    const hasContent = Boolean(
      message.text ||
      message.caption ||
      message.photo ||
      message.video ||
      message.animation ||
      message.document ||
      message.sticker
    );
    if (!hasContent) return ok();
    const userId = message.from?.id;

    // Skip bot messages
    if (message.from?.username?.endsWith('bot')) return ok();

    // Deduplication: Check if we already processed this update (prevents infinite loops on Lambda timeout/retry)
    const shouldProcess = await startMessageProcessing(agentId, update.update_id);
    if (!shouldProcess) {
      console.log(`[Telegram] Skipping already processed update: ${update.update_id}`);
      return ok();
    }

    try {
      // Use channel-aware processing (Kyro-style architecture)
      // This buffers messages and responds to the channel, not individual messages
      const result = await processChannelMessage(agentId, agent, message, token);

      await markMessageProcessed(agentId, update.update_id);

      console.log(JSON.stringify({
        level: 'INFO',
        subsystem: 'telegram',
        event: 'channel_processed',
        agentId,
        chatId: message.chat.id,
        fromUser: userId,
        chatType: message.chat.type,
        updateId: update.update_id,
        responded: result.responded,
        reason: result.reason,
        requestId,
      }));

      return ok();
    } catch (error) {
      await clearMessageProcessing(agentId, update.update_id);
      throw error;
    }
  } catch (error) {
    console.error(JSON.stringify({
      level: 'ERROR',
      subsystem: 'telegram',
      event: 'webhook_error',
      agentId,
      requestId,
      error: error instanceof Error ? error.message : 'Unknown',
      stack: error instanceof Error ? error.stack : undefined,
    }));
    return ok();
  }
}
