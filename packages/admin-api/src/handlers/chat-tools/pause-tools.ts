/**
 * Pause Tools Module
 *
 * Handles "pause for input" tool calls -- tools that require user interaction
 * (model selector, feature toggle, secret input, upload prompts, integration config).
 */
import { logger } from '@swarm/core';
import { isPauseForInputTool, type AllServices } from '@swarm/mcp-server';
import type { Tool } from '@openrouter/sdk';
import type { AdminChatMessage } from '../../types.js';
import {
  executeUiTool,
  buildModelSelectorPayload,
  buildFeatureTogglePayload,
  buildPendingToolResponse,
  toAdminToolCall,
  type SdkToolCall,
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

  let pendingArgs = getToolArgs(pauseToolCall);
  const toolName = String(pauseToolCall.name);
  let uiToolName = toolName;

  try {
    if (toolName === 'request_model_selection') {
      const family = typeof pendingArgs.family === 'string'
        ? pendingArgs.family
        : typeof pendingArgs.preferredFamily === 'string'
          ? pendingArgs.preferredFamily
          : undefined;
      pendingArgs = await buildModelSelectorPayload(mcpServices.models, avatarId, family);
    } else if (toolName === 'request_feature_toggle') {
      pendingArgs = await buildFeatureTogglePayload(avatarId, pendingArgs);
    } else if (toolName === 'request_secret') {
      // Normalize secret prompts to configure_integration when applicable
      const secretType = typeof pendingArgs.secretType === 'string'
        ? pendingArgs.secretType
        : typeof pendingArgs.secretKey === 'string'
          ? pendingArgs.secretKey
          : undefined;

      const secretTypeToIntegration: Record<string, 'telegram' | 'twitter' | 'discord' | 'replicate' | 'openai' | 'anthropic' | 'openrouter'> = {
        telegram_bot_token: 'telegram',
        telegram_webhook_secret: 'telegram',
        twitter_api_key: 'twitter',
        twitter_api_secret: 'twitter',
        twitter_access_token: 'twitter',
        twitter_access_secret: 'twitter',
        discord_bot_token: 'discord',
        replicate_api_key: 'replicate',
        replicate_api_token: 'replicate',
        openai_api_key: 'openai',
        anthropic_api_key: 'anthropic',
        openrouter_api_key: 'openrouter',
      };

      const integration = secretType ? secretTypeToIntegration[secretType] : undefined;
      if (integration) {
        pendingArgs = {
          integration,
          reason: typeof pendingArgs.reason === 'string' ? pendingArgs.reason : undefined,
        };
        uiToolName = 'configure_integration';
      }
    } else if (toolName === 'request_twitter_connection' || toolName === 'twitter_request_integration') {
      pendingArgs = {
        integration: 'twitter',
        reason: typeof pendingArgs.message === 'string' ? pendingArgs.message : undefined,
        ...pendingArgs,
      };
      uiToolName = 'configure_integration';
    } else if (
      toolName === 'get_profile_upload_url' ||
      toolName === 'get_reference_image_upload_url' ||
      toolName === 'get_character_reference_upload_url' ||
      toolName === 'set_profile_image' ||
      toolName === 'set_character_reference'
    ) {
      pendingArgs = await executeUiTool(toolName, pendingArgs, tools);
    }
  } catch (error) {
    logger.error('Failed to build pending tool payload', error, {
      toolName,
    });
  }

  const pendingToolCall = {
    id: String(pauseToolCall.id),
    name: uiToolName,
    arguments: pendingArgs,
  };

  const response = buildPendingToolResponse(uiToolName, pendingArgs);
  const shouldOverrideToolCall = uiToolName !== toolName;
  const toolCallsForHistory = shouldOverrideToolCall
    ? [
        {
          id: pendingToolCall.id,
          type: 'function' as const,
          function: {
            name: uiToolName,
            arguments: JSON.stringify(pendingArgs),
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
