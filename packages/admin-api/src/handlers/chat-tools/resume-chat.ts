/* eslint-disable no-console -- TODO: migrate to structured logger */
/**
 * Resume Chat Module
 *
 * Handles resuming a chat conversation after the UI submits a tool result
 * (e.g., model selection, integration config, secret input).
 */
import { detectEnabledCategories, type ToolCategory } from '@swarm/core';
import type { AdminChatMessage, ToolResult, UserSession } from '../../types.js';
import * as chatHistory from '../../services/chat-history.js';
import * as avatars from '../../services/avatars.js';
import { configureIntegration } from '../../services/integrations.js';
import { syncAvatarConfig } from '../../services/config-sync.js';
import { resolveChatModel } from '../../services/models-registry.js';
import { LLM_MODEL } from '../chat-llm.js';
import type { AvatarContext, ProcessChatResult } from './types.js';

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

  const hasMatchingToolCall = history.some(m =>
    m.role === 'assistant' &&
    Array.isArray(m.tool_calls) &&
    m.tool_calls.some(tc => tc.id === toolCallId)
  );
  if (!hasMatchingToolCall) {
    // The toolCallId may be missing from history due to TTL expiry or
    // message sanitization stripping unmatched tool_calls.  If the ID
    // looks like a valid provider-issued call ID, allow it through —
    // downstream tool handlers validate the actual payload.  (#1039)
    const looksValid = /^(call_|chatcmpl-|toolu_)/.test(toolCallId) || toolCallId.length >= 20;
    if (!looksValid) {
      throw new Error(`Unknown or expired toolCallId: ${toolCallId}`);
    }
    console.warn(
      `[resumeChatAfterToolResult] toolCallId not found in chat history (may have expired); allowing valid-format ID through: ${toolCallId}`
    );
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
        console.log(`[resumeChatAfterToolResult] Saved ${integration} config for avatar ${avatarId}`);

        // Sync to STATE_TABLE so handlers pick up the new config
        const updatedAvatar = await avatars.getAvatar(avatarId);
        if (updatedAvatar) {
          await syncAvatarConfig(updatedAvatar);
          console.log(`[resumeChatAfterToolResult] Synced config to STATE_TABLE for avatar ${avatarId}`);
        }
      } catch (err) {
        console.error(`[resumeChatAfterToolResult] Failed to save ${integration} config:`, err instanceof Error ? err.message : 'Unknown error');
      }
    }
  }

  const toolContent = typeof result === 'string' ? result : JSON.stringify(result ?? {});

  // If the matching assistant tool_call was stripped from history (by sanitization
  // or TTL expiry), inject a synthetic assistant message so the LLM provider
  // sees a proper assistant→tool message pair.  (#1039)
  let baseHistory = history;
  if (!hasMatchingToolCall) {
    const toolName = (result && typeof result === 'object' && 'integration' in (result as Record<string, unknown>))
      ? 'configure_integration'
      : 'pending_tool';
    baseHistory = [
      ...history,
      {
        role: 'assistant',
        content: null as unknown as string,
        tool_calls: [{
          id: toolCallId,
          type: 'function' as const,
          function: { name: toolName, arguments: '{}' },
        }],
      },
    ];
  }

  const nextHistory: AdminChatMessage[] = [
    ...baseHistory,
    {
      role: 'tool',
      tool_call_id: toolCallId,
      content: toolContent,
    } as ToolResult,
  ];

  const avatarMaxTokens = avatarRecord?.llmConfig?.maxTokens;
  const resolvedModel = resolveChatModel({
    requestModel: undefined,
    avatarModel: avatarRecord?.llmConfig?.model,
    defaultModel: LLM_MODEL,
  });
  const chatResult = await processChat(null, nextHistory, session, avatarContext, {
    model: resolvedModel,
    maxTokens: typeof avatarMaxTokens === 'number' ? avatarMaxTokens : undefined,
  });

  await chatHistory.saveChatHistory(session, chatResult.history, avatarId);
  return chatResult;
}
