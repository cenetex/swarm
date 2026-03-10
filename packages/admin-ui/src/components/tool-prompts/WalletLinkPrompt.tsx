/**
 * Wallet Link Prompt - Inline chat prompt for linking an additional Solana wallet.
 *
 * Flow:
 * 1. User clicks a wallet button (e.g. "Phantom")
 * 2. The wallet extension opens for approval
 * 3. A challenge is requested from the backend
 * 4. The user signs the challenge message with the connected wallet
 * 5. The signed message is sent to the backend for verification
 * 6. On success the account is refreshed so the new wallet appears in identities
 *
 * NOTE: This bypasses the @solana/wallet-adapter modal and connects to wallet
 * extensions directly. The adapter modal conflicts with Privy's wallet standard
 * connectors, causing click handlers to silently fail (issue #948).
 */
import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type { ToolPromptProps } from './types';
import { API_BASE } from './types';
import { PromptSuccess, PromptError } from './PromptStatus';
import { signWalletLinkMessage, type PhantomProvider } from '../../auth/wallet-linking';
import { humanizeWalletSignatureError } from '../../auth/wallet-errors';
import { useAuthStore } from '../../store/auth';
import { CopyableAddress } from '../CopyableAddress';

type LinkStatus = 'idle' | 'connecting' | 'challenging' | 'signing' | 'verifying' | 'success' | 'error';

/** Timeout (ms) for wallet connection approval. */
const CONNECT_TIMEOUT_MS = 30_000;

interface DetectedWallet {
  name: string;
  icon: string;
  provider: PhantomProvider;
}

/** Detect Solana wallet extensions injected into the browser. */
function detectWallets(): DetectedWallet[] {
  if (typeof window === 'undefined') return [];
  const wallets: DetectedWallet[] = [];

  const win = window as unknown as Record<string, unknown>;

  // Phantom
  const phantom = win.phantom as
    | { solana?: PhantomProvider & { isPhantom?: boolean } }
    | undefined;
  if (phantom?.solana?.isPhantom) {
    wallets.push({
      name: 'Phantom',
      icon: 'https://phantom.app/img/phantom-icon-purple-rounded.png',
      provider: phantom.solana,
    });
  }

  // Solflare
  const solflare = win.solflare as
    | (PhantomProvider & { isSolflare?: boolean })
    | undefined;
  if (solflare?.isSolflare) {
    wallets.push({
      name: 'Solflare',
      icon: 'https://solflare.com/favicon.ico',
      provider: solflare,
    });
  }

  // Backpack
  const backpack = win.backpack as
    | (PhantomProvider & { isBackpack?: boolean })
    | undefined;
  if (backpack?.isBackpack) {
    wallets.push({
      name: 'Backpack',
      icon: 'https://backpack.app/favicon.ico',
      provider: backpack,
    });
  }

  return wallets;
}

export function WalletLinkPrompt({ toolCall, onSubmit, disabled }: ToolPromptProps) {
  const refreshAccount = useAuthStore((s) => s.refreshAccount);
  const account = useAuthStore((s) => s.account);

  const [status, setStatus] = useState<LinkStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [linkedAddress, setLinkedAddress] = useState<string | null>(null);
  // Counter to re-detect wallets on retry (extensions may load late).
  const [detectAttempt, setDetectAttempt] = useState(0);

  // Ref to track challenge expiry timer so we can clear it.
  const challengeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const args = toolCall.arguments as { reason?: string };

  // Re-detect wallets when detectAttempt changes (e.g. on retry after error).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const detectedWallets = useMemo(() => detectWallets(), [detectAttempt]);

  const linkedWallets = useMemo(
    () => account?.identities
      ?.filter((i) => i.type === 'wallet')
      .map((i) => i.providerId) ?? [],
    [account?.identities],
  );

  const handleLinkWithProvider = useCallback(async (provider: PhantomProvider) => {
    // Guard against double-clicks — ignore if already processing.
    if (['connecting', 'challenging', 'signing', 'verifying'].includes(status)) return;

    setErrorMessage(null);

    try {
      // Step 0: Connect to wallet directly (bypasses adapter modal)
      setStatus('connecting');

      if (!provider.isConnected && provider.connect) {
        // Race the connection against a timeout so the UI doesn't get stuck
        // if the user never approves/rejects the popup.
        const connectResult = await Promise.race([
          provider.connect(),
          new Promise<'timeout'>((resolve) =>
            setTimeout(() => resolve('timeout'), CONNECT_TIMEOUT_MS),
          ),
        ]);
        if (connectResult === 'timeout') {
          setStatus('idle');
          setErrorMessage('Wallet connection timed out. Please try again.');
          setDetectAttempt((n) => n + 1);
          return;
        }
      }

      const walletAddress = provider.publicKey?.toString();
      if (!walletAddress) {
        throw new Error('Wallet did not return a public key after connecting.');
      }

      // Check if this wallet is already linked
      if (linkedWallets.includes(walletAddress)) {
        setStatus('idle');
        setErrorMessage('This wallet is already linked to your account.');
        return;
      }

      // Step 1: Request challenge
      setStatus('challenging');
      const challengeResponse = await fetch(`${API_BASE}/auth/link/wallet/challenge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ walletAddress }),
      });

      if (!challengeResponse.ok) {
        const errorData = await challengeResponse.json().catch(() => ({})) as { error?: string };
        throw new Error(errorData.error || `Challenge request failed (${challengeResponse.status})`);
      }

      const { nonce, message, expiresAt } = await challengeResponse.json() as {
        nonce: string;
        message: string;
        expiresAt?: string;
      };

      // Step 2: Sign the challenge
      setStatus('signing');

      // Track challenge TTL — if the backend returned an expiresAt timestamp,
      // start a timer so we surface a clear error instead of a cryptic 400.
      if (expiresAt) {
        const ttlMs = new Date(expiresAt).getTime() - Date.now();
        if (ttlMs > 0) {
          challengeTimerRef.current = setTimeout(() => {
            setStatus('error');
            setErrorMessage('Challenge expired. Please try again.');
          }, ttlMs);
        }
      }

      const messageBytes = new TextEncoder().encode(message);

      const { signatureBase58 } = await signWalletLinkMessage({
        message: messageBytes,
        phantomProvider: provider,
      });

      // Clear challenge TTL timer — signing succeeded before expiry.
      if (challengeTimerRef.current) {
        clearTimeout(challengeTimerRef.current);
        challengeTimerRef.current = null;
      }

      // Step 3: Verify signature
      setStatus('verifying');
      const verifyResponse = await fetch(`${API_BASE}/auth/link/wallet/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          walletAddress,
          nonce,
          signature: signatureBase58,
        }),
      });

      if (!verifyResponse.ok) {
        const errorData = await verifyResponse.json().catch(() => ({})) as { error?: string };
        throw new Error(errorData.error || `Verification failed (${verifyResponse.status})`);
      }

      // Success - refresh account to pick up the new identity
      setStatus('success');
      setLinkedAddress(walletAddress);
      const refreshOk = await refreshAccount();
      if (!refreshOk) {
        console.warn('[WalletLinkPrompt] Account refresh failed after successful link — UI may be stale.');
      }

      // Submit tool result so the chat conversation can continue
      onSubmit(toolCall.id, {
        linked: true,
        walletAddress,
      });
    } catch (err) {
      // Clear any pending challenge timer on error.
      if (challengeTimerRef.current) {
        clearTimeout(challengeTimerRef.current);
        challengeTimerRef.current = null;
      }

      setStatus('error');
      setErrorMessage(humanizeWalletSignatureError(err));
      // Re-detect wallets on error so late-loading extensions get picked up.
      setDetectAttempt((n) => n + 1);
    }
  }, [status, linkedWallets, refreshAccount, onSubmit, toolCall.id]);

  // ------------------------------------------------------------------
  // Cleanup challenge timer on unmount.
  // ------------------------------------------------------------------
  useEffect(() => {
    return () => {
      if (challengeTimerRef.current) {
        clearTimeout(challengeTimerRef.current);
      }
    };
  }, []);

  // Success state
  if (status === 'success' && linkedAddress) {
    return (
      <PromptSuccess message="">
        <span className="text-green-300">
          Wallet linked: <CopyableAddress address={linkedAddress} />
        </span>
      </PromptSuccess>
    );
  }

  const isProcessing = ['connecting', 'challenging', 'signing', 'verifying'].includes(status);

  const statusLabel =
    status === 'connecting' ? 'Connecting...' :
    status === 'challenging' ? 'Requesting challenge...' :
    status === 'signing' ? 'Sign in your wallet...' :
    status === 'verifying' ? 'Verifying...' :
    null;

  return (
    <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg p-3 space-y-2">
      <div className="flex items-start gap-2">
        <div className="p-1.5 bg-brand-500/20 rounded-md flex-shrink-0">
          <svg className="w-4 h-4 text-brand-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-medium text-[var(--color-text)]">
            Link a Wallet
          </h4>
          <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">
            {args.reason || 'Connect and sign with a Solana wallet to link it to your account.'}
          </p>

          {linkedWallets.length > 0 && (
            <div className="mt-2">
              <p className="text-xs text-[var(--color-text-muted)] mb-1">Currently linked wallets:</p>
              <div className="flex flex-wrap gap-1">
                {linkedWallets.map((addr) => (
                  <span
                    key={addr}
                    className="inline-flex items-center px-2 py-0.5 rounded text-xs font-mono bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]"
                  >
                    {addr.slice(0, 4)}...{addr.slice(-4)}
                  </span>
                ))}
              </div>
            </div>
          )}

          {errorMessage && (
            <div className="mt-2">
              <PromptError message={errorMessage} />
            </div>
          )}

          <p className="text-[11px] text-[var(--color-text-muted)] mt-1">
            Signing does not trigger any transaction or cost fees.
          </p>
        </div>
      </div>

      {/* Processing indicator */}
      {isProcessing && statusLabel && (
        <div className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
          <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          {statusLabel}
        </div>
      )}

      {/* Wallet buttons — shown when idle or error (retry) */}
      {!isProcessing && (
        <div className="flex flex-col gap-2">
          {detectedWallets.length > 0 ? (
            <>
              {detectedWallets.map((wallet) => (
                <button
                  key={wallet.name}
                  onClick={() => handleLinkWithProvider(wallet.provider)}
                  disabled={disabled}
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-sm bg-brand-600 hover:bg-brand-700 disabled:bg-[var(--color-bg-tertiary)] disabled:cursor-not-allowed text-white rounded-lg transition-colors"
                >
                  <img
                    src={wallet.icon}
                    alt={wallet.name}
                    className="w-4 h-4 rounded"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                  />
                  {status === 'error' ? `Retry with ${wallet.name}` : `Connect ${wallet.name}`}
                </button>
              ))}
            </>
          ) : (
            <div className="text-sm text-[var(--color-text-secondary)] bg-[var(--color-bg-tertiary)] rounded-lg p-3">
              No Solana wallet detected. Please install{' '}
              <a
                href="https://phantom.app"
                target="_blank"
                rel="noopener noreferrer"
                className="text-brand-400 hover:text-brand-300 underline"
              >
                Phantom
              </a>{' '}
              or another Solana wallet extension and reload this page.
            </div>
          )}

          {/* Cancel button */}
          <button
            onClick={() => {
              onSubmit(toolCall.id, { linked: false, cancelled: true });
            }}
            disabled={disabled}
            className="px-3 py-1.5 text-sm bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-elevated)] disabled:opacity-50 text-[var(--color-text)] rounded-lg transition-colors"
          >
            Skip
          </button>
        </div>
      )}
    </div>
  );
}
