/**
 * Resume Chat Module
 *
 * Handles resuming a chat conversation after the UI submits a tool result
 * (e.g., model selection, integration config, secret input).
 */
import {
  DEFAULT_LLM_MAX_TOKENS,
  DEFAULT_LLM_MODEL,
  DEFAULT_LLM_PROVIDER,
  DEFAULT_LLM_TEMPERATURE,
  detectEnabledCategories,
  type ToolCategory,
} from '@swarm/core';
import type { AdminChatMessage, ToolResult, UserSession } from '../../types.js';
import * as chatHistory from '../../services/chat-history.js';
import * as pendingTools from '../../services/pending-tools.js';
import * as avatars from '../../services/avatars.js';
import { configureIntegration } from '../../services/integrations.js';
import { syncAvatarConfig } from '../../services/config-sync.js';
import { getValidModelId } from '../../services/models-registry.js';
import { resolveOpenRouterChatModelPlan } from '../../services/openrouter-chat-models.js';
import { createSystemLogger } from '../../services/structured-logger.js';
import { LLM_MODEL } from '../chat-llm.js';
import type { AvatarContext, ProcessChatResult } from './types.js';

const log = createSystemLogger('resume-chat');

// Import processChat from chat.ts -- this creates a circular reference that is
// resolved at runtime because ES modules use live bindings.
// We use a late-binding callback pattern instead to avoid circular imports.
type ProcessChatFn = (
  userMessage: string | null,
  conversationHistory: AdminChatMessage[],
  session: UserSession,
  avatar?: AvatarContext,
  options?: { customSystemPrompt?: string; attachments?: Array<{ type: 'image' | 'file' | 'audio'; data: string; name?: string }>; model?: string; maxTokens?: number }
) => Promise<ProcessChatResult>;

/**
 * Resume the admin chat conversation after the UI submits a tool result.
 * This appends a proper `role: tool` message (with `tool_call_id`) and lets the model continue.
 */
export async function resumeChatAfterToolResult(
  params: {
    avatarId: string;
    toolCallId: string;
    result: unknown;
    session: UserSession;
  },
  processChat: ProcessChatFn
): Promise<ProcessChatResult> {
  const { avatarId, toolCallId, result, session } = params;

  // Validate required parameters
  if (!session.email) {
    throw new Error('Session email is required to resume tool call');
  }
  if (!avatarId) {
    throw new Error('Avatar ID is required to resume tool call');
  }
  if (!toolCallId) {
    throw new Error('Tool call ID is required to resume tool call');
  }

  const avatarRecord = await avatars.getAvatar(avatarId);
  const voiceEnabled = process.env.ENABLE_VOICE_TOOLS !== 'false';
  const mcpConfig = avatarRecord?.mcpConfig;
  const enabledToolsets = mcpConfig?.enabledToolsets || [];
  const enabledCategories: ToolCategory[] | undefined = avatarRecord
    ? detectEnabledCategories({
        voice: voiceEnabled,
        memory: enabledToolsets.includes('memory'),
        telegram: Boolean(avatarRecord.platforms?.telegram?.enabled),
        twitter: Boolean(avatarRecord.platforms?.twitter?.enabled),
        discord: Boolean(avatarRecord.platforms?.discord?.enabled),
        nft: true,
        property: enabledToolsets.includes('property'),
        signalStation: enabledToolsets.includes('signal-station'),
      })
    : undefined;
  const avatarContext: AvatarContext | undefined = avatarRecord
    ? {
        id: avatarId,
        name: avatarRecord.name,
        description: avatarRecord.description,
        persona: avatarRecord.persona,
        enabledCategories,
      }
    : { id: avatarId, enabledCategories };

  const history = await chatHistory.getChatHistory(session, avatarId);

  // Validate toolCallId against the pending tool store (server-issued proof)
  // and fall back to chat history scan for backward compatibility.
  const pendingRecord = await pendingTools.getPendingTool(session.email, avatarId);
  const historyToolCalls = history
    .filter(m => m.role === 'assistant' && Array.isArray(m.tool_calls))
    .flatMap(m => m.tool_calls || []);
  const matchingHistoryToolCall = historyToolCalls.find(tc => tc.id === toolCallId);
  const hasMatchingToolCall = Boolean(matchingHistoryToolCall);

  const validatedViaPendingStore = pendingRecord?.toolCallId === toolCallId;
  const validatedToolName = pendingRecord?.toolName || (() => {
    if (!matchingHistoryToolCall) return undefined;
    const call = matchingHistoryToolCall as { name?: string; function?: { name?: string } };
    return call.function?.name || call.name;
  })();

  log.info('resume', 'tool_call_validation_started', {
    toolCallId,
    hasPendingRecord: !!pendingRecord,
    pendingRecordToolCallId: pendingRecord?.toolCallId,
    hasMatchingToolCall,
    validatedViaPendingStore,
    historyLength: history.length,
    email: session.email,
    avatarId,
  });

  if (validatedViaPendingStore) {
    // Valid — server issued this tool call. Defer consumption until the
    // resume flow succeeds so the record survives downstream failures.
    log.info('resume', 'tool_call_validated_via_pending_store', { toolCallId });
  } else if (hasMatchingToolCall) {
    // Valid — still in chat history.
    log.info('resume', 'tool_call_validated_via_history', { toolCallId });
  } else {
    // If validation fails, log detailed info including all tool calls in history
    const toolCallsInHistory = historyToolCalls.map(tc => {
      const call = tc as {
        id?: string;
        name?: string;
        type?: string;
        function?: { name?: string };
      };
      return {
        id: call.id,
        name: call.function?.name || call.name,
        type: call.type,
      };
    });

    log.error('resume', 'tool_call_validation_failed', {
      toolCallId,
      hasPendingRecord: !!pendingRecord,
      pendingRecordToolCallId: pendingRecord?.toolCallId,
      pendingRecordToolName: pendingRecord?.toolName,
      hasMatchingToolCall,
      historyLength: history.length,
      email: session.email,
      avatarId,
      toolCallsInHistory,
    });
    throw new Error(`Unknown or expired toolCallId: ${toolCallId}`);
  }

  // If the matching assistant tool_call was stripped from history (by sanitization
  // or TTL expiry), inject a synthetic assistant message so the LLM provider
  // sees a proper assistant→tool message pair.
  let baseHistory = history;
  if (!hasMatchingToolCall && pendingRecord) {
    baseHistory = [
      ...history,
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: toolCallId,
          type: 'function' as const,
          function: {
            name: pendingRecord.toolName,
            arguments: JSON.stringify(pendingRecord.arguments),
          },
        }],
      },
    ];
  }

  // Handle request_model_selection results server-side so the pending tool
  // record is consumed consistently with every other manual tool prompt.
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const resultObj = result as Record<string, unknown>;
    if (validatedToolName === 'request_model_selection' && typeof resultObj.selectedModel === 'string') {
      const selectedModel = getValidModelId(resultObj.selectedModel);
      if (!selectedModel) {
        throw new Error(`Unknown or unsupported model ID: ${resultObj.selectedModel}`);
      }

      const currentConfig = avatarRecord?.llmConfig || {
        provider: DEFAULT_LLM_PROVIDER,
        model: DEFAULT_LLM_MODEL,
        temperature: DEFAULT_LLM_TEMPERATURE,
        maxTokens: DEFAULT_LLM_MAX_TOKENS,
        useGlobalKey: true,
      };
      await avatars.updateAvatar(avatarId, {
        llmConfig: {
          ...currentConfig,
          provider: currentConfig.provider || DEFAULT_LLM_PROVIDER,
          model: selectedModel,
        },
      }, session);

      const response = `Model updated to ${selectedModel}.`;
      const nextHistory: AdminChatMessage[] = [
        ...baseHistory,
        {
          role: 'tool',
          tool_call_id: toolCallId,
          content: JSON.stringify({ selectedModel }),
        } as ToolResult,
        {
          role: 'assistant',
          content: response,
        },
      ];

      await chatHistory.saveChatHistory(session, nextHistory, avatarId);

      if (validatedViaPendingStore) {
        await pendingTools.removePendingTool(session.email, avatarId);
      }

      return {
        response,
        history: nextHistory,
      };
    }
  }

  // Handle configure_integration results - persist models and settings to DynamoDB
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const resultObj = result as Record<string, unknown>;
    if (resultObj.configured === true && typeof resultObj.integration === 'string') {
      const integration = resultObj.integration as 'replicate' | 'openai' | 'anthropic' | 'openrouter' | 'telegram' | 'twitter' | 'discord' | 'solana' | 'ethereum' | 'web';
      const useGlobalKey = typeof resultObj.useGlobalKey === 'boolean' ? resultObj.useGlobalKey : undefined;
      const models = resultObj.models && typeof resultObj.models === 'object'
        ? resultObj.models as Record<string, string>
        : undefined;

      try {
        await configureIntegration({
          avatarId,
          integration,
          enabled: true,
          useGlobalKey,
          models,
          session,
        });
        log.info('integration', 'config_saved', { integration, avatarId });

        // Sync to STATE_TABLE so handlers pick up the new config
        const updatedAvatar = await avatars.getAvatar(avatarId);
        if (updatedAvatar) {
          await syncAvatarConfig(updatedAvatar);
          log.info('integration', 'config_synced_to_state_table', { integration, avatarId });
        }
      } catch (err) {
        log.error('integration', 'config_save_failed', {
          integration,
          avatarId,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }
  }

  const toolContent = typeof result === 'string' ? result : JSON.stringify(result ?? {});

  const nextHistory: AdminChatMessage[] = [
    ...baseHistory,
    {
      role: 'tool',
      tool_call_id: toolCallId,
      content: toolContent,
    } as ToolResult,
  ];

  const avatarMaxTokens = avatarRecord?.llmConfig?.maxTokens;
  const resolvedModel = (await resolveOpenRouterChatModelPlan({
    requestModel: undefined,
    avatarModel: avatarRecord?.llmConfig?.model,
    defaultModel: LLM_MODEL,
  })).primaryModel;
  const chatResult = await processChat(null, nextHistory, session, avatarContext, {
    model: resolvedModel,
    maxTokens: typeof avatarMaxTokens === 'number' ? avatarMaxTokens : undefined,
  });

  await chatHistory.saveChatHistory(session, chatResult.history, avatarId);

  // Consume the pending tool record only after the full resume flow succeeds.
  // This preserves the record as retry proof if any downstream step fails.
  if (validatedViaPendingStore) {
    await pendingTools.removePendingTool(session.email, avatarId);
  }

  return chatResult;
}
