/**
 * TaskCard — standalone transcript item for tool interactions.
 *
 * Renders as its own item in the transcript timeline (not inside a message
 * bubble). Reads from the task card store for authoritative state so it
 * survives setChat() / syncChatHistory() replacing the message array.
 */
import { useTaskCardStore, type TaskCard as TaskCardType } from '../../store/task-cards';
import { useWorkspaceStore } from '../../store/workspace';
import { ToolPrompt } from './index';
import { PromptSuccess, PromptError } from './PromptStatus';
import type { ToolSubmitResult } from './types';
import type { ToolCall } from '../../types';

/** Human-readable labels for tool names. */
const TOOL_LABELS: Record<string, string> = {
  request_secret: 'Secret Input',
  prompt_secret: 'Secret Input',
  confirm_action: 'Confirmation',
  request_wallet_link: 'Wallet Link',
  request_twitter_connection: 'Twitter Connect',
  twitter_request_integration: 'Twitter Connect',
  request_feature_toggle: 'Feature Toggle',
  request_property_research: 'Property Auth',
  configure_integration: 'Integration Setup',
  set_profile_image: 'Profile Upload',
  get_profile_upload_url: 'Image Upload',
  get_reference_image_upload_url: 'Reference Upload',
  set_character_reference: 'Character Reference',
  get_my_gallery: 'Media Gallery',
  search_gallery: 'Gallery Search',
  get_my_wallets: 'Wallet Overview',
  report_issue: 'Issue Report',
  report_user_feedback: 'User Feedback',
};

function getToolLabel(card: TaskCardType): string {
  const args = card.arguments;
  if (args?.type === 'model_selector') return 'Model Selection';
  if (args?.type === 'feature_toggle') return 'Feature Toggle';
  if (args?.type === 'upload_url') return 'File Upload';
  if (args?.type === 'twitter_connect') return 'Twitter Connect';
  return TOOL_LABELS[card.toolName] || 'Action Required';
}

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
    const label = TOOL_LABELS[toolName] ?? 'this form';
    return `${label} expired before you submitted it. Ask again to get a fresh one.`;
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
      return typeof result?.error === 'string' ? result.error as string : 'Failed';
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

interface TaskCardProps {
  cardId: string;
  onSubmit: (toolCallId: string, result: unknown) => Promise<ToolSubmitResult>;
  disabled?: boolean;
}

export function TaskCard({ cardId, onSubmit, disabled }: TaskCardProps) {
  const card = useTaskCardStore((s) => s.cards[cardId]);
  const toggleExpanded = useTaskCardStore((s) => s.toggleExpanded);
  const openForTask = useWorkspaceStore((s) => s.openForTask);

  if (!card) return null;

  const isResolved = card.status !== 'pending';
  const label = getToolLabel(card);
  const summary = card.summary || (isResolved ? getResolvedSummary(card) : undefined);

  // Build a ToolCall object for the pending ToolPrompt component
  const toolCallForPrompt: ToolCall = {
    id: card.id,
    name: card.toolName,
    arguments: card.arguments,
    status: 'pending',
  };

  return (
    <div className={`flex justify-start mb-3 lg:mb-4`}>
      <div className={`max-w-[85%] lg:max-w-[75%] w-full border-l-2 ${STATUS_COLORS[card.status]} rounded-lg bg-[var(--color-bg-secondary)] overflow-hidden`}>
        {/* Header — always shown for resolved, acts as collapse toggle */}
        <button
          onClick={() => toggleExpanded(card.id)}
          className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[var(--color-bg-tertiary)] transition-colors"
        >
          <svg
            className={`w-3 h-3 text-[var(--color-text-muted)] transition-transform ${card.inlineExpanded ? 'rotate-90' : ''}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <span className="text-xs font-medium text-[var(--color-text-secondary)]">{label}</span>
          {isResolved && summary && (
            <span className="ml-auto text-xs text-[var(--color-text-muted)]">{summary}</span>
          )}
          {!isResolved && (
            <span className="ml-auto text-xs text-brand-400">Waiting for input</span>
          )}
          {/* Open in workspace button */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              openForTask(card.id, label);
            }}
            className="flex-shrink-0 p-1 rounded hover:bg-[var(--color-bg-elevated)] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition-colors"
            title="Open in workspace"
            aria-label="Open in workspace"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
              <path d="M4.25 5.5a.75.75 0 00-.75.75v8.5c0 .414.336.75.75.75h8.5a.75.75 0 00.75-.75v-4a.75.75 0 011.5 0v4A2.25 2.25 0 0112.75 17h-8.5A2.25 2.25 0 012 14.75v-8.5A2.25 2.25 0 014.25 4h5a.75.75 0 010 1.5h-5z" />
              <path d="M6.194 12.753a.75.75 0 001.06.053L16.5 4.44v2.81a.75.75 0 001.5 0v-4.5a.75.75 0 00-.75-.75h-4.5a.75.75 0 000 1.5h2.553l-9.056 8.194a.75.75 0 00-.053 1.06z" />
            </svg>
          </button>
        </button>

        {/* Body */}
        {card.inlineExpanded && (
          <div className="px-3 pb-3">
            {card.status === 'completed' && (
              <PromptSuccess message={getSuccessMessage(card)} />
            )}
            {card.status === 'failed' && (
              <PromptError
                message={humanizeTaskError(
                  typeof (card.result as Record<string, unknown>)?.error === 'string'
                    ? (card.result as Record<string, unknown>).error as string
                    : 'Action failed',
                  card.toolName,
                )}
              />
            )}
            {card.status === 'cancelled' && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] text-sm">
                <span className="text-[var(--color-text-secondary)]">Cancelled</span>
              </div>
            )}
            {card.status === 'pending' && (
              <ToolPrompt
                toolCall={toolCallForPrompt}
                onSubmit={onSubmit}
                disabled={disabled}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
