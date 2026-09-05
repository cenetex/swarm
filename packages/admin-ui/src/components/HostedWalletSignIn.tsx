import { useEffect, useMemo, useState, type ReactNode, type Ref } from 'react';
import QRCode from 'qrcode';
import { applyAuthenticatedBackendSession } from '../auth/bootstrap';
import {
  phantomBrowseUrl,
  pollMobileWalletPairing,
  solflareBrowseUrl,
  startMobileWalletPairing,
  type MobileWalletPairing,
} from '../auth/mobile-wallet-pairing';
import { useAuth } from '../store/auth';
import { PrivyLoginButton } from './PrivyLoginButton';

interface HostedWalletSignInProps {
  browserWalletFallback?: ReactNode;
  buttonRef?: Ref<HTMLButtonElement>;
  className?: string;
  label?: string;
  mode?: 'sign-in' | 'link';
  onLinked?: (walletAddress: string) => void | Promise<void>;
  showIcon?: boolean;
}

type MobileWallet = 'phantom' | 'solflare';
type PairingPhase = 'waiting' | 'paused' | 'expired';

function walletLink(pairing: MobileWalletPairing, wallet: MobileWallet): string {
  return wallet === 'phantom'
    ? phantomBrowseUrl(pairing.mobileUrl)
    : solflareBrowseUrl(pairing.mobileUrl);
}

function pairingErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('expired')) return 'This code expired. Create a new one.';
  if (message.includes('different hosted account')) return 'This wallet is linked to another account.';
  if (message.includes('authentication required') || message.includes('sign in with a passkey')) {
    return 'Your passkey session ended. Sign in again, then link the wallet.';
  }
  if (message.includes('network') || message.includes('fetch')) {
    return 'Connection interrupted. Check your connection, then try again.';
  }
  return 'Wallet connection paused. Try again.';
}

function countdown(expiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.ceil((expiresAt - now) / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

export function HostedWalletSignIn({
  browserWalletFallback,
  buttonRef,
  className = '',
  label,
  mode = 'sign-in',
  onLinked,
  showIcon = true,
}: HostedWalletSignInProps) {
  const { isAuthenticated } = useAuth();
  const [creating, setCreating] = useState(false);
  const [pairing, setPairing] = useState<MobileWalletPairing | null>(null);
  const [wallet, setWallet] = useState<MobileWallet>('phantom');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [phase, setPhase] = useState<PairingPhase>('waiting');
  const [now, setNow] = useState(Date.now());
  const selectedWalletLink = useMemo(
    () => pairing ? walletLink(pairing, wallet) : '',
    [pairing, wallet],
  );
  const phantomLink = pairing ? walletLink(pairing, 'phantom') : '';
  const solflareLink = pairing ? walletLink(pairing, 'solflare') : '';
  const timeLeft = pairing ? countdown(pairing.expiresAt, now) : '';

  useEffect(() => {
    let active = true;
    setQrDataUrl('');
    if (!selectedWalletLink) return () => { active = false; };
    void QRCode.toDataURL(selectedWalletLink, {
      width: 288,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#171223', light: '#ffffff' },
    })
      .then((dataUrl) => {
        if (active) setQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (active) {
          setError('The QR code could not be prepared. Open a wallet app on this phone.');
          setPhase('paused');
        }
      });
    return () => { active = false; };
  }, [selectedWalletLink]);

  useEffect(() => {
    if (!pairing) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [pairing]);

  useEffect(() => {
    if (pairing && now >= pairing.expiresAt && phase !== 'expired') {
      setError('This code expired. Create a new one.');
      setPhase('expired');
    }
  }, [now, pairing, phase]);

  useEffect(() => {
    if (!pairing || phase !== 'waiting') return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (Date.now() >= pairing.expiresAt) {
        if (active) {
          setError('This code expired. Create a new one.');
          setPhase('expired');
        }
        return;
      }
      try {
        const result = await pollMobileWalletPairing(pairing);
        if (!active) return;
        if ('status' in result && result.status === 'pending') {
          timer = setTimeout(() => void poll(), 1_250);
          return;
        }
        if ('linked' in result) {
          await onLinked?.(result.walletAddress);
          if (!active) return;
          if (!onLinked) setMessage('Wallet linked.');
          setPairing(null);
          return;
        }
        if (!applyAuthenticatedBackendSession(result)) {
          setError('Wallet approved. Refresh the page to finish signing in.');
          setPhase('paused');
          return;
        }
        setPairing(null);
      } catch (pollError) {
        if (!active) return;
        setError(pairingErrorMessage(pollError));
        setPhase('paused');
      }
    };
    timer = setTimeout(() => void poll(), 750);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [onLinked, pairing, phase]);

  if (isAuthenticated && mode === 'sign-in') {
    return <PrivyLoginButton className={className} showIcon={showIcon} />;
  }

  const startPairing = async () => {
    setCreating(true);
    setPairing(null);
    setQrDataUrl('');
    setError('');
    setMessage('');
    setPhase('waiting');
    try {
      setPairing(await startMobileWalletPairing({ purpose: mode }));
    } catch (startError) {
      setError(pairingErrorMessage(startError));
    } finally {
      setCreating(false);
    }
  };

  const closePairing = () => {
    setPairing(null);
    setQrDataUrl('');
    setError('');
    setPhase('waiting');
  };

  const qrPanel = (
    <>
      <div className="mx-auto grid h-[244px] w-[244px] max-w-full place-items-center rounded-2xl bg-white p-2 sm:h-[304px] sm:w-[304px]">
        {qrDataUrl ? (
          <img src={qrDataUrl} alt={`QR code for ${wallet}`} className="h-full w-full" />
        ) : (
          <span className="h-7 w-7 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
        )}
      </div>
      <p className="mt-3 text-center text-sm text-[var(--color-text-secondary)]">
        Scan with {wallet === 'phantom' ? 'Phantom' : 'Solflare'}, then approve the message.
      </p>
    </>
  );

  return (
    <div className="contents">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => void startPairing()}
        disabled={creating}
        className={`flex items-center gap-2 rounded-xl border border-[var(--color-border-secondary)] bg-[var(--color-bg-secondary)] px-4 py-2.5 text-sm font-medium text-[var(--color-text)] transition-all hover:border-brand-400 hover:text-brand-200 disabled:cursor-wait disabled:opacity-70 ${className}`}
      >
        {creating ? (
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
        ) : showIcon ? (
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3h6v6H3V3zm12 0h6v6h-6V3zM3 15h6v6H3v-6zm12 0h2m4 0h-2v2m-4 4h2v-2m4 2v-2h-2m-2-2h2" />
          </svg>
        ) : null}
        <span>{creating ? 'Preparing wallet connection' : label ?? (mode === 'link' ? 'Link a wallet' : 'Use a wallet')}</span>
      </button>
      {!pairing && error && <p className="mt-2 max-w-xs text-sm leading-5 text-red-300" role="alert">{error}</p>}
      {!pairing && message && <p className="mt-2 text-sm leading-5 text-emerald-300" role="status">{message}</p>}

      {pairing && (
        <div
          className="fixed inset-0 z-[100] overflow-y-auto bg-black/70 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="mobile-wallet-title"
        >
          <div
            className="flex min-h-full items-start justify-center p-3 sm:items-center sm:p-4"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) closePairing();
            }}
          >
            <div className="max-h-[calc(100dvh-1.5rem)] w-full max-w-sm overflow-y-auto overscroll-contain rounded-3xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-5 shadow-2xl sm:max-h-[calc(100dvh-2rem)]">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-300">Optional wallet</p>
                  <h2 id="mobile-wallet-title" className="mt-1 text-xl font-semibold">
                    {mode === 'link' ? 'Link a wallet' : 'Use a wallet'}
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={closePairing}
                  className="rounded-lg p-2 text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"
                  aria-label="Close wallet connection"
                >
                  <span aria-hidden="true">×</span>
                </button>
              </div>

              {phase === 'expired' ? (
                <div className="mt-6 rounded-2xl bg-[var(--color-bg)] p-5 text-center">
                  <p className="font-semibold">This code expired</p>
                  <p className="mt-2 text-sm text-[var(--color-text-secondary)]">Create a fresh code to continue.</p>
                  <button
                    type="button"
                    onClick={() => void startPairing()}
                    className="mt-4 w-full rounded-xl bg-brand-500 px-4 py-3 text-sm font-semibold text-white"
                  >
                    Create a new code
                  </button>
                </div>
              ) : (
                <>
                  <div className="mt-5 sm:hidden">
                    <p className="text-sm font-semibold">On this phone</p>
                    <div className="mt-3 grid gap-2">
                      <a
                        href={phantomLink}
                        className="rounded-xl bg-brand-500 px-4 py-3 text-center text-sm font-semibold text-white"
                      >
                        Open Phantom
                      </a>
                      <a
                        href={solflareLink}
                        className="rounded-xl border border-[var(--color-border-secondary)] px-4 py-3 text-center text-sm font-semibold text-[var(--color-text)]"
                      >
                        Open Solflare
                      </a>
                    </div>
                  </div>

                  <div className="mt-5 hidden sm:block">
                    <div className="grid grid-cols-2 rounded-xl bg-[var(--color-bg)] p-1">
                      {(['phantom', 'solflare'] as const).map((option) => (
                        <button
                          key={option}
                          type="button"
                          onClick={() => setWallet(option)}
                          className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                            wallet === option
                              ? 'bg-brand-500 text-white'
                              : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]'
                          }`}
                        >
                          {option === 'phantom' ? 'Phantom' : 'Solflare'}
                        </button>
                      ))}
                    </div>
                    <div className="mt-4">{qrPanel}</div>
                  </div>

                  <details className="mt-5 sm:hidden">
                    <summary className="cursor-pointer py-2 text-center text-sm font-medium text-brand-200">
                      Scan from another device
                    </summary>
                    <div className="mt-3 grid grid-cols-2 rounded-xl bg-[var(--color-bg)] p-1">
                      {(['phantom', 'solflare'] as const).map((option) => (
                        <button
                          key={option}
                          type="button"
                          onClick={() => setWallet(option)}
                          className={`rounded-lg px-3 py-2 text-sm font-medium ${
                            wallet === option ? 'bg-brand-500 text-white' : 'text-[var(--color-text-muted)]'
                          }`}
                        >
                          {option === 'phantom' ? 'Phantom' : 'Solflare'}
                        </button>
                      ))}
                    </div>
                    <div className="mt-4">{qrPanel}</div>
                  </details>

                  <div className="mt-4 rounded-xl bg-[var(--color-bg)] px-4 py-3 text-center" aria-live="polite">
                    <p className="text-sm font-medium">
                      {phase === 'paused' ? 'Connection paused' : 'Waiting for wallet approval'}
                    </p>
                    <p className="mt-1 font-mono text-xs text-[var(--color-text-muted)]">
                      Code {pairing.verificationCode} · {timeLeft}
                    </p>
                  </div>

                  {error && <p className="mt-3 text-center text-sm leading-5 text-red-300" role="alert">{error}</p>}
                  {phase === 'paused' && (
                    <button
                      type="button"
                      onClick={() => {
                        setError('');
                        setPhase('waiting');
                      }}
                      className="mt-3 w-full rounded-xl border border-[var(--color-border-secondary)] px-4 py-2.5 text-sm font-semibold"
                    >
                      Try this code again
                    </button>
                  )}

                  <p className="mt-3 text-center text-xs leading-5 text-[var(--color-text-muted)]">
                    A signature confirms this wallet. No transaction is sent.
                  </p>
                </>
              )}

              {phase !== 'expired' && (
                <div className="mt-4 border-t border-[var(--color-border)] pt-3 text-center">
                  <p className="mb-2 text-xs text-[var(--color-text-muted)]">Wallet already available in this browser?</p>
                  {browserWalletFallback ?? (
                    <PrivyLoginButton label="Use browser wallet" showIcon={false} className="w-full justify-center shadow-none" />
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
