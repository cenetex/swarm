import { ChangeEvent, FormEvent, ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { API_BASE } from './api/apiBase';
import { HostedWalletSignIn } from './components/HostedWalletSignIn';
import { HostedPasskeyAuth } from './components/HostedPasskeyAuth';
import {
  createHostedAvatar,
  connectHostedX,
  connectHostedTelegram,
  disconnectHostedProvider,
  disconnectHostedTelegram,
  disconnectHostedX,
  enqueueHostedMessage,
  forgetHostedTelegramGroup,
  getHostedHistory,
  getHostedProviderStatus,
  getHostedTelegramStatus,
  getHostedXStatus,
  hostedXAvatarId,
  hostedXResult,
  importHostedAvatar,
  listHostedAvatars,
  openRouterConnectUrl,
  openRouterResult,
  ownedHostedAvatarBundleUrl,
  repairHostedTelegram,
  setHostedTelegramGroupEnabled,
  updateHostedAvatarProfile,
  updateHostedAvatarPublication,
  waitForHostedJob,
  type HostedAvatar,
  type HostedChatMessage,
  type HostedProviderStatus,
  type HostedTelegramStatus,
  type HostedXStatus,
} from './hosted-api';
import { useAuth } from './store/auth';

type HostedView = 'chat' | 'pack' | 'settings';

function shortWallet(walletAddress: string): string {
  return `${walletAddress.slice(0, 5)}…${walletAddress.slice(-4)}`;
}

function cleanHostedOAuthResult(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('ai');
  url.searchParams.delete('openrouter');
  url.searchParams.delete('x');
  url.searchParams.delete('xAvatarId');
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

function SettingsSection({
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
  if (view === 'pack') {
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
  const [xOauthResult] = useState(() => hostedXResult(window.location.search));
  const [xOauthAvatarId] = useState(() => hostedXAvatarId(window.location.search));
  const [provider, setProvider] = useState<HostedProviderStatus | null>(null);
  const [avatars, setAvatars] = useState<HostedAvatar[]>([]);
  const [activeAvatarId, setActiveAvatarId] = useState('');
  const [messages, setMessages] = useState<HostedChatMessage[]>([]);
  const [activeView, setActiveView] = useState<HostedView>('chat');
  const [createOpen, setCreateOpen] = useState(false);
  const [avatarName, setAvatarName] = useState('My hosted avatar');
  const [avatarDescription, setAvatarDescription] = useState('');
  const [avatarPersona, setAvatarPersona] = useState('');
  const [avatarVisibility, setAvatarVisibility] = useState<'public' | 'private'>('public');
  const [avatarListed, setAvatarListed] = useState(true);
  const [profileName, setProfileName] = useState('');
  const [profileDescription, setProfileDescription] = useState('');
  const [profilePersona, setProfilePersona] = useState('');
  const [profileSaved, setProfileSaved] = useState(false);
  const [draft, setDraft] = useState('');
  const [telegram, setTelegram] = useState<HostedTelegramStatus | null>(null);
  const [telegramToken, setTelegramToken] = useState('');
  const [telegramLoading, setTelegramLoading] = useState(false);
  const [x, setX] = useState<HostedXStatus | null>(null);
  const [xLoading, setXLoading] = useState(false);
  const [xConnecting, setXConnecting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  const activeAvatar = useMemo(
    () => avatars.find((avatar) => avatar.avatarId === activeAvatarId) ?? null,
    [activeAvatarId, avatars],
  );

  useEffect(() => {
    setProfileName(activeAvatar?.name ?? '');
    setProfileDescription(activeAvatar?.description ?? '');
    setProfilePersona(activeAvatar?.persona ?? '');
    setProfileSaved(false);
  }, [activeAvatar]);

  const refreshAvatars = useCallback(async () => {
    const nextAvatars = await listHostedAvatars();
    setAvatars(nextAvatars);
    setActiveAvatarId((current) => current
      || nextAvatars.find((avatar) => avatar.avatarId === xOauthAvatarId)?.avatarId
      || nextAvatars[0]?.avatarId
      || '');
  }, [xOauthAvatarId]);

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
    if (oauthResult || xOauthResult) cleanHostedOAuthResult();
  }, [oauthResult, xOauthResult]);

  useEffect(() => {
    if (!isAuthenticated) {
      setProvider(null);
      setAvatars([]);
      setActiveAvatarId('');
      setMessages([]);
      setTelegram(null);
      setTelegramToken('');
      setTelegramLoading(false);
      setX(null);
      setXLoading(false);
      setXConnecting(false);
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

  const refreshX = useCallback(async () => {
    if (!activeAvatarId) {
      setX(null);
      setXLoading(false);
      return;
    }
    setXLoading(true);
    try {
      setX(await getHostedXStatus(activeAvatarId));
    } finally {
      setXLoading(false);
    }
  }, [activeAvatarId]);

  useEffect(() => {
    if (!activeAvatarId || !provider?.connected) {
      setX(null);
      setXLoading(false);
      return;
    }
    setX(null);
    void refreshX().catch((xError) => {
      setError(xError instanceof Error ? xError.message : 'Unable to load X status.');
    });
  }, [activeAvatarId, provider?.connected, refreshX]);

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
      setCreateOpen(false);
      setActiveView('chat');
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
      setCreateOpen(false);
      setActiveView('chat');
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

  const handleSaveProfile = async (event: FormEvent) => {
    event.preventDefault();
    if (!activeAvatar || !profileName.trim()) return;
    setLoading(true);
    setError('');
    setProfileSaved(false);
    try {
      const updated = await updateHostedAvatarProfile(activeAvatar.avatarId, {
        name: profileName.trim(),
        description: profileDescription.trim(),
        persona: profilePersona.trim(),
      });
      setAvatars((current) => current.map((avatar) => avatar.avatarId === updated.avatarId ? updated : avatar));
      setProfileSaved(true);
    } catch (profileError) {
      setError(profileError instanceof Error ? profileError.message : 'Unable to save companion settings.');
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
      setTelegram({ connected: false, status: 'disconnected', ownerBound: false, groups: [] });
    } catch (disconnectError) {
      setError(disconnectError instanceof Error ? disconnectError.message : 'Unable to disconnect Telegram.');
    } finally {
      setLoading(false);
    }
  };

  const handleRefreshX = async () => {
    setError('');
    try {
      await refreshX();
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : 'Unable to load X status.');
    }
  };

  const handleConnectX = async () => {
    if (!activeAvatarId) return;
    setXConnecting(true);
    setError('');
    try {
      const started = await connectHostedX(activeAvatarId);
      window.location.assign(started.authorizationUrl);
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : 'Unable to connect X.');
      setXConnecting(false);
    }
  };

  const handleDisconnectX = async () => {
    if (!activeAvatarId) return;
    setLoading(true);
    setError('');
    try {
      await disconnectHostedX(activeAvatarId);
      setX({ connected: false, status: 'disconnected' });
    } catch (disconnectError) {
      setError(disconnectError instanceof Error ? disconnectError.message : 'Unable to disconnect X.');
    } finally {
      setLoading(false);
    }
  };

  const handleCopyGroupBindCommand = async () => {
    if (!telegram?.groupBindCommand) return;
    try {
      await navigator.clipboard.writeText(telegram.groupBindCommand);
    } catch {
      setError('Unable to copy the Telegram group command.');
    }
  };

  const handleToggleTelegramGroup = async (chatId: string, enabled: boolean) => {
    if (!activeAvatarId) return;
    setLoading(true);
    setError('');
    try {
      setTelegram(await setHostedTelegramGroupEnabled(activeAvatarId, chatId, enabled));
    } catch (groupError) {
      setError(groupError instanceof Error ? groupError.message : 'Unable to update the Telegram group.');
    } finally {
      setLoading(false);
    }
  };

  const handleForgetTelegramGroup = async (chatId: string, title: string) => {
    if (!activeAvatarId || !window.confirm(`Forget ${title}? The bot stays in Telegram but Swarm stops answering there.`)) return;
    setLoading(true);
    setError('');
    try {
      setTelegram(await forgetHostedTelegramGroup(activeAvatarId, chatId));
    } catch (groupError) {
      setError(groupError instanceof Error ? groupError.message : 'Unable to forget the Telegram group.');
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
  const xReady = Boolean(x?.connected && x.status === 'connected');
  const activeName = activeAvatar?.name ?? 'Hosted chat';
  const profileChanged = Boolean(activeAvatar && (
    profileName.trim() !== activeAvatar.name
    || profileDescription.trim() !== (activeAvatar.description ?? '')
    || profilePersona.trim() !== (activeAvatar.persona ?? '')
  ));
  const activeChannels = ['Web', ...(telegramReady ? ['Telegram'] : []), ...(xReady ? ['X'] : [])].join(' + ');

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

      <main className="relative mx-auto grid h-[calc(100dvh-4rem)] max-w-[90rem] grid-cols-1 grid-rows-[minmax(0,1fr)_4.25rem] overflow-hidden lg:grid-cols-[17rem_minmax(0,1fr)_21rem] lg:grid-rows-1 lg:border-x lg:border-[var(--color-border)]">
        {(error || oauthResult || xOauthResult) && (
          <div className="absolute inset-x-3 top-3 z-30 mx-auto max-w-xl border border-[var(--color-border-secondary)] bg-[var(--color-bg-elevated)] px-4 py-3 shadow-xl" role="status">
            {oauthResult === 'connected' && !error && (
              <p className="border-l-2 border-emerald-400 pl-3 text-sm text-emerald-200">
                OpenRouter connected. The credential was exchanged and stored server-side.
              </p>
            )}
            {xOauthResult === 'connected' && !error && (
              <p className="border-l-2 border-emerald-400 pl-3 text-sm text-emerald-200">
                X connected. Mentions and replies are now handled by this companion.
              </p>
            )}
            {(oauthResult === 'error' || xOauthResult === 'error' || error) && (
              <p className="border-l-2 border-red-400 pl-3 text-sm text-red-200">
                {error || (xOauthResult === 'error'
                  ? 'X authorization did not complete. Check the app permissions and try again.'
                  : 'OpenRouter authorization did not complete. Please try again.')}
              </p>
            )}
          </div>
        )}

        <aside
          aria-label="Pack"
          data-mobile-active={activeView === 'pack'}
          className={`${activeView === 'pack' ? 'flex' : 'hidden'} min-h-0 flex-col overflow-hidden bg-[var(--color-bg-secondary)] lg:col-start-1 lg:row-start-1 lg:flex lg:border-r lg:border-[var(--color-border)]`}
        >
          <div className="flex min-h-[5rem] shrink-0 items-center justify-between gap-3 border-b border-[var(--color-border)] px-5 py-4">
            <div>
              <h2 className="text-lg font-semibold">Your pack</h2>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">{avatars.length} companion{avatars.length === 1 ? '' : 's'}</p>
            </div>
            {isAuthenticated && (
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
                <details className="mt-3 border-t border-brand-400/20 pt-3">
                  <summary className="cursor-pointer text-xs font-medium text-brand-300">Identity and sharing</summary>
                  <div className="mt-3 space-y-3">
                    <label htmlFor="avatar-description" className="block text-xs text-[var(--color-text-muted)]">Public description</label>
                    <textarea
                      id="avatar-description"
                      value={avatarDescription}
                      onChange={(event) => setAvatarDescription(event.target.value)}
                      maxLength={1000}
                      rows={3}
                      placeholder="What this companion is for"
                      className="w-full resize-y rounded-xl border border-[var(--color-border-secondary)] bg-[var(--color-bg)] px-3 py-3 text-sm outline-none transition focus:border-brand-400 focus:ring-1 focus:ring-brand-400"
                    />
                    <label htmlFor="avatar-persona" className="block text-xs text-[var(--color-text-muted)]">Starting character</label>
                    <textarea
                      id="avatar-persona"
                      value={avatarPersona}
                      onChange={(event) => setAvatarPersona(event.target.value)}
                      maxLength={50000}
                      rows={4}
                      placeholder="How this mind begins"
                      className="w-full resize-y rounded-xl border border-[var(--color-border-secondary)] bg-[var(--color-bg)] px-3 py-3 text-sm outline-none transition focus:border-brand-400 focus:ring-1 focus:ring-brand-400"
                    />
                    <label htmlFor="avatar-visibility" className="block text-xs text-[var(--color-text-muted)]">Visibility</label>
                    <select
                      id="avatar-visibility"
                      value={avatarVisibility}
                      onChange={(event) => setAvatarVisibility(event.target.value as 'public' | 'private')}
                      className="w-full rounded-xl border border-[var(--color-border-secondary)] bg-[var(--color-bg)] px-3 py-3 text-sm outline-none focus:border-brand-400"
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
                        Show this companion in Discover
                      </label>
                    )}
                    <p className="text-xs leading-5 text-[var(--color-text-muted)]">Private chat and secrets are never included in a portable file.</p>
                  </div>
                </details>
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
                  const channels = selected ? activeChannels : 'Web';
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
                  Choose a name now. Intelligence and channels can be added in Settings.
                </p>
                {isAuthenticated ? (
                  <button type="button" onClick={() => setCreateOpen(true)} className="mt-5 rounded-xl bg-brand-500 px-4 py-3 text-sm font-semibold text-white">
                    Create a companion
                  </button>
                ) : (
                  <button type="button" onClick={() => setActiveView('settings')} className="mt-5 rounded-xl border border-[var(--color-border-secondary)] px-4 py-3 text-sm font-semibold">
                    Open Settings
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
                    <span>{activeChannels}</span>
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
                  {!isAuthenticated ? 'Start with one conversation.' : !providerReady ? 'Give your pack intelligence.' : 'Meet your first companion.'}
                </h2>
                <p className="mt-4 text-sm leading-6 text-[var(--color-text-secondary)]">
                  {!isAuthenticated
                    ? 'Sign in, connect your model provider, and create a companion that keeps working after this page closes.'
                    : !providerReady
                      ? 'Connect OpenRouter securely, then shape a companion through your first conversation.'
                      : 'Choose a name, say hello, and let a distinct identity grow from shared work and memory.'}
                </p>
                {!isAuthenticated ? (
                  <div className="mx-auto mt-6 w-full max-w-xs space-y-3">
                    <HostedPasskeyAuth />
                    <div className="flex items-center gap-3 text-xs text-[var(--color-text-muted)]" aria-hidden="true">
                      <span className="h-px flex-1 bg-[var(--color-border)]" />
                      <span>or use a wallet</span>
                      <span className="h-px flex-1 bg-[var(--color-border)]" />
                    </div>
                    <HostedWalletSignIn className="w-full justify-center" />
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setActiveView(providerReady ? 'pack' : 'settings')}
                    className="mt-6 rounded-xl bg-brand-500 px-5 py-3 text-sm font-semibold text-white transition hover:bg-brand-600 lg:hidden"
                  >
                    {providerReady ? 'Open Pack' : 'Open Settings'}
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
          aria-label="Settings"
          data-mobile-active={activeView === 'settings'}
          className={`${activeView === 'settings' ? 'flex' : 'hidden'} min-h-0 flex-col overflow-hidden bg-[var(--color-bg-secondary)] lg:col-start-3 lg:row-start-1 lg:flex lg:border-l lg:border-[var(--color-border)]`}
        >
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="border-b border-[var(--color-border)] px-5 py-5">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-300">Settings</p>
              <h2 className="mt-2 text-2xl font-semibold">{activeAvatar ? `Shape ${activeAvatar.name}` : 'Build your workspace'}</h2>
              <p className="mt-2 text-sm leading-6 text-[var(--color-text-secondary)]">
                {activeAvatar ? 'Tune the voice first, then choose where this companion can work.' : 'Complete each step once. Technical details stay out of the way.'}
              </p>
            </div>

            {!isAuthenticated && (
              <SettingsSection
                title="Account"
                detail="Sign in to create a private hosted workspace."
                state="Start here"
                ready={false}
              >
                <div className="space-y-3">
                  <HostedPasskeyAuth />
                  <HostedWalletSignIn className="w-full justify-center" />
                </div>
              </SettingsSection>
            )}

            {isAuthenticated && (
              <SettingsSection
                title="Passkey sign-in"
                detail="Add a device or synced passkey. Your wallet stays available as the recovery path."
                state="Protected"
                ready
              >
                <HostedPasskeyAuth />
              </SettingsSection>
            )}

            {isAuthenticated && activeAvatar && (
              <section className="border-b border-[var(--color-border)] bg-gradient-to-b from-brand-500/10 to-transparent px-5 py-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-300">Companion</p>
                    <h3 className="mt-2 text-lg font-semibold">Voice &amp; identity</h3>
                  </div>
                  <span className={`shrink-0 text-xs ${profileSaved ? 'text-emerald-300' : profileChanged ? 'text-amber-300' : 'text-[var(--color-text-muted)]'}`}>
                    {profileSaved ? 'Saved' : profileChanged ? 'Unsaved' : 'Current'}
                  </span>
                </div>
                <p className="mt-2 text-xs leading-5 text-[var(--color-text-muted)]">
                  The system prompt is the durable direction behind every Web, Telegram, and X reply.
                </p>
                <form onSubmit={(event) => void handleSaveProfile(event)} className="mt-4 space-y-4">
                  <div>
                    <label htmlFor="profile-name" className="block text-xs font-medium text-[var(--color-text-secondary)]">Name</label>
                    <input
                      id="profile-name"
                      value={profileName}
                      onChange={(event) => {
                        setProfileName(event.target.value);
                        setProfileSaved(false);
                      }}
                      maxLength={80}
                      className="mt-2 w-full rounded-xl border border-[var(--color-border-secondary)] bg-[var(--color-bg)] px-3 py-3 text-base outline-none transition focus:border-brand-400 focus:ring-1 focus:ring-brand-400"
                    />
                  </div>
                  <div>
                    <label htmlFor="profile-description" className="block text-xs font-medium text-[var(--color-text-secondary)]">Public description</label>
                    <textarea
                      id="profile-description"
                      value={profileDescription}
                      onChange={(event) => {
                        setProfileDescription(event.target.value);
                        setProfileSaved(false);
                      }}
                      maxLength={1000}
                      rows={2}
                      placeholder="What this companion is for"
                      className="mt-2 w-full resize-y rounded-xl border border-[var(--color-border-secondary)] bg-[var(--color-bg)] px-3 py-3 text-sm outline-none transition focus:border-brand-400 focus:ring-1 focus:ring-brand-400"
                    />
                  </div>
                  <div>
                    <div className="flex items-baseline justify-between gap-3">
                      <label htmlFor="profile-persona" className="block text-xs font-medium text-[var(--color-text-secondary)]">System prompt</label>
                      <span className="text-[0.65rem] text-[var(--color-text-muted)]">{profilePersona.length.toLocaleString()}/50,000</span>
                    </div>
                    <textarea
                      id="profile-persona"
                      value={profilePersona}
                      onChange={(event) => {
                        setProfilePersona(event.target.value);
                        setProfileSaved(false);
                      }}
                      maxLength={50000}
                      rows={8}
                      placeholder={`You are ${activeAvatar.name}…`}
                      className="mt-2 w-full resize-y rounded-xl border border-[var(--color-border-secondary)] bg-[var(--color-bg)] px-3 py-3 font-mono text-sm leading-6 outline-none transition focus:border-brand-400 focus:ring-1 focus:ring-brand-400"
                    />
                    <p className="mt-2 text-xs leading-5 text-[var(--color-text-muted)]">Saved changes apply to the next message and create a new portable revision.</p>
                  </div>
                  <button
                    type="submit"
                    disabled={loading || !profileName.trim() || !profileChanged}
                    className="w-full rounded-xl bg-brand-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
                  >
                    Save voice &amp; identity
                  </button>
                </form>
              </section>
            )}

            <SettingsSection
              title="Model"
              detail={providerReady ? 'OpenRouter is securely connected for conversation and reasoning.' : 'Connect a model provider for conversation and reasoning.'}
              state={providerReady ? 'Ready' : isAuthenticated ? 'Connect' : 'Waiting'}
              ready={providerReady}
            >
              {providerReady && (
                <div className="rounded-xl border border-[var(--color-border-secondary)] bg-[var(--color-bg)] px-3 py-3">
                  <p className="text-xs text-[var(--color-text-muted)]">Current route</p>
                  <p className="mt-1 text-sm font-medium">OpenRouter Free</p>
                  <p className="mt-1 text-xs leading-5 text-[var(--color-text-muted)]">Automatically chooses an available free model.</p>
                </div>
              )}
              {isAuthenticated && !providerReady && (
                <a href={openRouterConnectUrl()} className="flex w-full justify-center rounded-xl bg-brand-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-brand-600">
                  Connect OpenRouter securely
                </a>
              )}
            </SettingsSection>

            {isAuthenticated && !activeAvatar && (
              <SettingsSection
                title="Companion"
                detail="Choose a name and begin the first conversation."
                state="Create"
                ready={false}
              >
                <button
                  type="button"
                  onClick={() => {
                    setCreateOpen(true);
                    setActiveView('pack');
                  }}
                  className="w-full rounded-xl border border-[var(--color-border-secondary)] px-4 py-3 text-sm font-semibold hover:bg-[var(--color-bg-tertiary)] lg:hidden"
                >
                  Open Pack
                </button>
              </SettingsSection>
            )}

            {isAuthenticated && providerReady && activeAvatar && (
              <SettingsSection
                title="Telegram"
                detail={telegramReady ? `${activeAvatar.name} follows mentions, replies, commands, and topics in enabled groups.` : `Add ${activeAvatar.name} to another place when you are ready.`}
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
                    {telegram.groups.length > 0 && (
                      <div className="border-t border-[var(--color-border)] pt-3">
                        <p className="text-xs font-medium text-[var(--color-text-secondary)]">Bound groups</p>
                        <div className="mt-2 space-y-2">
                          {telegram.groups.map((group) => {
                            const unavailable = group.membershipStatus === 'left' || group.membershipStatus === 'kicked';
                            return (
                              <div
                                key={group.chatId}
                                className="rounded-lg border border-[var(--color-border-secondary)] bg-[var(--color-bg)] p-3"
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <p className="truncate text-sm font-medium">{group.title}</p>
                                    <p className="mt-1 text-xs text-[var(--color-text-muted)]">
                                      {unavailable ? group.membershipStatus : group.enabled ? 'Answering' : 'Paused'}
                                    </p>
                                  </div>
                                  <button
                                    type="button"
                                    aria-pressed={group.enabled}
                                    onClick={() => void handleToggleTelegramGroup(group.chatId, !group.enabled)}
                                    disabled={loading || unavailable}
                                    className="rounded-md border border-[var(--color-border-secondary)] px-2.5 py-1.5 text-xs font-medium disabled:opacity-50"
                                  >
                                    {group.enabled ? 'Pause' : 'Enable'}
                                  </button>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => void handleForgetTelegramGroup(group.chatId, group.title)}
                                  disabled={loading}
                                  className="mt-2 text-xs text-red-300 underline decoration-red-400/40 underline-offset-4 disabled:opacity-50"
                                >
                                  Forget group
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    <details className="border-t border-[var(--color-border)] pt-3">
                      <summary className="cursor-pointer text-xs font-medium text-[var(--color-text-muted)]">Telegram options</summary>
                      <div className="mt-3 space-y-3">
                        {telegram.ownerBound && telegram.groupBindCommand && (
                          <button
                            type="button"
                            onClick={() => void handleCopyGroupBindCommand()}
                            className="w-full rounded-xl border border-[var(--color-border-secondary)] px-4 py-3 text-sm font-medium hover:bg-[var(--color-bg-tertiary)]"
                          >
                            Copy command for an existing group
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => void handleRefreshTelegram()}
                          disabled={loading}
                          className="w-full rounded-xl border border-[var(--color-border-secondary)] px-4 py-3 text-sm font-medium hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50"
                        >
                          Refresh Telegram status
                        </button>
                        {((!telegram.ownerBound && !telegram.ownerBindUrl)
                          || (telegram.ownerBound && !telegram.addToGroupUrl)) && (
                          <button
                            type="button"
                            onClick={() => void handleRepairTelegram()}
                            disabled={loading}
                            className="w-full rounded-xl border border-amber-400/30 px-4 py-3 text-sm font-medium text-amber-200 hover:bg-amber-400/10 disabled:opacity-50"
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
                    </details>
                  </div>
                )}
              </SettingsSection>
            )}

            {isAuthenticated && (
              <SettingsSection
                title="Portability & sharing"
                detail={activeAvatar ? 'Take this companion with you or share a public page.' : 'Restore a companion from a portable artifact.'}
                state={activeAvatar ? (activeAvatar.visibility === 'private' ? 'Private' : 'Public') : 'Optional'}
                ready={Boolean(activeAvatar)}
              >
                <div className="flex flex-wrap gap-3 text-sm">
                  {activeAvatar && (
                    <a href={ownedHostedAvatarBundleUrl(activeAvatar.avatarId)} className="text-brand-300 underline underline-offset-4">
                      Download
                    </a>
                  )}
                  {activeAvatar?.visibility !== 'private' && activeAvatar?.slug && (
                    <a href={`/a/${activeAvatar.slug}`} className="text-brand-300 underline underline-offset-4">
                      Public page
                    </a>
                  )}
                  {activeAvatar?.visibility === 'private' && (
                    <button
                      type="button"
                      onClick={() => void handlePublishAvatar(activeAvatar.avatarId)}
                      disabled={loading}
                      className="text-emerald-300 underline underline-offset-4 disabled:opacity-50"
                    >
                      Publish
                    </button>
                  )}
                  <label htmlFor="avatar-import" className="cursor-pointer text-brand-300 underline underline-offset-4">
                    Restore from file
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
              </SettingsSection>
            )}

            {isAuthenticated && providerReady && activeAvatar && (
              <SettingsSection
                title="X"
                detail={xReady
                  ? `${activeAvatar.name} checks new mentions and replies in the same X conversation.`
                  : `Connect ${activeAvatar.name} to an X account for mention-based conversations.`}
                state={xConnecting ? 'Connecting' : xLoading ? 'Checking' : xReady ? 'On' : x?.status === 'reauth_required' ? 'Reconnect' : 'Optional'}
                ready={xReady}
              >
                {xLoading ? (
                  <p className="text-xs text-[var(--color-text-muted)]">Loading X status…</p>
                ) : !x?.connected ? (
                  <div className="space-y-3">
                    <button
                      type="button"
                      onClick={() => void handleConnectX()}
                      disabled={xConnecting}
                      className="block w-full rounded-xl bg-white px-4 py-3 text-center text-sm font-semibold text-black transition hover:bg-white/90"
                    >
                      {xConnecting ? 'Connecting X…' : 'Connect X account'}
                    </button>
                    <p className="text-xs leading-5 text-[var(--color-text-muted)]">
                      X shows the authorization screen. Access tokens stay encrypted and are never returned to Studio.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <p className="flex min-w-0 items-center gap-2 text-xs">
                      <span className="shrink-0 text-[var(--color-text-muted)]">Account</span>
                      <a
                        href={`https://x.com/${x.username ?? ''}`}
                        target="_blank"
                        rel="noreferrer"
                        className="truncate text-brand-300 underline underline-offset-4"
                      >
                        @{x.username}
                      </a>
                    </p>
                    {x.status === 'reauth_required' && (
                      <div className="space-y-3 rounded-lg border border-amber-400/30 bg-amber-400/5 p-3">
                        <p className="text-xs leading-5 text-amber-100">
                          X rejected the saved authorization. Reconnect to resume replies.
                        </p>
                        <button
                          type="button"
                          onClick={() => void handleConnectX()}
                          disabled={xConnecting}
                          className="block w-full rounded-xl bg-white px-4 py-3 text-center text-sm font-semibold text-black"
                        >
                          {xConnecting ? 'Connecting X…' : 'Reconnect X'}
                        </button>
                      </div>
                    )}
                    {x.lastPolledAt && (
                      <p className="text-xs text-[var(--color-text-muted)]">
                        Last checked {new Date(x.lastPolledAt).toLocaleString()}
                      </p>
                    )}
                    <details className="border-t border-[var(--color-border)] pt-3">
                      <summary className="cursor-pointer text-xs font-medium text-[var(--color-text-muted)]">X options</summary>
                      <div className="mt-3 space-y-3">
                        <button
                          type="button"
                          onClick={() => void handleRefreshX()}
                          disabled={loading}
                          className="w-full rounded-xl border border-[var(--color-border-secondary)] px-4 py-3 text-sm font-medium hover:bg-[var(--color-bg-tertiary)] disabled:opacity-50"
                        >
                          Refresh X status
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleConnectX()}
                          disabled={xConnecting}
                          className="block w-full rounded-xl border border-[var(--color-border-secondary)] px-4 py-3 text-center text-sm font-medium hover:bg-[var(--color-bg-tertiary)]"
                        >
                          {xConnecting ? 'Connecting X…' : 'Reauthorize X'}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDisconnectX()}
                          disabled={loading}
                          className="text-sm font-medium text-red-300 underline decoration-red-400/40 underline-offset-4 hover:text-red-200 disabled:opacity-50"
                        >
                          Disconnect X
                        </button>
                      </div>
                    </details>
                  </div>
                )}
              </SettingsSection>
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
          {(['chat', 'pack', 'settings'] as const).map((view) => (
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
