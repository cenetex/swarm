/**
 * Privy Auth Provider
 * Wraps the app with Privy authentication context for email/social login
 * and (optionally) embedded wallet creation.
 */
import { type ReactNode, useEffect, useState } from 'react';
import { PrivyProvider as PrivyReactProvider, type PrivyClientConfig } from '@privy-io/react-auth';

const PRIVY_APP_ID = import.meta.env.VITE_PRIVY_APP_ID || '';
const PRIVY_ENABLE_EMBEDDED_WALLETS_RAW = import.meta.env.VITE_PRIVY_ENABLE_EMBEDDED_WALLETS;

interface PrivyProviderProps {
  children: ReactNode;
}

export function PrivyProvider({ children }: PrivyProviderProps) {
  const [config, setConfig] = useState<PrivyClientConfig | null>(null);

  useEffect(() => {
    buildPrivyConfig().then(setConfig).catch(() => {
      setConfig({
        loginMethods: ['wallet', 'email', 'google', 'twitter'],
        appearance: {
          showWalletLoginFirst: true,
          walletList: ['phantom', 'detected_solana_wallets', 'solflare', 'backpack', 'wallet_connect_qr_solana'],
          walletChainType: 'solana-only',
        },
      });
    });
  }, []);

  if (!PRIVY_APP_ID) {
    console.error('[Privy] Missing VITE_PRIVY_APP_ID');
    return (
      <div className="min-h-screen bg-[#0b0614] text-white flex items-center justify-center p-6">
        <div className="w-full max-w-xl rounded-2xl border border-white/10 bg-white/5 p-6">
          <h1 className="text-xl font-semibold">Privy is not configured</h1>
          <p className="mt-3 text-sm text-white/70">
            This app requires a Privy App ID to enable sign-in. Set{' '}
            <span className="font-mono text-white/90">VITE_PRIVY_APP_ID</span> and restart the dev server
            (or rebuild the deployed UI).
          </p>
          <pre className="mt-4 overflow-x-auto rounded-xl bg-black/40 p-4 text-xs text-white/80">
VITE_PRIVY_APP_ID=your_privy_app_id
          </pre>
        </div>
      </div>
    );
  }

  if (!config) {
    return null; // Loading config
  }

  return (
    <PrivyReactProvider
      appId={PRIVY_APP_ID}
      config={config}
    >
      {children}
    </PrivyReactProvider>
  );
}

function parseBool(value: unknown): boolean | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

function shouldEnableEmbeddedWallets(hostnameOverride?: string): boolean {
  // Allow explicit override for debugging / rollout.
  const override = parseBool(PRIVY_ENABLE_EMBEDDED_WALLETS_RAW);
  if (override !== null) return override;

  // Default: enable embedded wallets on known admin domains.
  // If Privy hasn't been configured to allow the origin for embedded wallets, the iframe will be
  // blocked by Privy's CSP (frame-ancestors) and login will fail.
  const host = (hostnameOverride ?? window.location.hostname).toLowerCase();
  return host === 'swarm.rati.chat' || host === 'staging-swarm.rati.chat';
}

async function getSolanaConnectors() {
  if (typeof window === 'undefined') return undefined;
  try {
    const { toSolanaWalletConnectors } = await import('@privy-io/react-auth/solana');
    return toSolanaWalletConnectors({ shouldAutoConnect: false });
  } catch {
    return undefined;
  }
}

export async function buildPrivyConfig(options?: { hostname?: string }): Promise<PrivyClientConfig> {
  const enableEmbeddedWallets = shouldEnableEmbeddedWallets(options?.hostname);
  const solanaConnectors = await getSolanaConnectors();

  return {
    loginMethods: ['wallet', 'email', 'google', 'twitter'],
    appearance: {
      showWalletLoginFirst: true,
      walletList: ['phantom', 'detected_solana_wallets', 'solflare', 'backpack', 'wallet_connect_qr_solana'],
      walletChainType: 'solana-only',
    },
    ...(solanaConnectors
      ? {
          externalWallets: {
            solana: {
              connectors: solanaConnectors,
            },
          },
        }
      : {}),
    ...(enableEmbeddedWallets
      ? {
          embeddedWallets: {
            solana: {
              createOnLogin: 'users-without-wallets',
            },
          },
        }
      : {}),
  };
}

