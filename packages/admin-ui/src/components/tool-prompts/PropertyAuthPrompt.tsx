/**
 * Property Research Authorization Prompt
 * Shows grant/deny buttons for enabling property research
 */
import { useState } from 'react';
import type { ToolPromptProps } from './types';

export function PropertyAuthPrompt({ toolCall, onSubmit, disabled }: ToolPromptProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [responded, setResponded] = useState<'granted' | 'denied' | null>(null);

  const { reason } = toolCall.arguments as {
    reason?: string;
  };

  const handleResponse = async (granted: boolean) => {
    if (isSubmitting) return;

    setIsSubmitting(true);
    try {
      await onSubmit(toolCall.id, { granted });
      setResponded(granted ? 'granted' : 'denied');
    } catch {
      setIsSubmitting(false);
    }
  };

  if (responded) {
    return (
      <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${
        responded === 'granted'
          ? 'bg-green-500/10 border border-green-500/30'
          : 'bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]'
      }`}>
        <span className={responded === 'granted' ? 'text-green-300' : 'text-[var(--color-text-secondary)]'}>
          {responded === 'granted' ? '✓ Property research enabled' : '✗ Property research denied'}
        </span>
      </div>
    );
  }

  return (
    <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 space-y-2">
      <div className="flex items-start gap-2">
        <div className="p-1.5 bg-amber-500/20 rounded-md">
          <svg className="w-4 h-4 text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-medium text-amber-100">Property Research Authorization</h4>
          {reason && (
            <p className="text-xs text-amber-200/80 mt-0.5">{reason}</p>
          )}
          <p className="text-[11px] text-amber-300/60 mt-1">
            Allows the avatar to search property listings, comparables, and neighborhood data.
          </p>
        </div>
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => handleResponse(false)}
          disabled={disabled || isSubmitting}
          className="flex-1 px-3 py-1.5 text-sm bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-elevated)] disabled:opacity-50 text-[var(--color-text)] rounded-lg transition-colors"
        >
          Deny
        </button>
        <button
          onClick={() => handleResponse(true)}
          disabled={disabled || isSubmitting}
          className="flex-1 px-3 py-1.5 text-sm bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white rounded-lg transition-colors"
        >
          {isSubmitting ? 'Enabling...' : 'Grant Access'}
        </button>
      </div>
    </div>
  );
}
