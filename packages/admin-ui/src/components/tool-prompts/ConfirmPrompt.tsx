/**
 * Confirm Action Prompt - User action confirmation with optional destructive warning
 */
import { useState } from 'react';
import type { ToolPromptProps } from './types';
import { PromptSuccess, PromptError } from './PromptStatus';

export function ConfirmPrompt({ toolCall, onSubmit, disabled }: ToolPromptProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [responded, setResponded] = useState<'confirmed' | 'denied' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { action, description, destructive } = toolCall.arguments as {
    action: string;
    description?: string;
    destructive?: boolean;
  };

  const handleResponse = async (confirmed: boolean) => {
    if (isSubmitting) return;

    setIsSubmitting(true);
    setError(null);
    try {
      await onSubmit(toolCall.id, { confirmed });
      setResponded(confirmed ? 'confirmed' : 'denied');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setIsSubmitting(false);
    }
  };

  if (responded === 'confirmed') {
    return <PromptSuccess message="Confirmed" />;
  }

  if (responded === 'denied') {
    return (
      <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]">
        <span className="text-[var(--color-text-secondary)]">
          ✗ Cancelled
        </span>
      </div>
    );
  }

  return (
    <div className={`border rounded-lg p-4 space-y-3 ${
      destructive
        ? 'bg-red-500/10 border-red-500/30'
        : 'bg-[var(--color-bg-secondary)] border-[var(--color-border)]'
    }`}>
      <div className="flex items-start gap-3">
        <div className={`p-2 rounded-lg ${destructive ? 'bg-red-500/20' : 'bg-brand-500/20'}`}>
          <svg className={`w-5 h-5 ${destructive ? 'text-red-400' : 'text-brand-400'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <div className="flex-1">
          <h4 className="font-medium text-[var(--color-text)]">{action}</h4>
          {description && (
            <p className="text-sm text-[var(--color-text-secondary)] mt-1">{description}</p>
          )}
        </div>
      </div>

      {error && <PromptError message={error} />}

      <div className="flex gap-2">
        <button
          onClick={() => handleResponse(false)}
          disabled={disabled || isSubmitting}
          className="flex-1 px-4 py-2 bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-elevated)] disabled:opacity-50 text-[var(--color-text)] rounded-lg transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={() => handleResponse(true)}
          disabled={disabled || isSubmitting}
          className={`flex-1 px-4 py-2 rounded-lg transition-colors ${
            destructive
              ? 'bg-red-600 hover:bg-red-700'
              : 'bg-brand-600 hover:bg-brand-700'
          } disabled:opacity-50 text-white`}
        >
          {isSubmitting ? 'Processing...' : 'Confirm'}
        </button>
      </div>
    </div>
  );
}
