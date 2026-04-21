/**
 * OpenAI-Compatible Streaming Handler (Lambda Function URL)
 *
 * True token-by-token SSE streaming using Lambda response streaming.
 * Invoked via Function URL with InvokeMode=RESPONSE_STREAM.
 *
 * This handler reuses validation/auth from openai-compat.ts but replaces
 * the buffered processChat() call with a direct OpenRouter streaming fetch,
 * writing SSE chunks to the response stream as they arrive.
 */
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { z } from 'zod';
import { logger } from '@swarm/core';
import {
  extractApiKey,
  validateApiKey,
  parseAvatarId,
  resolveModel,
  hashApiKey,
} from './openai-compat.js';
import * as avatars from '../services/avatars.js';
import {
  LLM_TIMEOUT_MS,
  getLlmApiKey,
} from './chat-llm.js';
import { resolveTokenUsage, recordTokenUsage } from '../services/token-accounting.js';

// Schema (same as openai-compat.ts)
const OpenAIMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
});

const StreamRequestSchema = z.object({
  model: z.string().optional(), // Optional for scoped keys
  messages: z.array(OpenAIMessageSchema).min(1),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().optional(),
  stream: z.literal(true),
  user: z.string().optional(),
});

interface StreamChunk {
  choices?: Array<{
    delta?: { role?: string; content?: string };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * Lambda Function URL streaming handler.
 *
 * Uses the `awslambda.streamifyResponse` wrapper (injected by the Lambda runtime)
 * to write SSE events directly to the HTTP response as they arrive from OpenRouter.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const handler = (globalThis as any).awslambda?.streamifyResponse?.(
  async (event: APIGatewayProxyEventV2, responseStream: NodeJS.WritableStream) => {
    const requestId = event.requestContext?.requestId || crypto.randomUUID();

    // Set SSE content type via metadata
    const metadata = {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const httpStream = (globalThis as any).awslambda.HttpResponseStream.from(responseStream, metadata);

    try {
      await handleStreamingRequest(event, httpStream, requestId);
    } catch (err) {
      const errorChunk = {
        id: `chatcmpl-${requestId}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: 'error',
        choices: [{
          index: 0,
          delta: { content: `\n\n[Error: ${err instanceof Error ? err.message : 'Internal error'}]` },
          finish_reason: null,
        }],
      };
      httpStream.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
      httpStream.write('data: [DONE]\n\n');
    } finally {
      httpStream.end();
    }
  }
) ?? (async (_event: APIGatewayProxyEventV2) => {
  // Fallback for non-streaming Lambda invocations (API Gateway)
  return {
    statusCode: 400,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      error: {
        message: 'This endpoint requires Lambda Function URL with response streaming. Use the standard /v1/chat/completions endpoint for buffered responses.',
        type: 'invalid_request_error',
      },
    }),
  };
});

async function handleStreamingRequest(
  event: APIGatewayProxyEventV2,
  stream: NodeJS.WritableStream & { write(chunk: string): boolean },
  requestId: string,
): Promise<void> {
  // Validate API key
  const apiKey = extractApiKey(event);
  if (!apiKey) {
    writeErrorAndEnd(stream, requestId, 'Missing API key');
    return;
  }

  const validation = await validateApiKey(apiKey);
  if (!validation.valid || !validation.session) {
    writeErrorAndEnd(stream, requestId, 'Invalid API key');
    return;
  }

  // Parse request
  let request: z.infer<typeof StreamRequestSchema>;
  try {
    const body = JSON.parse(event.body || '{}');
    const result = StreamRequestSchema.safeParse(body);
    if (!result.success) {
      writeErrorAndEnd(stream, requestId, `Invalid request: ${result.error.issues.map(e => e.message).join(', ')}`);
      return;
    }
    request = result.data;
  } catch {
    writeErrorAndEnd(stream, requestId, 'Invalid JSON body');
    return;
  }

  const resolved = resolveModel(request.model, validation);
  if ('error' in resolved) {
    writeErrorAndEnd(stream, requestId, resolved.error);
    return;
  }
  const model = resolved.model;
  const avatarId = parseAvatarId(model);

  // Verify avatar access
  if (validation.avatarId && validation.avatarId !== avatarId) {
    writeErrorAndEnd(stream, requestId, `API key not authorized for avatar: ${avatarId}`);
    return;
  }

  // See the sibling non-stream handler for why this uses getAvatar directly
  // instead of assertAvatarOwnership: API-key sessions synthesize a
  // non-wallet userId so the ownership gate always rejected them.
  const avatarRecord = await avatars.getAvatar(avatarId);
  if (!avatarRecord) {
    writeErrorAndEnd(stream, requestId, `Avatar not found: ${avatarId}`);
    return;
  }

  const keyHash = hashApiKey(apiKey);

  // Build messages
  const llmModel = avatarRecord.llmConfig?.model || 'anthropic/claude-3-5-sonnet-latest';
  const systemPrompt = avatarRecord.persona || `You are ${avatarRecord.name || 'an AI assistant'}.`;
  const messages = [
    { role: 'system' as const, content: systemPrompt },
    ...request.messages,
  ];

  logger.info('Starting streaming chat completion', {
    event: 'stream_start',
    subsystem: 'openai-compat-stream',
    avatarId,
    model: llmModel,
    requestId,
  });

  // Get OpenRouter API key
  const llmApiKey = await getLlmApiKey();
  const startTime = Date.now();
  const completionId = `chatcmpl-${requestId}`;
  const created = Math.floor(Date.now() / 1000);

  // Write role announcement chunk
  const roleChunk = {
    id: completionId,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
  };
  stream.write(`data: ${JSON.stringify(roleChunk)}\n\n`);

  // Call OpenRouter with streaming
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${llmApiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://swarm.rati.chat',
      'X-Title': 'Swarm API',
    },
    body: JSON.stringify({
      model: llmModel,
      messages,
      max_tokens: request.max_tokens,
      temperature: request.temperature,
      stream: true,
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorText = await response.text();
    writeErrorAndEnd(stream, requestId, `LLM error: ${response.status} ${errorText.slice(0, 200)}`);
    return;
  }

  if (!response.body) {
    writeErrorAndEnd(stream, requestId, 'No response body from LLM');
    return;
  }

  // Stream tokens from OpenRouter → client
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullContent = '';
  let providerUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
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
            // Forward as OpenAI-compatible chunk
            const clientChunk = {
              id: completionId,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta: { content }, finish_reason: null }],
            };
            stream.write(`data: ${JSON.stringify(clientChunk)}\n\n`);
          }

          if (chunk.usage) {
            providerUsage = chunk.usage;
          }
        } catch {
          // Skip malformed chunks
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  // Resolve token usage
  const promptText = request.messages.map(m => m.content).join('\n');
  const tokenUsage = resolveTokenUsage(
    providerUsage ? {
      promptTokens: providerUsage.prompt_tokens || 0,
      completionTokens: providerUsage.completion_tokens || 0,
      totalTokens: providerUsage.total_tokens || 0,
    } : undefined,
    promptText,
    fullContent,
    llmModel,
  );

  // Write final chunk with finish_reason and usage
  const finalChunk = {
    id: completionId,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: tokenUsage.promptTokens,
      completion_tokens: tokenUsage.completionTokens,
      total_tokens: tokenUsage.totalTokens,
    },
  };
  stream.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
  stream.write('data: [DONE]\n\n');

  const latencyMs = Date.now() - startTime;

  logger.info('Streaming chat completion finished', {
    event: 'stream_complete',
    subsystem: 'openai-compat-stream',
    avatarId,
    model: llmModel,
    latencyMs,
    contentLength: fullContent.length,
    requestId,
  });

  // Record token usage (fire-and-forget)
  recordTokenUsage({
    requestId,
    keyHash,
    avatarId,
    model: llmModel,
    usage: tokenUsage,
  }).catch(() => {});
}

function writeErrorAndEnd(
  stream: NodeJS.WritableStream & { write(chunk: string): boolean },
  requestId: string,
  message: string,
): void {
  const errorChunk = {
    id: `chatcmpl-${requestId}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'error',
    choices: [{
      index: 0,
      delta: { content: `Error: ${message}` },
      finish_reason: 'stop',
    }],
  };
  stream.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
  stream.write('data: [DONE]\n\n');
}
