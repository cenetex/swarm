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
}
function passkeyErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return 'Passkey prompt was cancelled or timed out.';
  }
  if (error instanceof Error && error.message === 'Passkey sign-in is invalid or expired.') {
    return 'This passkey could not be verified. Sign in with your wallet, then add the passkey again.';
  }
  return error instanceof Error ? error.message : fallback;
}

export function HostedPasskeyAuth({ className = '' }: HostedPasskeyAuthProps) {
  const { isAuthenticated } = useAuth();
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const handlePasskey = async () => {
    setMessage('');
    setError('');
    if (!supportsPasskeys()) {
      setError('This browser does not support passkeys. Use wallet sign-in instead.');
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
      setError(passkeyErrorMessage(
        passkeyError,
        isAuthenticated ? 'Passkey setup failed.' : 'Passkey sign-in failed.',
      ));
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
        className="flex w-full items-center justify-center gap-2 rounded-xl border border-brand-400/40 bg-brand-400/10 px-4 py-2.5 text-sm font-semibold text-brand-200 transition hover:bg-brand-400/20 disabled:cursor-wait disabled:opacity-60"
      >
        {working ? (
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
        ) : (
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11V8a4 4 0 118 0v3m-7 0h6a2 2 0 012 2v6H7v-6a2 2 0 012-2zm3 4h.01" />
          </svg>
        )}
        <span>{working ? 'Waiting for your device' : isAuthenticated ? 'Add a passkey' : 'Sign in with a passkey'}</span>
      </button>
      {message && <p className="mt-2 text-xs leading-5 text-emerald-300" role="status">{message}</p>}
      {error && <p className="mt-2 text-xs leading-5 text-red-400" role="alert">{error}</p>}
    </div>
  );
}
