import { FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
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
  listHostedAvatars,
  openRouterConnectUrl,
  openRouterResult,
  repairHostedTelegram,
  waitForHostedJob,
  type HostedAvatar,
  type HostedChatMessage,
  type HostedProviderStatus,
  type HostedTelegramStatus,
} from './hosted-api';
import { useAuth } from './store/auth';

type HostedView = 'chat' | 'crew' | 'setup';

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

function avatarTone(avatarId: string): string {
  const tones = [
    'from-brand-400/70 via-brand-600/45 to-brand-950',
    'from-cyan-400/60 via-sky-700/40 to-brand-950',
    'from-emerald-400/55 via-teal-700/40 to-brand-950',
    'from-amber-300/60 via-rose-700/35 to-brand-950',
  ];
  const seed = [...avatarId].reduce((sum, character) => sum + character.charCodeAt(0), 0);
  return tones[seed % tones.length];
}

function AvatarPortrait({ avatar, compact = false }: { avatar: HostedAvatar; compact?: boolean }) {
  const initial = avatar.name.trim().charAt(0).toUpperCase() || 'S';
  return (
    <div
      role="img"
      aria-label={`${avatar.name} portrait`}
      className={`relative grid shrink-0 place-items-center overflow-hidden border border-white/15 bg-gradient-to-br ${avatarTone(avatar.avatarId)} ${
        compact ? 'h-12 w-12 rounded-2xl' : 'h-28 w-24 rounded-[2rem] sm:h-32 sm:w-28'
      }`}
    >
      <span aria-hidden="true" className="absolute -right-4 -top-3 text-5xl text-white/15">✦</span>
      <span aria-hidden="true" className="absolute inset-3 rounded-full border border-white/15" />
      <span className={`${compact ? 'text-xl' : 'text-4xl'} font-medium text-white`}>{initial}</span>
    </div>
  );
}

function avatarStateCopy(status: string): string {
  if (status === 'active' || status === 'configured') return 'Ready';
  if (status === 'error') return 'Needs attention';
  if (status === 'paused') return 'Paused';
  return 'Awakening';
}

function updatedCopy(timestamp: number): string {
  const elapsedDays = Math.floor(Math.max(0, Date.now() - timestamp) / 86_400_000);
  if (elapsedDays === 0) return 'Updated today';
  if (elapsedDays === 1) return 'Updated yesterday';
  if (elapsedDays < 7) return `Updated ${elapsedDays} days ago`;
  return 'Ready when you are';
}

function SetupStep({
  title,
  detail,
  state,
  ready,
  children,
}: {
  title: string;
  detail: string;
  state: string;
  ready: boolean;
  children?: ReactNode;
}) {
  return (
    <section className="border-b border-[var(--color-border)] px-5 py-5">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl border text-sm ${
            ready
              ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
              : 'border-brand-400/30 bg-brand-400/10 text-brand-300'
          }`}
        >
          {ready ? '✓' : '→'}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <h3 className="text-sm font-semibold">{title}</h3>
            <span className={`shrink-0 text-xs ${ready ? 'text-emerald-300' : 'text-brand-300'}`}>{state}</span>
          </div>
          <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">{detail}</p>
          {children && <div className="mt-4">{children}</div>}
        </div>
      </div>
    </section>
  );
}

function NavIcon({ view }: { view: HostedView }) {
  if (view === 'chat') {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5 fill-none stroke-current" strokeWidth="1.8">
        <path d="M5 5.5h14v10H9l-4 3v-13Z" />
      </svg>
    );
  }
  if (view === 'crew') {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5 fill-none stroke-current" strokeWidth="1.8">
        <circle cx="9" cy="9" r="3" />
        <circle cx="16.5" cy="10" r="2.5" />
        <path d="M3.5 19c.7-3.2 2.5-4.8 5.5-4.8s4.8 1.6 5.5 4.8M14 15.2c2.9-.8 5.1.5 6.5 3.8" />
      </svg>
    );
  }
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5 fill-none stroke-current" strokeWidth="1.8">
      <path d="M5 7h14M5 17h14M8 4v6M16 14v6" />
    </svg>
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
  const [activeView, setActiveView] = useState<HostedView>('chat');
  const [createOpen, setCreateOpen] = useState(false);
  const [avatarName, setAvatarName] = useState('My hosted avatar');
  const [draft, setDraft] = useState('');
  const [telegram, setTelegram] = useState<HostedTelegramStatus | null>(null);
  const [telegramToken, setTelegramToken] = useState('');
  const [telegramLoading, setTelegramLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
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
      if (nextProvider.connected) await refreshAvatars();
      else {
        setAvatars([]);
        setActiveAvatarId('');
        setMessages([]);
      }
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

  const handleDisconnect = async () => {
    setLoading(true);
    setError('');
    try {
      const nextProvider = await disconnectHostedProvider();
      setProvider(nextProvider);
      setAvatars([]);
      setActiveAvatarId('');
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
      const avatar = await createHostedAvatar(avatarName.trim());
      setAvatars((current) => [avatar, ...current]);
      setActiveAvatarId(avatar.avatarId);
      setMessages([]);
      setAvatarName('My hosted avatar');
      setCreateOpen(false);
      setActiveView('chat');
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Unable to create the avatar.');
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
    setActiveView('chat');
  };

  const providerReady = Boolean(provider?.connected);
  const telegramReady = Boolean(telegram?.connected && telegram.ownerBound);
  const workspaceReady = isAuthenticated && providerReady && Boolean(activeAvatar);
  const activeName = activeAvatar?.name ?? 'Hosted chat';

  return (
    <div className="h-[100dvh] overflow-hidden bg-[var(--color-bg)] text-[var(--color-text)]">
      <header className="h-16 border-b border-[var(--color-border)] bg-[var(--color-bg)]">
        <div className="mx-auto flex h-full max-w-[90rem] items-center justify-between gap-3 px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <img src="/swarm.svg" alt="" className="h-8 w-8 shrink-0" />
            <div className="min-w-0">
              <h1 className="text-base font-semibold">
                <span className="sm:hidden">Swarm</span>
                <span className="hidden sm:inline">Swarm Hosted</span>
              </h1>
              <p className="hidden text-xs text-[var(--color-text-muted)] sm:block">Your companions, always on</p>
            </div>
          </div>
          <HostedWalletSignIn showIcon={!isAuthenticated} />
        </div>
      </header>

      <main className="relative mx-auto grid h-[calc(100dvh-4rem)] max-w-[90rem] grid-cols-1 grid-rows-[minmax(0,1fr)_4.25rem] overflow-hidden lg:grid-cols-[17rem_minmax(0,1fr)_21rem] lg:grid-rows-1 lg:border-x lg:border-[var(--color-border)]">
        {(error || oauthResult) && (
          <div className="absolute inset-x-3 top-3 z-30 mx-auto max-w-xl border border-[var(--color-border-secondary)] bg-[var(--color-bg-elevated)] px-4 py-3 shadow-xl" role="status">
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

        <aside
          aria-label="Crew"
          data-mobile-active={activeView === 'crew'}
          className={`${activeView === 'crew' ? 'flex' : 'hidden'} min-h-0 flex-col overflow-hidden bg-[var(--color-bg-secondary)] lg:col-start-1 lg:row-start-1 lg:flex lg:border-r lg:border-[var(--color-border)]`}
        >
          <div className="flex min-h-[5rem] shrink-0 items-center justify-between gap-3 border-b border-[var(--color-border)] px-5 py-4">
            <div>
              <h2 className="text-lg font-semibold">Your crew</h2>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">{avatars.length} companion{avatars.length === 1 ? '' : 's'}</p>
            </div>
            {isAuthenticated && providerReady && (
              <button
                type="button"
                aria-expanded={createOpen}
                onClick={() => setCreateOpen((current) => !current)}
                className="rounded-xl bg-brand-500 px-3.5 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-600"
              >
                Create
              </button>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {createOpen && (
              <form onSubmit={(event) => void handleCreateAvatar(event)} className="border-b border-brand-400/30 bg-brand-500/10 px-5 py-5">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-300">Name your companion</p>
                <p className="mt-2 text-xs leading-5 text-[var(--color-text-secondary)]">
                  Their role and first memory take shape in your opening conversation.
                </p>
                <label htmlFor="avatar-name" className="mt-4 block text-xs text-[var(--color-text-muted)]">Companion name</label>
                <input
                  id="avatar-name"
                  value={avatarName}
                  onChange={(event) => setAvatarName(event.target.value)}
                  maxLength={80}
                  className="mt-2 w-full rounded-xl border border-[var(--color-border-secondary)] bg-[var(--color-bg)] px-3 py-3 text-base outline-none transition focus:border-brand-400 focus:ring-1 focus:ring-brand-400"
                />
                <button
                  type="submit"
                  disabled={loading || !avatarName.trim()}
                  className="mt-3 w-full rounded-xl bg-brand-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
                >
                  Meet this companion
                </button>
              </form>
            )}

            {avatars.length > 0 ? (
              <div className="grid grid-cols-2 lg:grid-cols-1">
                {avatars.map((avatar) => {
                  const selected = avatar.avatarId === activeAvatarId;
                  const channels = selected && telegramReady ? 'Web + Telegram' : 'Web';
                  return (
                    <button
                      type="button"
                      key={avatar.avatarId}
                      aria-current={selected ? 'true' : undefined}
                      onClick={() => selectAvatar(avatar.avatarId)}
                      className={`relative flex min-h-44 flex-col justify-between border-b border-r border-[var(--color-border)] bg-gradient-to-br p-4 text-left transition hover:brightness-110 lg:min-h-0 lg:flex-row lg:items-center lg:gap-3 lg:border-r-0 ${avatarTone(avatar.avatarId)} ${selected ? 'ring-2 ring-inset ring-brand-300' : ''}`}
                    >
                      {selected && (
                        <span className="absolute right-3 top-3 rounded-lg bg-white/90 px-2 py-1 text-[0.65rem] font-semibold uppercase tracking-wide text-brand-950 lg:hidden">Active</span>
                      )}
                      <AvatarPortrait avatar={avatar} compact />
                      <span className="mt-8 min-w-0 lg:mt-0 lg:flex-1">
                        <strong className="block truncate text-sm font-semibold text-white">{avatar.name}</strong>
                        <span className="mt-1 block text-xs text-white/70">{channels}</span>
                        <span className="mt-1 hidden text-xs text-white/55 lg:block">{updatedCopy(avatar.updatedAt)}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="px-5 py-10">
                <p className="text-lg font-semibold">Your first companion starts here.</p>
                <p className="mt-2 text-sm leading-6 text-[var(--color-text-secondary)]">
                  Connect intelligence in Setup, then choose a name and begin with a conversation.
                </p>
                {isAuthenticated && providerReady ? (
                  <button type="button" onClick={() => setCreateOpen(true)} className="mt-5 rounded-xl bg-brand-500 px-4 py-3 text-sm font-semibold text-white">
                    Create a companion
                  </button>
                ) : (
                  <button type="button" onClick={() => setActiveView('setup')} className="mt-5 rounded-xl border border-[var(--color-border-secondary)] px-4 py-3 text-sm font-semibold">
                    Open Setup
                  </button>
                )}
              </div>
            )}
          </div>
        </aside>

        <section
          aria-label="Hosted chat"
          data-mobile-active={activeView === 'chat'}
          className={`${activeView === 'chat' ? 'flex' : 'hidden'} min-h-0 min-w-0 flex-col bg-[var(--color-bg)] lg:col-start-2 lg:row-start-1 lg:flex`}
        >
          {activeAvatar && providerReady ? (
            <div className="relative shrink-0 overflow-hidden border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
              <span aria-hidden="true" className="absolute -right-8 -top-14 h-56 w-56 rounded-full border border-brand-400/20" />
              <span aria-hidden="true" className="absolute right-6 top-4 h-40 w-40 rounded-full border border-brand-400/20" />
              <div className="relative flex min-h-44 items-center justify-between gap-5 px-5 py-6 sm:px-8">
                <div className="min-w-0 max-w-md">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-300">Active companion</p>
                  <h2 className="mt-2 truncate text-3xl font-semibold tracking-tight">{activeAvatar.name}</h2>
                  <p className="mt-2 line-clamp-2 text-sm leading-6 text-[var(--color-text-secondary)]">
                    {activeAvatar.description || 'A companion shaped by your conversations and shared work.'}
                  </p>
                  <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-[var(--color-text-secondary)]">
                    <span className="flex items-center gap-2"><StatusDot ready={activeAvatar.status !== 'error'} />{avatarStateCopy(activeAvatar.status)}</span>
                    <span>{telegramReady ? 'Web + Telegram' : 'Web'}</span>
                    <span>{updatedCopy(activeAvatar.updatedAt)}</span>
                  </div>
                </div>
                <AvatarPortrait avatar={activeAvatar} />
              </div>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-12 text-center">
              <div className="max-w-md">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-300">Your companions, always on</p>
                <h2 className="mt-3 text-3xl font-semibold tracking-tight">
                  {!isAuthenticated ? 'Start with one conversation.' : !providerReady ? 'Give your crew intelligence.' : 'Meet your first companion.'}
                </h2>
                <p className="mt-4 text-sm leading-6 text-[var(--color-text-secondary)]">
                  {!isAuthenticated
                    ? 'Sign in, connect your model provider, and create a companion that keeps working after this page closes.'
                    : !providerReady
                      ? 'Connect OpenRouter securely, then shape a companion through your first conversation.'
                      : 'Choose a name, say hello, and let a distinct identity grow from shared work and memory.'}
                </p>
                {!isAuthenticated ? (
                  <HostedWalletSignIn className="mx-auto mt-6 justify-center" />
                ) : (
                  <button
                    type="button"
                    onClick={() => setActiveView(providerReady ? 'crew' : 'setup')}
                    className="mt-6 rounded-xl bg-brand-500 px-5 py-3 text-sm font-semibold text-white transition hover:bg-brand-600 lg:hidden"
                  >
                    {providerReady ? 'Open Crew' : 'Open Setup'}
                  </button>
                )}
              </div>
            </div>
          )}

          {activeAvatar && providerReady && (
            <>
              <div className="min-h-0 flex-1 overflow-y-auto px-5 sm:px-8" aria-live="polite">
                <div className="mx-auto max-w-3xl">
                  {messages.length === 0 && !sending && (
                    <div className="py-12 text-center">
                      <p className="text-sm font-semibold">Start the story.</p>
                      <p className="mt-2 text-sm text-[var(--color-text-muted)]">Say hello, define a purpose, or share the first thing worth remembering.</p>
                    </div>
                  )}
                  {messages.map((message, index) => {
                    const sender = message.role === 'user' ? 'You' : activeName;
                    return (
                      <article
                        key={`${message.role}-${index}`}
                        aria-label={`${sender} message`}
                        data-message-role={message.role}
                        className="grid grid-cols-1 gap-2 border-b border-[var(--color-border)] py-5 sm:grid-cols-[5rem_minmax(0,1fr)] sm:gap-4"
                      >
                        <p className={`text-xs font-semibold uppercase tracking-[0.12em] ${message.role === 'user' ? 'text-brand-300' : 'text-[var(--color-text-muted)]'}`}>{sender}</p>
                        <p className="chat-message whitespace-pre-wrap text-sm leading-6 text-[var(--color-text-secondary)]">{message.content}</p>
                      </article>
                    );
                  })}
                  {sending && (
                    <div className="grid grid-cols-1 gap-2 border-b border-[var(--color-border)] py-5 sm:grid-cols-[5rem_minmax(0,1fr)] sm:gap-4">
                      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[var(--color-text-muted)]">{activeName}</p>
                      <p className="text-sm text-[var(--color-text-muted)]">Thinking…</p>
                    </div>
                  )}
                </div>
              </div>

              <form onSubmit={(event) => void handleSend(event)} className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3 sm:px-6 sm:py-4">
                <div className="mx-auto flex max-w-3xl gap-2 sm:gap-3">
                  <label htmlFor="hosted-message" className="sr-only">Message</label>
                  <input
                    id="hosted-message"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    maxLength={4000}
                    placeholder={`Message ${activeAvatar.name}`}
                    className="min-w-0 flex-1 rounded-xl border border-[var(--color-border-secondary)] bg-[var(--color-bg-secondary)] px-4 py-3 text-base outline-none transition focus:border-brand-400 focus:ring-1 focus:ring-brand-400"
                  />
                  <button type="submit" disabled={sending || !draft.trim()} className="rounded-xl bg-brand-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-brand-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-300 disabled:opacity-50 sm:px-5">
                    Send
                  </button>
                </div>
              </form>
            </>
          )}
        </section>

        <aside
          aria-label="Setup"
          data-mobile-active={activeView === 'setup'}
          className={`${activeView === 'setup' ? 'flex' : 'hidden'} min-h-0 flex-col overflow-hidden bg-[var(--color-bg-secondary)] lg:col-start-3 lg:row-start-1 lg:flex lg:border-l lg:border-[var(--color-border)]`}
        >
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="border-b border-[var(--color-border)] px-5 py-5">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-300">Setup</p>
              <h2 className="mt-2 text-2xl font-semibold">{workspaceReady ? 'Ready to work' : 'A clear path to ready'}</h2>
              <p className="mt-2 text-sm leading-6 text-[var(--color-text-secondary)]">
                {workspaceReady ? 'Core services are healthy. Optional places can be added when you want them.' : 'Complete each step once. Technical details stay out of the way.'}
              </p>
            </div>

            <SetupStep
              title="Account"
              detail={isAuthenticated ? 'Your private hosted workspace is available.' : 'Sign in to create a private hosted workspace.'}
              state={isAuthenticated ? 'Ready' : 'Start here'}
              ready={isAuthenticated}
            >
              {!isAuthenticated && <HostedWalletSignIn className="w-full justify-center" />}
            </SetupStep>

            <SetupStep
              title="Intelligence"
              detail={providerReady ? 'OpenRouter is securely connected.' : 'Connect a model provider for conversation and reasoning.'}
              state={providerReady ? 'Ready' : isAuthenticated ? 'Connect' : 'Waiting'}
              ready={providerReady}
            >
              {isAuthenticated && !providerReady && (
                <a href={openRouterConnectUrl()} className="flex w-full justify-center rounded-xl bg-brand-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-brand-600">
                  Connect OpenRouter securely
                </a>
              )}
            </SetupStep>

            <SetupStep
              title="Companion"
              detail={activeAvatar ? `${activeAvatar.name} is your active companion.` : 'Choose a name and begin the first conversation.'}
              state={activeAvatar ? 'Ready' : providerReady ? 'Create' : 'Waiting'}
              ready={Boolean(activeAvatar)}
            >
              {providerReady && !activeAvatar && (
                <button
                  type="button"
                  onClick={() => {
                    setCreateOpen(true);
                    setActiveView('crew');
                  }}
                  className="w-full rounded-xl border border-[var(--color-border-secondary)] px-4 py-3 text-sm font-semibold hover:bg-[var(--color-bg-tertiary)] lg:hidden"
                >
                  Open Crew
                </button>
              )}
            </SetupStep>

            {isAuthenticated && providerReady && activeAvatar && (
              <SetupStep
                title="Telegram"
                detail={telegramReady ? `${activeAvatar.name} can answer on web and Telegram.` : `Add ${activeAvatar.name} to another place when you are ready.`}
                state={telegramLoading ? 'Checking' : telegramReady ? 'On' : telegram?.connected ? 'Finish' : 'Optional'}
                ready={telegramReady}
              >
                {telegramLoading ? (
                  <p className="text-xs text-[var(--color-text-muted)]">Loading Telegram status…</p>
                ) : !telegram?.connected ? (
                  <form onSubmit={(event) => void handleConnectTelegram(event)} className="space-y-3">
                    <label htmlFor="telegram-token" className="block text-xs text-[var(--color-text-muted)]">BotFather token (write only)</label>
                    <input
                      id="telegram-token"
                      type="password"
                      autoComplete="new-password"
                      value={telegramToken}
                      onChange={(event) => setTelegramToken(event.target.value)}
                      placeholder="123456789:bot-token"
                      className="w-full rounded-xl border border-[var(--color-border-secondary)] bg-[var(--color-bg)] px-3 py-3 text-base outline-none transition focus:border-brand-400 focus:ring-1 focus:ring-brand-400"
                    />
                    <button type="submit" disabled={loading || !telegramToken.trim()} className="w-full rounded-xl bg-[#229ED9] px-4 py-3 text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-50">
                      Connect Telegram bot
                    </button>
                  </form>
                ) : (
                  <div className="space-y-3">
                    <p className="flex min-w-0 items-center gap-2 text-xs">
                      <span className="shrink-0 text-[var(--color-text-muted)]">Bot</span>
                      <a href={`https://t.me/${telegram.bot?.username ?? ''}`} target="_blank" rel="noreferrer" className="truncate text-brand-300 underline underline-offset-4">@{telegram.bot?.username}</a>
                    </p>
                    {!telegram.ownerBound && telegram.ownerBindUrl && (
                      <a href={telegram.ownerBindUrl} target="_blank" rel="noreferrer" className="block w-full rounded-xl bg-[#229ED9] px-4 py-3 text-center text-sm font-semibold text-white">Open Telegram to prove ownership</a>
                    )}
                    {telegram.ownerBound && telegram.addToGroupUrl && (
                      <a href={telegram.addToGroupUrl} target="_blank" rel="noreferrer" className="block w-full rounded-xl bg-[#229ED9] px-4 py-3 text-center text-sm font-semibold text-white">Add bot to a group</a>
                    )}
                    <details className="border-t border-[var(--color-border)] pt-3">
                      <summary className="cursor-pointer text-xs font-medium text-[var(--color-text-muted)]">Telegram options</summary>
                      <div className="mt-3 space-y-3">
                        <button type="button" onClick={() => void handleRefreshTelegram()} disabled={loading} className="w-full rounded-xl border border-[var(--color-border-secondary)] px-4 py-3 text-sm font-medium hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50">Refresh Telegram status</button>
                        {((!telegram.ownerBound && !telegram.ownerBindUrl) || (telegram.ownerBound && !telegram.addToGroupUrl)) && (
                          <button type="button" onClick={() => void handleRepairTelegram()} disabled={loading} className="w-full rounded-xl border border-amber-400/30 px-4 py-3 text-sm font-medium text-amber-200 hover:bg-amber-400/10 disabled:opacity-50">Repair and refresh links</button>
                        )}
                        <button type="button" onClick={() => void handleDisconnectTelegram()} disabled={loading} className="text-sm font-medium text-red-300 underline decoration-red-400/40 underline-offset-4 hover:text-red-200 disabled:opacity-50">Disconnect Telegram</button>
                      </div>
                    </details>
                  </div>
                )}
              </SetupStep>
            )}

            <details className="group border-b border-[var(--color-border)] px-5 py-5">
              <summary className="cursor-pointer text-sm font-medium text-[var(--color-text-secondary)] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand-400">Technical details</summary>
              <div className="mt-4 border-l border-[var(--color-border-secondary)] pl-4">
                <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
                  <dt className="text-[var(--color-text-muted)]">Environment</dt>
                  <dd className="text-[var(--color-text-secondary)]">{environmentCopy.label}</dd>
                  <dt className="text-[var(--color-text-muted)]">Account</dt>
                  <dd className="truncate font-mono text-[var(--color-text-secondary)]">{user ? shortWallet(user.walletAddress) : 'Not signed in'}</dd>
                  <dt className="text-[var(--color-text-muted)]">Session</dt>
                  <dd className="text-[var(--color-text-secondary)]">{isAuthenticated ? 'Active' : 'Inactive'}</dd>
                  <dt className="text-[var(--color-text-muted)]">Provider</dt>
                  <dd className="text-[var(--color-text-secondary)]">{providerReady ? 'OpenRouter · connected' : 'Not connected'}</dd>
                </dl>
                <p className="mt-4 text-xs leading-5 text-[var(--color-text-muted)]">
                  OAuth uses PKCE S256. The exchanged credential is encrypted for your account and never returned to this page.
                </p>
                <a href={`${API_BASE}/hosting/status`} className="mt-4 inline-block text-sm text-[var(--color-text-secondary)] underline underline-offset-4 hover:text-[var(--color-text)]">Runtime status</a>
                {providerReady && (
                  <button type="button" onClick={() => void handleDisconnect()} disabled={loading} className="mt-4 block text-sm font-medium text-red-300 underline decoration-red-400/40 underline-offset-4 hover:text-red-200 disabled:opacity-50">Disconnect OpenRouter</button>
                )}
              </div>
            </details>

            <p className="px-5 py-5 text-xs leading-5 text-[var(--color-text-muted)]">{environmentCopy.footer}</p>
          </div>
        </aside>

        <nav aria-label="Hosted workspace" className="col-start-1 row-start-2 grid grid-cols-3 border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)] lg:hidden">
          {(['chat', 'crew', 'setup'] as const).map((view) => (
            <button
              type="button"
              key={view}
              aria-pressed={activeView === view}
              onClick={() => setActiveView(view)}
              className={`relative flex min-h-[4.25rem] flex-col items-center justify-center gap-1 text-xs font-medium capitalize transition ${activeView === view ? 'text-brand-200' : 'text-[var(--color-text-muted)]'}`}
            >
              {activeView === view && <span aria-hidden="true" className="absolute inset-x-1/4 top-0 h-0.5 bg-brand-300" />}
              <NavIcon view={view} />
              {view}
            </button>
          ))}
        </nav>
      </main>
    </div>
  );
}
