/**
 * Twitter Connect Prompt - OAuth2 flow for Twitter/X authorization
 *
 * NOTE: onSubmit is intentionally NOT called from this component. The OAuth
 * flow opens in a separate popup window, and the tool call is marked as
 * completed when the OAuth callback fires (handled by handleTwitterOAuthResult
 * in App.tsx). The prompt only needs to launch the popup and show a waiting
 * state; it does not own the success/completion lifecycle.
 */
import { useState } from 'react';
import type { ToolPromptProps } from './types';
import { API_BASE } from './types';
import { PromptError } from './PromptStatus';
import { useActiveAvatar } from '../../store';

export function TwitterConnectPrompt({ toolCall, onSubmit: _onSubmit, disabled }: ToolPromptProps) {
  const activeAgent = useActiveAvatar();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);

  const args = toolCall.arguments as { message?: string };

  const handleConnect = async () => {
    if (!activeAgent?.id || disabled || isSubmitting) return;

    setIsSubmitting(true);
    setError(null);
    // Open OAuth start endpoint in a new tab/window. This endpoint will redirect to X.
    const url = `${API_BASE}/oauth/twitter/start?avatarId=${encodeURIComponent(activeAgent.id)}&reconnect=1`;
    setOauthUrl(url);
    const opened = window.open(url, '_blank', 'noopener,noreferrer');
    if (!opened) {
      setIsSubmitting(false);
      setError('Popup blocked. Allow popups, or open the link manually.');
      return;
    }

    // Don't call onSubmit here - OAuth is still in progress
    // The tool call will be marked completed when OAuth finishes (via handleTwitterOAuthResult in App.tsx)
    setStarted(true);
    setIsSubmitting(false);
  };

  // Only hide when completed - the success/error message will be shown separately by App.tsx
  if (toolCall.status === 'completed') {
    return null;
  }

  // Show waiting state while user is in OAuth popup
  if (started) {
    return (
      <div className="bg-[var(--color-bg-secondary)] border border-yellow-500/30 rounded-lg p-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-yellow-500/20 rounded-lg">
            <svg className="w-5 h-5 text-yellow-400 animate-pulse" fill="currentColor" viewBox="0 0 24 24">
              <path d="M13.95 10.85L20.54 3h-1.56l-5.74 6.84L8.5 3H3.1l6.92 10.09L3.1 21h1.56l5.97-7.11L15.5 21h5.4l-6.95-10.15zm-2.45 2.92l-.7-1.03L5.8 4.5h2.46l4.06 5.98.7 1.02 5.24 7.71h-2.46l-4.3-6.44z" />
            </svg>
          </div>
          <div className="flex-1">
            <h4 className="font-medium text-[var(--color-text)]">Waiting for Authorization</h4>
            <p className="text-sm text-[var(--color-text-secondary)] mt-1">
              Complete the X/Twitter authorization in the popup window.
            </p>
          </div>
          <div className="w-5 h-5 border-2 border-yellow-400 border-t-transparent rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  return (
    <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg p-4 space-y-3">
      <div className="flex items-start gap-3">
        <div className="p-2 bg-blue-500/20 rounded-lg">
          <svg className="w-5 h-5 text-blue-300" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M13.95 10.85L20.54 3h-1.56l-5.74 6.84L8.5 3H3.1l6.92 10.09L3.1 21h1.56l5.97-7.11L15.5 21h5.4l-6.95-10.15zm-2.45 2.92l-.7-1.03L5.8 4.5h2.46l4.06 5.98.7 1.02 5.24 7.71h-2.46l-4.3-6.44z" />
          </svg>
        </div>
        <div className="flex-1">
          <h4 className="font-medium text-[var(--color-text)]">Connect X/Twitter</h4>
          <p className="text-sm text-[var(--color-text-secondary)] mt-1">
            {args.message || 'Authorize this avatar to post and manage tweets.'}
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between pt-2 border-t border-[var(--color-border)]">
        <span className="text-xs text-[var(--color-text-muted)]">
          Opens a new window for OAuth authorization (disconnects any existing link first).
        </span>
        <button
          onClick={handleConnect}
          disabled={!activeAgent?.id || disabled || isSubmitting}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-[var(--color-bg-tertiary)] disabled:cursor-not-allowed text-white rounded-lg transition-colors text-sm"
        >
          {isSubmitting ? 'Opening...' : 'Connect X'}
        </button>
      </div>

      {error && (
        <div className="space-y-1">
          <PromptError message={error} />
          {oauthUrl && (
            <a
              className="text-xs underline text-red-400 hover:text-red-300 ml-6"
              href={oauthUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open link manually
            </a>
          )}
        </div>
      )}
    </div>
  );
}
