/**
 * Solana Wallet Provider
 * Uses a local unified wallet wrapper over @solana/wallet-adapter
 *
 * This keeps the existing app API (`UnifiedWalletProvider` + `useUnifiedWalletContext`)
 * without depending on Jupiter's adapter package.
 */
import { type ReactNode, useMemo } from 'react';
import { UnifiedWalletProvider } from './unified-wallet';
import { useAuthStore } from '../store/auth';
import { humanizeWalletAdapterError, WALLET_NOT_DETECTED_MESSAGE } from '../store/wallet-errors';

interface WalletProviderProps {
  children: ReactNode;
}

export function WalletProvider({ children }: WalletProviderProps) {
  const setWalletError = useAuthStore((s) => s.setWalletError);

  const notificationCallback = useMemo(
    () => ({
      onConnect: (_props: { walletName: string; shortAddress: string }) => {
        // noop
      },
      onConnecting: (_props: { walletName: string }) => {
        // noop
      },
      onDisconnect: (_props: { walletName: string }) => {
        // noop
      },
      onNotInstalled: (_props: { walletName: string }) => {
        setWalletError(WALLET_NOT_DETECTED_MESSAGE);
      },
      onError: (props: { walletName: string; error: unknown }) => {
        setWalletError(humanizeWalletAdapterError(props.error));
      },
    }),
    [setWalletError]
  );

  return (
    <UnifiedWalletProvider
      wallets={[]} // Empty = use provider defaults from the local unified wrapper
      config={{
        autoConnect: true,
        env: 'mainnet-beta',
        metadata: {
          name: 'Swarm',
          description: 'Multi-tenant social media avatar platform',
          url: typeof window === 'undefined' ? 'https://swarm.rati.chat' : window.location.origin,
          iconUrls: [
            typeof window === 'undefined'
              ? 'https://swarm.rati.chat/swarm.svg'
              : `${window.location.origin}/swarm.svg`,
          ],
        },
        theme: 'dark',
        lang: 'en',
        notificationCallback,
      }}
    >
      {children}
    </UnifiedWalletProvider>
  );
}
