/**
 * Shared types for tool prompt components
 */
import type { ToolCall } from '../../types';

/**
 * Result of submitting a tool call from a prompt component.
 *
 * Prompt components can `await onSubmit(...)` and branch on `result.ok`
 * to render inline success/failure state, instead of optimistically
 * assuming success (which previously produced the "Saved" + global
 * "tool call error" contradiction during Telegram save failures).
 *
 * `onSubmit` never throws — failure is always a resolved `{ ok: false }`.
 * Consumers that don't care about the result can ignore the returned
 * Promise; that's safe at runtime.
 */
export type ToolSubmitResult =
  | { ok: true }
  | { ok: false; error: string };

export interface ToolPromptProps {
  toolCall: ToolCall;
  onSubmit: (toolCallId: string, result: unknown) => Promise<ToolSubmitResult>;
  disabled?: boolean;
}

export const API_BASE = import.meta.env.VITE_API_URL || '/api';
