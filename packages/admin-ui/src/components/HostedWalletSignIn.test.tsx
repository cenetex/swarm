import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HostedWalletSignIn } from './HostedWalletSignIn';

const mocks = vi.hoisted(() => ({
  poll: vi.fn(),
  start: vi.fn(),
  toDataUrl: vi.fn(),
}));

vi.mock('qrcode', () => ({
  default: { toDataURL: mocks.toDataUrl },
}));

vi.mock('../auth/mobile-wallet-pairing', async () => {
  const actual = await vi.importActual<typeof import('../auth/mobile-wallet-pairing')>(
    '../auth/mobile-wallet-pairing',
  );
  return {
    ...actual,
    pollMobileWalletPairing: mocks.poll,
    startMobileWalletPairing: mocks.start,
  };
});

vi.mock('../store/auth', () => ({
  useAuth: () => ({ isAuthenticated: false }),
}));

vi.mock('./PrivyLoginButton', () => ({
  PrivyLoginButton: () => <button type="button">Use browser wallet</button>,
}));

vi.mock('../auth/bootstrap', () => ({
  applyAuthenticatedBackendSession: vi.fn(),
}));

describe('HostedWalletSignIn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.toDataUrl.mockResolvedValue('data:image/png;base64,qr');
    mocks.poll.mockImplementation(() => new Promise(() => {}));
    mocks.start.mockResolvedValue({
      pairingId: 'pairing-id-abcdefghijklmnopqrstuvwxyz',
      pollToken: 'desktop-only-poll-token-abcdefghijklmnopqrstuvwxyz',
      mobileUrl: 'https://swarm.example/mobile-sign-in?pairing=pairing-id-abcdefghijklmnopqrstuvwxyz',
      verificationCode: 'PAIRIN',
      expiresAt: Date.now() + 300_000,
    });
  });

  it('opens a Phantom QR first instead of a desktop wallet chooser', async () => {
    render(<HostedWalletSignIn />);

    fireEvent.click(screen.getByRole('button', { name: 'Scan to sign in' }));

    expect(await screen.findByRole('dialog', { name: 'Scan to sign in' })).toBeInTheDocument();
    expect(screen.getByText('Pairing code PAIRIN')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('img', { name: 'QR code for phantom' })).toBeInTheDocument());
    expect(mocks.toDataUrl).toHaveBeenCalledWith(
      expect.stringContaining('https://phantom.app/ul/browse/'),
      expect.any(Object),
    );
  });

  it('can switch the QR to Solflare and keeps browser wallets as a fallback', async () => {
    render(<HostedWalletSignIn />);
    fireEvent.click(screen.getByRole('button', { name: 'Scan to sign in' }));
    await screen.findByRole('dialog', { name: 'Scan to sign in' });

    fireEvent.click(screen.getByRole('button', { name: 'Solflare' }));

    await waitFor(() => expect(mocks.toDataUrl).toHaveBeenLastCalledWith(
      expect.stringContaining('https://solflare.com/ul/v1/browse/'),
      expect.any(Object),
    ));
    expect(screen.getByRole('button', { name: 'Use browser wallet' })).toBeInTheDocument();
  });
});
