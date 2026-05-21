/**
 * Pause Tools Module
 *
 * Handles "pause for input" tool calls -- tools that require user interaction
 * (model selector, feature toggle, secret input, upload prompts, integration config).
 */
import { logger } from '@swarm/core';
import { isPauseForInputTool, type AllServices } from '@swarm/mcp-server';
import type { AdminChatMessage } from '../../types.js';
import {
  buildPauseToolPayload,
  buildPendingToolResponse,
  toAdminToolCall,
  type SdkToolCall,
  type Tool,
} from '../chat-tool-helpers.js';
import { getToolArgs } from './tool-execution.js';

export interface PauseToolResult {
  response: string;
  history: AdminChatMessage[];
  pendingToolCall: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  };
}

/**
 * Check for and handle pause-for-input tool calls.
 *
 * Returns the PauseToolResult if a pause tool was found, or null if no pause
 * tool was in the tool calls list.
 */
export async function handlePauseToolCalls(params: {
  toolCalls: SdkToolCall[];
  adminToolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  mcpServices: { models: AllServices['models'] } | null;
  avatarId: string | undefined;
  messages: AdminChatMessage[];
  tools: Tool[];
}): Promise<PauseToolResult | null> {
  const { toolCalls, adminToolCalls, mcpServices, avatarId, messages, tools } = params;

  const pauseToolCall = toolCalls.find(tc => isPauseForInputTool(String(tc.name), getToolArgs(tc)));
  if (!pauseToolCall || !mcpServices || !avatarId) {
    return null;
  }

  const pauseToolName = String(pauseToolCall.name);

  // Detect if the same pause tool was just called in the previous assistant message
  // This can indicate a loop where the user cancelled the dialog or the tool call failed
  if (messages.length >= 1) {
    const lastAssistantMsg = [...messages].reverse().find(m => m.role === 'assistant');
    if (lastAssistantMsg && Array.isArray(lastAssistantMsg.tool_calls)) {
      const lastPauseToolCall = lastAssistantMsg.tool_calls.find(tc =>
        typeof tc === 'object' && tc !== null && 'function' in tc &&
        isPauseForInputTool(tc.function?.name || '', {})
      );
      if (lastPauseToolCall && lastPauseToolCall.function?.name === pauseToolName) {
        logger.warn('Pause tool called again consecutively', {
          event: 'pause_tool_repeat_detected',
          pauseToolName,
          messageHistoryLength: messages.length,
        });
        // Don't immediately return error; let the fallback loop handle it
        // This allows detection of true loops (multiple repeated attempts)
      }
    }
  }

  const toolName = String(pauseToolCall.name);
  const payload = await buildPauseToolPayload({
    toolName,
    args: getToolArgs(pauseToolCall),
    mcpServices,
    avatarId,
    tools,
  });

  const pendingToolCall = {
    id: String(pauseToolCall.id),
    name: payload.toolName,
    arguments: payload.arguments,
  };

  const response = buildPendingToolResponse(payload.toolName, payload.arguments);
  const shouldOverrideToolCall = payload.toolName !== toolName;
  const toolCallsForHistory = shouldOverrideToolCall
    ? [
        {
          id: pendingToolCall.id,
          type: 'function' as const,
          function: {
            name: payload.toolName,
            arguments: JSON.stringify(payload.arguments),
          },
        },
      ]
    : adminToolCalls.length > 0
      ? adminToolCalls
      : [toAdminToolCall(pauseToolCall)];

  const updatedMessages = [...messages];
  updatedMessages.push({
    role: 'assistant',
    content: response,
    tool_calls: toolCallsForHistory,
  });

  return {
    response,
    history: updatedMessages,
    pendingToolCall,
  };
}
