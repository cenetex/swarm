import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { API_BASE } from './api/apiBase';
import { HostedWalletSignIn } from './components/HostedWalletSignIn';
import {
  createHostedAvatar,
  connectHostedTelegram,
  disconnectHostedProvider,
  disconnectHostedTelegram,
  enqueueHostedMessage,
  getHostedHistory,
  getHostedProviderStatus,
  getHostedTelegramStatus,
  importHostedAvatar,
  listHostedAvatars,
  openRouterConnectUrl,
  openRouterResult,
  ownedHostedAvatarBundleUrl,
  repairHostedTelegram,
  updateHostedAvatarPublication,
  waitForHostedJob,
  type HostedAvatar,
  type HostedChatMessage,
  type HostedProviderStatus,
  type HostedTelegramStatus,
} from './hosted-api';
import { useAuth } from './store/auth';

function shortWallet(walletAddress: string): string {
  return `${walletAddress.slice(0, 5)}…${walletAddress.slice(-4)}`;
}

function cleanOpenRouterResult(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('ai');
  url.searchParams.delete('openrouter');
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

export function hostedEnvironmentCopy(environment: string | undefined) {
  return environment === 'production'
    ? {
      label: 'Production',
      footer: 'Account data is isolated and credentials stay encrypted.',
    }
    : {
      label: 'Private preview',
      footer: 'Preview data is isolated from production.',
    };
}

function StatusDot({ ready }: { ready: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${ready ? 'bg-emerald-400' : 'bg-amber-400'}`}
    />
  );
}

export function HostedApp() {
  const environmentCopy = hostedEnvironmentCopy(import.meta.env.VITE_HOSTED_ENVIRONMENT);
  const { isAuthenticated, user } = useAuth();
  const [oauthResult] = useState(() => openRouterResult(window.location.search));
  const [provider, setProvider] = useState<HostedProviderStatus | null>(null);
  const [avatars, setAvatars] = useState<HostedAvatar[]>([]);
  const [activeAvatarId, setActiveAvatarId] = useState('');
  const [messages, setMessages] = useState<HostedChatMessage[]>([]);
  const [avatarName, setAvatarName] = useState('My hosted avatar');
  const [avatarDescription, setAvatarDescription] = useState('');
  const [avatarPersona, setAvatarPersona] = useState('');
  const [avatarVisibility, setAvatarVisibility] = useState<'public' | 'private'>('public');
  const [avatarListed, setAvatarListed] = useState(true);
  const [draft, setDraft] = useState('');
  const [telegram, setTelegram] = useState<HostedTelegramStatus | null>(null);
  const [telegramToken, setTelegramToken] = useState('');
  const [telegramLoading, setTelegramLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [error, setError] = useState('');

  const activeAvatar = useMemo(
    () => avatars.find((avatar) => avatar.avatarId === activeAvatarId) ?? null,
    [activeAvatarId, avatars],
  );

  const refreshAvatars = useCallback(async () => {
    const nextAvatars = await listHostedAvatars();
    setAvatars(nextAvatars);
    setActiveAvatarId((current) => current || nextAvatars[0]?.avatarId || '');
  }, []);

  const refreshProvider = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const nextProvider = await getHostedProviderStatus();
      setProvider(nextProvider);
      await refreshAvatars();
      if (!nextProvider.connected) setMessages([]);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Unable to load hosted status.');
    } finally {
      setLoading(false);
    }
  }, [refreshAvatars]);

  useEffect(() => {
    if (oauthResult) cleanOpenRouterResult();
  }, [oauthResult]);

  useEffect(() => {
    if (!isAuthenticated) {
      setProvider(null);
      setAvatars([]);
      setActiveAvatarId('');
      setMessages([]);
      setTelegram(null);
      setTelegramToken('');
      setTelegramLoading(false);
      return;
    }
    void refreshProvider();
  }, [isAuthenticated, refreshProvider]);

  const refreshTelegram = useCallback(async () => {
    if (!activeAvatarId) {
      setTelegram(null);
      setTelegramLoading(false);
      return;
    }
    setTelegramLoading(true);
    try {
      const status = await getHostedTelegramStatus(activeAvatarId);
      setTelegram(status);
    } finally {
      setTelegramLoading(false);
    }
  }, [activeAvatarId]);

  useEffect(() => {
    if (!activeAvatarId || !provider?.connected) {
      setTelegram(null);
      setTelegramLoading(false);
      return;
    }
    setTelegram(null);
    void refreshTelegram().catch((telegramError) => {
      setError(telegramError instanceof Error ? telegramError.message : 'Unable to load Telegram status.');
    });
  }, [activeAvatarId, provider?.connected, refreshTelegram]);

  useEffect(() => {
    if (!activeAvatarId || !provider?.connected) {
      setMessages([]);
      return;
    }
    let active = true;
    getHostedHistory(activeAvatarId)
      .then((history) => {
        if (active) setMessages(history);
      })
      .catch((historyError) => {
        if (active) setError(historyError instanceof Error ? historyError.message : 'Unable to load chat history.');
      });
    return () => {
      active = false;
    };
  }, [activeAvatarId, provider?.connected]);

  useEffect(() => {
    if (!manageOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setManageOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [manageOpen]);

  const handleDisconnect = async () => {
    setLoading(true);
    setError('');
    try {
      const nextProvider = await disconnectHostedProvider();
      setProvider(nextProvider);
      setMessages([]);
    } catch (disconnectError) {
      setError(disconnectError instanceof Error ? disconnectError.message : 'Unable to disconnect OpenRouter.');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateAvatar = async (event: FormEvent) => {
    event.preventDefault();
    if (!avatarName.trim()) return;
    setLoading(true);
    setError('');
    try {
      const avatar = await createHostedAvatar({
        name: avatarName.trim(),
        ...(avatarDescription.trim() ? { description: avatarDescription.trim() } : {}),
        ...(avatarPersona.trim() ? { persona: avatarPersona.trim() } : {}),
        visibility: avatarVisibility,
        listed: avatarVisibility === 'public' && avatarListed,
      });
      setAvatars((current) => [avatar, ...current]);
      setActiveAvatarId(avatar.avatarId);
      setMessages([]);
      setAvatarName('My hosted avatar');
      setAvatarDescription('');
      setAvatarPersona('');
      setAvatarVisibility('public');
      setAvatarListed(true);
      setManageOpen(false);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Unable to create the avatar.');
    } finally {
      setLoading(false);
    }
  };

  const handleImportAvatar = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setLoading(true);
    setError('');
    try {
      const bundle = JSON.parse(await file.text()) as unknown;
      const avatar = await importHostedAvatar(bundle);
      setAvatars((current) => [avatar, ...current]);
      setActiveAvatarId(avatar.avatarId);
      setMessages([]);
      setManageOpen(false);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : 'Unable to import the portable avatar.');
    } finally {
      setLoading(false);
    }
  };

  const handlePublishAvatar = async (avatarId: string) => {
    setLoading(true);
    setError('');
    try {
      const updated = await updateHostedAvatarPublication(avatarId, { visibility: 'public', listed: true });
      setAvatars((current) => current.map((avatar) => avatar.avatarId === avatarId ? updated : avatar));
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : 'Unable to publish the avatar.');
    } finally {
      setLoading(false);
    }
  };

  const handleConnectTelegram = async (event: FormEvent) => {
    event.preventDefault();
    const token = telegramToken.trim();
    if (!activeAvatarId || !token) return;
    setTelegramToken('');
    setLoading(true);
    setError('');
    try {
      setTelegram(await connectHostedTelegram(activeAvatarId, token));
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : 'Unable to connect Telegram.');
    } finally {
      setLoading(false);
    }
  };

  const handleRepairTelegram = async () => {
    if (!activeAvatarId) return;
    setLoading(true);
    setError('');
    try {
      setTelegram(await repairHostedTelegram(activeAvatarId));
    } catch (repairError) {
      setError(repairError instanceof Error ? repairError.message : 'Unable to repair Telegram.');
    } finally {
      setLoading(false);
    }
  };

  const handleRefreshTelegram = async () => {
    setError('');
    try {
      await refreshTelegram();
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Unable to load Telegram status.');
    }
  };

  const handleDisconnectTelegram = async () => {
    if (!activeAvatarId) return;
    setLoading(true);
    setError('');
    try {
      await disconnectHostedTelegram(activeAvatarId);
      setTelegram({ connected: false, status: 'disconnected', ownerBound: false });
    } catch (disconnectError) {
      setError(disconnectError instanceof Error ? disconnectError.message : 'Unable to disconnect Telegram.');
    } finally {
      setLoading(false);
    }
  };

  const handleSend = async (event: FormEvent) => {
    event.preventDefault();
    const message = draft.trim();
    if (!message || !activeAvatarId || sending) return;
    setSending(true);
    setError('');
    setDraft('');
    setMessages((current) => [...current, { role: 'user', content: message }]);
    try {
      const queued = await enqueueHostedMessage(activeAvatarId, message);
      const job = await waitForHostedJob(queued.jobId);
      if (job.status !== 'completed' || !job.response) {
        throw new Error(job.error || 'The hosted model did not return a response.');
      }
      setMessages(job.history ?? [
        ...messages,
        { role: 'user', content: message },
        { role: 'assistant', content: job.response },
      ]);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : 'Unable to send the hosted message.');
    } finally {
      setSending(false);
    }
  };

  const selectAvatar = (avatarId: string) => {
    setActiveAvatarId(avatarId);
    setManageOpen(false);
  };

  const providerReady = Boolean(provider?.connected);
  const workspaceReady = providerReady && Boolean(activeAvatar);
  const activeName = activeAvatar?.name ?? 'Hosted chat';

  return (
    <div className="h-[100dvh] overflow-hidden bg-[var(--color-bg)] text-[var(--color-text)]">
      <header className="h-16 border-b border-[var(--color-border)] bg-[var(--color-bg)]">
        <div className="mx-auto flex h-full max-w-[90rem] items-center justify-between gap-3 px-4 sm:px-6">
          <a href="/" className="flex min-w-0 items-center gap-3" aria-label="Swarm public registry">
            <img src="/swarm.svg" alt="" className="h-8 w-8 shrink-0" />
            <div className="min-w-0">
              <div className="flex items-baseline gap-2">
                <h1 className="truncate text-base font-semibold">Swarm</h1>
                <span className="text-sm text-[var(--color-text-secondary)]">Studio</span>
              </div>
              <p className="hidden text-xs text-[var(--color-text-muted)] sm:block">{environmentCopy.label}</p>
            </div>
          </a>
          <div className="flex items-center gap-2">
            <a href="/" className="hidden rounded-lg px-3 py-2 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)] sm:block">Discover</a>
            <HostedWalletSignIn showIcon={!isAuthenticated} />
          </div>
        </div>
      </header>

      <main className="relative mx-auto grid h-[calc(100dvh-4rem)] max-w-[90rem] overflow-hidden lg:grid-cols-[17rem_minmax(0,1fr)] lg:border-x lg:border-[var(--color-border)]">
        <section
          aria-label="Hosted chat"
          className="flex min-h-0 min-w-0 flex-col bg-[var(--color-bg)] lg:col-start-2 lg:row-start-1"
        >
          <div className="flex min-h-[4.5rem] items-center justify-between gap-4 border-b border-[var(--color-border)] px-4 py-3 sm:px-6">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                {isAuthenticated && <StatusDot ready={workspaceReady} />}
                <h2 className="truncate font-semibold">{activeName}</h2>
              </div>
              <p className="mt-1 truncate text-xs text-[var(--color-text-muted)]">
                {loading
                  ? 'Checking your workspace…'
                  : workspaceReady
                    ? 'Available while your browser is closed'
                    : isAuthenticated
                      ? 'Your public project is ready; connect a model to chat'
                      : 'Sign in to publish or restore an avatar'}
              </p>
            </div>
            <button
              type="button"
              aria-controls="hosted-workspace-management"
              aria-expanded={manageOpen}
              onClick={() => setManageOpen(true)}
              className="shrink-0 rounded-lg border border-[var(--color-border-secondary)] px-3 py-2 text-sm font-medium transition hover:bg-[var(--color-bg-secondary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-400 lg:hidden"
            >
              Manage
            </button>
          </div>

          {(error || oauthResult) && (
            <div className="border-b border-[var(--color-border)] px-4 py-3 sm:px-6" role="status">
              {oauthResult === 'connected' && !error && (
                <p className="border-l-2 border-emerald-400 pl-3 text-sm text-emerald-200">
                  OpenRouter connected. The credential was exchanged and stored server-side.
                </p>
              )}
              {(oauthResult === 'error' || error) && (
                <p className="border-l-2 border-red-400 pl-3 text-sm text-red-200">
                  {error || 'OpenRouter authorization did not complete. Please try again.'}
                </p>
              )}
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto px-4 sm:px-6" aria-live="polite">
            <div className="mx-auto flex min-h-full max-w-3xl flex-col">
              {!isAuthenticated && (
                <div className="m-auto max-w-lg py-12 text-center">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-300">Your avatar studio</p>
                  <h3 className="mt-3 text-2xl font-semibold">Publish a mind you can carry.</h3>
                  <p className="mt-3 text-sm leading-6 text-[var(--color-text-secondary)]">
                    Sign in with Phantom or Solflare to create, restore, and operate portable avatar projects. Public is the default.
                  </p>
                  <HostedWalletSignIn className="mx-auto mt-6 justify-center" />
                </div>
              )}

              {isAuthenticated && !providerReady && !loading && (
                <div className="m-auto max-w-lg py-12 text-center">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-300">One step left</p>
                  <h3 className="mt-3 text-2xl font-semibold">Connect your model provider.</h3>
                  <p className="mt-3 text-sm leading-6 text-[var(--color-text-secondary)]">
                    Open Manage to authorize OpenRouter with PKCE. The exchanged credential is stored encrypted for your account.
                  </p>
                  <button
                    type="button"
                    onClick={() => setManageOpen(true)}
                    className="mt-6 rounded-lg border border-[var(--color-border-secondary)] px-4 py-2.5 text-sm font-semibold transition hover:bg-[var(--color-bg-secondary)] lg:hidden"
                  >
                    Open Manage
                  </button>
                </div>
              )}

              {providerReady && !activeAvatar && !loading && (
                <div className="m-auto max-w-lg py-12 text-center">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-300">Ready for an avatar</p>
                  <h3 className="mt-3 text-2xl font-semibold">Give your workspace a voice.</h3>
                  <p className="mt-3 text-sm leading-6 text-[var(--color-text-secondary)]">
                    Create your first hosted avatar from Manage. It will get its own isolated conversation history.
                  </p>
                  <button
                    type="button"
                    onClick={() => setManageOpen(true)}
                    className="mt-6 rounded-lg border border-[var(--color-border-secondary)] px-4 py-2.5 text-sm font-semibold transition hover:bg-[var(--color-bg-secondary)] lg:hidden"
                  >
                    Open Manage
                  </button>
                </div>
              )}

              {messages.length > 0 && (
                <div className="py-2">
                  {messages.map((message, index) => {
                    const sender = message.role === 'user' ? 'You' : activeName;
                    return (
                      <article
                        key={`${message.role}-${index}`}
                        aria-label={`${sender} message`}
                        data-message-role={message.role}
                        className={`grid grid-cols-[3.5rem_minmax(0,1fr)] gap-3 border-b border-[var(--color-border)] py-5 sm:grid-cols-[5rem_minmax(0,1fr)] ${
                          message.role === 'user' ? 'border-l-2 border-l-brand-400 bg-brand-500/10 px-3' : ''
                        }`}
                      >
                        <p className="pt-0.5 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
                          {sender}
                        </p>
                        <p className="chat-message whitespace-pre-wrap text-sm leading-6 text-[var(--color-text-secondary)]">
                          {message.content}
                        </p>
                      </article>
                    );
                  })}
                  {sending && (
                    <div className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-3 border-b border-[var(--color-border)] py-5 sm:grid-cols-[5rem_minmax(0,1fr)]">
                      <p className="pt-0.5 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">
                        {activeName}
                      </p>
                      <p className="text-sm text-[var(--color-text-muted)]">Thinking…</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {activeAvatar && providerReady && (
            <form onSubmit={(event) => void handleSend(event)} className="border-t border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3 sm:px-6 sm:py-4">
              <div className="mx-auto flex max-w-3xl gap-2 sm:gap-3">
                <label htmlFor="hosted-message" className="sr-only">Message</label>
                <input
                  id="hosted-message"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  maxLength={4000}
                  placeholder={`Message ${activeAvatar.name}`}
                  className="min-w-0 flex-1 rounded-lg border border-[var(--color-border-secondary)] bg-[var(--color-bg-secondary)] px-4 py-3 text-sm outline-none transition focus:border-brand-400 focus:ring-1 focus:ring-brand-400"
                />
                <button
                  type="submit"
                  disabled={sending || !draft.trim()}
                  className="rounded-lg bg-brand-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-brand-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-300 disabled:opacity-50 sm:px-5"
                >
                  Send
                </button>
              </div>
            </form>
          )}
        </section>

        {manageOpen && (
          <button
            type="button"
            aria-label="Close workspace management"
            onClick={() => setManageOpen(false)}
            className="fixed inset-0 top-16 z-30 bg-black/60 lg:hidden"
          />
        )}

        <aside
          id="hosted-workspace-management"
          aria-label="Workspace management"
          data-mobile-open={manageOpen}
          className={`fixed inset-x-0 bottom-0 top-16 z-40 flex min-h-0 flex-col border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)] shadow-2xl transition duration-200 lg:visible lg:relative lg:inset-auto lg:z-auto lg:col-start-1 lg:row-start-1 lg:border-r lg:border-t-0 lg:shadow-none ${
            manageOpen ? 'visible translate-y-0 opacity-100' : 'invisible translate-y-4 opacity-0 lg:translate-y-0 lg:opacity-100'
          }`}
        >
          <div className="flex h-[4.5rem] shrink-0 items-center justify-between border-b border-[var(--color-border)] px-5">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-300">Workspace</p>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">{environmentCopy.label}</p>
            </div>
            <button
              type="button"
              onClick={() => setManageOpen(false)}
              className="rounded-lg px-3 py-2 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] lg:hidden"
            >
              Close
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <section aria-labelledby="runtime-heading" className="border-b border-[var(--color-border)] px-5 py-5">
              <div className="flex items-center justify-between gap-3">
                <h2 id="runtime-heading" className="text-sm font-semibold">Runtime</h2>
                <span className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
                  <StatusDot ready={isAuthenticated && providerReady} />
                  {loading ? 'Checking' : isAuthenticated && providerReady ? 'Ready' : 'Setup required'}
                </span>
              </div>
              <dl className="mt-4 grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
                <dt className="text-[var(--color-text-muted)]">Account</dt>
                <dd className="truncate font-mono text-[var(--color-text-secondary)]">
                  {user ? shortWallet(user.walletAddress) : 'Not signed in'}
                </dd>
                <dt className="text-[var(--color-text-muted)]">Session</dt>
                <dd className="text-[var(--color-text-secondary)]">{isAuthenticated ? 'Active' : 'Inactive'}</dd>
              </dl>
            </section>

            {isAuthenticated && (
              <section aria-labelledby="provider-heading" className="border-b border-[var(--color-border)] px-5 py-5">
                <div className="flex items-center justify-between gap-3">
                  <h2 id="provider-heading" className="text-sm font-semibold">OpenRouter</h2>
                  <span className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
                    <StatusDot ready={providerReady} />
                    {providerReady ? 'Connected' : 'Not connected'}
                  </span>
                </div>
                <p className="mt-3 text-xs leading-5 text-[var(--color-text-muted)]">
                  OAuth uses PKCE S256. The exchanged credential is encrypted for your account and never returned to this page.
                </p>
                {providerReady ? (
                  <button
                    type="button"
                    onClick={() => void handleDisconnect()}
                    disabled={loading}
                    className="mt-3 text-sm font-medium text-red-300 underline decoration-red-400/40 underline-offset-4 hover:text-red-200 disabled:opacity-50"
                  >
                    Disconnect OpenRouter
                  </button>
                ) : (
                  <a
                    href={openRouterConnectUrl()}
                    className="mt-4 flex w-full justify-center rounded-lg bg-brand-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-600"
                  >
                    Connect OpenRouter securely
                  </a>
                )}
              </section>
            )}

            {isAuthenticated && (
              <section aria-labelledby="avatars-heading" className="border-b border-[var(--color-border)] px-5 py-5">
                <div className="flex items-center justify-between gap-3">
                  <h2 id="avatars-heading" className="text-sm font-semibold">Avatars</h2>
                  <span className="text-xs text-[var(--color-text-muted)]">{avatars.length}/100</span>
                </div>
                {avatars.length > 0 ? (
                  <div className="mt-3 border-y border-[var(--color-border)]">
                    {avatars.map((avatar) => (
                      <div
                        key={avatar.avatarId}
                        className={`border-b border-[var(--color-border)] px-3 py-3 text-sm transition last:border-b-0 ${
                          avatar.avatarId === activeAvatarId
                            ? 'border-l-2 border-l-brand-400 bg-brand-500/10 text-[var(--color-text)]'
                            : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)]'
                        }`}
                      >
                        <button
                          type="button"
                          aria-current={avatar.avatarId === activeAvatarId ? 'true' : undefined}
                          onClick={() => selectAvatar(avatar.avatarId)}
                          className="flex w-full items-center justify-between gap-2 text-left"
                        >
                          <span className="truncate">{avatar.name}</span>
                          <span className={`text-[0.65rem] uppercase tracking-wide ${avatar.visibility === 'private' ? 'text-amber-300' : 'text-emerald-300'}`}>
                            {avatar.visibility === 'private' ? 'Private' : 'Public'}
                          </span>
                        </button>
                        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                          <a href={ownedHostedAvatarBundleUrl(avatar.avatarId)} className="text-brand-300 underline underline-offset-4">Download</a>
                          {avatar.visibility !== 'private' && avatar.slug && (
                            <a href={`/a/${avatar.slug}`} className="text-brand-300 underline underline-offset-4">Public page</a>
                          )}
                          {avatar.visibility === 'private' && (
                            <button
                              type="button"
                              onClick={() => void handlePublishAvatar(avatar.avatarId)}
                              disabled={loading}
                              className="text-emerald-300 underline underline-offset-4 disabled:opacity-50"
                            >
                              Publish
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 text-xs leading-5 text-[var(--color-text-muted)]">No avatars yet.</p>
                )}

                <details className="mt-4 border-t border-[var(--color-border)] pt-4">
                  <summary className="cursor-pointer text-sm font-medium text-brand-300 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-400">
                    Publish a new avatar
                  </summary>
                  <form onSubmit={(event) => void handleCreateAvatar(event)} className="mt-4 space-y-3">
                    <label htmlFor="avatar-name" className="block text-xs text-[var(--color-text-muted)]">Avatar name</label>
                    <input
                      id="avatar-name"
                      value={avatarName}
                      onChange={(event) => setAvatarName(event.target.value)}
                      maxLength={80}
                      className="w-full rounded-lg border border-[var(--color-border-secondary)] bg-[var(--color-bg)] px-3 py-2.5 text-sm outline-none transition focus:border-brand-400 focus:ring-1 focus:ring-brand-400"
                    />
                    <label htmlFor="avatar-description" className="block text-xs text-[var(--color-text-muted)]">Public description</label>
                    <textarea
                      id="avatar-description"
                      value={avatarDescription}
                      onChange={(event) => setAvatarDescription(event.target.value)}
                      maxLength={1000}
                      rows={3}
                      placeholder="What this avatar is for"
                      className="w-full resize-y rounded-lg border border-[var(--color-border-secondary)] bg-[var(--color-bg)] px-3 py-2.5 text-sm outline-none transition focus:border-brand-400 focus:ring-1 focus:ring-brand-400"
                    />
                    <label htmlFor="avatar-persona" className="block text-xs text-[var(--color-text-muted)]">Public starting prompt</label>
                    <textarea
                      id="avatar-persona"
                      value={avatarPersona}
                      onChange={(event) => setAvatarPersona(event.target.value)}
                      maxLength={50000}
                      rows={4}
                      placeholder="How this mind begins"
                      className="w-full resize-y rounded-lg border border-[var(--color-border-secondary)] bg-[var(--color-bg)] px-3 py-2.5 text-sm outline-none transition focus:border-brand-400 focus:ring-1 focus:ring-brand-400"
                    />
                    <label htmlFor="avatar-visibility" className="block text-xs text-[var(--color-text-muted)]">Visibility</label>
                    <select
                      id="avatar-visibility"
                      value={avatarVisibility}
                      onChange={(event) => setAvatarVisibility(event.target.value as 'public' | 'private')}
                      className="w-full rounded-lg border border-[var(--color-border-secondary)] bg-[var(--color-bg)] px-3 py-2.5 text-sm outline-none focus:border-brand-400"
                    >
                      <option value="public">Public</option>
                      <option value="private">Private</option>
                    </select>
                    {avatarVisibility === 'public' && (
                      <label className="flex items-start gap-2 text-xs leading-5 text-[var(--color-text-secondary)]">
                        <input
                          type="checkbox"
                          checked={avatarListed}
                          onChange={(event) => setAvatarListed(event.target.checked)}
                          className="mt-1 accent-[var(--color-brand-light)]"
                        />
                        List this avatar in the public registry
                      </label>
                    )}
                    <p className="text-xs leading-5 text-[var(--color-text-muted)]">
                      Public and listed is the default. Secrets and private chat are never included in the portable artifact.
                    </p>
                    <button
                      type="submit"
                      disabled={loading || !avatarName.trim()}
                      className="w-full rounded-lg bg-[var(--color-bg-tertiary)] px-4 py-2.5 text-sm font-medium transition hover:bg-[var(--color-bg-elevated)] disabled:opacity-50"
                    >
                      Publish portable avatar
                    </button>
                  </form>
                </details>
                <div className="mt-4 border-t border-[var(--color-border)] pt-4">
                  <label htmlFor="avatar-import" className="block cursor-pointer text-sm font-medium text-brand-300 underline underline-offset-4">
                    Restore from portable artifact
                  </label>
                  <input
                    id="avatar-import"
                    type="file"
                    accept=".json,.swarm-avatar.json,application/json,application/vnd.swarm.avatar+json"
                    onChange={(event) => void handleImportAvatar(event)}
                    disabled={loading}
                    className="sr-only"
                  />
                </div>
              </section>
            )}

            {isAuthenticated && providerReady && activeAvatar && (
              <section aria-labelledby="telegram-heading" className="px-5 py-5">
                <div className="flex items-center justify-between gap-3">
                  <h2 id="telegram-heading" className="text-sm font-semibold">Telegram</h2>
                  <span className="flex items-center gap-2 text-xs text-[var(--color-text-secondary)]">
                    <StatusDot ready={Boolean(telegram?.connected && telegram.ownerBound)} />
                    Connector 2
                  </span>
                </div>
                <p className="mt-3 text-xs leading-5 text-[var(--color-text-muted)]">
                  Connect a BotFather bot to {activeAvatar.name}. Its token is write only, and the bot answers only its owner or enabled groups.
                </p>
                {telegramLoading ? (
                  <p className="mt-4 text-xs text-[var(--color-text-muted)]">Loading Telegram status…</p>
                ) : !telegram?.connected ? (
                  <form onSubmit={(event) => void handleConnectTelegram(event)} className="mt-4 space-y-3">
                    <label htmlFor="telegram-token" className="block text-xs text-[var(--color-text-muted)]">
                      BotFather token (write only)
                    </label>
                    <input
                      id="telegram-token"
                      type="password"
                      autoComplete="new-password"
                      value={telegramToken}
                      onChange={(event) => setTelegramToken(event.target.value)}
                      placeholder="123456789:bot-token"
                      className="w-full rounded-lg border border-[var(--color-border-secondary)] bg-[var(--color-bg)] px-3 py-2.5 text-sm outline-none transition focus:border-brand-400 focus:ring-1 focus:ring-brand-400"
                    />
                    <button
                      type="submit"
                      disabled={loading || !telegramToken.trim()}
                      className="w-full rounded-lg bg-[#229ED9] px-4 py-2.5 text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-50"
                    >
                      Connect Telegram bot
                    </button>
                  </form>
                ) : (
                  <div className="mt-4 space-y-3">
                    <p className="flex min-w-0 items-center gap-2 text-xs">
                      <span className="shrink-0 text-[var(--color-text-muted)]">Bot</span>
                      <a
                        href={`https://t.me/${telegram.bot?.username ?? ''}`}
                        target="_blank"
                        rel="noreferrer"
                        className="truncate text-brand-300 underline underline-offset-4"
                      >
                        @{telegram.bot?.username}
                      </a>
                    </p>
                    {!telegram.ownerBound && telegram.ownerBindUrl && (
                      <a
                        href={telegram.ownerBindUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="block w-full rounded-lg bg-[#229ED9] px-4 py-2.5 text-center text-sm font-semibold text-white"
                      >
                        Open Telegram to prove ownership
                      </a>
                    )}
                    {telegram.ownerBound && telegram.addToGroupUrl && (
                      <a
                        href={telegram.addToGroupUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="block w-full rounded-lg bg-[#229ED9] px-4 py-2.5 text-center text-sm font-semibold text-white"
                      >
                        Add bot to a group
                      </a>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleRefreshTelegram()}
                      disabled={loading}
                      className="w-full rounded-lg border border-[var(--color-border-secondary)] px-4 py-2.5 text-sm font-medium hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50"
                    >
                      Refresh Telegram status
                    </button>
                    {((!telegram.ownerBound && !telegram.ownerBindUrl)
                      || (telegram.ownerBound && !telegram.addToGroupUrl)) && (
                      <button
                        type="button"
                        onClick={() => void handleRepairTelegram()}
                        disabled={loading}
                        className="w-full rounded-lg border border-amber-400/30 px-4 py-2.5 text-sm font-medium text-amber-200 hover:bg-amber-400/10 disabled:opacity-50"
                      >
                        Repair and refresh links
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleDisconnectTelegram()}
                      disabled={loading}
                      className="text-sm font-medium text-red-300 underline decoration-red-400/40 underline-offset-4 hover:text-red-200 disabled:opacity-50"
                    >
                      Disconnect Telegram
                    </button>
                  </div>
                )}
              </section>
            )}
          </div>

          <div className="shrink-0 border-t border-[var(--color-border)] px-5 py-4 text-xs text-[var(--color-text-muted)]">
            <p className="leading-5">{environmentCopy.footer}</p>
            <a href={`${API_BASE}/hosting/status`} className="mt-2 inline-block text-[var(--color-text-secondary)] underline underline-offset-4 hover:text-[var(--color-text)]">
              Runtime status
            </a>
          </div>
        </aside>
      </main>
    </div>
  );
}
