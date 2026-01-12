/**
 * Solana Wallet Provider
 * Wraps the app with Solana wallet adapter context
 * 
 * Note: Phantom, Solflare, and other major wallets auto-register as Standard Wallets
 * via the Wallet Standard. We only need to add adapters for wallets that don't
 * support the standard yet (like Coinbase).
 */
import { useMemo, type ReactNode } from 'react';
import {
  ConnectionProvider,
  WalletProvider as SolanaWalletProvider,
} from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import { CoinbaseWalletAdapter } from '@solana/wallet-adapter-wallets';

// Import wallet adapter styles
import '@solana/wallet-adapter-react-ui/styles.css';

// Solana RPC endpoint (mainnet-beta)
const SOLANA_RPC = import.meta.env.VITE_SOLANA_RPC || 'https://api.mainnet-beta.solana.com';

interface WalletProviderProps {
  children: ReactNode;
}

export function WalletProvider({ children }: WalletProviderProps) {
  // Initialize wallet adapters for non-standard wallets only
  // Phantom, Solflare, etc. auto-register via Wallet Standard
  const wallets = useMemo(
    () => [
      new CoinbaseWalletAdapter(),
    ],
    []
  );

  return (
    <ConnectionProvider endpoint={SOLANA_RPC}>
      <SolanaWalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          {children}
        </WalletModalProvider>
      </SolanaWalletProvider>
    </ConnectionProvider>
  );
}
