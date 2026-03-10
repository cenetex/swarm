/**
 * Shared Chat Handler
 *
 * Multi-user chat where authenticated users appear as wallet-backed users.
 *
 * Features:
 * - Wallet-based authentication (SIWS)
 * - Per-channel message history
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { z } from 'zod';
import { logger } from '@swarm/core';
import { getSessionWithUser } from '../services/wallet-auth.js';
import { getClearSessionCookies, getSessionFromCookie } from '../auth/session-cookie.js';
import { getCorsHeaders } from '../http/cors.js';
import { parseJsonBody } from '../http/request-body.js';
import { isRequestValidationError } from '../middleware/validate.js';
import {
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { MessageSender } from '../types.js';
import * as avatarService from '../services/avatars.js';
import { createSharedChatProcessor } from '../services/processor-adapter.js';
import { getDynamoClient } from '../services/dynamo-client.js';

const TABLE_NAME = process.env.ADMIN_TABLE || 'SwarmAdminTable';
const MAX_MESSAGES_PER_CHANNEL = 100;
const MESSAGE_TTL_HOURS = 24;

// Rate limiting configuration
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute window
const RATE_LIMIT_MAX_MESSAGES = 10; // Max messages per user per window per channel
const RATE_LIMIT_TTL_SECONDS = 120; // TTL for rate limit records (2 minutes)

// Typing indicator TTL
const TYPING_INDICATOR_TTL_MS = 30_000; // 30 seconds

const dynamoClient = getDynamoClient();

// In-memory typing indicators (for Lambda warm instances)
// In production, you'd want to use DynamoDB or Redis for cross-instance state
const typingIndicators = new Map<string, { avatarName: string; startedAt: number }>();

/**
 * Check if user is rate limited
 * Returns { limited: true, retryAfter: seconds } if rate limited
 */
async function checkRateLimit(
  walletAddress: string,
  channelId: string
): Promise<{ limited: boolean; retryAfter?: number }> {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const rateLimitKey = `RATE_LIMIT#${channelId}#${walletAddress}`;

  try {
    const result = await dynamoClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: rateLimitKey,
        sk: 'MESSAGES',
      },
    }));

    if (!result.Item) {
      return { limited: false };
    }

    const timestamps: number[] = result.Item.timestamps || [];
    const recentTimestamps = timestamps.filter(ts => ts > windowStart);

    if (recentTimestamps.length >= RATE_LIMIT_MAX_MESSAGES) {
      // Calculate when the oldest message in the window will expire
      const oldestInWindow = Math.min(...recentTimestamps);
      const retryAfter = Math.ceil((oldestInWindow + RATE_LIMIT_WINDOW_MS - now) / 1000);
      return { limited: true, retryAfter: Math.max(1, retryAfter) };
    }

    return { limited: false };
  } catch (error) {
    // On error, allow the request (fail open for rate limiting)
    logger.warn('Rate limit check failed, allowing request', {
      subsystem: 'shared-chat',
      channelId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { limited: false };
  }
}

/**
 * Record a message for rate limiting
 */
async function recordMessageForRateLimit(
  walletAddress: string,
  channelId: string
): Promise<void> {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const rateLimitKey = `RATE_LIMIT#${channelId}#${walletAddress}`;
  const ttl = Math.floor((now + RATE_LIMIT_TTL_SECONDS * 1000) / 1000);

  try {
    // Get existing timestamps
    const result = await dynamoClient.send(new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: rateLimitKey,
        sk: 'MESSAGES',
      },
    }));

    const existingTimestamps: number[] = result.Item?.timestamps || [];
    // Keep only recent timestamps + new one
    const timestamps = [...existingTimestamps.filter(ts => ts > windowStart), now];

    await dynamoClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        pk: rateLimitKey,
        sk: 'MESSAGES',
      },
      UpdateExpression: 'SET timestamps = :timestamps, #ttl = :ttl',
      ExpressionAttributeNames: {
        '#ttl': 'ttl',
      },
      ExpressionAttributeValues: {
        ':timestamps': timestamps,
        ':ttl': ttl,
      },
    }));
  } catch (error) {
    // Non-critical, just log
    logger.warn('Failed to record message for rate limit', {
      subsystem: 'shared-chat',
      channelId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Set typing indicator for a channel
 */
function setTypingIndicator(channelId: string, avatarName: string): void {
  typingIndicators.set(channelId, { avatarName, startedAt: Date.now() });
}

/**
 * Clear typing indicator for a channel
 */
function clearTypingIndicator(channelId: string): void {
  typingIndicators.delete(channelId);
}

/**
 * Get typing indicator for a channel (if still valid)
 */
function getTypingIndicator(channelId: string): { avatarName: string } | null {
  const indicator = typingIndicators.get(channelId);
  if (!indicator) return null;

  // Check if expired
  if (Date.now() - indicator.startedAt > TYPING_INDICATOR_TTL_MS) {
    typingIndicators.delete(channelId);
    return null;
  }

  return { avatarName: indicator.avatarName };
}

// =============================================================================
// Types
// =============================================================================

export interface SharedChatMessage {
  id: string;
  channelId: string;
  content: string;
  sender: MessageSender;
  timestamp: number;
  replyToId?: string;
}

export interface SharedChatChannel {
  pk: string;  // SHARED_CHAT#{channelId}
  sk: string;  // MESSAGES
  channelId: string;
  channelName?: string;
  messages: SharedChatMessage[];
  updatedAt: number;
  ttl: number;
}

/**
 * Public avatar info for the channel header
 */
export interface ChannelAvatarInfo {
  avatarId: string;
  name: string;
  description?: string;
  profileImageUrl?: string;
  persona?: string;
  connectedPlatforms: string[];
}

// Request schemas
const SendMessageSchema = z.object({
  channelId: z.string().min(1),
  content: z.string().min(1).max(4000),
  replyToId: z.string().optional(),
});

// Cookie helpers live in ../auth/session-cookie.ts

// =============================================================================
// Response Helpers
// =============================================================================

function jsonResponse(
  statusCode: number,
  body: unknown,
  headers?: Record<string, string>,
  cookies?: string[]
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    cookies,
    body: JSON.stringify(body),
  };
}

function corsHeaders(event: APIGatewayProxyEventV2): Record<string, string> {
  return getCorsHeaders(event);
}

// =============================================================================
// Avatar Info
// =============================================================================

/**
 * Get public avatar info for the channel (avatar page)
 * Returns null if avatar not found
 */
async function getChannelAvatarInfo(channelId: string): Promise<ChannelAvatarInfo | null> {
  // channelId is the avatarId
  const avatar = await avatarService.getAvatar(channelId);
  if (!avatar) return null;

  // Derive connected platforms from config (only expose names, not secrets)
  const connectedPlatforms: string[] = [];
  const platforms = avatar.platforms as Record<string, unknown> | undefined;
  if (platforms) {
    for (const key of ['telegram', 'discord', 'twitter'] as const) {
      if (platforms[key] && typeof platforms[key] === 'object') {
        connectedPlatforms.push(key);
      }
    }
  }

  return {
    avatarId: avatar.avatarId,
    name: avatar.name,
    description: avatar.description,
    profileImageUrl: avatar.profileImage?.url,
    persona: avatar.persona,
    connectedPlatforms,
  };
}

// =============================================================================
// Sender Identity
// =============================================================================

/**
 * Build the sender identity from wallet session
 */
async function buildSenderIdentity(walletAddress: string): Promise<MessageSender> {
  return {
    walletAddress,
    displayName: `${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}`,
  };
}

// =============================================================================
// Channel Storage
// =============================================================================

/**
 * Get messages from a shared chat channel
 */
async function getChannelMessages(channelId: string): Promise<SharedChatMessage[]> {
  const result = await dynamoClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: `SHARED_CHAT#${channelId}`,
      sk: 'MESSAGES',
    },
  }));

  if (!result.Item) {
    return [];
  }

  return (result.Item as SharedChatChannel).messages || [];
}

/**
 * Add a message to a shared chat channel
 */
async function addChannelMessage(
  channelId: string,
  message: SharedChatMessage
): Promise<void> {
  const now = Date.now();
  const ttl = Math.floor((now + MESSAGE_TTL_HOURS * 60 * 60 * 1000) / 1000);

  // Get existing messages
  const existingMessages = await getChannelMessages(channelId);

  // Add new message and trim to max
  const messages = [...existingMessages, message].slice(-MAX_MESSAGES_PER_CHANNEL);

  await dynamoClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: {
      pk: `SHARED_CHAT#${channelId}`,
      sk: 'MESSAGES',
    },
    UpdateExpression: 'SET messages = :messages, channelId = :channelId, updatedAt = :now, #ttl = :ttl',
    ExpressionAttributeNames: {
      '#ttl': 'ttl',
    },
    ExpressionAttributeValues: {
      ':messages': messages,
      ':channelId': channelId,
      ':now': now,
      ':ttl': ttl,
    },
  }));
}

// =============================================================================
// Avatar Response Generation
// =============================================================================

/**
 * Generate an avatar response to a user message using the unified MessageProcessor.
 * This ensures consistent behavior with Telegram and other platforms.
 * Returns null if avatar is not configured for responses or if generation fails.
 */
async function generateAvatarResponse(
  channelId: string,
  _userMessage: SharedChatMessage,  // Already included in recentMessages
  recentMessages: SharedChatMessage[]
): Promise<string | null> {
  try {
    // Get avatar config - channelId is the avatarId
    const avatar = await avatarService.getAvatar(channelId);
    if (!avatar) {
      logger.warn('Avatar not found for response generation', {
        subsystem: 'shared-chat',
        channelId,
      });
      return null;
    }

    // Check if avatar is active
    if (avatar.status !== 'active') {
      logger.info('Avatar not active, skipping response', {
        subsystem: 'shared-chat',
        channelId,
        status: avatar.status,
      });
      return null;
    }

    // Build conversation history for context (last 10 messages, excluding the latest user message)
    // The latest message will be passed separately to the processor
    const historyMessages = recentMessages.slice(-11, -1);
    const latestMessage = recentMessages[recentMessages.length - 1];

    // Format history messages for the processor
    // Messages from the avatar are 'assistant', others are 'user'
    const conversationHistory = historyMessages.map(msg => ({
      role: (msg.sender.walletAddress === 'avatar' ? 'assistant' : 'user') as 'user' | 'assistant',
      content: `${msg.sender.displayName || msg.sender.walletAddress?.slice(0, 6)}: ${msg.content}`,
    }));

    // Create the unified processor (same as Telegram uses)
    const processor = createSharedChatProcessor();

    // Format the latest message with sender info
    const userMessageContent = latestMessage
      ? `${latestMessage.sender.displayName || latestMessage.sender.walletAddress?.slice(0, 6)}: ${latestMessage.content}`
      : null;

    logger.info('Using unified MessageProcessor for shared-chat response', {
      subsystem: 'shared-chat',
      channelId,
      avatarName: avatar.name,
      historyLength: conversationHistory.length,
    });

    // Process the message using the unified processor
    const result = await processor.process(
      userMessageContent,
      conversationHistory,
      {
        avatarId: channelId,
        platform: 'shared-chat',
        conversationId: channelId,
      }
    );

    if (!result.response) {
      return null;
    }

    // Check if avatar chose not to respond (handled by the platform prompt)
    const content = result.response.trim();
    if (content === '[NO_RESPONSE]' || content.includes('[NO_RESPONSE]')) {
      logger.info('Avatar chose not to respond', {
        subsystem: 'shared-chat',
        channelId,
        avatarName: avatar.name,
      });
      return null;
    }

    logger.info('Avatar response generated via unified processor', {
      subsystem: 'shared-chat',
      channelId,
      avatarName: avatar.name,
      responseLength: content.length,
    });

    return content;
  } catch (error) {
    logger.error('Avatar response generation failed', error, {
      subsystem: 'shared-chat',
      channelId,
    });
    return null;
  }
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * GET /shared-chat/messages?channelId=xxx
 * Get messages from a shared chat channel
 */
export async function handleGetMessages(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const cors = corsHeaders(event);

  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    // Require authentication
    const sessionToken = getSessionFromCookie(event);
    if (!sessionToken) {
      return jsonResponse(401, { error: 'Authentication required' }, cors);
    }

    const session = await getSessionWithUser(sessionToken);
    if (!session) {
      return jsonResponse(401, { error: 'Session expired' }, cors, getClearSessionCookies());
    }

    const channelId = event.queryStringParameters?.channelId;
    if (!channelId) {
      return jsonResponse(400, { error: 'channelId is required' }, cors);
    }

    const [messages, avatarInfo] = await Promise.all([
      getChannelMessages(channelId),
      getChannelAvatarInfo(channelId),
    ]);

    // Also return the current user's sender identity
    const sender = await buildSenderIdentity(session.user.walletAddress);

    return jsonResponse(200, {
      messages,
      sender,
      avatar: avatarInfo,
    }, cors);
  } catch (error) {
    logger.error('Get messages error', error, { subsystem: 'shared-chat' });
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

/**
 * POST /shared-chat/messages
 * Send a message to a shared chat channel
 */
export async function handleSendMessage(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const cors = corsHeaders(event);

  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    // Require authentication
    const sessionToken = getSessionFromCookie(event);
    if (!sessionToken) {
      return jsonResponse(401, { error: 'Authentication required' }, cors);
    }

    const session = await getSessionWithUser(sessionToken);
    if (!session) {
      return jsonResponse(401, { error: 'Session expired' }, cors, getClearSessionCookies());
    }

    // Parse request
    const body = parseJsonBody(event);
    const parsed = SendMessageSchema.safeParse(body);

    if (!parsed.success) {
      return jsonResponse(400, {
        error: 'Invalid request',
        details: parsed.error.issues,
      }, cors);
    }

    const { channelId, content, replyToId } = parsed.data;
    const walletAddress = session.user.walletAddress;

    // Check rate limit
    const rateLimitStatus = await checkRateLimit(walletAddress, channelId);
    if (rateLimitStatus.limited) {
      logger.info('User rate limited', {
        subsystem: 'shared-chat',
        channelId,
        walletAddress: `${walletAddress.slice(0, 6)}...`,
        retryAfter: rateLimitStatus.retryAfter,
      });
      return jsonResponse(429, {
        error: 'Too many messages. Please slow down.',
        retryAfter: rateLimitStatus.retryAfter,
      }, {
        ...cors,
        'Retry-After': String(rateLimitStatus.retryAfter),
      });
    }

    // Parallel: Build sender identity + get avatar info (for typing indicator)
    const [sender, avatar] = await Promise.all([
      buildSenderIdentity(walletAddress),
      avatarService.getAvatar(channelId),
    ]);

    // Create message
    const message: SharedChatMessage = {
      id: `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
      channelId,
      content,
      sender,
      timestamp: Date.now(),
      replyToId,
    };

    // Parallel: Save message + record rate limit
    await Promise.all([
      addChannelMessage(channelId, message),
      recordMessageForRateLimit(walletAddress, channelId),
    ]);

    logger.info('Message sent', {
      subsystem: 'shared-chat',
      senderDisplayName: sender.displayName,
      channelId,
    });

    // Set typing indicator before generating response
    if (avatar && avatar.status === 'active') {
      setTypingIndicator(channelId, avatar.name);
    }

    // Generate avatar response
    // Get recent messages for context (message already saved, so it's included)
    const recentMessages = await getChannelMessages(channelId);
    const avatarResponseText = await generateAvatarResponse(channelId, message, recentMessages);

    // Clear typing indicator
    clearTypingIndicator(channelId);

    let avatarMessage: SharedChatMessage | null = null;
    if (avatarResponseText && avatar) {
      avatarMessage = {
        id: `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
        channelId,
        content: avatarResponseText,
        sender: {
          walletAddress: 'avatar',
          displayName: avatar.name,
          avatarUrl: avatar.profileImage?.url,
        },
        timestamp: Date.now(),
        replyToId: message.id,
      };

      // Save avatar response
      await addChannelMessage(channelId, avatarMessage);

      logger.info('Avatar response sent', {
        subsystem: 'shared-chat',
        avatarName: avatar.name,
        channelId,
      });
    }

    return jsonResponse(200, {
      success: true,
      message,
      avatarResponse: avatarMessage,
    }, cors);
  } catch (error) {
    if (isRequestValidationError(error)) {
      return jsonResponse(error.statusCode, {
        error: error.message,
        details: error.details,
      }, cors);
    }
    logger.error('Send message error', error, { subsystem: 'shared-chat' });
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

/**
 * GET /shared-chat/identity
 * Get the current user's sender identity
 */
export async function handleGetIdentity(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const cors = corsHeaders(event);

  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    // Require authentication
    const sessionToken = getSessionFromCookie(event);
    if (!sessionToken) {
      return jsonResponse(401, { error: 'Authentication required' }, cors);
    }

    const session = await getSessionWithUser(sessionToken);
    if (!session) {
      return jsonResponse(401, { error: 'Session expired' }, cors, getClearSessionCookies());
    }

    const sender = await buildSenderIdentity(session.user.walletAddress);

    return jsonResponse(200, { sender }, cors);
  } catch (error) {
    logger.error('Get identity error', error, { subsystem: 'shared-chat' });
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

/**
 * GET /shared-chat/typing?channelId=xxx
 * Get typing indicator status for a channel
 * Returns { typing: true, avatarName: "..." } if avatar is currently generating a response
 */
export async function handleGetTypingStatus(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const cors = corsHeaders(event);

  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    const channelId = event.queryStringParameters?.channelId;
    if (!channelId) {
      return jsonResponse(400, { error: 'channelId is required' }, cors);
    }

    const indicator = getTypingIndicator(channelId);

    if (indicator) {
      return jsonResponse(200, {
        typing: true,
        avatarName: indicator.avatarName,
      }, cors);
    }

    return jsonResponse(200, { typing: false }, cors);
  } catch (error) {
    logger.error('Get typing status error', error, { subsystem: 'shared-chat' });
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

/**
 * GET /shared-chat/avatar?channelId=xxx
 * Get the avatar info for a channel (public endpoint, no auth required)
 * Used for displaying the avatar header on shared chat pages
 */
export async function handleGetAvatar(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const cors = corsHeaders(event);

  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  try {
    const channelId = event.queryStringParameters?.channelId;
    if (!channelId) {
      return jsonResponse(400, { error: 'channelId is required' }, cors);
    }

    const avatarInfo = await getChannelAvatarInfo(channelId);

    if (!avatarInfo) {
      return jsonResponse(404, { error: 'Avatar not found' }, cors);
    }

    return jsonResponse(200, { avatar: avatarInfo }, cors);
  } catch (error) {
    logger.error('Get avatar error', error, { subsystem: 'shared-chat' });
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

/**
 * Main router for /shared-chat/* endpoints
 */
export async function handleSharedChat(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const rawPath = event.rawPath;
  const path = rawPath === '/api'
    ? '/'
    : rawPath.startsWith('/api/')
      ? rawPath.slice('/api'.length)
      : rawPath;
  const method = event.requestContext.http.method;
  const cors = corsHeaders(event);

  // Handle preflight for all routes
  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: cors };
  }

  // Route to appropriate handler
  if (path === '/shared-chat/messages' && method === 'GET') {
    return handleGetMessages(event);
  }

  if (path === '/shared-chat/messages' && method === 'POST') {
    return handleSendMessage(event);
  }

  if (path === '/shared-chat/identity' && method === 'GET') {
    return handleGetIdentity(event);
  }

  if (path === '/shared-chat/typing' && method === 'GET') {
    return handleGetTypingStatus(event);
  }

  // Public endpoint - no auth required
  if (path === '/shared-chat/avatar' && method === 'GET') {
    return handleGetAvatar(event);
  }

  return jsonResponse(404, { error: 'Not found' }, cors);
}
