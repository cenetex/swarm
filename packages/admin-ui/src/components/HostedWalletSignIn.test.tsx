import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HostedWalletSignIn } from './HostedWalletSignIn';

const mocks = vi.hoisted(() => ({
  applySession: vi.fn(),
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
  PrivyLoginButton: ({ label = 'Use browser wallet' }: { label?: string }) => <button type="button">{label}</button>,
}));

vi.mock('../auth/bootstrap', () => ({
  applyAuthenticatedBackendSession: mocks.applySession,
}));

const pairing = {
  pairingId: 'pairing-id-abcdefghijklmnopqrstuvwxyz',
  pollToken: 'desktop-only-poll-token-abcdefghijklmnopqrstuvwxyz',
  mobileUrl: 'https://swarm.example/mobile-sign-in?pairing=pairing-id-abcdefghijklmnopqrstuvwxyz',
  verificationCode: 'PAIRIN',
  expiresAt: Date.now() + 300_000,
  purpose: 'sign-in' as const,
};

describe('HostedWalletSignIn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pairing.expiresAt = Date.now() + 300_000;
    mocks.toDataUrl.mockResolvedValue('data:image/png;base64,qr');
    mocks.poll.mockImplementation(() => new Promise(() => {}));
    mocks.start.mockResolvedValue(pairing);
    mocks.applySession.mockReturnValue(true);
  });

  it('opens a Phantom QR first and keeps the private polling token out of it', async () => {
    render(<HostedWalletSignIn />);

    fireEvent.click(screen.getByRole('button', { name: 'Use a wallet' }));

    expect(await screen.findByRole('dialog', { name: 'Use a wallet' })).toBeInTheDocument();
    expect(screen.getByText(/Code PAIRIN/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole('img', { name: 'QR code for phantom' })).toHaveLength(2));
    expect(mocks.toDataUrl).toHaveBeenCalledWith(
      expect.stringContaining('https://phantom.app/ul/browse/'),
      expect.any(Object),
    );
    expect(mocks.toDataUrl.mock.calls[0]?.[0]).not.toContain(pairing.pollToken);
    expect(mocks.start).toHaveBeenCalledWith({ purpose: 'sign-in' });
  });

  it('offers direct Phantom and Solflare links on the current phone', async () => {
    render(<HostedWalletSignIn />);
    fireEvent.click(screen.getByRole('button', { name: 'Use a wallet' }));
    await screen.findByRole('dialog', { name: 'Use a wallet' });

    const phantom = screen.getByRole('link', { name: 'Open Phantom' });
    const solflare = screen.getByRole('link', { name: 'Open Solflare' });
    expect(phantom).toHaveAttribute('href', expect.stringContaining('https://phantom.app/ul/browse/'));
    expect(solflare).toHaveAttribute('href', expect.stringContaining('https://solflare.com/ul/v1/browse/'));
    expect(phantom.getAttribute('href')).not.toContain(pairing.pollToken);
    expect(solflare.getAttribute('href')).not.toContain(pairing.pollToken);
    expect(screen.getByText('Scan from another device')).toBeInTheDocument();
  });

  it('switches the desktop QR to Solflare and keeps a browser-wallet choice', async () => {
    render(<HostedWalletSignIn />);
    fireEvent.click(screen.getByRole('button', { name: 'Use a wallet' }));
    await screen.findByRole('dialog', { name: 'Use a wallet' });

    fireEvent.click(screen.getAllByRole('button', { name: 'Solflare' })[0]!);

    await waitFor(() => expect(mocks.toDataUrl).toHaveBeenLastCalledWith(
      expect.stringContaining('https://solflare.com/ul/v1/browse/'),
      expect.any(Object),
    ));
    expect(await screen.findAllByRole('img', { name: 'QR code for solflare' })).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Use browser wallet' })).toBeInTheDocument();
  });

  it('links a mobile wallet through a pairing bound to the passkey account', async () => {
    const onLinked = vi.fn();
    mocks.start.mockResolvedValue({
      ...pairing,
      mobileUrl: `${pairing.mobileUrl}&purpose=link`,
      purpose: 'link',
    });
    mocks.poll.mockResolvedValue({
      linked: true,
      status: 'linked',
      walletAddress: 'linked-wallet-address',
    });
    render(<HostedWalletSignIn mode="link" onLinked={onLinked} />);

    fireEvent.click(screen.getByRole('button', { name: 'Link a wallet' }));

    await waitFor(() => expect(onLinked).toHaveBeenCalledWith('linked-wallet-address'), { timeout: 2_000 });
    expect(mocks.start).toHaveBeenCalledWith({ purpose: 'link' });
    expect(mocks.applySession).not.toHaveBeenCalled();
  });

  it('stops on an expired code and offers a fresh one', async () => {
    mocks.start.mockResolvedValue({ ...pairing, expiresAt: Date.now() - 1 });
    render(<HostedWalletSignIn />);
    fireEvent.click(screen.getByRole('button', { name: 'Use a wallet' }));

    expect(await screen.findByText('This code expired')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create a new code' })).toBeInTheDocument();
    expect(mocks.poll).not.toHaveBeenCalled();
  });

  it('pauses polling after a connection error and offers a retry', async () => {
    mocks.poll.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<HostedWalletSignIn />);
    fireEvent.click(screen.getByRole('button', { name: 'Use a wallet' }));

    expect(await screen.findByRole('alert', {}, { timeout: 2_000 })).toHaveTextContent('Connection interrupted');
    expect(screen.getByRole('button', { name: 'Try this code again' })).toBeInTheDocument();
    expect(mocks.poll).toHaveBeenCalledTimes(1);
  });
});
