/**
 * LLM Orchestrator Module
 *
 * Manages the LLM call attempt loop with retry logic,
 * circuit breaker integration, and metrics logging.
 *
 * Calls the OpenRouter Chat Completions API directly (no SDK).
 */
import { logger, createCircuitBreaker } from '@swarm/core';
import type { AdminChatMessage } from '../../types.js';
import { recordError } from '../../services/auto-issues.js';
import {
  LLM_MAX_RETRIES,
  callLlmDirectFallback,
  logLlmMetrics,
  sleep,
  getRetryDelayMs,
  isRetryableLlmError,
  type LlmUsage,
} from '../chat-llm.js';
import {
  sanitizeMessages,
  toSdkMessages,
  toAdminToolCall,
  type SdkToolCall,
  type Tool,
} from '../chat-tool-helpers.js';

const llmCircuitBreaker = createCircuitBreaker();

export interface LlmCallResult {
  response: string;
  toolCalls: SdkToolCall[];
  adminToolCalls: ReturnType<typeof toAdminToolCall>[];
  usedFallback: boolean;
  fallbackResponse: string;
  lastLlmStart: number;
  lastLlmMode: 'direct' | null;
  lastFallbackUsage: LlmUsage | undefined;
  lastFallbackLatency: number | undefined;
}

/**
 * Run the LLM call loop with retry logic.
 *
 * Calls the OpenRouter Chat Completions API directly, retries on transient
 * failures, and returns the final state.
 */
export async function runLlmCallLoop(params: {
  systemPrompt: string;
  messages: AdminChatMessage[];
  tools: Tool[];
  effectiveModel: string;
  effectiveMaxOutputTokens: number;
  avatarId: string | undefined;
}): Promise<LlmCallResult> {
  const {
    systemPrompt, messages, tools,
    effectiveModel, effectiveMaxOutputTokens,
    avatarId,
  } = params;

  let response = '';
  let toolCalls: SdkToolCall[] = [];
  let adminToolCalls: ReturnType<typeof toAdminToolCall>[] = [];
  let fallbackResponse = '';
  let lastLlmStart = 0;
  let lastLlmMode: 'direct' | null = null;
  let lastFallbackUsage: LlmUsage | undefined;
  let lastFallbackLatency: number | undefined;

  const runLlmAttempt = async (): Promise<void> => {
    if (!llmCircuitBreaker.canExecute()) {
      throw new Error('LLM circuit breaker open');
    }
    toolCalls = []; adminToolCalls = [];
    fallbackResponse = '';
    lastLlmStart = 0; lastLlmMode = null;
    lastFallbackUsage = undefined; lastFallbackLatency = undefined;

    try {
      lastLlmStart = Date.now();
      lastLlmMode = 'direct';

      const apiMessages = [
        { role: 'system' as const, content: systemPrompt },
        ...toSdkMessages(sanitizeMessages(messages)),
      ];

      const result = await callLlmDirectFallback(
        effectiveModel,
        apiMessages,
        effectiveMaxOutputTokens,
        tools.length > 0 ? tools : undefined
      );

      fallbackResponse = result.content;
      lastFallbackUsage = result.usage;
      lastFallbackLatency = result.latencyMs;

      adminToolCalls = result.toolCalls.map(tc => ({
        id: tc.id, type: 'function' as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      }));
      toolCalls = result.toolCalls.map(tc => ({
        id: tc.id, name: tc.name, arguments: tc.arguments,
      })) as unknown as SdkToolCall[];

      if (toolCalls.length > 0) {
        logLlmMetrics({
          avatarId, model: effectiveModel,
          latencyMs: result.latencyMs, usage: result.usage,
          toolCalls: toolCalls.length, mode: 'direct',
        });
      }

      llmCircuitBreaker.recordSuccess();
    } catch (error) {
      llmCircuitBreaker.recordFailure();
      throw error;
    }
  };

  for (let attempt = 0; attempt <= LLM_MAX_RETRIES; attempt++) {
    try {
      await runLlmAttempt();

      // If model requested tools, break immediately to avoid duplicating side effects.
      if (toolCalls.length > 0) break;

      // No tool calls: use the response content.
      response = fallbackResponse;
      if (typeof lastFallbackLatency === 'number') {
        logLlmMetrics({
          avatarId, model: effectiveModel,
          latencyMs: lastFallbackLatency, usage: lastFallbackUsage,
          toolCalls: 0, mode: 'direct',
        });
      }

      if (response) break;

      if (attempt < LLM_MAX_RETRIES) {
        logger.warn('Empty LLM response, retrying', {
          event: 'llm_retry', attempt: attempt + 1, maxRetries: LLM_MAX_RETRIES,
          avatarId, model: effectiveModel,
        });
        await sleep(getRetryDelayMs(attempt + 1));
        continue;
      }
      break;
    } catch (err) {
      const retryable = isRetryableLlmError(err);
      if (retryable && attempt < LLM_MAX_RETRIES) {
        logger.warn('LLM call failed, retrying', {
          event: 'llm_retry_error', attempt: attempt + 1, maxRetries: LLM_MAX_RETRIES,
          avatarId, model: effectiveModel,
          error: err instanceof Error ? err.message : String(err),
        });
        await sleep(getRetryDelayMs(attempt + 1));
        continue;
      }
      if (retryable) {
        recordError({
          error: err instanceof Error ? err.message : 'LLM call failed after retries',
          stack: err instanceof Error ? err.stack : undefined,
          subsystem: 'llm', category: 'llm_call_failed', avatarId,
          context: { attempts: attempt + 1, model: effectiveModel },
        }).catch(() => {});
      }
      throw err;
    }
  }

  return {
    response, toolCalls, adminToolCalls,
    usedFallback: true, fallbackResponse,
    lastLlmStart, lastLlmMode, lastFallbackUsage, lastFallbackLatency,
  };
}
