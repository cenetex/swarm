/**
 * Wallet Link Prompt - Inline chat prompt for linking an additional Solana wallet.
 *
 * Flow:
 * 1. User clicks "Connect & Link Wallet"
 * 2. Wallet adapter opens to select/connect a wallet
 * 3. A challenge is requested from the backend
 * 4. The user signs the challenge message with the connected wallet
 * 5. The signed message is sent to the backend for verification
 * 6. On success the account is refreshed so the new wallet appears in identities
 */
import { useState, useCallback } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import type { ToolPromptProps } from './types';
import { API_BASE } from './types';
import { signWalletLinkMessage } from '../../auth/wallet-linking';
import { useAuthStore } from '../../store/auth';
import { CopyableAddress } from '../CopyableAddress';

type LinkStatus = 'idle' | 'connecting' | 'challenging' | 'signing' | 'verifying' | 'success' | 'error';

export function WalletLinkPrompt({ toolCall, onSubmit, disabled }: ToolPromptProps) {
  const { publicKey, signMessage, connected, disconnect } = useWallet();
  const { setVisible: openWalletModal } = useWalletModal();
  const refreshAccount = useAuthStore((s) => s.refreshAccount);
  const account = useAuthStore((s) => s.account);

  const [status, setStatus] = useState<LinkStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [linkedAddress, setLinkedAddress] = useState<string | null>(null);

  const args = toolCall.arguments as { reason?: string };

  const linkedWallets = account?.identities
    ?.filter((i) => i.type === 'wallet')
    .map((i) => i.providerId) ?? [];

  const handleLink = useCallback(async () => {
    setErrorMessage(null);

    // If no wallet is connected, open the modal
    if (!connected || !publicKey) {
      setStatus('connecting');
      openWalletModal(true);
      return;
    }

    const walletAddress = publicKey.toBase58();

    // Check if this wallet is already linked
    if (linkedWallets.includes(walletAddress)) {
      setErrorMessage('This wallet is already linked to your account.');
      return;
    }

    try {
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

      const { nonce, message } = await challengeResponse.json() as { nonce: string; message: string };

      // Step 2: Sign the challenge
      setStatus('signing');
      const messageBytes = new TextEncoder().encode(message);

      const { signatureBase58 } = await signWalletLinkMessage({
        message: messageBytes,
        privySignMessage: signMessage
          ? async (msg: Uint8Array) => {
              const sig = await signMessage(msg);
              return sig;
            }
          : undefined,
      });

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
      await refreshAccount();

      // Submit tool result so the chat conversation can continue
      onSubmit(toolCall.id, {
        linked: true,
        walletAddress,
      });
    } catch (err) {
      setStatus('error');
      const msg = err instanceof Error ? err.message : 'Wallet linking failed';
      setErrorMessage(msg);
    }
  }, [connected, publicKey, signMessage, openWalletModal, linkedWallets, refreshAccount, onSubmit, toolCall.id]);

  // After wallet modal connects, re-trigger the link flow
  const handleRetryAfterConnect = useCallback(() => {
    if (connected && publicKey) {
      handleLink();
    }
  }, [connected, publicKey, handleLink]);

  // Success state
  if (status === 'success' && linkedAddress) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 bg-green-500/10 border border-green-500/30 rounded-lg">
        <svg className="w-5 h-5 text-green-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
        <span className="text-green-300">
          Wallet linked: <CopyableAddress address={linkedAddress} />
        </span>
      </div>
    );
  }

  const statusLabels: Record<LinkStatus, string> = {
    idle: 'Connect & Link Wallet',
    connecting: 'Waiting for wallet...',
    challenging: 'Requesting challenge...',
    signing: 'Sign in your wallet...',
    verifying: 'Verifying signature...',
    success: 'Done',
    error: 'Try Again',
  };

  const isProcessing = ['challenging', 'signing', 'verifying'].includes(status);

  return (
    <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg p-4 space-y-3">
      <div className="flex items-start gap-3">
        <div className="p-2 bg-brand-500/20 rounded-lg flex-shrink-0">
          <svg className="w-5 h-5 text-brand-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="font-medium text-[var(--color-text)]">
            Link a Wallet
          </h4>
          <p className="text-sm text-[var(--color-text-secondary)] mt-1">
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
            <p className="text-sm text-red-400 mt-2">{errorMessage}</p>
          )}

          <p className="text-xs text-[var(--color-text-muted)] mt-2">
            Signing does not trigger any blockchain transaction or cost any fees.
          </p>
        </div>
      </div>

      <div className="flex gap-2">
        {/* If we were in "connecting" status and wallet connected, show continue button */}
        {status === 'connecting' && connected && publicKey ? (
          <button
            onClick={handleRetryAfterConnect}
            className="flex-1 px-4 py-2 bg-brand-600 hover:bg-brand-700 disabled:bg-[var(--color-bg-tertiary)] disabled:cursor-not-allowed text-white rounded-lg transition-colors"
          >
            Continue with {publicKey.toBase58().slice(0, 4)}...{publicKey.toBase58().slice(-4)}
          </button>
        ) : (
          <button
            onClick={handleLink}
            disabled={disabled || isProcessing}
            className="flex-1 px-4 py-2 bg-brand-600 hover:bg-brand-700 disabled:bg-[var(--color-bg-tertiary)] disabled:cursor-not-allowed text-white rounded-lg transition-colors flex items-center justify-center gap-2"
          >
            {isProcessing && (
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            )}
            {statusLabels[status]}
          </button>
        )}

        {/* Cancel button to dismiss without linking */}
        {status !== 'success' && !isProcessing && (
          <button
            onClick={() => {
              onSubmit(toolCall.id, { linked: false, cancelled: true });
            }}
            disabled={disabled || isProcessing}
            className="px-4 py-2 bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-elevated)] disabled:opacity-50 text-[var(--color-text)] rounded-lg transition-colors"
          >
            Skip
          </button>
        )}

        {/* Disconnect current wallet if one is connected but user wants to switch */}
        {connected && status === 'idle' && (
          <button
            onClick={() => {
              disconnect().catch(() => {});
            }}
            className="px-4 py-2 text-sm text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] rounded-lg transition-colors"
            title="Disconnect current wallet to link a different one"
          >
            Switch
          </button>
        )}
      </div>
    </div>
  );
}
