/**
 * Shared state hook for tool prompts that follow the simple
 * idle -> processing -> success / error lifecycle.
 *
 * Not intended for multi-step state machines like WalletLinkPrompt
 * or OAuth flows like TwitterConnectPrompt.
 */
import { useState, useCallback } from 'react';

export type PromptPhase = 'idle' | 'processing' | 'success' | 'error';

interface UseToolPromptStateOptions {
  /** Called when `submit` is invoked. Should perform the async work. */
  onSubmit: (toolCallId: string, result: unknown) => void | Promise<void>;
  toolCallId: string;
}

interface UseToolPromptStateReturn {
  phase: PromptPhase;
  error: string | null;
  /** Trigger the submit flow. Transitions idle -> processing -> success / error. */
  submit: (result: unknown) => Promise<void>;
  /** Reset from error back to idle so the user can try again. */
  retry: () => void;
}

export function useToolPromptState({
  onSubmit,
  toolCallId,
}: UseToolPromptStateOptions): UseToolPromptStateReturn {
  const [phase, setPhase] = useState<PromptPhase>('idle');
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    async (result: unknown) => {
      if (phase === 'processing') return;

      setPhase('processing');
      setError(null);

      try {
        await onSubmit(toolCallId, result);
        setPhase('success');
      } catch (err) {
        setPhase('error');
        setError(err instanceof Error ? err.message : 'Something went wrong');
      }
    },
    [phase, onSubmit, toolCallId],
  );

  const retry = useCallback(() => {
    setPhase('idle');
    setError(null);
  }, []);

  return { phase, error, submit, retry };
}
