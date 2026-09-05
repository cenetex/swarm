import { useCallback, useEffect, useMemo, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { linkHostedWallet } from '../auth/hosted-wallet-link';
import { humanizeWalletSignatureError } from '../auth/wallet-errors';
import { useAuthStore } from '../store/auth';
import { HostedWalletSignIn } from './HostedWalletSignIn';
import { useUnifiedWalletContext } from './unified-wallet';

function shortWallet(walletAddress: string): string {
  return `${walletAddress.slice(0, 4)}…${walletAddress.slice(-4)}`;
}

export function HostedWalletLink() {
  const authProvider = useAuthStore((state) => state.authProvider);
  const refreshAccount = useAuthStore((state) => state.refreshAccount);
  const walletError = useAuthStore((state) => state.walletError);
  const clearWalletError = useAuthStore((state) => state.clearWalletError);
  const account = useAuthStore((state) => state.account);
  const linkedWallets = useMemo(
    () => account?.identities
      .filter((identity) => identity.type === 'wallet')
      .map((identity) => identity.providerId) ?? [],
    [account?.identities],
  );
  const { connected, connecting, publicKey, signMessage } = useWallet();
  const { setShowModal } = useUnifiedWalletContext();
  const [waitingForWallet, setWaitingForWallet] = useState(false);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const linkWallet = useCallback(async () => {
    if (!publicKey || !signMessage || working) return;
    setWorking(true);
    setWaitingForWallet(false);
    setMessage('');
    setError('');
    clearWalletError();
    try {
      const result = await linkHostedWallet({
        walletAddress: publicKey.toBase58(),
        signMessage,
      });
      const refreshed = await refreshAccount();
      setMessage(refreshed
        ? `${result.status === 'already-linked' ? 'Wallet already linked' : 'Wallet linked'}: ${shortWallet(result.walletAddress)}`
        : `Wallet linked: ${shortWallet(result.walletAddress)}. Reload to refresh the wallet list.`);
    } catch (linkError) {
      setError(humanizeWalletSignatureError(linkError));
    } finally {
      setWorking(false);
    }
  }, [clearWalletError, publicKey, refreshAccount, signMessage, working]);

  useEffect(() => {
    if (waitingForWallet && connected && publicKey && signMessage && !working) {
      void linkWallet();
    }
  }, [connected, linkWallet, publicKey, signMessage, waitingForWallet, working]);

  useEffect(() => {
    if (waitingForWallet && walletError && !connecting && !connected) setWaitingForWallet(false);
  }, [connected, connecting, waitingForWallet, walletError]);

  const handleMobileLinked = useCallback(async (walletAddress: string) => {
    const refreshed = await refreshAccount();
    setMessage(refreshed
      ? `Wallet linked: ${shortWallet(walletAddress)}`
      : `Wallet linked: ${shortWallet(walletAddress)}. Reload to refresh the wallet list.`);
  }, [refreshAccount]);

  if (authProvider !== 'passkey') {
    return (
      <p className="text-xs leading-5 text-[var(--color-text-muted)]">
        Sign in with your passkey to link another wallet to this account.
      </p>
    );
  }

  const handleBrowserLink = () => {
    setMessage('');
    setError('');
    clearWalletError();
    if (connected && publicKey && signMessage) {
      void linkWallet();
      return;
    }
    setWaitingForWallet(true);
    setShowModal(true);
  };

  return (
    <div>
      <p className="text-xs leading-5 text-[var(--color-text-muted)]">
        Link a wallet to this passkey-controlled account by signing. No transaction is sent and no funds move.
      </p>
      {linkedWallets.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1" aria-label="Linked wallets">
          {linkedWallets.map((walletAddress) => (
            <span
              key={walletAddress}
              className="rounded-lg bg-[var(--color-bg)] px-2 py-1 font-mono text-[0.68rem] text-[var(--color-text-secondary)]"
            >
              {shortWallet(walletAddress)}
            </span>
          ))}
        </div>
      )}
      <HostedWalletSignIn
        mode="link"
        label="Link a wallet"
        className="mt-3 w-full justify-center"
        onLinked={handleMobileLinked}
        browserWalletFallback={(
          <button
            type="button"
            onClick={handleBrowserLink}
            disabled={working || connecting}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-[var(--color-border-secondary)] px-4 py-2.5 text-sm font-semibold text-[var(--color-text)] transition hover:border-brand-400 hover:text-brand-200 disabled:cursor-wait disabled:opacity-60"
          >
            {(working || connecting) && (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
            )}
            <span>{working ? 'Waiting for signature' : connecting ? 'Connecting wallet' : 'Use browser wallet'}</span>
          </button>
        )}
      />
      {message && <p className="mt-2 text-xs leading-5 text-emerald-300" role="status">{message}</p>}
      {(error || walletError) && <p className="mt-2 text-xs leading-5 text-red-400" role="alert">{error || walletError}</p>}
    </div>
  );
}
