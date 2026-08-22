/**
 * Handler Routes Module
 *
 * HTTP route handling extracted from the main chat handler:
 * - GET / | /health | /healthz  -- health check
 * - GET /chat?avatarId=xxx      -- retrieve chat history
 * - DELETE /chat?avatarId=xxx   -- clear chat history
 * - POST /chat/message          -- append a system message
 */
import type { HttpRequest, HttpResponse } from "@swarm/core";
import { logger, extractThinking } from '@swarm/core';
import { parseJsonBody } from '../../http/request-body.js';
import * as chatHistory from '../../services/chat-history.js';
import { redactMediaUrlsFromText } from '../../utils/redact-media-urls.js';
import type { UserSession } from '../../types.js';

type EnsureAvatarAccess = (avatarId: string | undefined) => Promise<HttpResponse | null>;

/**
 * Handle the lightweight health/info endpoint.
 * Returns a response if the path matches, null otherwise.
 */
export function handleHealthCheck(
  method: string,
  path: string,
  corsHeaders: Record<string, string>
): HttpResponse | null {
  if (method === 'GET' && (path === '/' || path === '/health' || path === '/healthz')) {
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ok: true,
        service: 'swarm-admin-api',
        path,
        hint: 'Try GET /auth/me (cookie auth) or POST /auth/wallet/verify (login)',
      }),
    };
  }
  return null;
}

/**
 * Handle GET /chat?avatarId=xxx -- retrieve chat history.
 */
export async function handleGetHistory(
  event: HttpRequest,
  session: UserSession,
  ensureAvatarAccess: EnsureAvatarAccess,
  corsHeaders: Record<string, string>
): Promise<HttpResponse> {
  const avatarId = event.queryStringParameters?.avatarId;
  const accessError = await ensureAvatarAccess(avatarId);
  if (accessError) return accessError;
  const history = await chatHistory.getChatHistory(session, avatarId);

  const cleanedHistory = history.map((msg) => {
    if (!msg || msg.role !== 'assistant' || typeof msg.content !== 'string') return msg;

    const existingThinking = Array.isArray((msg as unknown as { thinking?: unknown }).thinking)
      ? ((msg as unknown as { thinking?: string[] }).thinking ?? [])
      : [];

    const { cleanContent, thinkingBlocks } = extractThinking(msg.content);
    const mergedThinking = [...existingThinking, ...thinkingBlocks]
      .map((t) => redactMediaUrlsFromText(String(t)).trim())
      .filter((t) => t.length > 0);

    return {
      ...msg,
      content: cleanContent,
      ...(mergedThinking.length > 0 ? { thinking: mergedThinking } : {}),
    };
  });

  return {
    statusCode: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ history: cleanedHistory }),
  };
}

/**
 * Handle DELETE /chat?avatarId=xxx -- clear chat history.
 */
export async function handleDeleteHistory(
  event: HttpRequest,
  session: UserSession,
  ensureAvatarAccess: EnsureAvatarAccess,
  corsHeaders: Record<string, string>
): Promise<HttpResponse> {
  const avatarId = event.queryStringParameters?.avatarId;
  const accessError = await ensureAvatarAccess(avatarId);
  if (accessError) return accessError;
  await chatHistory.clearChatHistory(session, avatarId);

  return {
    statusCode: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ success: true }),
  };
}

/**
 * Handle POST /chat/message -- append a system/user message to chat history.
 */
export async function handleAppendMessage(
  event: HttpRequest,
  session: UserSession,
  ensureAvatarAccess: EnsureAvatarAccess,
  corsHeaders: Record<string, string>
): Promise<HttpResponse> {
  const body = parseJsonBody<{
    avatarId?: unknown;
    message?: {
      role?: unknown;
      content?: unknown;
    };
  }>(event);
  const { avatarId, message } = body;

  if (!avatarId || typeof avatarId !== 'string') {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'avatarId is required' }),
    };
  }

  const role: 'assistant' | 'user' | null =
    message?.role === 'assistant' || message?.role === 'user'
      ? message.role
      : null;
  const content = typeof message?.content === 'string' ? message.content : null;

  if (!role || !content) {
    return {
      statusCode: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'message with role (assistant|user) and content is required' }),
    };
  }

  const accessError = await ensureAvatarAccess(avatarId);
  if (accessError) return accessError;

  const history = await chatHistory.appendSystemMessage(session, avatarId, {
    role,
    content,
  });

  logger.info('System message appended', {
    event: 'system_message_appended',
    avatarId,
    role,
    contentLength: content.length,
  });

  return {
    statusCode: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ success: true, history }),
  };
}
