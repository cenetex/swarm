import { useEffect, useMemo, useState } from 'react';
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
  className?: string;
  showIcon?: boolean;
}

type MobileWallet = 'phantom' | 'solflare';

function walletLink(pairing: MobileWalletPairing, wallet: MobileWallet): string {
  return wallet === 'phantom'
    ? phantomBrowseUrl(pairing.mobileUrl)
    : solflareBrowseUrl(pairing.mobileUrl);
}

export function HostedWalletSignIn({ className = '', showIcon = true }: HostedWalletSignInProps) {
  const { isAuthenticated } = useAuth();
  const [creating, setCreating] = useState(false);
  const [pairing, setPairing] = useState<MobileWalletPairing | null>(null);
  const [wallet, setWallet] = useState<MobileWallet>('phantom');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [error, setError] = useState('');
  const selectedWalletLink = useMemo(
    () => pairing ? walletLink(pairing, wallet) : '',
    [pairing, wallet],
  );

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
        if (active) setError('Unable to draw the wallet QR code.');
      });
    return () => { active = false; };
  }, [selectedWalletLink]);

  useEffect(() => {
    if (!pairing) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const result = await pollMobileWalletPairing(pairing);
        if (!active) return;
        if ('status' in result) {
          timer = setTimeout(() => void poll(), 1_250);
          return;
        }
        applyAuthenticatedBackendSession(result);
        setPairing(null);
      } catch (pollError) {
        if (!active) return;
        setError(pollError instanceof Error ? pollError.message : 'Mobile wallet sign-in failed.');
      }
    };
    timer = setTimeout(() => void poll(), 750);
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [pairing]);

  if (isAuthenticated) {
    return <PrivyLoginButton className={className} showIcon={showIcon} />;
  }

  const startPairing = async () => {
    setCreating(true);
    setError('');
    try {
      setPairing(await startMobileWalletPairing());
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : 'Unable to start wallet sign-in.');
    } finally {
      setCreating(false);
    }
  };

  const closePairing = () => {
    setPairing(null);
    setQrDataUrl('');
    setError('');
  };

  return (
    <div className="contents">
      <button
        type="button"
        onClick={() => void startPairing()}
        disabled={creating}
        className={`flex items-center gap-2 rounded-xl bg-gradient-to-r from-brand-500 to-brand-600 px-4 py-2.5 text-sm font-medium text-white shadow-lg shadow-brand-500/25 transition-all hover:from-brand-600 hover:to-brand-700 disabled:cursor-wait disabled:opacity-70 ${className}`}
      >
        {creating ? (
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
        ) : showIcon ? (
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 3h6v6H3V3zm12 0h6v6h-6V3zM3 15h6v6H3v-6zm12 0h2m4 0h-2v2m-4 4h2v-2m4 2v-2h-2m-2-2h2" />
          </svg>
        ) : null}
        <span>{creating ? 'Preparing secure QR' : 'Scan to sign in'}</span>
      </button>
      {!pairing && error && <p className="mt-2 max-w-xs text-xs leading-5 text-red-400">{error}</p>}

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
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-300">Mobile wallet</p>
                  <h2 id="mobile-wallet-title" className="mt-1 text-xl font-semibold">Scan to sign in</h2>
                </div>
                <button
                  type="button"
                  onClick={closePairing}
                  className="rounded-lg p-2 text-[var(--color-text-muted)] hover:bg-[var(--color-bg)] hover:text-[var(--color-text)]"
                  aria-label="Close wallet QR"
                >
                  <span aria-hidden="true">×</span>
                </button>
              </div>

              <div className="mt-4 grid grid-cols-2 rounded-xl bg-[var(--color-bg)] p-1">
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

              <a
                href={selectedWalletLink}
                className="mt-4 flex w-full items-center justify-center rounded-xl bg-gradient-to-r from-brand-500 to-brand-600 px-4 py-3 font-medium text-white shadow-lg shadow-brand-500/25 sm:hidden"
              >
                Open {wallet === 'phantom' ? 'Phantom' : 'Solflare'} to sign in
              </a>
              <p className="mt-2 text-center text-xs leading-5 text-[var(--color-text-muted)] sm:hidden">
                Continue in the selected wallet app. No transaction is sent.
              </p>

              {error && <p className="mt-3 text-center text-xs leading-5 text-red-400">{error}</p>}

              <div className="hidden sm:block">
                <div className="mx-auto mt-4 grid h-[304px] w-[304px] max-w-full place-items-center rounded-2xl bg-white p-2">
                  {qrDataUrl ? (
                    <img src={qrDataUrl} alt={`QR code for ${wallet}`} className="h-full w-full" />
                  ) : (
                    <span className="h-7 w-7 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
                  )}
                </div>

                <p className="mt-4 text-center text-sm text-[var(--color-text-secondary)]">
                  Scan with {wallet === 'phantom' ? 'Phantom' : 'Solflare'}, then approve the sign-in message.
                </p>
                <p className="mt-2 text-center font-mono text-xs text-[var(--color-text-muted)]">
                  Pairing code {pairing.verificationCode}
                </p>
                <p className="mt-2 text-center text-xs leading-5 text-[var(--color-text-muted)]">
                  No transaction is sent. The QR expires in five minutes.
                </p>
              </div>

              <div className="mt-4 border-t border-[var(--color-border)] pt-3 text-center">
                <p className="mb-2 text-xs text-[var(--color-text-muted)]">Already inside a wallet browser?</p>
                <PrivyLoginButton label="Sign in with browser wallet" showIcon={false} className="w-full justify-center shadow-none" />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
