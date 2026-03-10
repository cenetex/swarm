/**
 * Feature Toggle Prompt - Feature enable/disable toggle switch
 */
import { useState, useEffect } from 'react';
import type { ToolPromptProps } from './types';

export function FeatureTogglePrompt({ toolCall, onSubmit, disabled }: ToolPromptProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [enabled, setEnabled] = useState<boolean | null>(null);

  const args = toolCall.arguments as {
    feature: string;
    currentState: boolean;
    label: string;
    description?: string;
  };

  // Initialize with current state
  useEffect(() => {
    if (enabled === null) {
      setEnabled(args.currentState);
    }
  }, [args.currentState, enabled]);

  const handleToggle = async () => {
    if (isSubmitting || enabled === null) return;

    const newState = !enabled;
    setEnabled(newState);
    setIsSubmitting(true);

    try {
      await onSubmit(toolCall.id, { feature: args.feature, enabled: newState });
      setSubmitted(true);
    } catch {
      setEnabled(!newState); // Revert on error
      setIsSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${
        enabled
          ? 'bg-green-500/10 border border-green-500/30'
          : 'bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]'
      }`}>
        <span className={enabled ? 'text-green-300' : 'text-[var(--color-text-secondary)]'}>
          {args.label}: {enabled ? 'Enabled' : 'Disabled'}
        </span>
      </div>
    );
  }

  const currentEnabled = enabled ?? args.currentState;

  return (
    <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg p-3 space-y-2">
      <div className="flex items-center gap-2">
        <div className={`p-1.5 rounded-md ${currentEnabled ? 'bg-green-500/20' : 'bg-[var(--color-bg-tertiary)]'}`}>
          <svg className={`w-4 h-4 ${currentEnabled ? 'text-green-400' : 'text-[var(--color-text-tertiary)]'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-medium text-[var(--color-text)]">{args.label}</h4>
          {args.description && (
            <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">{args.description}</p>
          )}
        </div>
        <button
          onClick={handleToggle}
          disabled={disabled || isSubmitting}
          className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ${
            disabled || isSubmitting ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
          } ${
            currentEnabled
              ? 'bg-green-600 hover:bg-green-700'
              : 'bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-elevated)]'
          }`}
        >
          <span
            className={`absolute top-0.5 w-5 h-5 bg-white rounded-full transition-transform shadow-xs ${
              currentEnabled ? 'left-[22px]' : 'left-0.5'
            }`}
          />
        </button>
      </div>
    </div>
  );
}
