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
    createHostedAvatar: vi.fn(),
    importHostedAvatar: vi.fn(),
    connectHostedTelegram: vi.fn(),
    disconnectHostedTelegram: vi.fn(),
    listHostedAvatars: vi.fn(),
    getHostedHistory: vi.fn(),
    getHostedTelegramStatus: vi.fn(),
    repairHostedTelegram: vi.fn(),
  };
});

const disconnected = { connected: false, provider: null } as const;
const connected = { connected: true, provider: 'openrouter' } as const;
const testBotToken = `123456789:${'A'.repeat(36)}`;

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
  vi.mocked(hostedApi.createHostedAvatar).mockResolvedValue({
    avatarId: 'avatar-new',
    name: 'Public Ada',
    status: 'shell',
    createdAt: 1,
    updatedAt: 1,
    slug: 'public-ada-new',
    visibility: 'public',
    listed: true,
    revisionId: `sha256:${'a'.repeat(64)}`,
  });
  vi.mocked(hostedApi.getHostedHistory).mockResolvedValue([]);
  vi.mocked(hostedApi.getHostedTelegramStatus).mockResolvedValue({
    connected: false,
    status: 'disconnected',
    ownerBound: false,
  });
  vi.mocked(hostedApi.connectHostedTelegram).mockResolvedValue({
    connected: true,
    status: 'binding_required',
    ownerBound: false,
    bot: { id: '123', username: 'JaxSwarmBot', name: 'Jax' },
    ownerBindUrl: 'https://t.me/JaxSwarmBot?start=one-time-code',
  });
  vi.mocked(hostedApi.disconnectHostedTelegram).mockResolvedValue();
  vi.mocked(hostedApi.repairHostedTelegram).mockResolvedValue({
    connected: true,
    status: 'connected',
    ownerBound: true,
    bot: { id: '123', username: 'JaxSwarmBot', name: 'Jax' },
    addToGroupUrl: 'https://t.me/JaxSwarmBot?startgroup=group-code',
  });
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
    expect(hostedApi.listHostedAvatars).toHaveBeenCalledOnce();
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

  it('shows Telegram as the second connector and clears the write-only token immediately', async () => {
    authenticate();
    vi.mocked(hostedApi.getHostedProviderStatus).mockResolvedValue(connected);
    vi.mocked(hostedApi.listHostedAvatars).mockResolvedValue([{
      avatarId: 'avatar-1',
      name: 'Jax',
      status: 'shell',
      createdAt: 1,
      updatedAt: 1,
    }]);
    render(<HostedApp />);

    expect(await screen.findByText('Connector 2')).toBeInTheDocument();
    const token = await screen.findByLabelText(/botfather token/i);
    fireEvent.change(token, { target: { value: testBotToken } });
    fireEvent.click(screen.getByRole('button', { name: /connect telegram bot/i }));

    await waitFor(() => expect(hostedApi.connectHostedTelegram).toHaveBeenCalledWith(
      'avatar-1',
      testBotToken,
    ));
    expect(screen.queryByDisplayValue(testBotToken)).not.toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /prove ownership/i })).toHaveAttribute(
      'href',
      'https://t.me/JaxSwarmBot?start=one-time-code',
    );
  });

  it('publishes a listed public portable avatar by default', async () => {
    authenticate();
    render(<HostedApp />);

    fireEvent.change(await screen.findByLabelText(/avatar name/i), { target: { value: 'Public Ada' } });
    fireEvent.change(screen.getByLabelText(/public description/i), { target: { value: 'An open research mind.' } });
    fireEvent.change(screen.getByLabelText(/public starting prompt/i), { target: { value: 'Think in public.' } });
    fireEvent.click(screen.getByRole('button', { name: /publish portable avatar/i }));

    await waitFor(() => expect(hostedApi.createHostedAvatar).toHaveBeenCalledWith({
      name: 'Public Ada',
      description: 'An open research mind.',
      persona: 'Think in public.',
      visibility: 'public',
      listed: true,
    }));
  });
});
