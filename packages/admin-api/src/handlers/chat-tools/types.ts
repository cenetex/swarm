/**
 * Shared types for chat-tools modules.
 */
import type { ToolCategory } from '@swarm/core';
import type { ToolContext, TaskAction } from '@swarm/mcp-server';
import type { AdminChatMessage } from '../../types.js';
import type { MediaItem, SdkToolCall } from '../chat-tool-helpers.js';
import type { LlmUsage } from '../chat-llm.js';

export interface AvatarContext {
  id: string;
  name?: string;
  description?: string;
  persona?: string;
  enabledCategories?: ToolCategory[];
}

export interface ProcessChatOptions {
  customSystemPrompt?: string;
  attachments?: Array<{ type: 'image' | 'file' | 'audio'; data: string; name?: string }>;
  model?: string;
  maxTokens?: number;
  /** Account ID of the current user — used to inject linked wallet context. */
  userAccountId?: string;
  /** Active task context from the admin UI (for system prompt enrichment). */
  activeTask?: { taskId: string; toolName: string; status: string; surface: 'inline' | 'workspace' };
}

export interface ProcessChatResult {
  response: string;
  history: AdminChatMessage[];
  media?: MediaItem[];
  pendingJobs?: Array<{ jobId: string; type: 'image' | 'video' | 'sticker'; prompt?: string; purpose?: string }>;
  avatarUpdates?: { profileImageUrl?: string; name?: string };
  pendingToolCall?: {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  };
  /** Structured task actions extracted from tool results — creates transcript cards and workspace suggestions */
  taskActions?: Array<{ toolCallId: string; toolName: string; taskAction: TaskAction }>;
}

/**
 * State accumulated during LLM attempts + tool execution.
 */
export interface LlmAttemptState {
  toolCalls: SdkToolCall[];
  adminToolCalls: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  modelResult: unknown | null;
  usedFallback: boolean;
  fallbackResponse: string;
  lastLlmStart: number;
  lastLlmMode: 'sdk' | 'fallback' | null;
  lastFallbackUsage: LlmUsage | undefined;
  lastFallbackLatency: number | undefined;
}

/**
 * Services/context needed for tool execution.
 */
export interface ToolExecutionContext {
  avatarId: string | undefined;
  toolContext: ToolContext | null;
  mcpServices: unknown | null;
}
