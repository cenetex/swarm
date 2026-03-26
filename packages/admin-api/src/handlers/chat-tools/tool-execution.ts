/**
 * Tool Execution Module
 *
 * Handles the fallback tool loop (manual tool execution when SDK Zod v3/v4
 * mismatch occurs) and the SDK streaming tool execution path.
 */
import { logger } from '@swarm/core';
import { isPauseForInputTool } from '@swarm/mcp-server';
import type { AdminChatMessage, ToolResult } from '../../types.js';
import {
  sanitizeMessages,
  sanitizeToolError,
  stringifyToolResultForModel,
  toAdminToolCall,
  buildPendingToolResponse,
  hasExecuteFunction,
  type SdkToolCall,
  type Tool,
} from '../chat-tool-helpers.js';
import {
  callLlmDirectFallback,
  logLlmMetrics,
  LLM_MAX_STEPS,
} from '../chat-llm.js';

/**
 * Safely extract tool call arguments as Record<string, unknown>.
 */
export function getToolArgs(tc: SdkToolCall): Record<string, unknown> {
  if (tc.arguments && typeof tc.arguments === 'object') {
    return tc.arguments as Record<string, unknown>;
  }
  return {};
}

export interface FallbackToolLoopResult {
  response: string;
  toolResults: ToolResult[];
  /** If a pause tool was encountered, the pending tool call info. */
  pendingToolCall?: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  };
  /** If a pause tool was encountered, the history with the assistant message appended. */
  earlyReturnHistory?: AdminChatMessage[];
}

/**
 * Execute the manual tool loop for the direct API fallback path.
 *
 * When the SDK cannot handle tool calls (Zod v3/v4 mismatch), we execute tools
 * manually and re-call the model in a loop until no more tool calls are returned.
 */
export async function executeFallbackToolLoop(params: {
  toolCalls: SdkToolCall[];
  adminToolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  fallbackResponse: string;
  tools: Tool[];
  effectiveModel: string;
  effectiveMaxOutputTokens: number;
  systemPrompt: string;
  messagesWithAttachments: AdminChatMessage[];
  messages: AdminChatMessage[];
  avatarId: string | undefined;
  mcpServices: unknown | null;
}): Promise<FallbackToolLoopResult> {
  const {
    tools,
    effectiveModel,
    effectiveMaxOutputTokens,
    systemPrompt,
    messagesWithAttachments,
    messages,
    avatarId,
    mcpServices,
  } = params;

  let currentToolCalls = params.toolCalls;
  let currentAdminToolCalls = params.adminToolCalls;
  let currentAssistantContent = params.fallbackResponse;
  let response = '';
  const toolResults: ToolResult[] = [];
  let lastPauseToolName: string | null = null;
  let pauseToolRepeatCount = 0;

  // Build base API messages for the fallback calls
  const baseApiMessages: Array<Record<string, unknown>> = [{ role: 'system', content: systemPrompt }];
  for (const msg of sanitizeMessages(messagesWithAttachments)) {
    if (msg.role === 'tool') {
      baseApiMessages.push({
        role: 'tool',
        tool_call_id: (msg as ToolResult).tool_call_id,
        content: msg.content,
      });
      continue;
    }

    if (msg.role === 'assistant' && msg.tool_calls) {
      baseApiMessages.push({
        role: 'assistant',
        content: msg.content || null,
        tool_calls: msg.tool_calls,
      });
      continue;
    }

    baseApiMessages.push({ role: msg.role, content: msg.content });
  }

  let fallbackStep = 0;
  const MAX_FALLBACK_TOOL_STEPS = LLM_MAX_STEPS;

  while (currentToolCalls.length > 0 && fallbackStep < MAX_FALLBACK_TOOL_STEPS) {
    fallbackStep++;
    logger.info('Executing tools manually (fallback mode)', {
      fallbackStep,
      toolCallCount: currentToolCalls.length,
      toolNames: currentToolCalls.map(tc => String(tc.name)),
    });

    // Add assistant tool-call message to API messages
    baseApiMessages.push({
      role: 'assistant',
      content: currentAssistantContent || '',
      tool_calls: currentAdminToolCalls.map(tc => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      })),
    });

    // Execute each tool call
    for (const toolCall of currentToolCalls) {
      const toolName = String(toolCall.name);
      const toolArgs = typeof toolCall.arguments === 'object' && toolCall.arguments !== null
        ? toolCall.arguments as Record<string, unknown>
        : {};

      try {
        const tool = tools.find(t => t.function.name === toolName);
        if (tool && hasExecuteFunction(tool)) {
          logger.info('Executing tool', { toolName, toolCallId: toolCall.id, fallbackStep });
          const result = await tool.function.execute(toolArgs);
          const resultStr = stringifyToolResultForModel(result);
          toolResults.push({
            tool_call_id: String(toolCall.id),
            role: 'tool',
            content: resultStr,
          });
          baseApiMessages.push({ role: 'tool', tool_call_id: String(toolCall.id), content: resultStr });
          logger.info('Tool executed successfully', {
            toolName,
            toolCallId: toolCall.id,
            fallbackStep,
            resultLength: resultStr.length,
          });
        } else {
          logger.warn('Tool not executable', {
            toolName,
            toolCallId: toolCall.id,
            fallbackStep,
            hasExecute: !!tool && hasExecuteFunction(tool),
          });
          const errStr = JSON.stringify({ error: `Tool ${toolName} is not executable` });
          toolResults.push({
            tool_call_id: String(toolCall.id),
            role: 'tool',
            content: errStr,
          });
          baseApiMessages.push({ role: 'tool', tool_call_id: String(toolCall.id), content: errStr });
        }
      } catch (error) {
        logger.error('Tool execution failed', error, { toolName, toolCallId: toolCall.id, fallbackStep });
        const errStr = JSON.stringify({ error: sanitizeToolError(error instanceof Error ? error.message : 'Tool execution failed') });
        toolResults.push({
          tool_call_id: String(toolCall.id),
          role: 'tool',
          content: errStr,
        });
        baseApiMessages.push({ role: 'tool', tool_call_id: String(toolCall.id), content: errStr });
      }
    }

    logger.info('Manual tool execution complete (fallback mode)', {
      fallbackStep,
      toolResultCount: toolResults.length,
    });

    // Call model again with tool results
    const next = await callLlmDirectFallback(
      effectiveModel,
      baseApiMessages as unknown as Array<{ role: string; content: string }>,
      effectiveMaxOutputTokens,
      tools.length > 0 ? tools : undefined
    );

    logLlmMetrics({
      avatarId,
      model: effectiveModel,
      latencyMs: next.latencyMs,
      usage: next.usage,
      toolCalls: next.toolCalls.length,
      mode: 'direct',
      step: fallbackStep,
    });

    currentAssistantContent = next.content;
    currentToolCalls = next.toolCalls.map(tc => ({
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
    })) as unknown as SdkToolCall[];
    currentAdminToolCalls = next.toolCalls.map(tc => ({
      id: tc.id,
      type: 'function' as const,
      function: {
        name: tc.name,
        arguments: JSON.stringify(tc.arguments),
      },
    }));

    // Check for pause tools in the next round
    const nextPauseTool = currentToolCalls.find(tc => isPauseForInputTool(String(tc.name), getToolArgs(tc)));
    if (nextPauseTool && mcpServices && avatarId) {
      const pauseToolName: string = String(nextPauseTool.name);

      // Detect looping: if the same pause tool is being called repeatedly, break the loop
      if (pauseToolName === lastPauseToolName) {
        pauseToolRepeatCount++;
        if (pauseToolRepeatCount >= 2) {
          logger.warn('Pause tool loop detected', {
            event: 'pause_tool_loop_detected',
            pauseToolName,
            repeatCount: pauseToolRepeatCount,
            fallbackStep,
            avatarId,
          });
          // Break the loop by returning an error response
          const displayName = (pauseToolName as string).replace(/_/g, ' ');
          response = `I encountered an issue while trying to access the ${displayName} interface. This might be due to a network error or misconfiguration. Please try refreshing the page or starting a new conversation.`;
          // Add the loop-breaking response to history
          const earlyMessages = [...messages];
          earlyMessages.push({
            role: 'assistant',
            content: response,
          });
          return {
            response,
            toolResults,
            earlyReturnHistory: earlyMessages,
          };
        }
      } else {
        lastPauseToolName = pauseToolName;
        pauseToolRepeatCount = 1;
      }

      const pendingToolCall = {
        id: String(nextPauseTool.id),
        name: pauseToolName,
        arguments: getToolArgs(nextPauseTool),
      };

      response = buildPendingToolResponse(pendingToolCall.name, pendingToolCall.arguments);
      const earlyMessages = [...messages];
      earlyMessages.push({
        role: 'assistant',
        content: response,
        tool_calls: [toAdminToolCall(nextPauseTool)],
      });

      return {
        response,
        toolResults,
        pendingToolCall,
        earlyReturnHistory: earlyMessages,
      };
    }

    // Reset pause tool tracking when a non-pause tool is called
    if (currentToolCalls.length > 0 && !isPauseForInputTool(String(currentToolCalls[0].name), getToolArgs(currentToolCalls[0]))) {
      lastPauseToolName = null;
      pauseToolRepeatCount = 0;
    }

    // No more tool calls -> final response
    if (currentToolCalls.length === 0) {
      response = currentAssistantContent;
    }
  }

  return { response, toolResults };
}

/**
 * Process the SDK streaming tool execution path.
 *
 * When the SDK successfully handles tool calls, this consumes the
 * new-messages stream and collects tool results.
 */
export async function executeSdkToolStream(
  modelResult: { getNewMessagesStream: () => AsyncIterable<unknown> }
): Promise<ToolResult[]> {
  const toolResults: ToolResult[] = [];
  let streamItemCount = 0;

  for await (const item of modelResult.getNewMessagesStream()) {
    streamItemCount++;
    logger.info('Stream item received', {
      itemType: typeof item === 'object' && item !== null && 'type' in item ? (item as { type: string }).type : 'unknown',
      hasItem: !!item,
    });
    if (item && typeof item === 'object' && 'type' in item && item.type === 'function_call_output') {
      const outputItem = item as { callId?: string; output?: string };
      if (outputItem.callId && typeof outputItem.output === 'string') {
        toolResults.push({
          tool_call_id: outputItem.callId,
          role: 'tool',
          content: outputItem.output,
        });
      }
    }
  }

  logger.info('Tool execution stream complete', { streamItemCount, toolResultCount: toolResults.length });
  return toolResults;
}
