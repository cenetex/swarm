import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../store/auth';
import { HostedPasskeyAuth } from './HostedPasskeyAuth';
import * as passkeys from '../auth/hosted-passkeys';

vi.mock('../auth/hosted-passkeys', () => ({
  supportsPasskeys: vi.fn(),
  registerHostedPasskey: vi.fn(),
  signInWithHostedPasskey: vi.fn(),
}));

beforeEach(() => {
  useAuthStore.getState().resetLocal();
  vi.mocked(passkeys.supportsPasskeys).mockReturnValue(true);
  vi.mocked(passkeys.registerHostedPasskey).mockResolvedValue();
  vi.mocked(passkeys.signInWithHostedPasskey).mockResolvedValue({
    authenticated: true,
    authProvider: 'passkey',
    account: { accountId: 'acct-1', role: 'user', identities: [] },
    user: { walletAddress: 'wallet-1' },
  });
});
describe('HostedPasskeyAuth', () => {
  it('signs a logged-out owner in and records the passkey session provider', async () => {
    render(<HostedPasskeyAuth />);
    const button = screen.getByRole('button', { name: /sign in with a passkey/i });
    expect(button).toHaveClass('from-brand-500', 'to-brand-600');
    fireEvent.click(button);

    await waitFor(() => expect(useAuthStore.getState().isAuthenticated).toBe(true));
    expect(useAuthStore.getState().authProvider).toBe('passkey');
  });

  it('adds a passkey to an authenticated account', async () => {
    useAuthStore.setState({
      isAuthenticated: true,
      authProvider: 'wallet',
      user: { id: 'acct-1', walletAddress: 'wallet-1' },
      account: { accountId: 'acct-1', role: 'user', identities: [] },
    });
    render(<HostedPasskeyAuth />);
    fireEvent.click(screen.getByRole('button', { name: /add a passkey/i }));

    expect(await screen.findByText(/passkey added/i)).toBeInTheDocument();
    expect(passkeys.registerHostedPasskey).toHaveBeenCalledOnce();
  });

  it('keeps wallet recovery visible when the browser lacks passkey support', async () => {
    vi.mocked(passkeys.supportsPasskeys).mockReturnValue(false);
    const useWallet = vi.fn();
    render(<HostedPasskeyAuth onUseWallet={useWallet} />);
    fireEvent.click(screen.getByRole('button', { name: /sign in with a passkey/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/passkeys are unavailable here/i);
    fireEvent.click(screen.getByRole('button', { name: 'Use a wallet' }));
    expect(useWallet).toHaveBeenCalledOnce();
    expect(passkeys.signInWithHostedPasskey).not.toHaveBeenCalled();
  });

  it('shows wallet recovery guidance when passkey verification fails', async () => {
    vi.mocked(passkeys.signInWithHostedPasskey).mockRejectedValue(
      new Error('Passkey sign-in is invalid or expired.'),
    );
    render(<HostedPasskeyAuth />);
    fireEvent.click(screen.getByRole('button', { name: /sign in with a passkey/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /use your wallet once, then add a fresh passkey/i,
    );
  });

  it('turns the raw iOS browser rejection into a short retry path', async () => {
    const rawMessage = 'The request is not allowed by the user agent or the platform in the current context, possibly because the user denied permission.';
    vi.mocked(passkeys.signInWithHostedPasskey)
      .mockRejectedValueOnce(new Error(rawMessage))
      .mockResolvedValueOnce({
        authenticated: true,
        authProvider: 'passkey',
        account: { accountId: 'acct-1', role: 'user', identities: [] },
        user: { walletAddress: 'wallet-1' },
      });
    render(<HostedPasskeyAuth />);

    fireEvent.click(screen.getByRole('button', { name: /sign in with a passkey/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Passkey did not open');
    expect(alert).toHaveTextContent(/open it in Safari or Chrome/i);
    expect(screen.queryByText(rawMessage)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Try passkey again' }));
    await waitFor(() => expect(useAuthStore.getState().isAuthenticated).toBe(true));
    expect(passkeys.signInWithHostedPasskey).toHaveBeenCalledTimes(2);
  });

  it('uses a calm generic message for unknown browser errors', async () => {
    vi.mocked(passkeys.signInWithHostedPasskey).mockRejectedValue(new Error('Internal platform detail 7819'));
    render(<HostedPasskeyAuth />);
    fireEvent.click(screen.getByRole('button', { name: /sign in with a passkey/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Passkey sign-in paused');
    expect(alert).not.toHaveTextContent('Internal platform detail 7819');
  });
});
