import { type ReactNode, createContext, useCallback, useContext, useMemo } from 'react';
import { clusterApiUrl } from '@solana/web3.js';
import {
  WalletAdapterNetwork,
  WalletReadyState,
  type Adapter,
  type WalletAdapter,
  type WalletError,
} from '@solana/wallet-adapter-base';
import { ConnectionProvider, WalletProvider as SolanaWalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider, useWalletModal } from '@solana/wallet-adapter-react-ui';
import { PhantomWalletAdapter } from '@solana/wallet-adapter-phantom';
import { SolflareWalletAdapter } from '@solana/wallet-adapter-solflare';
import '@solana/wallet-adapter-react-ui/styles.css';

type WalletEnvironment = 'mainnet-beta' | 'devnet' | 'testnet';

interface UnifiedWalletConfig {
  autoConnect?: boolean;
  env?: WalletEnvironment;
  metadata?: {
    name?: string;
    description?: string;
    url?: string;
    iconUrls?: string[];
  };
  theme?: 'light' | 'dark';
  lang?: string;
  walletlistExplanation?: {
    href?: string;
  };
  notificationCallback?: {
    onConnect?: (props: { walletName: string; shortAddress: string }) => void;
    onConnecting?: (props: { walletName: string }) => void;
    onDisconnect?: (props: { walletName: string }) => void;
    onNotInstalled?: (props: { walletName: string }) => void;
    onError?: (props: { walletName: string; error: unknown }) => void;
  };
}

interface UnifiedWalletProviderProps {
  children: ReactNode;
  wallets?: WalletAdapter[];
  config?: UnifiedWalletConfig;
}

interface UnifiedWalletContextValue {
  setShowModal: (show: boolean) => void;
}

const UnifiedWalletContext = createContext<UnifiedWalletContextValue | undefined>(undefined);

function getEndpointForEnv(env: WalletEnvironment): string {
  if (env === 'devnet') return clusterApiUrl('devnet');
  if (env === 'testnet') return clusterApiUrl('testnet');
  return clusterApiUrl('mainnet-beta');
}

function getNetworkForEnv(env: WalletEnvironment): WalletAdapterNetwork {
  if (env === 'devnet') return WalletAdapterNetwork.Devnet;
  if (env === 'testnet') return WalletAdapterNetwork.Testnet;
  return WalletAdapterNetwork.Mainnet;
}

function UnifiedWalletContextBridge({ children }: { children: ReactNode }) {
  const { setVisible } = useWalletModal();
  const contextValue = useMemo(
    () => ({
      setShowModal: (show: boolean) => setVisible(show),
    }),
    [setVisible]
  );

  return (
    <UnifiedWalletContext.Provider value={contextValue}>
      {children}
    </UnifiedWalletContext.Provider>
  );
}

export function UnifiedWalletProvider({ children, wallets, config }: UnifiedWalletProviderProps) {
  const env = config?.env ?? 'mainnet-beta';
  const endpoint = useMemo(() => getEndpointForEnv(env), [env]);
  const fallbackWallets = useMemo(
    () => [
      new PhantomWalletAdapter(),
      new SolflareWalletAdapter({ network: getNetworkForEnv(env) }),
    ],
    [env],
  );
  const selectedWallets = wallets && wallets.length > 0 ? wallets : fallbackWallets;
  const handleWalletError = useCallback(
    (error: WalletError, adapter?: Adapter) => {
      const walletName = adapter?.name ?? 'Wallet';
      if (
        adapter?.readyState === WalletReadyState.NotDetected
        || adapter?.readyState === WalletReadyState.Unsupported
      ) {
        config?.notificationCallback?.onNotInstalled?.({ walletName });
        return;
      }
      config?.notificationCallback?.onError?.({ walletName, error });
    },
    [config?.notificationCallback],
  );

  return (
    <ConnectionProvider endpoint={endpoint}>
      <SolanaWalletProvider
        wallets={selectedWallets}
        autoConnect={config?.autoConnect ?? true}
        onError={handleWalletError}
      >
        <WalletModalProvider>
          <UnifiedWalletContextBridge>{children}</UnifiedWalletContextBridge>
        </WalletModalProvider>
      </SolanaWalletProvider>
    </ConnectionProvider>
  );
}

export function useUnifiedWalletContext(): UnifiedWalletContextValue {
  const context = useContext(UnifiedWalletContext);
  if (!context) {
    throw new Error('useUnifiedWalletContext must be used within UnifiedWalletProvider');
  }
  return context;
}
