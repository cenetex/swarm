/**
 * Shared Chat Handler
 *
 * Multi-user chat where authenticated users appear as their inhabited avatar
 * or as a "ghost" if they haven't inhabited an agent yet.
 *
 * Features:
 * - Wallet-based authentication (SIWS)
 * - Ghost display for non-inhabiting users
 * - Avatar display for inhabiting users
 * - Per-channel message history
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { z } from 'zod';
import { logger } from '@swarm/core';
import { getSessionWithUser } from '../services/wallet-auth.js';
import { getInhabitedAgent } from '../services/agent-ownership.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { MessageSender } from '../types.js';

const TABLE_NAME = process.env.ADMIN_TABLE || 'SwarmAdminTable';
const MAX_MESSAGES_PER_CHANNEL = 100;
const MESSAGE_TTL_HOURS = 24;

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

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

// Request schemas
const SendMessageSchema = z.object({
  channelId: z.string().min(1),
  content: z.string().min(1).max(4000),
  replyToId: z.string().optional(),
});

// =============================================================================
// Cookie / Session Helpers
// =============================================================================

const COOKIE_NAME = 'swarm_session';

function getSessionFromCookie(event: APIGatewayProxyEventV2): string | null {
  const cookies = event.cookies || [];
  for (const cookie of cookies) {
    const [name, value] = cookie.split('=');
    if (name === COOKIE_NAME && value) {
      return value;
    }
  }
  return null;
}

function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

// =============================================================================
// Response Helpers
// =============================================================================

function jsonResponse(
  statusCode: number,
  body: unknown,
  headers?: Record<string, string>
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

function corsHeaders(event: APIGatewayProxyEventV2): Record<string, string> {
  const origin = event.headers.origin || event.headers.Origin || '';
  const allowedOrigins = [
    'https://admin.rati.chat',
    'http://localhost:5173',
    'http://localhost:3000',
  ];

  const corsOrigin = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];

  return {
    'Access-Control-Allow-Origin': corsOrigin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

// =============================================================================
// Sender Identity
// =============================================================================

/**
 * Build the sender identity from wallet session
 * Returns ghost if authenticated but not inhabiting, avatar if inhabiting
 */
async function buildSenderIdentity(walletAddress: string): Promise<MessageSender> {
  const inhabitedAgent = await getInhabitedAgent(walletAddress);

  if (!inhabitedAgent) {
    // Ghost user - authenticated but no avatar
    return {
      walletAddress,
      displayName: `${walletAddress.slice(0, 4)}...${walletAddress.slice(-4)}`,
      isGhost: true,
    };
  }

  // Inhabiting user - show as avatar
  return {
    walletAddress,
    displayName: inhabitedAgent.name,
    avatarUrl: inhabitedAgent.profileImage?.url,
    inhabitedAgentId: inhabitedAgent.agentId,
    inhabitedAgentName: inhabitedAgent.name,
    isGhost: false,
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
      return jsonResponse(401, { error: 'Session expired' }, {
        ...cors,
        'Set-Cookie': clearSessionCookie(),
      });
    }

    const channelId = event.queryStringParameters?.channelId;
    if (!channelId) {
      return jsonResponse(400, { error: 'channelId is required' }, cors);
    }

    const messages = await getChannelMessages(channelId);

    // Also return the current user's sender identity
    const sender = await buildSenderIdentity(session.user.walletAddress);

    return jsonResponse(200, {
      messages,
      sender,
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
      return jsonResponse(401, { error: 'Session expired' }, {
        ...cors,
        'Set-Cookie': clearSessionCookie(),
      });
    }

    // Parse request
    const body = JSON.parse(event.body || '{}');
    const parsed = SendMessageSchema.safeParse(body);

    if (!parsed.success) {
      return jsonResponse(400, {
        error: 'Invalid request',
        details: parsed.error.issues,
      }, cors);
    }

    const { channelId, content, replyToId } = parsed.data;

    // Build sender identity
    const sender = await buildSenderIdentity(session.user.walletAddress);

    // Create message
    const message: SharedChatMessage = {
      id: `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
      channelId,
      content,
      sender,
      timestamp: Date.now(),
      replyToId,
    };

    // Save message
    await addChannelMessage(channelId, message);

    logger.info('Message sent', {
      subsystem: 'shared-chat',
      isGhost: sender.isGhost,
      agentName: sender.inhabitedAgentName,
      channelId,
    });

    return jsonResponse(200, {
      success: true,
      message,
    }, cors);
  } catch (error) {
    logger.error('Send message error', error, { subsystem: 'shared-chat' });
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

/**
 * GET /shared-chat/identity
 * Get the current user's sender identity (ghost or avatar)
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
      return jsonResponse(401, { error: 'Session expired' }, {
        ...cors,
        'Set-Cookie': clearSessionCookie(),
      });
    }

    const sender = await buildSenderIdentity(session.user.walletAddress);

    return jsonResponse(200, { sender }, cors);
  } catch (error) {
    logger.error('Get identity error', error, { subsystem: 'shared-chat' });
    return jsonResponse(500, { error: 'Internal server error' }, cors);
  }
}

/**
 * Main router for /shared-chat/* endpoints
 */
export async function handleSharedChat(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const path = event.rawPath;
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

  return jsonResponse(404, { error: 'Not found' }, cors);
}
