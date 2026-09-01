import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../store/auth';
import { HostedWalletLink } from './HostedWalletLink';
import * as walletLink from '../auth/hosted-wallet-link';

const mocks = vi.hoisted(() => ({
  setShowModal: vi.fn(),
  wallet: {
    connected: true,
    connecting: false,
    publicKey: { toBase58: () => 'linked-wallet-22222222' } as { toBase58: () => string } | null,
    signMessage: vi.fn(async () => new Uint8Array(64)) as ((message: Uint8Array) => Promise<Uint8Array>) | undefined,
  },
}));

vi.mock('@solana/wallet-adapter-react', () => ({
  useWallet: () => mocks.wallet,
}));

vi.mock('./unified-wallet', () => ({
  useUnifiedWalletContext: () => ({ setShowModal: mocks.setShowModal }),
}));

vi.mock('../auth/hosted-wallet-link', () => ({
  linkHostedWallet: vi.fn(),
}));

describe('HostedWalletLink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.getState().resetLocal();
    useAuthStore.setState({
      isAuthenticated: true,
      authProvider: 'passkey',
      user: { id: 'acct-1', walletAddress: 'primary-wallet-11111111' },
      account: {
        accountId: 'acct-1',
        role: 'user',
        identities: [{ type: 'wallet', providerId: 'primary-wallet-11111111' }],
      },
      refreshAccount: vi.fn().mockResolvedValue(true),
    });
    Object.assign(mocks.wallet, {
      connected: true,
      connecting: false,
      publicKey: { toBase58: () => 'linked-wallet-22222222' },
      signMessage: vi.fn(async () => new Uint8Array(64)),
    });
    vi.mocked(walletLink.linkHostedWallet).mockResolvedValue({
      linked: true,
      status: 'linked',
      walletAddress: 'linked-wallet-22222222',
    });
  });

  it('links the connected wallet by signature and refreshes the account', async () => {
    render(<HostedWalletLink />);
    expect(screen.getByLabelText('Linked wallets')).toHaveTextContent('prim…1111');

    fireEvent.click(screen.getByRole('button', { name: 'Link wallet' }));

    await waitFor(() => expect(walletLink.linkHostedWallet).toHaveBeenCalledWith({
      walletAddress: 'linked-wallet-22222222',
      signMessage: mocks.wallet.signMessage,
    }));
    expect(useAuthStore.getState().refreshAccount).toHaveBeenCalledOnce();
    expect(await screen.findByRole('status')).toHaveTextContent('Wallet linked: link…2222');
  });

  it('opens the browser-wallet chooser when no signer is connected', () => {
    Object.assign(mocks.wallet, { connected: false, publicKey: null, signMessage: undefined });
    render(<HostedWalletLink />);

    fireEvent.click(screen.getByRole('button', { name: 'Link wallet' }));

    expect(mocks.setShowModal).toHaveBeenCalledWith(true);
    expect(walletLink.linkHostedWallet).not.toHaveBeenCalled();
  });

  it('requires a passkey-backed session before offering wallet linking', () => {
    useAuthStore.setState({ authProvider: 'wallet' });
    render(<HostedWalletLink />);

    expect(screen.getByText(/sign in with your passkey to link another wallet/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Link wallet' })).not.toBeInTheDocument();
  });
});
