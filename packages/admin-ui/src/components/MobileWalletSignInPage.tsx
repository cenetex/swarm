import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { WalletReadyState } from '@solana/wallet-adapter-base';
import { useWallet } from '@solana/wallet-adapter-react';
import { approveMobileWalletPairing } from '../auth/mobile-wallet-pairing';
import { useAuthStore } from '../store/auth';
import { humanizeWalletAdapterError } from '../store/wallet-errors';

function pairingFromLocation(): string | null {
  const pairingId = new URLSearchParams(window.location.search).get('pairing') ?? '';
  return /^[A-Za-z0-9_-]{24,64}$/u.test(pairingId) ? pairingId : null;
}

function pairingPurposeFromLocation(): 'sign-in' | 'link' {
  return new URLSearchParams(window.location.search).get('purpose') === 'link' ? 'link' : 'sign-in';
}

export function MobileWalletSignInPage() {
  const pairingId = useMemo(pairingFromLocation, []);
  const purpose = useMemo(pairingPurposeFromLocation, []);
  const { connect, connected, connecting, publicKey, select, signMessage, wallet, wallets } = useWallet();
  const walletError = useAuthStore((state) => state.walletError);
  const clearWalletError = useAuthStore((state) => state.clearWalletError);
  const [pending, setPending] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');
  const approvalStarted = useRef(false);
  const pairingCode = pairingId?.slice(0, 6).toUpperCase() ?? '';
  const installedWallet = wallets.find(({ readyState }) => readyState === WalletReadyState.Installed)
    ?? wallets.find(({ readyState }) => readyState === WalletReadyState.Loadable);

  const signApproval = useCallback(async () => {
    if (!pairingId || !publicKey || !signMessage || approvalStarted.current) return;
    approvalStarted.current = true;
    setPending(true);
    setError('');
    clearWalletError();
    try {
      const approval = await approveMobileWalletPairing({
        pairingId,
        walletAddress: publicKey.toBase58(),
        signMessage,
      });
      if (purpose === 'link' && approval.status === 'approved') {
        throw new Error('Wallet link approval response is invalid.');
      }
      setSuccess(true);
    } catch (approvalError) {
      setError(approvalError instanceof Error ? approvalError.message : 'Wallet approval failed.');
      approvalStarted.current = false;
    } finally {
      setPending(false);
    }
  }, [clearWalletError, pairingId, publicKey, purpose, signMessage]);

  useEffect(() => {
    if (pending && connected && publicKey && signMessage && !success) {
      void signApproval();
    }
  }, [connected, pending, publicKey, signApproval, signMessage, success]);

  useEffect(() => {
    if (
      !pending
      || connected
      || connecting
      || success
      || !wallet
      || (
        wallet.readyState !== WalletReadyState.Installed
        && wallet.readyState !== WalletReadyState.Loadable
      )
    ) return;
    void connect().catch((connectError: unknown) => {
      setError(humanizeWalletAdapterError(connectError));
      setPending(false);
    });
  }, [connect, connected, connecting, pending, success, wallet]);

  useEffect(() => {
    if (pending && walletError && !connecting && !connected) setPending(false);
  }, [connected, connecting, pending, walletError]);

  const handleApprove = async () => {
    if (!pairingId) return;
    clearWalletError();
    setError('');
    if (connected) {
      await signApproval();
      return;
    }
    setPending(true);
    if (wallet && (
      wallet.readyState === WalletReadyState.Installed
      || wallet.readyState === WalletReadyState.Loadable
    )) {
      return;
    }
    if (installedWallet) {
      select(installedWallet.adapter.name);
      return;
    }
    setError('Open this page inside Phantom or Solflare, then try again.');
    setPending(false);
  };

  if (!pairingId) {
    return (
      <main className="grid min-h-[100dvh] place-items-center bg-[var(--color-bg)] p-5 text-[var(--color-text)]">
        <div className="max-w-sm rounded-2xl border border-red-500/30 bg-red-500/10 p-6 text-center">
          <h1 className="text-xl font-semibold">Invalid sign-in QR</h1>
          <p className="mt-2 text-sm text-red-100">Start again from Swarm on your computer.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="grid min-h-[100dvh] place-items-center bg-[var(--color-bg)] p-5 text-[var(--color-text)]">
      <section className="w-full max-w-sm rounded-3xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-6 text-center shadow-2xl">
        <img src="/swarm.svg" alt="" className="mx-auto h-14 w-14" />
        {success ? (
          <>
            <div className="mx-auto mt-5 grid h-12 w-12 place-items-center rounded-full bg-emerald-400/15 text-2xl text-emerald-300">✓</div>
            <h1 className="mt-4 text-2xl font-semibold">
              {purpose === 'link' ? 'Wallet linked' : 'Sign-in approved'}
            </h1>
            <p className="mt-2 text-sm leading-6 text-[var(--color-text-secondary)]">
              Return to Swarm on your other device. This page can now be closed.
            </p>
          </>
        ) : (
          <>
            <p className="mt-5 text-xs font-semibold uppercase tracking-[0.18em] text-brand-300">Swarm Hosted</p>
            <h1 className="mt-1 text-2xl font-semibold">
              {purpose === 'link' ? 'Link this wallet' : 'Approve sign-in'}
            </h1>
            <p className="mt-3 text-sm leading-6 text-[var(--color-text-secondary)]">
              Your wallet will sign a message for Swarm. No transaction is sent and no funds move.
            </p>
            <div className="mt-4 rounded-xl bg-[var(--color-bg)] px-4 py-3">
              <p className="text-xs text-[var(--color-text-muted)]">Pairing code</p>
              <p className="mt-1 font-mono text-lg tracking-[0.2em]">{pairingCode}</p>
            </div>
            <button
              type="button"
              onClick={() => void handleApprove()}
              disabled={pending || connecting}
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-brand-500 to-brand-600 px-4 py-3 font-medium text-white shadow-lg shadow-brand-500/25 disabled:cursor-wait disabled:opacity-70"
            >
              {(pending || connecting) && <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />}
              <span>
                {connected
                  ? purpose === 'link' ? 'Sign wallet link' : 'Sign login message'
                  : purpose === 'link' ? 'Approve wallet link' : 'Approve sign-in'}
              </span>
            </button>
            {(error || walletError) && (
              <p className="mt-3 text-xs leading-5 text-red-300">{error || walletError}</p>
            )}
          </>
        )}
      </section>
    </main>
  );
}
