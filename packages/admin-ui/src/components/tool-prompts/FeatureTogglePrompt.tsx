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
      <div className={`flex items-center gap-2 px-4 py-3 rounded-lg ${
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
    <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg p-4 space-y-3">
      <div className="flex items-start gap-3">
        <div className={`p-2 rounded-lg ${currentEnabled ? 'bg-green-500/20' : 'bg-[var(--color-bg-tertiary)]'}`}>
          <svg className={`w-5 h-5 ${currentEnabled ? 'text-green-400' : 'text-[var(--color-text-tertiary)]'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        </div>
        <div className="flex-1">
          <h4 className="font-medium text-[var(--color-text)]">{args.label}</h4>
          {args.description && (
            <p className="text-sm text-[var(--color-text-secondary)] mt-1">{args.description}</p>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between pt-2 border-t border-[var(--color-border)]">
        <span className="text-sm text-[var(--color-text-secondary)]">
          {currentEnabled ? 'Currently enabled' : 'Currently disabled'}
        </span>
        <button
          onClick={handleToggle}
          disabled={disabled || isSubmitting}
          className={`relative w-14 h-7 rounded-full transition-colors ${
            disabled || isSubmitting ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
          } ${
            currentEnabled
              ? 'bg-green-600 hover:bg-green-700'
              : 'bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-elevated)]'
          }`}
        >
          <span
            className={`absolute top-1 w-5 h-5 bg-white rounded-full transition-transform shadow-xs ${
              currentEnabled ? 'left-8' : 'left-1'
            }`}
          />
        </button>
      </div>
    </div>
  );
}
