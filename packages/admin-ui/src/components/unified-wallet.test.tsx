import { act, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { UnifiedWalletProvider } from './unified-wallet';

const captures = vi.hoisted(() => ({ providerProps: null as unknown }));

vi.mock('@solana/web3.js', () => ({
  clusterApiUrl: (network: string) => `https://rpc.example/${network}`,
}));

vi.mock('@solana/wallet-adapter-phantom', () => ({
  PhantomWalletAdapter: class PhantomWalletAdapter {
    name = 'Phantom';
  },
}));

vi.mock('@solana/wallet-adapter-solflare', () => ({
  SolflareWalletAdapter: class SolflareWalletAdapter {
    name = 'Solflare';
  },
}));

vi.mock('@solana/wallet-adapter-react', () => ({
  ConnectionProvider: ({ children }: { children: ReactNode }) => children,
  WalletProvider: (props: { children: ReactNode }) => {
    captures.providerProps = props;
    return props.children;
  },
}));

vi.mock('@solana/wallet-adapter-react-ui', () => ({
  WalletModalProvider: ({ children }: { children: ReactNode }) => children,
  useWalletModal: () => ({ setVisible: vi.fn() }),
}));

type CapturedProviderProps = {
  wallets: Array<{ name: string }>;
  autoConnect: boolean;
  onError: (
    error: Error,
    adapter: { name: string; readyState: 'Installed' | 'NotDetected' },
  ) => void;
};

describe('UnifiedWalletProvider', () => {
  it('starts selected wallet connections and includes Phantom and Solflare', () => {
    render(
      <UnifiedWalletProvider config={{ autoConnect: true }}>
        <span>Hosted wallet</span>
      </UnifiedWalletProvider>,
    );

    const props = captures.providerProps as CapturedProviderProps;
    expect(screen.getByText('Hosted wallet')).toBeInTheDocument();
    expect(props.autoConnect).toBe(true);
    expect(props.wallets.map((wallet) => wallet.name)).toEqual(['Phantom', 'Solflare']);
  });

  it('reports missing and failed wallet connections to the page callback', () => {
    const onNotInstalled = vi.fn();
    const onError = vi.fn();
    render(
      <UnifiedWalletProvider
        config={{
          autoConnect: true,
          notificationCallback: { onNotInstalled, onError },
        }}
      >
        <span>Hosted wallet</span>
      </UnifiedWalletProvider>,
    );

    const props = captures.providerProps as CapturedProviderProps;
    act(() => {
      props.onError(new Error('not ready'), { name: 'Phantom', readyState: 'NotDetected' });
      props.onError(new Error('connection failed'), { name: 'Solflare', readyState: 'Installed' });
    });

    expect(onNotInstalled).toHaveBeenCalledWith({ walletName: 'Phantom' });
    expect(onError).toHaveBeenCalledWith({ walletName: 'Solflare', error: expect.any(Error) });
  });
});
