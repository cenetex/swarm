/**
 * LLM Orchestrator Module
 *
 * Manages the LLM call attempt loop with retry logic, SDK/fallback switching,
 * circuit breaker integration, and metrics logging.
 */
import { logger, createCircuitBreaker } from '@swarm/core';
import { toChatMessage, stepCountIs } from '@openrouter/sdk';
import type { Tool } from '@openrouter/sdk';
import type { AdminChatMessage } from '../../types.js';
import { recordError } from '../../services/auto-issues.js';
import {
  LLM_MAX_RETRIES,
  LLM_MAX_STEPS,
  getOpenRouterClient,
  callLlmDirectFallback,
  normalizeUsage,
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
} from '../chat-tool-helpers.js';

const llmCircuitBreaker = createCircuitBreaker();

export interface LlmCallResult {
  response: string;
  toolCalls: SdkToolCall[];
  adminToolCalls: ReturnType<typeof toAdminToolCall>[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  modelResult: any;
  usedFallback: boolean;
  fallbackResponse: string;
  lastLlmStart: number;
  lastLlmMode: 'sdk' | 'fallback' | null;
  lastFallbackUsage: LlmUsage | undefined;
  lastFallbackLatency: number | undefined;
}

/**
 * Run the LLM call loop with retry logic and SDK/fallback switching.
 *
 * This encapsulates the entire attempt-retry cycle: it tries the SDK first,
 * falls back to direct API on Zod errors, retries on transient failures,
 * and returns the final state.
 */
export async function runLlmCallLoop(params: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: any;
  systemPrompt: string;
  messages: AdminChatMessage[];
  tools: Tool[];
  effectiveModel: string;
  effectiveMaxOutputTokens: number;
  avatarId: string | undefined;
}): Promise<LlmCallResult> {
  const {
    input, systemPrompt, messages, tools,
    effectiveModel, effectiveMaxOutputTokens,
    avatarId,
  } = params;

  let response = '';
  let toolCalls: SdkToolCall[] = [];
  let adminToolCalls: ReturnType<typeof toAdminToolCall>[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let modelResult: any = null;
  let usedFallback = false;
  let fallbackResponse = '';
  let lastLlmStart = 0;
  let lastLlmMode: 'sdk' | 'fallback' | null = null;
  let lastFallbackUsage: LlmUsage | undefined;
  let lastFallbackLatency: number | undefined;

  const runLlmAttempt = async (): Promise<void> => {
    if (!llmCircuitBreaker.canExecute()) {
      throw new Error('LLM circuit breaker open');
    }
    toolCalls = []; adminToolCalls = []; modelResult = null;
    usedFallback = false; fallbackResponse = '';
    lastLlmStart = 0; lastLlmMode = null;
    lastFallbackUsage = undefined; lastFallbackLatency = undefined;

    try {
      try {
        const callStart = Date.now();
        lastLlmStart = callStart;
        lastLlmMode = 'sdk';
        modelResult = getOpenRouterClient().callModel({
          model: effectiveModel,
          input,
          maxOutputTokens: effectiveMaxOutputTokens,
          ...(tools.length > 0 ? { tools, stopWhen: stepCountIs(LLM_MAX_STEPS) } : {}),
        });
        toolCalls = await modelResult.getToolCalls();
        adminToolCalls = toolCalls.map(toAdminToolCall);
        if (toolCalls.length > 0) {
          logLlmMetrics({ avatarId, model: effectiveModel, latencyMs: Date.now() - callStart, usage: undefined, toolCalls: toolCalls.length, mode: 'sdk' });
        }
      } catch (sdkError) {
        const errorName = sdkError instanceof Error ? sdkError.name : '';
        const errorMessage = sdkError instanceof Error ? sdkError.message : '';
        const isZodError = errorName === 'ZodError' || errorMessage.includes('invalid_type') || errorMessage.includes('Invalid Zod schema');
        const isResponsesApiError = errorMessage.includes('Unexpected response type from API');
        if (!isZodError && !isResponsesApiError) throw sdkError;

        logger.info('SDK error, falling back to direct API call', {
          event: 'sdk_fallback', errorName, errorMessage: errorMessage.slice(0, 120),
          reason: isResponsesApiError ? 'responses_api_incompatible' : 'zod_mismatch',
        });
        const apiMessages = [
          { role: 'system' as const, content: systemPrompt },
          ...toSdkMessages(sanitizeMessages(messages)),
        ];
        const fallbackResult = await callLlmDirectFallback(
          effectiveModel,
          apiMessages,
          effectiveMaxOutputTokens,
          tools.length > 0 ? tools : undefined
        );
        usedFallback = true; fallbackResponse = fallbackResult.content;
        lastLlmMode = 'fallback'; lastFallbackUsage = fallbackResult.usage; lastFallbackLatency = fallbackResult.latencyMs;
        adminToolCalls = fallbackResult.toolCalls.map(tc => ({
          id: tc.id, type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        }));
        toolCalls = fallbackResult.toolCalls.map(tc => ({
          id: tc.id, name: tc.name, arguments: tc.arguments,
        })) as unknown as SdkToolCall[];
        if (toolCalls.length > 0) {
          logLlmMetrics({ avatarId, model: effectiveModel, latencyMs: fallbackResult.latencyMs, usage: fallbackResult.usage, toolCalls: toolCalls.length, mode: 'fallback' });
        }
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

      // No tool calls: fetch response now, retry if empty.
      if (usedFallback) {
        response = fallbackResponse;
        if (lastLlmMode === 'fallback' && typeof lastFallbackLatency === 'number') {
          logLlmMetrics({ avatarId, model: effectiveModel, latencyMs: lastFallbackLatency, usage: lastFallbackUsage, toolCalls: 0, mode: 'fallback' });
        }
      } else if (modelResult) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const finalResponse: any = await modelResult.getResponse();
        const assistantMessage = toChatMessage(finalResponse);
        response = typeof assistantMessage.content === 'string' ? assistantMessage.content : '';
        const finishReason = finalResponse?.choices?.[0]?.finish_reason as string | undefined;
        logLlmMetrics({
          avatarId, model: effectiveModel,
          latencyMs: lastLlmStart ? Date.now() - lastLlmStart : 0,
          usage: normalizeUsage(finalResponse?.usage),
          toolCalls: 0, finishReason, mode: 'sdk',
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
    response, toolCalls, adminToolCalls, modelResult,
    usedFallback, fallbackResponse,
    lastLlmStart, lastLlmMode, lastFallbackUsage, lastFallbackLatency,
  };
}
