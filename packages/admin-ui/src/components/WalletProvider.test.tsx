import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WalletProvider } from './WalletProvider';

const mocks = vi.hoisted(() => ({
  config: null as { autoConnect?: boolean } | null,
}));

vi.mock('./unified-wallet', () => ({
  UnifiedWalletProvider: ({
    children,
    config,
  }: {
    children: ReactNode;
    config: { autoConnect?: boolean };
  }) => {
    mocks.config = config;
    return children;
  },
}));

vi.mock('../store/auth', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) => selector({ setWalletError: vi.fn() }),
}));

describe('WalletProvider', () => {
  it('allows the hosted QR-first entry point to disable remembered-wallet auto-connect', () => {
    render(
      <WalletProvider autoConnect={false}>
        <div>Hosted wallet flow</div>
      </WalletProvider>,
    );

    expect(screen.getByText('Hosted wallet flow')).toBeInTheDocument();
    expect(mocks.config?.autoConnect).toBe(false);
  });
});
