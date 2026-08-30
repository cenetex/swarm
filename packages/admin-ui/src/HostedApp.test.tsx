import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HostedApp, hostedEnvironmentCopy } from './HostedApp';
import * as hostedApi from './hosted-api';
import { useAuthStore } from './store/auth';

vi.mock('./components/HostedWalletSignIn', () => ({
  HostedWalletSignIn: () => <button type="button">Wallet session</button>,
}));

vi.mock('./hosted-api', async () => {
  const actual = await vi.importActual<typeof import('./hosted-api')>('./hosted-api');
  return {
    ...actual,
    getHostedProviderStatus: vi.fn(),
    disconnectHostedProvider: vi.fn(),
    listHostedAvatars: vi.fn(),
    getHostedHistory: vi.fn(),
  };
});

const disconnected = { connected: false, provider: null } as const;
const connected = { connected: true, provider: 'openrouter' } as const;

function authenticate() {
  useAuthStore.setState({
    isAuthenticated: true,
    isLoading: false,
    authProvider: 'wallet',
    user: { id: 'acct-1', walletAddress: '7V7exampleWalletAddress9z9' },
    account: {
      accountId: 'acct-1',
      role: 'user',
      identities: [{ type: 'wallet', providerId: '7V7exampleWalletAddress9z9' }],
    },
  });
}

beforeEach(() => {
  window.history.replaceState({}, '', '/');
  useAuthStore.getState().resetLocal();
  vi.mocked(hostedApi.getHostedProviderStatus).mockResolvedValue(disconnected);
  vi.mocked(hostedApi.disconnectHostedProvider).mockResolvedValue(disconnected);
  vi.mocked(hostedApi.listHostedAvatars).mockResolvedValue([]);
  vi.mocked(hostedApi.getHostedHistory).mockResolvedValue([]);
});

describe('HostedApp', () => {
  it('uses production-safe environment copy outside preview', () => {
    expect(hostedEnvironmentCopy('production')).toEqual({
      label: 'Production',
      footer: 'Account data is isolated and credentials stay encrypted.',
    });
    expect(hostedEnvironmentCopy('preview').label).toBe('Private preview');
  });

  it('offers OAuth PKCE setup without a manual credential field', async () => {
    authenticate();
    render(<HostedApp />);

    const connect = await screen.findByRole('link', { name: /connect openrouter securely/i });
    expect(connect).toHaveAttribute('href', expect.stringMatching(/\/auth\/openrouter$/u));
    expect(screen.getByText(/oauth uses pkce s256/i)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/sk-or/iu)).not.toBeInTheDocument();
    expect(hostedApi.listHostedAvatars).not.toHaveBeenCalled();
  });

  it('shows the callback result, refreshes connected state, and removes callback parameters', async () => {
    authenticate();
    window.history.replaceState({}, '', '/?ai=openrouter&openrouter=connected');
    vi.mocked(hostedApi.getHostedProviderStatus).mockResolvedValue(connected);

    render(<HostedApp />);

    expect(await screen.findByText(/credential was exchanged and stored server-side/i)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /disconnect openrouter/i })).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(hostedApi.listHostedAvatars).toHaveBeenCalledOnce();
  });

  it('disconnects the account provider and returns to the OAuth setup state', async () => {
    authenticate();
    vi.mocked(hostedApi.getHostedProviderStatus).mockResolvedValue(connected);
    render(<HostedApp />);

    fireEvent.click(await screen.findByRole('button', { name: /disconnect openrouter/i }));

    expect(await screen.findByRole('link', { name: /connect openrouter securely/i })).toBeInTheDocument();
    expect(hostedApi.disconnectHostedProvider).toHaveBeenCalledOnce();
  });

  it('keeps chat primary and exposes one responsive workspace management surface', async () => {
    authenticate();
    vi.mocked(hostedApi.getHostedProviderStatus).mockResolvedValue(connected);
    vi.mocked(hostedApi.listHostedAvatars).mockResolvedValue([
      {
        avatarId: 'jax',
        name: 'Jax',
        status: 'active',
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    vi.mocked(hostedApi.getHostedHistory).mockResolvedValue([
      { role: 'assistant', content: 'How can I help?' },
      { role: 'user', content: 'Show me the workspace.' },
    ]);

    render(<HostedApp />);

    expect(screen.getByRole('region', { name: /hosted chat/i })).toBeInTheDocument();
    const manage = screen.getByRole('button', { name: /^manage$/i });
    const management = screen.getByRole('complementary', { name: /workspace management/i });
    expect(manage).toHaveAttribute('aria-expanded', 'false');
    expect(management).toHaveAttribute('data-mobile-open', 'false');

    fireEvent.click(manage);

    expect(manage).toHaveAttribute('aria-expanded', 'true');
    expect(management).toHaveAttribute('data-mobile-open', 'true');
    expect(await screen.findByRole('button', { name: /^Jax/u })).toHaveAttribute('aria-current', 'true');

    const assistantMessage = await screen.findByLabelText('Jax message');
    const userMessage = screen.getByLabelText('You message');
    expect(assistantMessage).toHaveAttribute('data-message-role', 'assistant');
    expect(assistantMessage).not.toHaveClass('rounded-2xl');
    expect(userMessage).toHaveAttribute('data-message-role', 'user');
    expect(userMessage).toHaveClass('border-l-brand-400');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(manage).toHaveAttribute('aria-expanded', 'false');
    expect(management).toHaveAttribute('data-mobile-open', 'false');
  });
});
