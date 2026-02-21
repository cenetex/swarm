/**
 * Shared status display components for tool prompts.
 *
 * These extract the recurring success / error / processing patterns
 * that were previously duplicated across SecretPrompt, UploadPrompt,
 * WalletLinkPrompt, ConfirmPrompt, and TwitterConnectPrompt.
 *
 * Visual styles are kept identical to the originals.
 */
import type { ReactNode } from 'react';

/* ---------- Success ---------- */

interface PromptSuccessProps {
  message: string;
  /** Optional extra content rendered after the message (e.g. a thumbnail). */
  children?: ReactNode;
}

/**
 * Green checkmark bar shown after a tool prompt completes successfully.
 * Matches the style previously in SecretPrompt, UploadPrompt, and WalletLinkPrompt.
 */
export function PromptSuccess({ message, children }: PromptSuccessProps) {
  return (
    <div className="flex items-center gap-2 px-4 py-3 bg-green-500/10 border border-green-500/30 rounded-lg">
      {children}
      <svg className="w-5 h-5 text-green-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
      </svg>
      <span className="text-green-300">{message}</span>
    </div>
  );
}

/* ---------- Error ---------- */

interface PromptErrorProps {
  message: string;
  /** When provided, a "Retry" button is rendered alongside the message. */
  onRetry?: () => void;
}

/**
 * Red error bar with optional retry button.
 * Consolidates the various `text-red-400` error displays from UploadPrompt,
 * WalletLinkPrompt, and TwitterConnectPrompt.
 */
export function PromptError({ message, onRetry }: PromptErrorProps) {
  return (
    <div className="flex items-center gap-2 text-red-400 text-sm">
      <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <span>{message}</span>
      {onRetry && (
        <button
          onClick={onRetry}
          className="ml-auto text-red-300 hover:text-red-200 underline text-sm"
        >
          Retry
        </button>
      )}
    </div>
  );
}

/* ---------- Processing ---------- */

interface PromptProcessingProps {
  message: string;
}

/**
 * Spinner with a label.
 * Matches the uploading spinner from UploadPrompt and the processing
 * indicator used in WalletLinkPrompt.
 */
export function PromptProcessing({ message }: PromptProcessingProps) {
  return (
    <div className="flex items-center gap-2">
      <div className="w-5 h-5 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
      <span className="text-[var(--color-text-secondary)]">{message}</span>
    </div>
  );
}
