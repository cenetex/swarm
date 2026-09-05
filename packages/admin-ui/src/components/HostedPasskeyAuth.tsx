import { useState } from 'react';
import { applyAuthenticatedBackendSession } from '../auth/bootstrap';
import {
  registerHostedPasskey,
  signInWithHostedPasskey,
  supportsPasskeys,
} from '../auth/hosted-passkeys';
import { useAuth } from '../store/auth';

interface HostedPasskeyAuthProps {
  className?: string;
  label?: string;
  onUseWallet?: () => void;
}

type PasskeyIssue = {
  title: string;
  detail: string;
};

function errorName(error: unknown): string {
  return typeof error === 'object' && error !== null && 'name' in error
    ? String(error.name)
    : '';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.toLowerCase() : '';
}

export function passkeyIssue(error: unknown, isRegistration: boolean): PasskeyIssue {
  const name = errorName(error);
  const message = errorMessage(error);

  if (
    name === 'NotAllowedError'
    || name === 'AbortError'
    || name === 'TimeoutError'
    || message.includes('not allowed by the user agent')
    || message.includes('denied permission')
  ) {
    return {
      title: 'Passkey did not open',
      detail: 'Try again. If this page opened inside another app, open it in Safari or Chrome.',
    };
  }
  if (name === 'SecurityError' || message.includes('secure context') || message.includes('permissions policy')) {
    return {
      title: 'Open Swarm in your browser',
      detail: 'Passkeys work from the secure Swarm page in Safari or Chrome.',
    };
  }
  if (message.includes('invalid or expired')) {
    return {
      title: 'This passkey needs a refresh',
      detail: isRegistration
        ? 'Try adding it again.'
        : 'Use your wallet once, then add a fresh passkey from your account card.',
    };
  }
  if (
    name === 'NetworkError'
    || name === 'TypeError'
    || message.includes('network')
    || message.includes('fetch')
  ) {
    return {
      title: 'Connection interrupted',
      detail: 'Check your connection, then try again.',
    };
  }
  return {
    title: isRegistration ? 'Passkey was not added' : 'Passkey sign-in paused',
    detail: 'Try again. You can also use a wallet.',
  };
}

function passkeyContextIssue(): PasskeyIssue | null {
  if (typeof window === 'undefined') return null;
  if (window.isSecureContext === false) {
    return {
      title: 'Open the secure Swarm page',
      detail: 'Passkeys need the HTTPS version of Swarm in Safari or Chrome.',
    };
  }
  return null;
}

export function HostedPasskeyAuth({ className = '', label, onUseWallet }: HostedPasskeyAuthProps) {
  const { isAuthenticated } = useAuth();
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');
  const [issue, setIssue] = useState<PasskeyIssue | null>(null);

  const handlePasskey = async () => {
    setMessage('');
    setIssue(null);
    if (!supportsPasskeys()) {
      setIssue({
        title: 'Passkeys are unavailable here',
        detail: 'Open Swarm in Safari or Chrome, or use a wallet.',
      });
      return;
    }
    const contextIssue = passkeyContextIssue();
    if (contextIssue) {
      setIssue(contextIssue);
      return;
    }
    setWorking(true);
    try {
      if (isAuthenticated) {
        await registerHostedPasskey();
        setMessage('Passkey added. You can use it the next time you sign in.');
      } else {
        const session = await signInWithHostedPasskey();
        if (!applyAuthenticatedBackendSession(session)) throw new Error('Passkey session could not be applied.');
      }
    } catch (passkeyError) {
      setIssue(passkeyIssue(passkeyError, isAuthenticated));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => void handlePasskey()}
        disabled={working}
        className={`flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition disabled:cursor-wait disabled:opacity-60 ${
          isAuthenticated
            ? 'border border-brand-400/40 bg-brand-400/10 text-brand-200 hover:bg-brand-400/20'
            : 'bg-gradient-to-r from-brand-500 to-brand-600 text-white shadow-lg shadow-brand-500/25 hover:from-brand-600 hover:to-brand-700'
        }`}
      >
        {working ? (
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
        ) : (
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11V8a4 4 0 118 0v3m-7 0h6a2 2 0 012 2v6H7v-6a2 2 0 012-2zm3 4h.01" />
          </svg>
        )}
        <span>{working ? 'Waiting for your device' : label ?? (isAuthenticated ? 'Add a passkey' : 'Sign in with a passkey')}</span>
      </button>
      {message && <p className="mt-2 text-xs leading-5 text-emerald-300" role="status">{message}</p>}
      {issue && (
        <div className="mt-3 rounded-xl border border-amber-400/30 bg-amber-400/10 p-3" role="alert">
          <p className="text-sm font-semibold text-amber-100">{issue.title}</p>
          <p className="mt-1 text-sm leading-5 text-[var(--color-text-secondary)]">{issue.detail}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void handlePasskey()}
              className="rounded-lg bg-[var(--color-text)] px-3 py-2 text-xs font-semibold text-[var(--color-bg)]"
            >
              Try passkey again
            </button>
            {!isAuthenticated && onUseWallet && (
              <button
                type="button"
                onClick={onUseWallet}
                className="rounded-lg border border-[var(--color-border-secondary)] px-3 py-2 text-xs font-semibold text-[var(--color-text)]"
              >
                Use a wallet
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
