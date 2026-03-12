/**
 * SSE Streaming Chat Handler
 *
 * Provides real-time token streaming for chat responses using Server-Sent Events.
 * This handler is designed to work with Lambda Function URLs (response streaming)
 * or standard API Gateway (falls back to buffered SSE).
 *
 * SSE Event Types:
 * - token:    Individual text tokens as they arrive from the LLM
 * - tool:     Tool call execution notifications
 * - media:    Media items generated during the response
 * - done:     Final response with complete history and metadata
 * - error:    Error events
 */
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import {
  logger,
  buildDynamicSystemPrompt,
  extractThinking,
  detectEnabledCategories,
  type ToolCategory,
  type ProcessorAvatarConfig,
} from '@swarm/core';
import { authenticateRequest, requireAdmin } from '../auth/request-auth.js';
import { getCorsHeaders } from '../http/cors.js';
import { parseJsonBody } from '../http/request-body.js';
import * as chatHistory from '../services/chat-history.js';
import {
  ChatRequestSchema,
  type AdminChatMessage,
} from '../types.js';
import { createAvatarAccessChecker } from '../services/chat-access.js';
import * as avatars from '../services/avatars.js';
import { resolveChatModel } from '../services/models-registry.js';
import { resolvePublicAvatarIdFromRequest } from './chat-public-access.js';
import {
  LLM_MODEL,
  LLM_MAX_TOKENS,
  LLM_TIMEOUT_MS,
  getLlmApiKey,
  normalizeUsage,
  logLlmMetrics,
  type LlmUsage,
} from './chat-llm.js';
import {
  sanitizeMessages,
  toSdkMessages,
} from './chat-tool-helpers.js';
import { recordError } from '../services/auto-issues.js';
import { mapAdminChatHandlerError } from './chat-error-mapping.js';
import { redactMediaUrlsFromText } from '../utils/redact-media-urls.js';
import { incrementUsage } from '../services/billing/entitlements.js';

// ---- SSE Helpers ----

/** Format a Server-Sent Event */
function sseEvent(event: string, data: unknown): string {
  const json = JSON.stringify(data);
  return `event: ${event}\ndata: ${json}\n\n`;
}

// ---- Types ----

interface StreamingChatOptions {
  model: string;
  maxTokens: number;
  systemPrompt: string;
  messages: AdminChatMessage[];
  avatarId?: string;
}

/** OpenRouter streaming response chunk shape */
interface StreamChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

// ---- Streaming LLM Call ----

/**
 * Call OpenRouter with streaming enabled and yield SSE-formatted events.
 * This intentionally does NOT use tools to keep the streaming path simple.
 * Tool-based interactions continue to use the existing non-streaming /chat endpoint.
 */
async function* streamLlmResponse(
  options: StreamingChatOptions
): AsyncGenerator<string, void, unknown> {
  const apiKey = await getLlmApiKey();
  const startTime = Date.now();

  const apiMessages = [
    { role: 'system', content: options.systemPrompt },
    ...toSdkMessages(sanitizeMessages(options.messages)),
  ];

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://swarm.admin',
      'X-Title': 'Swarm Admin',
    },
    body: JSON.stringify({
      model: options.model,
      messages: apiMessages,
      max_tokens: options.maxTokens,
      stream: true,
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenRouter streaming error: ${response.status} ${errorText}`);
  }

  if (!response.body) {
    throw new Error('No response body from OpenRouter streaming API');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullContent = '';
  let usage: LlmUsage | undefined;
  let finishReason: string | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE lines from the buffer
      const lines = buffer.split('\n');
      // Keep the last potentially incomplete line in the buffer
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;

        try {
          const chunk = JSON.parse(trimmed.slice(6)) as StreamChunk;
          const delta = chunk.choices?.[0]?.delta;
          const content = delta?.content;

          if (content) {
            fullContent += content;
            yield sseEvent('token', { content });
          }

          if (chunk.choices?.[0]?.finish_reason) {
            finishReason = chunk.choices[0].finish_reason;
          }

          if (chunk.usage) {
            usage = normalizeUsage(chunk.usage);
          }
        } catch {
          // Skip malformed chunks
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  logLlmMetrics({
    avatarId: options.avatarId,
    model: options.model,
    latencyMs: Date.now() - startTime,
    usage,
    toolCalls: 0,
    finishReason,
    mode: 'direct',
  });

  // Yield the final content and usage in a done event
  yield sseEvent('done', {
    content: fullContent,
    usage,
    finishReason,
    latencyMs: Date.now() - startTime,
  });
}

// ---- Build System Prompt (duplicated from chat.ts for decoupling) ----

function buildSystemPrompt(avatar?: {
  id: string;
  name?: string;
  description?: string;
  persona?: string;
  enabledCategories?: ToolCategory[];
}): string {
  if (avatar) {
    const categories = avatar.enabledCategories || [
      'secrets', 'profile', 'media', 'gallery', 'wallets', 'diagnostics',
    ];
    const avatarConfig: ProcessorAvatarConfig = {
      avatarId: avatar.id,
      name: avatar.name,
      description: avatar.description,
      persona: avatar.persona,
      enabledCategories: categories,
    };
    return buildDynamicSystemPrompt(avatarConfig, 'admin-ui');
  }
  return 'You are a Swarm avatar assistant. Please select an avatar to chat with.';
}

// ---- Lambda Handler ----

/**
 * SSE streaming chat handler.
 *
 * POST /chat/stream
 *
 * Returns a text/event-stream response with SSE events for each token.
 * Falls back gracefully: if streaming is not supported (e.g., API Gateway
 * buffering), the client still receives all events once the response completes.
 *
 * The streaming endpoint intentionally skips tool execution to keep the
 * streaming path simple and fast. Clients should use the regular /chat
 * endpoint for tool-based interactions.
 */
export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const corsHeaders = getCorsHeaders(event);

  // Handle preflight
  if (event.requestContext.http.method === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders };
  }

  if (event.requestContext.http.method !== 'POST') {
    return {
      statusCode: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed. Use POST.' }),
    };
  }

  try {
    const session = await authenticateRequest(event);
    const requestId = event.requestContext.requestId;
    logger.setContext({ subsystem: 'chat-stream', requestId });

    const isAdmin = requireAdmin(session);
    const publicAvatarId = resolvePublicAvatarIdFromRequest(event);
    const ensureAvatarAccess = createAvatarAccessChecker({
      isAdmin,
      session,
      getAvatar: avatars.getAvatar,
      corsHeaders,
      publicAvatarId,
    });

    // Parse request
    const requestBody = parseJsonBody<Record<string, unknown>>(event);
    const parseResult = ChatRequestSchema.safeParse(requestBody);
    if (!parseResult.success) {
      return {
        statusCode: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'Invalid request',
          details: parseResult.error.issues.map((e) => `${(e.path as PropertyKey[]).map(String).join('.')}: ${e.message}`),
        }),
      };
    }

    const { message, history, avatar, model } = parseResult.data;

    const accessError = await ensureAvatarAccess(avatar?.id);
    if (accessError) return accessError;

    // Build avatar context
    const avatarRecord = avatar?.id ? await avatars.getAvatar(avatar.id) : null;
    const enabledCategories = avatarRecord
      ? detectEnabledCategories({
          voice: process.env.ENABLE_VOICE_TOOLS !== 'false',
          memory: (avatarRecord.mcpConfig?.enabledToolsets || []).includes('memory'),
          telegram: Boolean(avatarRecord.platforms?.telegram?.enabled),
          twitter: Boolean(avatarRecord.platforms?.twitter?.enabled),
          discord: Boolean(avatarRecord.platforms?.discord?.enabled),
          nft: true,
          property: (avatarRecord.mcpConfig?.enabledToolsets || []).includes('property'),
        })
      : undefined;

    const avatarContext = avatar ? {
      id: avatar.id,
      name: avatarRecord?.name ?? avatar.name,
      description: avatarRecord?.description ?? avatar.description,
      persona: avatarRecord?.persona ?? avatar.persona,
      enabledCategories,
    } : undefined;

    let systemPrompt = buildSystemPrompt(avatarContext);
    // Inject user identity context (linked wallets) for the streaming path
    if (session.accountId) {
      const { injectUserIdentityContext } = await import('./chat-tools/context-builder.js');
      systemPrompt = await injectUserIdentityContext(systemPrompt, session.accountId);
    }
    const resolvedModel = resolveChatModel({
      requestModel: model,
      avatarModel: avatarRecord?.llmConfig?.model,
      defaultModel: LLM_MODEL,
    });

    const avatarMaxTokens = avatarRecord?.llmConfig?.maxTokens;
    const maxTokens = typeof avatarMaxTokens === 'number' ? avatarMaxTokens : LLM_MAX_TOKENS;

    // Build messages for the LLM
    const messages: AdminChatMessage[] = [
      ...history,
      { role: 'user' as const, content: message },
    ];

    logger.info('SSE stream request', {
      event: 'sse_stream_start',
      avatarId: avatar?.id,
      model: resolvedModel,
      messageCount: messages.length,
    });

    // Collect all SSE events into a single response body.
    // Lambda + API Gateway buffers the response anyway, but the client
    // can still parse the SSE events from the buffered body. When served
    // via Lambda Function URL with response streaming, the events arrive
    // incrementally.
    let sseBody = '';
    let fullContent = '';

    try {
      for await (const chunk of streamLlmResponse({
        model: resolvedModel,
        maxTokens,
        systemPrompt,
        messages,
        avatarId: avatar?.id,
      })) {
        sseBody += chunk;

        // Extract content from done event for history saving
        if (chunk.startsWith('event: done\n')) {
          try {
            const dataLine = chunk.split('\n').find(l => l.startsWith('data: '));
            if (dataLine) {
              const data = JSON.parse(dataLine.slice(6)) as { content?: string };
              if (data.content) {
                fullContent = data.content;
              }
            }
          } catch {
            // Ignore parse errors
          }
        }
      }
    } catch (streamError) {
      logger.error('SSE stream error', streamError, {
        event: 'sse_stream_error',
        avatarId: avatar?.id,
      });

      sseBody += sseEvent('error', {
        error: streamError instanceof Error ? streamError.message : 'Stream failed',
      });

      recordError({
        error: streamError instanceof Error ? streamError.message : 'SSE stream failed',
        stack: streamError instanceof Error ? streamError.stack : undefined,
        subsystem: 'chat-stream',
        category: 'sse_stream_error',
        avatarId: avatar?.id,
      }).catch(() => { /* ignore */ });
    }

    // Post-process the response
    if (fullContent) {
      const { cleanContent, thinkingBlocks } = extractThinking(fullContent);
      const cleanResponse = redactMediaUrlsFromText(cleanContent);

      // Save to chat history
      const updatedHistory: AdminChatMessage[] = [
        ...history,
        { role: 'user' as const, content: message },
        {
          role: 'assistant' as const,
          content: cleanResponse,
          ...(thinkingBlocks.length > 0 ? { thinking: thinkingBlocks } : {}),
        },
      ];

      await chatHistory.saveChatHistory(session, updatedHistory, avatar?.id);

      // Track message usage against entitlement quota
      if (avatar?.id) {
        incrementUsage(avatar.id, 'messagesProcessed').catch(() => {});
      }

      // Append a final history event for the client
      sseBody += sseEvent('history', {
        history: updatedHistory,
      });
    }

    return {
      statusCode: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
      body: sseBody,
    };
  } catch (error) {
    const mapped = mapAdminChatHandlerError(error);
    logger.error('Stream handler error', error, {
      event: 'stream_handler_error',
      requestId: event.requestContext.requestId,
      statusCode: mapped.statusCode,
    });

    return {
      statusCode: mapped.statusCode,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: mapped.publicError,
        message: mapped.errorMessage,
      }),
    };
  }
}
