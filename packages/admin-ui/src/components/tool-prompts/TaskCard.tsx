/**
 * TaskCard — compact transcript reference for a tool interaction.
 *
 * Renders as its own item in the transcript timeline (not inside a message
 * bubble). The full prompt UX lives in the workspace Tools tab — this card
 * is just a label + status + "Open" affordance pointing there (#1637).
 *
 * Exception: `confirm_action` keeps an inline-expanded yes/no prompt so
 * tiny confirmations don't force a workspace context switch.
 */
import { useTaskCardStore, type TaskCard as TaskCardType } from '../../store/task-cards';
import { useWorkspaceStore } from '../../store/workspace';
import { ToolPrompt } from './index';
import { PromptError } from './PromptStatus';
import type { ToolSubmitResult } from './types';
import type { ToolCall } from '../../types';
import { getToolLabel, isInlineOnly } from './tool-labels';

/** Success-specific summary for completed cards. */
function getSuccessMessage(card: TaskCardType): string {
  const result = card.result as Record<string, unknown> | undefined;
  const args = card.arguments;
  switch (card.toolName) {
    case 'configure_integration': {
      const integration = result?.integration || args?.integration;
      return integration ? `${String(integration)} configured` : 'Integration configured';
    }
    case 'confirm_action':
      return result?.confirmed ? 'Confirmed' : 'Cancelled';
    case 'request_secret':
    case 'prompt_secret':
      return 'Secret saved';
    case 'request_wallet_link':
      return 'Wallet linked';
    case 'request_twitter_connection':
    case 'twitter_request_integration':
      return 'Twitter connected';
    case 'request_feature_toggle':
      return 'Features updated';
    case 'request_property_research':
      return 'Property authorized';
    default:
      if (args?.type === 'model_selector') return 'Model selected';
      if (args?.type === 'feature_toggle') return 'Features updated';
      if (args?.type === 'upload_url') return 'Upload complete';
      if (args?.type === 'twitter_connect') return 'Twitter connected';
      return 'Completed';
  }
}

/**
 * Translate raw server errors to plain-English recovery messages. Keeps the
 * original text as a fallback so we don't hide genuinely new failure modes.
 */
function humanizeTaskError(raw: string, toolName: string): string {
  if (/Unknown or expired toolCallId/i.test(raw)) {
    return `${getToolLabel({ toolName, arguments: {} })} expired before you submitted it. Ask again to get a fresh one.`;
  }
  return raw;
}

/** Status-aware summary — returns appropriate text for any resolved status. */
function getResolvedSummary(card: TaskCardType): string {
  switch (card.status) {
    case 'completed':
      return getSuccessMessage(card);
    case 'cancelled':
      return 'Cancelled';
    case 'failed': {
      const result = card.result as Record<string, unknown> | undefined;
      return typeof result?.error === 'string'
        ? humanizeTaskError(result.error as string, card.toolName)
        : 'Failed';
    }
    default:
      return '';
  }
}

const STATUS_COLORS = {
  pending: 'border-l-brand-500',
  completed: 'border-l-green-500',
  failed: 'border-l-red-500',
  cancelled: 'border-l-gray-500',
} as const;

const STATUS_DOT = {
  pending: 'bg-brand-400 animate-pulse',
  completed: 'bg-green-500',
  failed: 'bg-red-500',
  cancelled: 'bg-gray-500',
} as const;

interface TaskCardProps {
  cardId: string;
  onSubmit: (toolCallId: string, result: unknown) => Promise<ToolSubmitResult>;
  disabled?: boolean;
}

export function TaskCard({ cardId, onSubmit, disabled }: TaskCardProps) {
  const card = useTaskCardStore((s) => s.cards[cardId]);
  const openForTask = useWorkspaceStore((s) => s.openForTask);

  if (!card) return null;

  const isPending = card.status === 'pending';
  const isResolved = !isPending;
  const label = getToolLabel(card);
  const summary = card.summary || (isResolved ? getResolvedSummary(card) : '');
  const inlineOnly = isInlineOnly(card.toolName);

  // Inline-only tools (e.g. confirm_action) keep the legacy expanded form
  // since they're tiny enough that a workspace switch is overkill.
  if (inlineOnly && isPending) {
    const toolCallForPrompt: ToolCall = {
      id: card.id,
      name: card.toolName,
      arguments: card.arguments,
      status: 'pending',
    };
    return (
      <div className="flex justify-start mb-3 lg:mb-4">
        <div className={`max-w-[85%] lg:max-w-[75%] w-full border-l-2 ${STATUS_COLORS[card.status]} rounded-lg bg-[var(--color-bg-secondary)] overflow-hidden`}>
          <div className="px-3 py-2 flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${STATUS_DOT[card.status]}`} aria-hidden />
            <span className="text-xs font-medium text-[var(--color-text-secondary)]">{label}</span>
          </div>
          <div className="px-3 pb-3">
            <ToolPrompt toolCall={toolCallForPrompt} onSubmit={onSubmit} disabled={disabled} />
          </div>
        </div>
      </div>
    );
  }

  // Resolved card with a failure: surface the error inline (small, helpful)
  if (card.status === 'failed') {
    return (
      <div className="flex justify-start mb-3 lg:mb-4">
        <div className={`max-w-[85%] lg:max-w-[75%] w-full border-l-2 ${STATUS_COLORS[card.status]} rounded-lg bg-[var(--color-bg-secondary)] overflow-hidden`}>
          <div className="px-3 py-2 flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${STATUS_DOT[card.status]}`} aria-hidden />
            <span className="text-xs font-medium text-[var(--color-text-secondary)]">{label}</span>
          </div>
          <div className="px-3 pb-3">
            <PromptError message={summary || 'Action failed'} />
          </div>
        </div>
      </div>
    );
  }

  // Default compact view: tool label + status dot + Open / summary
  return (
    <div className="flex justify-start mb-3 lg:mb-4">
      <div className={`max-w-[85%] lg:max-w-[75%] w-full border-l-2 ${STATUS_COLORS[card.status]} rounded-lg bg-[var(--color-bg-secondary)]`}>
        <div className="flex items-center gap-2 px-3 py-2">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_DOT[card.status]}`} aria-hidden />
          <span className="text-xs font-medium text-[var(--color-text-secondary)] truncate">{label}</span>
          {isResolved && summary && (
            <span className="ml-auto text-xs text-[var(--color-text-muted)] truncate">{summary}</span>
          )}
          {isPending && (
            <button
              onClick={() => openForTask(card.id, label)}
              className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium bg-brand-500/10 text-brand-400 hover:bg-brand-500/20 transition-colors"
              aria-label={`Open ${label} in workspace`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3 h-3">
                <path d="M4.25 5.5a.75.75 0 00-.75.75v8.5c0 .414.336.75.75.75h8.5a.75.75 0 00.75-.75v-4a.75.75 0 011.5 0v4A2.25 2.25 0 0112.75 17h-8.5A2.25 2.25 0 012 14.75v-8.5A2.25 2.25 0 014.25 4h5a.75.75 0 010 1.5h-5z" />
                <path d="M6.194 12.753a.75.75 0 001.06.053L16.5 4.44v2.81a.75.75 0 001.5 0v-4.5a.75.75 0 00-.75-.75h-4.5a.75.75 0 000 1.5h2.553l-9.056 8.194a.75.75 0 00-.053 1.06z" />
              </svg>
              Open
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
