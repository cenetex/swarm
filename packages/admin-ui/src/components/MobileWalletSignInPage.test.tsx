import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileWalletSignInPage } from './MobileWalletSignInPage';

const mocks = vi.hoisted(() => ({
  approve: vi.fn(),
  connect: vi.fn(),
  select: vi.fn(),
  walletState: {
    connected: false,
    connecting: false,
    publicKey: null as { toBase58: () => string } | null,
    signMessage: undefined as ((message: Uint8Array) => Promise<Uint8Array>) | undefined,
    wallet: null as { readyState: string } | null,
    wallets: [{ adapter: { name: 'Phantom' }, readyState: 'Installed' }],
  },
}));

vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: () => ({
    ...mocks.walletState,
    connect: mocks.connect,
    select: mocks.select,
  }),
}));

vi.mock('../auth/mobile-wallet-pairing', async () => {
  const actual = await vi.importActual<typeof import('../auth/mobile-wallet-pairing')>(
    '../auth/mobile-wallet-pairing',
  );
  return { ...actual, approveMobileWalletPairing: mocks.approve };
});

vi.mock('../store/auth', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) => selector({
    walletError: null,
    clearWalletError: vi.fn(),
  }),
}));

describe('MobileWalletSignInPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue(undefined);
    mocks.approve.mockResolvedValue(undefined);
    window.history.replaceState(
      {},
      '',
      '/mobile-sign-in?pairing=pairing-id-abcdefghijklmnopqrstuvwxyz',
    );
    Object.assign(mocks.walletState, {
      connected: false,
      connecting: false,
      publicKey: null,
      signMessage: undefined,
      wallet: null,
      wallets: [{ adapter: { name: 'Phantom' }, readyState: 'Installed' }],
    });
  });

  it('selects, connects, and signs with the wallet injected by the mobile wallet browser', async () => {
    const { rerender } = render(<MobileWalletSignInPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Approve sign-in' }));

    expect(mocks.select).toHaveBeenCalledWith('Phantom');
    expect(screen.getByText('Pairing code')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /open phantom/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /open solflare/i })).not.toBeInTheDocument();

    mocks.walletState.wallet = { readyState: 'Installed' };
    rerender(<MobileWalletSignInPage />);
    await waitFor(() => expect(mocks.connect).toHaveBeenCalledTimes(1));

    const signMessage = vi.fn(async () => new Uint8Array(64));
    mocks.walletState.connected = true;
    mocks.walletState.publicKey = { toBase58: () => 'mobile-wallet-address' };
    mocks.walletState.signMessage = signMessage;
    rerender(<MobileWalletSignInPage />);

    await waitFor(() => expect(mocks.approve).toHaveBeenCalledWith({
      pairingId: 'pairing-id-abcdefghijklmnopqrstuvwxyz',
      walletAddress: 'mobile-wallet-address',
      signMessage,
    }));
  });
});
