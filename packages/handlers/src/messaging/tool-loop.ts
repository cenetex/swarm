/**
 * Tool Loop Module
 *
 * Extracted iterative tool-call loop shared by message-processor (sync fallback)
 * and chat-worker (async path). Executes pending tool calls, feeds results back
 * to the LLM, and repeats until the LLM produces a final text response.
 */
import {
  extractThinking,
  logger,
  type LLMConfig,
  type ResponseAction,
  type SwarmEnvelope,
  type SwarmResponse,
} from '@swarm/core';
import type { createToolClient, ToolContext } from '@swarm/mcp-server';
import { callLLM, stripAvatarNamePrefix, type LLMMessage } from './llm-client.js';
import { toolResultsToActions } from './tool-executor.js';
import {
  checkToolCallLimit,
  isMemoryWriteAllowed,
} from '../services/entitlement-enforcement.js';
import type { createRuntimeBrainService } from '../services/brain.js';

const MAX_TOOL_ITERATIONS = 5;

export interface ToolLoopParams {
  messages: LLMMessage[];
  enabledTools: Array<{ type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }>;
  toolClient: ReturnType<typeof createToolClient>;
  toolContext: ToolContext;
  avatarId: string;
  avatarName: string;
  llmConfig: LLMConfig;
  secrets: Record<string, string>;
  envelope: SwarmEnvelope;
  brainService: ReturnType<typeof createRuntimeBrainService>;
  refreshTyping?: () => Promise<void>;
  /** Number of tool results already accumulated (for entitlement continuity across queue hop) */
  initialToolResultCount?: number;
  /** Starting iteration (for continuity when worker picks up after first LLM call) */
  startIteration?: number;
}

export interface ToolLoopResult {
  /** Final text content from LLM (with thinking tags) */
  finalContent: string | undefined;
  /** Clean content (thinking stripped, name prefix stripped) */
  cleanFinalContent: string | undefined;
  /** All tool results accumulated */
  allToolResults: Array<{ name: string; result: { success: boolean; data?: unknown; media?: { type: string; url: string }; pendingJob?: { jobId: string; type: string; prompt?: string } } }>;
  totalTokens: number;
}

/**
 * Execute the iterative tool-call loop.
 *
 * Runs up to MAX_TOOL_ITERATIONS rounds of:
 *   1. Execute pending tool calls
 *   2. Feed results back to LLM
 *   3. If LLM returns more tool calls, repeat
 *   4. If LLM returns text, stop
 */
export async function executeToolLoop(params: ToolLoopParams): Promise<ToolLoopResult> {
  const {
    messages,
    enabledTools,
    toolClient,
    toolContext,
    avatarName,
    llmConfig,
    secrets,
    envelope,
    brainService,
    refreshTyping,
    initialToolResultCount = 0,
    startIteration = 0,
  } = params;

  const allToolResults: ToolLoopResult['allToolResults'] = [];
  let finalContent: string | undefined;
  let cleanFinalContent: string | undefined;
  let iterations = startIteration;
  let totalTokens = 0;

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations++;

    // Refresh typing indicator before each LLM round-trip (expires after ~5s)
    if (refreshTyping) await refreshTyping();

    const llmStart = Date.now();
    const llmResponse = await callLLM(messages, enabledTools, llmConfig, secrets);
    totalTokens += 100; // Approximate

    // #1551 — structured telemetry for each LLM round-trip. No message text,
    // only shapes/counts so dashboards and debugging queries can reconstruct
    // behavior without touching conversation content.
    logger.info('llm_round', {
      event: 'llm_round',
      subsystem: 'chat',
      iteration: iterations,
      modelId: llmConfig.model,
      toolCallCount: llmResponse.toolCalls?.length ?? 0,
      toolNames: (llmResponse.toolCalls ?? []).map(tc => tc.name),
      latencyMs: Date.now() - llmStart,
      hasFinalContent: !!llmResponse.content,
    });

    if (!llmResponse.toolCalls || llmResponse.toolCalls.length === 0) {
      // No tool calls — final response
      finalContent = llmResponse.content;

      if (finalContent) {
        const { cleanContent, thinkingBlocks, hasThinking } = extractThinking(finalContent);
        cleanFinalContent = cleanContent;

        if (hasThinking && thinkingBlocks.length > 0) {
          const memoryAllowed = await isMemoryWriteAllowed(envelope.avatarId);
          if (memoryAllowed) {
            for (const thinking of thinkingBlocks) {
              try {
                await brainService.remember(
                  envelope.avatarId,
                  `[Internal thought in ${envelope.conversationId}]: ${thinking}`,
                  'thinking'
                );
              } catch (err) {
                logger.error('Failed to save thinking to memory', { error: err });
              }
            }
            logger.info('Saved thinking blocks to memory', {
              count: thinkingBlocks.length,
              avatarId: envelope.avatarId,
            });
          }
        }

        cleanFinalContent = stripAvatarNamePrefix(cleanFinalContent, avatarName);
      }
      break;
    }

    // Add assistant message with tool calls
    messages.push({
      role: 'assistant',
      content: llmResponse.content || '',
      tool_calls: llmResponse.toolCalls.map(tc => ({
        id: tc.id,
        type: 'function' as const,
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.arguments),
        },
      })),
    });

    // Execute tool calls
    for (const toolCall of llmResponse.toolCalls) {
      const toolLimit = await checkToolCallLimit(envelope.avatarId, initialToolResultCount + allToolResults.length);
      if (!toolLimit.allowed) {
        logger.warn('Tool call blocked by entitlement limits', {
          event: 'limit_exceeded',
          subsystem: 'entitlements',
          tool: toolCall.name,
          reason: toolLimit.reason,
          limit: toolLimit.limit,
          current: toolLimit.current,
        });

        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify({
            error: toolLimit.reason || 'Tool calls are limited by your current plan',
          }),
        });
        break;
      }

      logger.info('Executing tool', { tool: toolCall.name, args: toolCall.arguments });

      const toolStart = Date.now();
      const result = await toolClient.execute(toolCall.name, toolCall.arguments, toolContext);

      // #1551 — structured tool execution telemetry. Shapes only, no payloads.
      const resultShape: 'media' | 'uiAction' | 'text' | 'error' | 'pending' | 'empty' =
        !result.success ? 'error'
        : result.media?.url ? 'media'
        : result.uiAction ? 'uiAction'
        : result.pendingJob ? 'pending'
        : result.data ? 'text'
        : 'empty';
      logger.info('tool_executed', {
        event: 'tool_executed',
        subsystem: 'chat',
        tool: toolCall.name,
        success: result.success,
        resultShape,
        latencyMs: Date.now() - toolStart,
        iteration: iterations,
      });

      allToolResults.push({ name: toolCall.name, result });

      // Check if this is a manual tool (pause tool) with ui action - wrap it with tool call id
      const toolResultContent = (() => {
        if (result.success && result.uiAction) {
          // Include tool call ID in the ui action so it can be tracked by admin-ui
          return JSON.stringify({
            data: result.data,
            uiAction: result.uiAction,
            toolCallId: toolCall.id,
            media: result.media,
          });
        }
        return JSON.stringify(result.success
          ? { data: result.data, media: result.media, pendingJob: result.pendingJob }
          : { error: result.error });
      })();

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: toolResultContent,
      });

      // Feed generated images back into context for vision models
      if (result.success && result.media?.type === 'image' && result.media.url) {
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: 'Here is the image you just generated. Please look at it and respond.' },
            { type: 'image_url', image_url: { url: result.media.url } },
          ],
        });
      }

      logger.info('Tool result', { tool: toolCall.name, success: result.success, hasUiAction: !!result.uiAction });
    }
  }

  // #1551 — loop exit summary. Lets dashboards count "loops that hit the
  // MAX_TOOL_ITERATIONS cap" vs. "loops that naturally terminated."
  logger.info('tool_loop_complete', {
    event: 'tool_loop_complete',
    subsystem: 'chat',
    iterations,
    hitIterationCap: iterations >= MAX_TOOL_ITERATIONS,
    totalToolCalls: allToolResults.length,
    finalContentLen: cleanFinalContent?.length ?? finalContent?.length ?? 0,
  });

  return { finalContent, cleanFinalContent, allToolResults, totalTokens };
}

/**
 * Build a SwarmResponse from tool loop results.
 */
export function buildResponseFromToolLoop(
  envelope: SwarmEnvelope,
  toolLoopResult: ToolLoopResult,
  llmModel: string,
): {
  actions: ResponseAction[];
  tokensUsed: number;
  response: SwarmResponse;
} {
  let actions: ResponseAction[] = toolResultsToActions(toolLoopResult.allToolResults);
  const outputContent = toolLoopResult.cleanFinalContent || toolLoopResult.finalContent;

  if (outputContent && !actions.some(a => a.type === 'send_message')) {
    actions.push({ type: 'send_message', text: outputContent, replyToMessageId: envelope.messageId });
  }

  if (actions.length === 0 && outputContent) {
    actions = [{ type: 'send_message', text: outputContent, replyToMessageId: envelope.messageId }];
  }

  return {
    actions,
    tokensUsed: toolLoopResult.totalTokens,
    response: {
      avatarId: envelope.avatarId,
      platform: envelope.platform,
      conversationId: envelope.conversationId,
      replyToMessageId: envelope.messageId,
      actions,
      generatedAt: Date.now(),
      llmModel,
      tokensUsed: toolLoopResult.totalTokens,
    },
  };
}
