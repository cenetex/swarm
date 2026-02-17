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
      onNotInstalled: (props: { walletName: string }) => {
        setWalletError(`${props.walletName} is not installed. Please install it and try again.`);
      },
    }),
    [setWalletError]
  );

  return (
    <UnifiedWalletProvider
      wallets={[]} // Empty = use provider defaults from the local unified wrapper
      config={{
        autoConnect: false,
        env: 'mainnet-beta',
        metadata: {
          name: 'Swarm',
          description: 'Multi-tenant social media avatar platform',
          url: 'https://swarm.rati.chat',
          iconUrls: ['https://swarm.rati.chat/swarm.svg'],
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
