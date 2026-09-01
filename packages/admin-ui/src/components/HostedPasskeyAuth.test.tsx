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
    fireEvent.click(screen.getByRole('button', { name: /sign in with a passkey/i }));

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
    render(<HostedPasskeyAuth />);
    fireEvent.click(screen.getByRole('button', { name: /sign in with a passkey/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/use wallet sign-in instead/i);
    expect(passkeys.signInWithHostedPasskey).not.toHaveBeenCalled();
  });
});
