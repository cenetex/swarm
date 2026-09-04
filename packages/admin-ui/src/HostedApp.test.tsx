import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HostedApp, hostedEnvironmentCopy } from './HostedApp';
import * as hostedApi from './hosted-api';
import { useAuthStore } from './store/auth';

vi.mock('./components/HostedWalletSignIn', () => ({
  HostedWalletSignIn: () => <button type="button">Wallet session</button>,
}));

vi.mock('./components/HostedWalletLink', () => ({
  HostedWalletLink: () => <button type="button">Link wallet</button>,
}));

vi.mock('./hosted-api', async () => {
  const actual = await vi.importActual<typeof import('./hosted-api')>('./hosted-api');
  return {
    ...actual,
    connectHostedX: vi.fn(),
    enqueueHostedMessage: vi.fn(),
    waitForHostedJob: vi.fn(),
    getPublicHostedAvatar: vi.fn(),
    getHostedProviderStatus: vi.fn(),
    disconnectHostedProvider: vi.fn(),
    createHostedAvatar: vi.fn(),
    importHostedAvatar: vi.fn(),
    connectHostedTelegram: vi.fn(),
    disconnectHostedTelegram: vi.fn(),
    disconnectHostedX: vi.fn(),
    listHostedAvatars: vi.fn(),
    getHostedHistory: vi.fn(),
    getHostedTelegramStatus: vi.fn(),
    getHostedXStatus: vi.fn(),
    setHostedTelegramGroupEnabled: vi.fn(),
    forgetHostedTelegramGroup: vi.fn(),
    repairHostedTelegram: vi.fn(),
    updateHostedAvatarProfile: vi.fn(),
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

async function openAction(name: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'More', exact: true }));
  const action = screen.getByRole('button', { name, exact: true });
  await waitFor(() => expect(action).toBeEnabled());
  fireEvent.click(action);
}

beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  window.history.replaceState({}, '', '/');
  useAuthStore.getState().resetLocal();
  vi.mocked(hostedApi.getHostedProviderStatus).mockResolvedValue(disconnected);
  vi.mocked(hostedApi.disconnectHostedProvider).mockResolvedValue(disconnected);
  vi.mocked(hostedApi.listHostedAvatars).mockResolvedValue([]);
  vi.mocked(hostedApi.createHostedAvatar).mockResolvedValue({
    avatarId: 'new-companion',
    name: 'Nova',
    status: 'shell',
    createdAt: 1,
    updatedAt: 1,
    slug: 'nova-new',
    visibility: 'public',
    listed: true,
    revisionId: `sha256:${'a'.repeat(64)}`,
  });
  vi.mocked(hostedApi.getHostedHistory).mockResolvedValue([]);
  vi.mocked(hostedApi.getHostedTelegramStatus).mockResolvedValue({
    connected: false,
    status: 'disconnected',
    ownerBound: false,
    groups: [],
  });
  vi.mocked(hostedApi.connectHostedTelegram).mockResolvedValue({
    connected: true,
    status: 'binding_required',
    ownerBound: false,
    bot: { id: '123', username: 'JaxSwarmBot', name: 'Jax' },
    ownerBindUrl: 'https://t.me/JaxSwarmBot?start=one-time-code',
    groups: [],
  });
  vi.mocked(hostedApi.disconnectHostedTelegram).mockResolvedValue();
  vi.mocked(hostedApi.getHostedXStatus).mockResolvedValue({
    connected: false,
    status: 'disconnected',
  });
  vi.mocked(hostedApi.disconnectHostedX).mockResolvedValue();
  vi.mocked(hostedApi.connectHostedX).mockResolvedValue({
    authorizationUrl: 'https://api.x.com/oauth/authorize?oauth_token=request-token',
  });
  vi.mocked(hostedApi.repairHostedTelegram).mockResolvedValue({
    connected: true,
    status: 'connected',
    ownerBound: true,
    bot: { id: '123', username: 'JaxSwarmBot', name: 'Jax' },
    addToGroupUrl: 'https://t.me/JaxSwarmBot?startgroup=group-code',
    groupBindCommand: '/start@JaxSwarmBot group-code',
    groups: [],
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

    await openAction('Connect a model');
    const connect = await screen.findByRole('link', { name: /connect openrouter securely/i });
    expect(connect).toHaveAttribute('href', expect.stringMatching(/\/auth\/openrouter$/u));

    expect(screen.queryByPlaceholderText(/sk-or/iu)).not.toBeInTheDocument();
    expect(hostedApi.listHostedAvatars).toHaveBeenCalledOnce();
  });

  it('offers passkey sign-in alongside wallet recovery', () => {
    render(<HostedApp />);

    expect(screen.getAllByRole('button', { name: /sign in with a passkey/i }).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('Use a wallet'));
    expect(screen.getByRole('button', { name: /wallet session/i })).toBeInTheDocument();
  });

  it('offers wallet linking after passkey sign-in', async () => {
    authenticate();
    useAuthStore.setState({ authProvider: 'passkey' });
    render(<HostedApp />);

    await openAction('Your account');
    expect(screen.getByText('Passkey active')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Link wallet' })).toBeInTheDocument();
  });

  it('shows the callback result, refreshes connected state, and removes callback parameters', async () => {
    authenticate();
    window.history.replaceState({}, '', '/?ai=openrouter&openrouter=connected');
    vi.mocked(hostedApi.getHostedProviderStatus).mockResolvedValue(connected);

    render(<HostedApp />);

    expect(await screen.findByText(/openrouter is connected/i)).toBeInTheDocument();
    await openAction('Connect a model');
    fireEvent.click(screen.getByText('Connection actions'));
    expect(screen.getByRole('button', { name: /disconnect openrouter/i })).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toBe(''));
    expect(hostedApi.listHostedAvatars).toHaveBeenCalledOnce();
  });

  it('disconnects the account provider and returns to the OAuth setup state', async () => {
    authenticate();
    vi.mocked(hostedApi.getHostedProviderStatus).mockResolvedValue(connected);
    render(<HostedApp />);

    await openAction('Connect a model');
    fireEvent.click(screen.getByText('Connection actions'));
    fireEvent.click(screen.getByRole('button', { name: /disconnect openrouter/i }));

    expect(await screen.findByRole('link', { name: /connect openrouter securely/i })).toBeInTheDocument();
    expect(hostedApi.disconnectHostedProvider).toHaveBeenCalledOnce();
  });

  it('keeps one chat surface and opens one action at a time', async () => {
    authenticate();
    vi.mocked(hostedApi.getHostedProviderStatus).mockResolvedValue(connected);
    vi.mocked(hostedApi.listHostedAvatars).mockResolvedValue([
      { avatarId: 'jax', name: 'Jax', status: 'active', createdAt: 1, updatedAt: 1 },
    ]);
    vi.mocked(hostedApi.getHostedHistory).mockResolvedValue([
      { role: 'assistant', content: '<thinking>Private provider reasoning</thinking>How can I help?' },
      { role: 'user', content: 'Show me the workspace.' },
    ]);
    render(<HostedApp />);
    expect(await screen.findByText('How can I help?')).toBeInTheDocument();
    expect(screen.queryByText(/Private provider reasoning/)).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Choose companion' })).toHaveValue('jax');
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^settings$/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/system prompt/i)).not.toBeInTheDocument();

    await openAction('Shape this companion');
    expect(screen.getByLabelText(/system prompt/i)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Hosted chat' })).toContainElement(
      screen.getByLabelText(/system prompt/i),
    );
    expect(screen.getByLabelText('Message')).toBeInTheDocument();
    expect(screen.queryByLabelText(/botfather token/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close Shape this companion' }));
    expect(screen.queryByLabelText(/system prompt/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText('Message')).toHaveFocus();
  });

  it('shows and persists the active companion system prompt in a chat card', async () => {
    authenticate();
    vi.mocked(hostedApi.getHostedProviderStatus).mockResolvedValue(connected);
    vi.mocked(hostedApi.listHostedAvatars).mockResolvedValue([
      {
        avatarId: 'ada',
        name: 'Ada',
        description: 'A careful research companion.',
        persona: 'Be careful and concise.',
        status: 'active',
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    vi.mocked(hostedApi.updateHostedAvatarProfile).mockResolvedValue({
      avatarId: 'ada',
      name: 'Ada North',
      description: 'A careful research companion.',
      persona: 'Be direct, curious, and evidence-led.',
      status: 'active',
      createdAt: 1,
      updatedAt: 2,
    });

    render(<HostedApp />);

    await openAction('Shape this companion');
    const prompt = await screen.findByLabelText(/system prompt/i);
    await waitFor(() => expect(prompt).toHaveValue('Be careful and concise.'));
    fireEvent.change(screen.getByLabelText(/^name$/i), { target: { value: 'Ada North' } });
    fireEvent.change(prompt, { target: { value: 'Be direct, curious, and evidence-led.' } });
    fireEvent.click(screen.getByRole('button', { name: /save voice & identity/i }));

    await waitFor(() =>
      expect(hostedApi.updateHostedAvatarProfile).toHaveBeenCalledWith('ada', {
        name: 'Ada North',
        description: 'A careful research companion.',
        persona: 'Be direct, curious, and evidence-led.',
      }),
    );
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Ada North' })).toBeInTheDocument();
  });

  it('creates a companion from a name card inside chat', async () => {
    authenticate();
    vi.mocked(hostedApi.getHostedProviderStatus).mockResolvedValue(connected);
    render(<HostedApp />);

    await waitFor(() => expect(hostedApi.listHostedAvatars).toHaveBeenCalledOnce());
    await screen.findByLabelText(/companion name/i);

    const name = screen.getByLabelText(/companion name/i);
    fireEvent.change(name, { target: { value: 'Nova' } });
    fireEvent.click(screen.getByRole('button', { name: /^create companion$/i }));

    await waitFor(() =>
      expect(hostedApi.createHostedAvatar).toHaveBeenCalledWith({
        name: 'Nova',
        visibility: 'public',
        listed: true,
      }),
    );
    expect(await screen.findByLabelText('Message')).toHaveAttribute('placeholder', 'Message Nova');
    expect(screen.getByRole('region', { name: 'Hosted chat' })).toBeInTheDocument();
  });

  it('shows Telegram as the second connector and clears the write-only token immediately', async () => {
    authenticate();
    vi.mocked(hostedApi.getHostedProviderStatus).mockResolvedValue(connected);
    vi.mocked(hostedApi.listHostedAvatars).mockResolvedValue([
      {
        avatarId: 'avatar-1',
        name: 'Jax',
        status: 'shell',
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    render(<HostedApp />);

    await openAction('Connect Telegram');
    const token = await screen.findByLabelText(/botfather token/i);
    fireEvent.change(token, { target: { value: testBotToken } });
    fireEvent.click(await screen.findByRole('button', { name: /connect telegram bot/i }));

    await waitFor(() => expect(hostedApi.connectHostedTelegram).toHaveBeenCalledWith('avatar-1', testBotToken));
    expect(screen.queryByDisplayValue(testBotToken)).not.toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /prove ownership/i })).toHaveAttribute(
      'href',
      'https://t.me/JaxSwarmBot?start=one-time-code',
    );
  });

  it('offers avatar-scoped X OAuth and disconnects without exposing credentials', async () => {
    authenticate();
    vi.mocked(hostedApi.getHostedProviderStatus).mockResolvedValue(connected);
    vi.mocked(hostedApi.getHostedXStatus).mockResolvedValue({
      connected: true,
      status: 'connected',
      username: 'JaxOnX',
      userId: '42',
      lastPolledAt: 10,
    });
    vi.mocked(hostedApi.listHostedAvatars).mockResolvedValue([
      {
        avatarId: 'avatar/one',
        name: 'Jax',
        status: 'shell',
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    render(<HostedApp />);

    await openAction('Connect X');
    const account = await screen.findByRole('link', { name: '@JaxOnX' });
    expect(account).toHaveAttribute('href', 'https://x.com/JaxOnX');
    fireEvent.click(screen.getByText(/^X options$/u));
    fireEvent.click(screen.getByRole('button', { name: /disconnect x/i }));
    await waitFor(() => expect(hostedApi.disconnectHostedX).toHaveBeenCalledWith('avatar/one'));
    expect(await screen.findByRole('button', { name: /connect x account/i })).toBeInTheDocument();
  });

  it('starts X connection for the active avatar and shows the connecting state', async () => {
    authenticate();
    vi.mocked(hostedApi.getHostedProviderStatus).mockResolvedValue(connected);
    vi.mocked(hostedApi.listHostedAvatars).mockResolvedValue([
      {
        avatarId: 'avatar-1',
        name: 'Jax',
        status: 'shell',
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    vi.mocked(hostedApi.connectHostedX).mockImplementation(() => new Promise(() => undefined));
    render(<HostedApp />);

    await openAction('Connect X');
    fireEvent.click(await screen.findByRole('button', { name: /connect x account/i }));

    await waitFor(() => expect(hostedApi.connectHostedX).toHaveBeenCalledWith('avatar-1'));
    expect(screen.getByText('Connecting X…')).toBeInTheDocument();
  });

  it('returns from X OAuth to the companion that started the flow', async () => {
    authenticate();
    window.history.replaceState({}, '', '/?x=connected&xAvatarId=avatar-2');
    vi.mocked(hostedApi.getHostedProviderStatus).mockResolvedValue(connected);
    vi.mocked(hostedApi.listHostedAvatars).mockResolvedValue([
      { avatarId: 'avatar-1', name: 'Jax', status: 'shell', createdAt: 1, updatedAt: 1 },
      { avatarId: 'avatar-2', name: 'Nova', status: 'shell', createdAt: 1, updatedAt: 1 },
    ]);
    render(<HostedApp />);

    expect(await screen.findByText(/x is connected.*mentions and replies/iu)).toBeInTheDocument();
    await waitFor(() => expect(hostedApi.getHostedXStatus).toHaveBeenCalledWith('avatar-2'));
    expect(window.location.search).toBe('');
  });

  it('publishes a listed public portable avatar by default', async () => {
    authenticate();
    render(<HostedApp />);

    await waitFor(() => expect(hostedApi.listHostedAvatars).toHaveBeenCalledOnce());
    await screen.findByLabelText(/companion name/i);

    fireEvent.change(screen.getByLabelText(/companion name/i), { target: { value: 'Public Ada' } });
    fireEvent.click(screen.getByText(/^add details$/i));
    fireEvent.change(screen.getByLabelText(/public description/i), { target: { value: 'An open research mind.' } });
    fireEvent.change(screen.getByLabelText(/starting character/i), { target: { value: 'Think in public.' } });
    fireEvent.click(screen.getByRole('button', { name: /^create companion$/i }));

    await waitFor(() =>
      expect(hostedApi.createHostedAvatar).toHaveBeenCalledWith({
        name: 'Public Ada',
        description: 'An open research mind.',
        persona: 'Think in public.',
        visibility: 'public',
        listed: true,
      }),
    );
  });

  it('shows bound groups, copies the existing-group command, and updates group controls', async () => {
    authenticate();
    vi.mocked(hostedApi.getHostedProviderStatus).mockResolvedValue(connected);
    vi.mocked(hostedApi.listHostedAvatars).mockResolvedValue([
      {
        avatarId: 'avatar-1',
        name: 'Jax',
        status: 'shell',
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    const telegramStatus: hostedApi.HostedTelegramStatus = {
      connected: true,
      status: 'connected',
      ownerBound: true,
      bot: { id: '123', username: 'JaxSwarmBot', name: 'Jax' },
      addToGroupUrl: 'https://t.me/JaxSwarmBot?startgroup=group-code',
      groupBindCommand: '/start@JaxSwarmBot group-code',
      groups: [
        {
          chatId: '-1001',
          title: 'Penguin HQ',
          type: 'supergroup',
          enabled: true,
          membershipStatus: 'member',
        },
      ],
    };
    vi.mocked(hostedApi.getHostedTelegramStatus).mockResolvedValue(telegramStatus);
    vi.mocked(hostedApi.setHostedTelegramGroupEnabled).mockResolvedValue({
      ...telegramStatus,
      groups: [{ ...telegramStatus.groups[0]!, enabled: false }],
    });
    vi.mocked(hostedApi.forgetHostedTelegramGroup).mockResolvedValue({ ...telegramStatus, groups: [] });
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<HostedApp />);

    await openAction('Connect Telegram');
    expect(await screen.findByText('Penguin HQ')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Telegram options'));
    fireEvent.click(screen.getByRole('button', { name: /copy command for an existing group/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('/start@JaxSwarmBot group-code'));

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    await waitFor(() =>
      expect(hostedApi.setHostedTelegramGroupEnabled).toHaveBeenCalledWith('avatar-1', '-1001', false),
    );
    fireEvent.click(await screen.findByRole('button', { name: /forget group/i }));
    await waitFor(() => expect(hostedApi.forgetHostedTelegramGroup).toHaveBeenCalledWith('avatar-1', '-1001'));
    expect(confirm).toHaveBeenCalled();
    confirm.mockRestore();
  });
  it('opens a service card from a short chat request', async () => {
    authenticate();
    vi.mocked(hostedApi.getHostedProviderStatus).mockResolvedValue(connected);
    vi.mocked(hostedApi.listHostedAvatars).mockResolvedValue([
      { avatarId: 'jax', name: 'Jax', status: 'active', createdAt: 1, updatedAt: 1 },
    ]);
    render(<HostedApp />);
    fireEvent.change(await screen.findByLabelText('Message'), { target: { value: 'connect Telegram' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByLabelText(/BotFather token/i)).toBeInTheDocument();
    expect(hostedApi.enqueueHostedMessage).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Message')).toHaveValue('');
  });

  it('sends ordinary messages and shows only the final answer', async () => {
    authenticate();
    vi.mocked(hostedApi.getHostedProviderStatus).mockResolvedValue(connected);
    vi.mocked(hostedApi.listHostedAvatars).mockResolvedValue([
      { avatarId: 'jax', name: 'Jax', status: 'active', createdAt: 1, updatedAt: 1 },
    ]);
    vi.mocked(hostedApi.enqueueHostedMessage).mockResolvedValue({ jobId: 'job-1' });
    vi.mocked(hostedApi.waitForHostedJob).mockResolvedValue({
      jobId: 'job-1',
      status: 'completed',
      response: '<think>provider reasoning</think>Here is a simple plan.',
    });
    render(<HostedApp />);
    fireEvent.change(await screen.findByLabelText('Message'), { target: { value: 'Help me make a plan' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Here is a simple plan.')).toBeInTheDocument();
    expect(hostedApi.enqueueHostedMessage).toHaveBeenCalledWith('jax', 'Help me make a plan');
    expect(screen.queryByText(/provider reasoning/)).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Choose companion' })).toBeEnabled();
  });

  it.each([
    ['Connect a model', 'Connection actions', 'Disconnect OpenRouter', 'disconnectHostedProvider'],
    ['Connect Telegram', 'Telegram options', 'Disconnect Telegram', 'disconnectHostedTelegram'],
    ['Connect X', 'X options', 'Disconnect X', 'disconnectHostedX'],
  ] as const)('asks before changing %s access', async (action, details, button, method) => {
    authenticate();
    vi.mocked(hostedApi.getHostedProviderStatus).mockResolvedValue(connected);
    vi.mocked(hostedApi.listHostedAvatars).mockResolvedValue([
      { avatarId: 'jax', name: 'Jax', status: 'active', createdAt: 1, updatedAt: 1 },
    ]);
    vi.mocked(hostedApi.getHostedTelegramStatus).mockResolvedValue({
      connected: true,
      status: 'connected',
      ownerBound: true,
      groups: [],
      bot: { id: '1', username: 'SampleBot', name: 'Sample' },
    });
    vi.mocked(hostedApi.getHostedXStatus).mockResolvedValue({
      connected: true,
      status: 'connected',
      username: 'Sample',
    });
    vi.mocked(window.confirm).mockReturnValue(false);
    render(<HostedApp />);
    await openAction(action);
    fireEvent.click(await screen.findByText(details));
    fireEvent.click(screen.getByRole('button', { name: button, exact: true }));
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(hostedApi[method]).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Message')).toBeInTheDocument();
  });

  it('lets a new companion stay private', async () => {
    authenticate();
    render(<HostedApp />);
    fireEvent.change(await screen.findByLabelText(/companion name/i), { target: { value: 'Private Ada' } });
    fireEvent.click(screen.getByText('Add details'));
    fireEvent.change(screen.getByLabelText('Visibility'), { target: { value: 'private' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create companion' }));
    await waitFor(() =>
      expect(hostedApi.createHostedAvatar).toHaveBeenCalledWith({
        name: 'Private Ada',
        visibility: 'private',
        listed: false,
      }),
    );
  });

  it('asks before importing the public companion selected in Discover', async () => {
    authenticate();
    window.history.replaceState({}, '', '/studio?companion=public-ada');
    const publicProject: hostedApi.PublicHostedAvatarProject = {
      avatarId: 'public-ada',
      slug: 'public-ada',
      name: 'Public Ada',
      description: 'A research companion.',
      visibility: 'public',
      listed: true,
      revisionId: 'sha256:sample',
      controller: 'sample-controller',
      createdAt: 1,
      updatedAt: 1,
      sha256: 'sample',
      bundle: {
        schema: 'swarm.avatar/v1',
        identity: {
          avatarId: 'public-ada',
          slug: 'public-ada',
          name: 'Public Ada',
          description: 'A research companion.',
          controller: { type: 'solana-wallet', address: 'sample-controller' },
        },
        publication: { visibility: 'public', listed: true },
        prompts: { system: 'Be helpful.', starters: [] },
        capabilities: [],
        sharedMemory: { summary: '', entries: [] },
        media: [],
        lineage: {},
        revision: { createdAt: '2026-09-02T00:00:00Z' },
      },
    };
    vi.mocked(hostedApi.getPublicHostedAvatar).mockResolvedValue(publicProject);
    vi.mocked(hostedApi.importHostedAvatar).mockResolvedValue({
      avatarId: 'my-ada',
      name: 'Public Ada',
      status: 'active',
      createdAt: 1,
      updatedAt: 1,
    });
    render(<HostedApp />);
    const add = await screen.findByRole('button', { name: 'Add to my companions' });
    expect(hostedApi.importHostedAvatar).not.toHaveBeenCalled();
    fireEvent.click(add);
    await waitFor(() => expect(hostedApi.importHostedAvatar).toHaveBeenCalledWith(publicProject.bundle));
    expect(window.location.search).toBe('');
    expect(await screen.findByRole('link', { name: /connect openrouter securely/i })).toBeInTheDocument();
  });
});
