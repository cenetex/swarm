import { ChangeEvent, FormEvent, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE } from './api/apiBase';
import { HostedWalletSignIn } from './components/HostedWalletSignIn';
import { HostedPasskeyAuth } from './components/HostedPasskeyAuth';
import { HostedWalletLink } from './components/HostedWalletLink';
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
  getPublicHostedAvatar,
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
  type PublicHostedAvatarProject,
} from './hosted-api';
import { useAuth } from './store/auth';
import { cleanHostedReply, hostedActionForMessage, hostedActionLabels, type HostedAction } from './hosted-chat-actions';

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
      <span aria-hidden="true" className="absolute -right-4 -top-3 text-5xl text-white/15">
        ✦
      </span>
      <span aria-hidden="true" className="absolute inset-3 rounded-full border border-white/15" />
      <span className={`${compact ? 'text-xl' : 'text-4xl'} font-medium text-white`}>{initial}</span>
    </div>
  );
}

function avatarStateCopy(status: string): string {
  if (status === 'active' || status === 'configured') return 'Ready';
  if (status === 'error') return 'Needs attention';
  if (status === 'paused') return 'Paused';
  return 'Getting ready';
}

function ActionSection({
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
    <section className="border-t border-[var(--color-border)] px-5 py-5 first:border-t-0">
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
            <span className={`shrink-0 text-sm ${ready ? 'text-emerald-300' : 'text-brand-300'}`}>{state}</span>
          </div>
          <p className="mt-1 text-sm leading-5 text-[var(--color-text-muted)]">{detail}</p>
          {children && <div className="mt-4">{children}</div>}
        </div>
      </div>
    </section>
  );
}

function ConversationCard({
  title,
  intro,
  onClose,
  children,
}: {
  title: string;
  intro: string;
  onClose?: () => void;
  children: ReactNode;
}) {
  return (
    <article aria-label={`${title} chat card`} className="py-3 sm:py-4">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-[var(--color-text-secondary)]">
        <img src="/swarm.svg" alt="" className="h-6 w-6" />
        <span>Swarm</span>
      </div>
      <div className="overflow-hidden rounded-2xl border border-[var(--color-border-secondary)] bg-[var(--color-bg-secondary)] shadow-sm">
        <div className="flex items-start justify-between gap-4 px-5 py-5">
          <div>
            <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
            {intro && <p className="mt-2 text-sm leading-6 text-[var(--color-text-secondary)]">{intro}</p>}
          </div>
          {onClose && (
            <button
              type="button"
              aria-label={`Close ${title}`}
              onClick={onClose}
              className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-xl text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)]"
            >
              ×
            </button>
          )}
        </div>
        {children}
      </div>
    </article>
  );
}

export function HostedApp() {
  const environmentCopy = hostedEnvironmentCopy(import.meta.env.VITE_HOSTED_ENVIRONMENT);
  const { authProvider, isAuthenticated, user } = useAuth();
  const [oauthResult, setOauthResult] = useState(() => openRouterResult(window.location.search));
  const [xOauthResult, setXOauthResult] = useState(() => hostedXResult(window.location.search));
  const [xOauthAvatarId] = useState(() => hostedXAvatarId(window.location.search));
  const [publicSlug] = useState(() => new URLSearchParams(window.location.search).get('companion'));
  const [publicProject, setPublicProject] = useState<PublicHostedAvatarProject | null>(null);
  const [provider, setProvider] = useState<HostedProviderStatus | null>(null);
  const [avatars, setAvatars] = useState<HostedAvatar[]>([]);
  const [activeAvatarId, setActiveAvatarId] = useState('');
  const [messages, setMessages] = useState<HostedChatMessage[]>([]);
  const [activeAction, setActiveAction] = useState<HostedAction | null>(null);
  const [avatarName, setAvatarName] = useState('');
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
  const conversationEnd = useRef<HTMLDivElement>(null);
  const actionCard = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLInputElement>(null);

  const activeAvatar = useMemo(
    () => avatars.find((avatar) => avatar.avatarId === activeAvatarId) ?? null,
    [activeAvatarId, avatars],
  );

  useEffect(() => {
    setProfileName(activeAvatar?.name ?? '');
    setProfileDescription(activeAvatar?.description ?? '');
    setProfilePersona(activeAvatar?.persona ?? '');
  }, [activeAvatar]);

  const refreshAvatars = useCallback(async () => {
    const nextAvatars = await listHostedAvatars();
    setAvatars(nextAvatars);
    setActiveAvatarId(
      (current) =>
        current ||
        nextAvatars.find((avatar) => avatar.avatarId === xOauthAvatarId)?.avatarId ||
        nextAvatars.find((avatar) => avatar.slug === publicSlug)?.avatarId ||
        nextAvatars[0]?.avatarId ||
        '',
    );
  }, [xOauthAvatarId, publicSlug]);

  useEffect(() => {
    if (!publicSlug) return;
    let active = true;
    getPublicHostedAvatar(publicSlug)
      .then((project) => {
        if (active) setPublicProject(project);
      })
      .catch((reason) => {
        if (active) setError(reason instanceof Error ? reason.message : 'Please choose another companion.');
      });
    return () => {
      active = false;
    };
  }, [publicSlug]);

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
    if (!window.confirm('Disconnect OpenRouter from this account? Chat will pause until you reconnect it.')) return;
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
      setAvatarName('');
      setAvatarDescription('');
      setAvatarPersona('');
      setAvatarVisibility('public');
      setAvatarListed(true);
      setActiveAction(null);
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
      setActiveAction(null);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : 'Unable to import the portable avatar.');
    } finally {
      setLoading(false);
    }
  };

  const handlePublishAvatar = async (avatarId: string) => {
    if (!window.confirm('Publish this companion? Its profile and system prompt will be public.')) return;
    setLoading(true);
    setError('');
    try {
      const updated = await updateHostedAvatarPublication(avatarId, { visibility: 'public', listed: true });
      setAvatars((current) => current.map((avatar) => (avatar.avatarId === avatarId ? updated : avatar)));
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
      setAvatars((current) => current.map((avatar) => (avatar.avatarId === updated.avatarId ? updated : avatar)));
      setProfileSaved(true);
    } catch (profileError) {
      setError(profileError instanceof Error ? profileError.message : 'Unable to save this companion.');
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
    if (!window.confirm('Disconnect Telegram from this companion?')) return;
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
    if (!window.confirm('Disconnect X from this companion?')) return;
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
    if (
      !activeAvatarId ||
      !window.confirm(`Forget ${title}? The bot stays in Telegram but Swarm stops answering there.`)
    )
      return;
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
    if (!message || sending) return;
    const action = hostedActionForMessage(message);
    if (action) {
      setActiveAction(action);
      setDraft('');
      return;
    }
    if (!activeAvatarId || !provider?.connected) return;
    setActiveAction(null);
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
      setMessages(
        job.history ?? [...messages, { role: 'user', content: message }, { role: 'assistant', content: job.response }],
      );
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : 'Unable to send the hosted message.');
    } finally {
      setSending(false);
    }
  };

  const selectAvatar = (avatarId: string) => {
    setProfileSaved(false);
    setActiveAvatarId(avatarId);
    setMessages([]);
    setActiveAction(null);
    setDraft('');
    setTelegramToken('');
  };

  const handleUsePublicAvatar = async () => {
    if (!publicProject) return;
    setLoading(true);
    setError('');
    try {
      const avatar = await importHostedAvatar(publicProject.bundle);
      setAvatars((current) => [avatar, ...current]);
      selectAvatar(avatar.avatarId);
      setPublicProject(null);
      const url = new URL(window.location.href);
      url.searchParams.delete('companion');
      window.history.replaceState({}, '', url.pathname + url.search);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Please try adding this companion again.');
    } finally {
      setLoading(false);
    }
  };

  const providerReady = Boolean(provider?.connected);
  const telegramReady = Boolean(telegram?.connected && telegram.ownerBound);
  const xReady = Boolean(x?.connected && x.status === 'connected');
  const activeName = activeAvatar?.name ?? 'Hosted chat';
  const profileChanged = Boolean(
    activeAvatar &&
    (profileName.trim() !== activeAvatar.name ||
      profileDescription.trim() !== (activeAvatar.description ?? '') ||
      profilePersona.trim() !== (activeAvatar.persona ?? '')),
  );
  const activeChannels = ['Web', ...(telegramReady ? ['Telegram'] : []), ...(xReady ? ['X'] : [])].join(' + ');

  const publicImportReady = Boolean(publicProject && !avatars.some((avatar) => avatar.slug === publicSlug));
  const shownAction =
    activeAction ??
    (isAuthenticated && !loading && !publicImportReady
      ? !activeAvatar
        ? 'create'
        : !providerReady
          ? 'model'
          : null
      : null);
  const visibleMessages = (isAuthenticated ? messages : [])
    .map((message) => ({
      ...message,
      content: message.role === 'assistant' ? cleanHostedReply(message.content) : message.content,
    }))
    .filter((message) => message.content.trim());

  useEffect(() => {
    if (shownAction) actionCard.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    else conversationEnd.current?.scrollIntoView?.({ block: 'end' });
  }, [shownAction, messages.length, sending]);

  const closeAction = () => {
    setActiveAction(null);
    setTelegramToken('');
    composer.current?.focus();
  };

  return (
    <div className="hosted-chat flex h-[100dvh] w-full flex-col overflow-hidden bg-[var(--color-bg)] text-[var(--color-text)]">
      <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 sm:px-8">
        <a href="/" className="flex items-center gap-2.5 font-semibold" aria-label="Swarm home">
          <img src="/swarm.svg" alt="" className="h-8 w-8" />
          <span>Swarm</span>
        </a>
        <a
          href="/"
          className="rounded-lg px-3 py-2 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]"
        >
          Discover
        </a>
      </header>
      <main className="flex min-h-0 w-full flex-1 flex-col">
        <section
          aria-label="Hosted chat"
          className="flex min-h-0 w-full flex-1 flex-col"
          onKeyDown={(event) => {
            if (event.key === 'Escape') closeAction();
          }}
        >
          {isAuthenticated && (
            <div className="shrink-0 border-b border-[var(--color-border)] px-4 py-3 sm:px-8">
              <div className="mx-auto flex max-w-4xl items-center gap-3">
                {activeAvatar && (
                  <div className="hidden sm:block">
                    <AvatarPortrait avatar={activeAvatar} compact />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  {activeAvatar ? (
                    <>
                      <label htmlFor="companion-picker" className="sr-only">
                        Choose companion
                      </label>
                      <select
                        id="companion-picker"
                        value={activeAvatarId}
                        disabled={sending || loading}
                        onChange={(event) => selectAvatar(event.target.value)}
                        className="w-full max-w-sm truncate rounded-lg border border-transparent bg-[var(--color-bg)] py-1 pr-2 text-base font-semibold focus:border-brand-400"
                      >
                        {avatars.map((avatar) => (
                          <option key={avatar.avatarId} value={avatar.avatarId}>
                            {avatar.name}
                          </option>
                        ))}
                      </select>
                      <p className="mt-1 flex items-center gap-2 text-sm text-[var(--color-text-secondary)]">
                        <StatusDot ready={providerReady && activeAvatar.status !== 'error'} />
                        {providerReady ? avatarStateCopy(activeAvatar.status) : 'Connect a model to chat'}
                        <span className="hidden sm:inline">· {activeChannels}</span>
                      </p>
                    </>
                  ) : (
                    <p className="text-base font-semibold">Your conversation</p>
                  )}
                </div>
                {activeAvatar && (
                  <button
                    type="button"
                    disabled={sending || loading}
                    onClick={() => setActiveAction('create')}
                    className="rounded-xl border border-[var(--color-border-secondary)] px-3 py-2.5 text-sm font-medium hover:bg-[var(--color-bg-secondary)] disabled:opacity-50"
                  >
                    New
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setActiveAction(shownAction === 'help' ? null : 'help')}
                  aria-expanded={shownAction === 'help'}
                  className="rounded-xl px-3 py-2.5 text-sm font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-secondary)]"
                >
                  More
                </button>
              </div>
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-8 sm:py-8">
            <div className="mx-auto max-w-4xl">
              {(error || oauthResult || xOauthResult) && (
                <div
                  className="mb-5 flex items-start justify-between gap-3 rounded-xl border border-[var(--color-border-secondary)] bg-[var(--color-bg-secondary)] p-4"
                  role={error ? 'alert' : 'status'}
                >
                  <p className="text-sm leading-6">
                    {error ||
                      (oauthResult === 'error' || xOauthResult === 'error'
                        ? 'Please try connecting again.'
                        : xOauthResult === 'connected'
                          ? 'X is connected. Your companion can answer mentions and replies.'
                          : 'OpenRouter is connected. Your model is ready.')}
                  </p>
                  <button
                    type="button"
                    aria-label="Dismiss message"
                    onClick={() => {
                      setError('');
                      setOauthResult(null);
                      setXOauthResult(null);
                    }}
                    className="shrink-0 px-2 text-lg"
                  >
                    ×
                  </button>
                </div>
              )}
              {!isAuthenticated && (
                <ConversationCard title="Start a conversation" intro="Sign in. We will take it one step at a time.">
                  <div className="space-y-4 px-5 pb-5">
                    <HostedPasskeyAuth />
                    <details>
                      <summary className="cursor-pointer py-2 text-sm text-[var(--color-text-secondary)]">
                        Use a wallet
                      </summary>
                      <HostedWalletSignIn className="mt-3 w-full justify-center" />
                    </details>
                  </div>
                </ConversationCard>
              )}
              {isAuthenticated && !provider && loading && (
                <p role="status" className="py-12 text-center text-[var(--color-text-secondary)]">
                  Opening your conversation…
                </p>
              )}
              {isAuthenticated && publicImportReady && publicProject && (
                <ConversationCard
                  title={'Meet ' + publicProject.name}
                  intro={publicProject.description || 'Add this public companion to your Studio.'}
                >
                  <div className="px-5 pb-5">
                    <button
                      type="button"
                      onClick={() => void handleUsePublicAvatar()}
                      disabled={loading}
                      className="w-full rounded-xl bg-brand-500 px-4 py-3 text-base font-semibold text-white disabled:opacity-50"
                    >
                      Add to my companions
                    </button>
                    <button
                      type="button"
                      onClick={() => setPublicProject(null)}
                      className="mt-3 w-full py-2 text-sm text-[var(--color-text-secondary)]"
                    >
                      Choose another
                    </button>
                  </div>
                </ConversationCard>
              )}
              {activeAvatar &&
                providerReady &&
                visibleMessages.length === 0 &&
                !sending &&
                !shownAction &&
                !publicImportReady && (
                  <div className="py-16 text-center sm:py-24">
                    <h2 className="text-2xl font-semibold tracking-tight">What would you like to do?</h2>
                    <p className="mt-3 text-base leading-7 text-[var(--color-text-secondary)]">
                      Say hello to {activeAvatar.name}, or share something to work on.
                    </p>
                  </div>
                )}
              {visibleMessages.map((message, index) => {
                const sender = message.role === 'user' ? 'You' : activeName;
                return (
                  <article
                    key={message.role + '-' + index}
                    aria-label={sender + ' message'}
                    data-message-role={message.role}
                    className="border-b border-[var(--color-border)] py-5"
                  >
                    <p className="mb-2 text-sm font-semibold text-brand-200">{sender}</p>
                    <p className="chat-message whitespace-pre-wrap break-words text-base leading-7 text-[var(--color-text-secondary)]">
                      {message.content}
                    </p>
                  </article>
                );
              })}
              {sending && (
                <p role="status" className="py-5 text-base text-[var(--color-text-secondary)]">
                  {activeName} is replying…
                </p>
              )}
              {isAuthenticated && shownAction && (
                <div ref={actionCard}>
                  <ConversationCard
                    title={hostedActionLabels[shownAction]}
                    intro={
                      shownAction === 'create'
                        ? 'What should we call your companion?'
                        : shownAction === 'help'
                          ? 'Choose an action, or type a short request in chat.'
                          : ''
                    }
                    onClose={activeAction ? closeAction : undefined}
                  >
                    {shownAction === 'help' && (
                      <div className="grid gap-2 px-5 pb-5 sm:grid-cols-2">
                        {(Object.keys(hostedActionLabels) as HostedAction[])
                          .filter((action) => action !== 'help')
                          .map((action) => (
                            <button
                              type="button"
                              key={action}
                              disabled={
                                sending ||
                                loading ||
                                (['profile', 'telegram', 'x'].includes(action) && !activeAvatar) ||
                                (['telegram', 'x'].includes(action) && !providerReady)
                              }
                              onClick={() => setActiveAction(action)}
                              className="rounded-xl border border-[var(--color-border-secondary)] px-4 py-3 text-left text-sm font-medium hover:bg-[var(--color-bg-tertiary)] disabled:opacity-40"
                            >
                              {hostedActionLabels[action]}
                            </button>
                          ))}
                      </div>
                    )}
                    {shownAction === 'create' && (
                      <form onSubmit={(event) => void handleCreateAvatar(event)} className="px-5 pb-5">
                        <label htmlFor="avatar-name" className="mt-4 block text-sm text-[var(--color-text-muted)]">
                          Companion name
                        </label>
                        <input
                          id="avatar-name"
                          value={avatarName}
                          onChange={(event) => setAvatarName(event.target.value)}
                          maxLength={80}
                          className="mt-2 w-full rounded-xl border border-[var(--color-border-secondary)] bg-[var(--color-bg)] px-3 py-3 text-base outline-none transition focus:border-brand-400 focus:ring-1 focus:ring-brand-400"
                        />
                        <details className="mt-3 border-t border-brand-400/20 pt-3">
                          <summary className="cursor-pointer text-sm font-medium text-brand-300">Add details</summary>
                          <div className="mt-3 space-y-3">
                            <label
                              htmlFor="avatar-description"
                              className="block text-sm text-[var(--color-text-muted)]"
                            >
                              Public description
                            </label>
                            <textarea
                              id="avatar-description"
                              value={avatarDescription}
                              onChange={(event) => setAvatarDescription(event.target.value)}
                              maxLength={1000}
                              rows={3}
                              placeholder="What this companion is for"
                              className="w-full resize-y rounded-xl border border-[var(--color-border-secondary)] bg-[var(--color-bg)] px-3 py-3 text-sm outline-none transition focus:border-brand-400 focus:ring-1 focus:ring-brand-400"
                            />
                            <label htmlFor="avatar-persona" className="block text-sm text-[var(--color-text-muted)]">
                              Starting character
                            </label>
                            <textarea
                              id="avatar-persona"
                              value={avatarPersona}
                              onChange={(event) => setAvatarPersona(event.target.value)}
                              maxLength={50000}
                              rows={4}
                              placeholder="How this mind begins"
                              className="w-full resize-y rounded-xl border border-[var(--color-border-secondary)] bg-[var(--color-bg)] px-3 py-3 text-sm outline-none transition focus:border-brand-400 focus:ring-1 focus:ring-brand-400"
                            />
                            <label htmlFor="avatar-visibility" className="block text-sm text-[var(--color-text-muted)]">
                              Visibility
                            </label>
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
                              <label className="flex items-start gap-2 text-sm leading-5 text-[var(--color-text-secondary)]">
                                <input
                                  type="checkbox"
                                  checked={avatarListed}
                                  onChange={(event) => setAvatarListed(event.target.checked)}
                                  className="mt-1 accent-[var(--color-brand-light)]"
                                />
                                Show this companion in Discover
                              </label>
                            )}
                            <p className="text-sm leading-5 text-[var(--color-text-muted)]">
                              Private chat and secrets are never included in a portable file.
                            </p>
                          </div>
                        </details>
                        <p className="mt-3 text-sm leading-6 text-[var(--color-text-secondary)]">
                          {avatarVisibility === 'public'
                            ? 'Public profile. Private chats. You can choose privacy in Add details.'
                            : 'Private profile and chats.'}
                        </p>
                        <button
                          type="submit"
                          disabled={loading || !avatarName.trim()}
                          className="mt-3 w-full rounded-xl bg-brand-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
                        >
                          Create companion
                        </button>
                      </form>
                    )}
                    {shownAction === 'profile' && activeAvatar && (
                      <section className="border-b border-[var(--color-border)] bg-gradient-to-b from-brand-500/10 to-transparent px-5 py-5">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-brand-300">
                              Companion
                            </p>
                            <h3 className="mt-2 text-lg font-semibold">Voice &amp; identity</h3>
                          </div>
                          <span
                            className={`shrink-0 text-sm ${profileSaved ? 'text-emerald-300' : profileChanged ? 'text-amber-300' : 'text-[var(--color-text-muted)]'}`}
                          >
                            {profileSaved ? 'Saved' : profileChanged ? 'Unsaved' : 'Current'}
                          </span>
                        </div>
                        <p className="mt-2 text-sm leading-5 text-[var(--color-text-muted)]">
                          The system prompt is the durable direction behind every Web, Telegram, and X reply.
                        </p>
                        <form onSubmit={(event) => void handleSaveProfile(event)} className="mt-4 space-y-4">
                          <div>
                            <label
                              htmlFor="profile-name"
                              className="block text-sm font-medium text-[var(--color-text-secondary)]"
                            >
                              Name
                            </label>
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
                            <label
                              htmlFor="profile-description"
                              className="block text-sm font-medium text-[var(--color-text-secondary)]"
                            >
                              Public description
                            </label>
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
                              <label
                                htmlFor="profile-persona"
                                className="block text-sm font-medium text-[var(--color-text-secondary)]"
                              >
                                System prompt
                              </label>
                              <span className="text-[0.65rem] text-[var(--color-text-muted)]">
                                {profilePersona.length.toLocaleString()}/50,000
                              </span>
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
                            <p className="mt-2 text-sm leading-5 text-[var(--color-text-muted)]">
                              Saved changes apply to the next message and create a new portable revision.
                            </p>
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
                    {shownAction === 'model' && (
                      <>
                        <ActionSection
                          title="Model"
                          detail={
                            providerReady
                              ? 'OpenRouter is securely connected for conversation and reasoning.'
                              : 'Connect a model provider for conversation and reasoning.'
                          }
                          state={providerReady ? 'Ready' : isAuthenticated ? 'Connect' : 'Waiting'}
                          ready={providerReady}
                        >
                          {providerReady && (
                            <div className="rounded-xl border border-[var(--color-border-secondary)] bg-[var(--color-bg)] px-3 py-3">
                              <p className="text-sm text-[var(--color-text-muted)]">Current route</p>
                              <p className="mt-1 text-sm font-medium">OpenRouter Free</p>
                              <p className="mt-1 text-sm leading-5 text-[var(--color-text-muted)]">
                                Automatically chooses an available free model.
                              </p>
                            </div>
                          )}
                          {isAuthenticated && !providerReady && (
                            <a
                              href={openRouterConnectUrl()}
                              className="flex w-full justify-center rounded-xl bg-brand-500 px-4 py-3 text-sm font-semibold text-white transition hover:bg-brand-600"
                            >
                              Connect OpenRouter securely
                            </a>
                          )}
                          {providerReady && (
                            <details className="mt-4">
                              <summary className="cursor-pointer py-2 text-sm text-[var(--color-text-secondary)]">
                                Connection actions
                              </summary>
                              <button
                                type="button"
                                onClick={() => void handleDisconnect()}
                                disabled={loading}
                                className="mt-3 text-sm text-red-300 underline disabled:opacity-50"
                              >
                                Disconnect OpenRouter
                              </button>
                            </details>
                          )}
                        </ActionSection>
                      </>
                    )}
                    {shownAction === 'telegram' && providerReady && activeAvatar && (
                      <ActionSection
                        title="Telegram"
                        detail={
                          telegramReady
                            ? `${activeAvatar.name} follows mentions, replies, commands, and topics in enabled groups.`
                            : `Add ${activeAvatar.name} to another place when you are ready.`
                        }
                        state={
                          telegramLoading
                            ? 'Checking'
                            : telegramReady
                              ? 'On'
                              : telegram?.connected
                                ? 'Finish'
                                : 'Optional'
                        }
                        ready={telegramReady}
                      >
                        {telegramLoading ? (
                          <p className="text-sm text-[var(--color-text-muted)]">Loading Telegram status…</p>
                        ) : !telegram?.connected ? (
                          <form onSubmit={(event) => void handleConnectTelegram(event)} className="space-y-3">
                            <label htmlFor="telegram-token" className="block text-sm text-[var(--color-text-muted)]">
                              BotFather token (write only)
                            </label>
                            <input
                              id="telegram-token"
                              type="password"
                              autoComplete="new-password"
                              value={telegramToken}
                              onChange={(event) => setTelegramToken(event.target.value)}
                              placeholder="123456789:bot-token"
                              className="w-full rounded-xl border border-[var(--color-border-secondary)] bg-[var(--color-bg)] px-3 py-3 text-base outline-none transition focus:border-brand-400 focus:ring-1 focus:ring-brand-400"
                            />
                            <button
                              type="submit"
                              disabled={loading || !telegramToken.trim()}
                              className="w-full rounded-xl bg-[#229ED9] px-4 py-3 text-sm font-semibold text-white transition hover:brightness-110 disabled:opacity-50"
                            >
                              Connect Telegram bot
                            </button>
                          </form>
                        ) : (
                          <div className="space-y-3">
                            <p className="flex min-w-0 items-center gap-2 text-sm">
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
                                className="block w-full rounded-xl bg-[#229ED9] px-4 py-3 text-center text-sm font-semibold text-white"
                              >
                                Open Telegram to prove ownership
                              </a>
                            )}
                            {telegram.ownerBound && telegram.addToGroupUrl && (
                              <a
                                href={telegram.addToGroupUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="block w-full rounded-xl bg-[#229ED9] px-4 py-3 text-center text-sm font-semibold text-white"
                              >
                                Add bot to a group
                              </a>
                            )}
                            {telegram.groups.length > 0 && (
                              <div className="border-t border-[var(--color-border)] pt-3">
                                <p className="text-sm font-medium text-[var(--color-text-secondary)]">Bound groups</p>
                                <div className="mt-2 space-y-2">
                                  {telegram.groups.map((group) => {
                                    const unavailable =
                                      group.membershipStatus === 'left' || group.membershipStatus === 'kicked';
                                    return (
                                      <div
                                        key={group.chatId}
                                        className="rounded-lg border border-[var(--color-border-secondary)] bg-[var(--color-bg)] p-3"
                                      >
                                        <div className="flex items-start justify-between gap-3">
                                          <div className="min-w-0">
                                            <p className="truncate text-sm font-medium">{group.title}</p>
                                            <p className="mt-1 text-sm text-[var(--color-text-muted)]">
                                              {unavailable
                                                ? group.membershipStatus
                                                : group.enabled
                                                  ? 'Answering'
                                                  : 'Paused'}
                                            </p>
                                          </div>
                                          <button
                                            type="button"
                                            aria-pressed={group.enabled}
                                            onClick={() => void handleToggleTelegramGroup(group.chatId, !group.enabled)}
                                            disabled={loading || unavailable}
                                            className="rounded-md border border-[var(--color-border-secondary)] px-2.5 py-1.5 text-sm font-medium disabled:opacity-50"
                                          >
                                            {group.enabled ? 'Pause' : 'Enable'}
                                          </button>
                                        </div>
                                        <button
                                          type="button"
                                          onClick={() => void handleForgetTelegramGroup(group.chatId, group.title)}
                                          disabled={loading}
                                          className="mt-2 text-sm text-red-300 underline decoration-red-400/40 underline-offset-4 disabled:opacity-50"
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
                              <summary className="cursor-pointer text-sm font-medium text-[var(--color-text-muted)]">
                                Telegram options
                              </summary>
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
                                {((!telegram.ownerBound && !telegram.ownerBindUrl) ||
                                  (telegram.ownerBound && !telegram.addToGroupUrl)) && (
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
                      </ActionSection>
                    )}
                    {shownAction === 'x' && providerReady && activeAvatar && (
                      <ActionSection
                        title="X"
                        detail={
                          xReady
                            ? `${activeAvatar.name} checks new mentions and replies in the same X conversation.`
                            : `Connect ${activeAvatar.name} to an X account for mention-based conversations.`
                        }
                        state={
                          xConnecting
                            ? 'Connecting'
                            : xLoading
                              ? 'Checking'
                              : xReady
                                ? 'On'
                                : x?.status === 'reauth_required'
                                  ? 'Reconnect'
                                  : 'Optional'
                        }
                        ready={xReady}
                      >
                        {xLoading ? (
                          <p className="text-sm text-[var(--color-text-muted)]">Loading X status…</p>
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
                            <p className="text-sm leading-5 text-[var(--color-text-muted)]">
                              X shows the authorization screen. Access tokens stay encrypted and are never returned to
                              Studio.
                            </p>
                          </div>
                        ) : (
                          <div className="space-y-3">
                            <p className="flex min-w-0 items-center gap-2 text-sm">
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
                                <p className="text-sm leading-5 text-amber-100">
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
                              <p className="text-sm text-[var(--color-text-muted)]">
                                Last checked {new Date(x.lastPolledAt).toLocaleString()}
                              </p>
                            )}
                            <details className="border-t border-[var(--color-border)] pt-3">
                              <summary className="cursor-pointer text-sm font-medium text-[var(--color-text-muted)]">
                                X options
                              </summary>
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
                      </ActionSection>
                    )}
                    {shownAction === 'share' && (
                      <ActionSection
                        title="Portability & sharing"
                        detail={
                          activeAvatar
                            ? 'Take this companion with you or share a public page.'
                            : 'Restore a companion from a portable artifact.'
                        }
                        state={
                          activeAvatar ? (activeAvatar.visibility === 'private' ? 'Private' : 'Public') : 'Optional'
                        }
                        ready={Boolean(activeAvatar)}
                      >
                        <div className="flex flex-wrap gap-3 text-sm">
                          {activeAvatar && (
                            <a
                              href={ownedHostedAvatarBundleUrl(activeAvatar.avatarId)}
                              className="text-brand-300 underline underline-offset-4"
                            >
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
                          <label
                            htmlFor="avatar-import"
                            className="cursor-pointer text-brand-300 underline underline-offset-4"
                          >
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
                      </ActionSection>
                    )}
                    {shownAction === 'account' && (
                      <ActionSection
                        title="Passkey & wallets"
                        detail="Use passkeys for everyday access. Link wallets by signing when you need recovery or wallet-backed ownership."
                        state={authProvider === 'passkey' ? 'Passkey active' : 'Protected'}
                        ready
                      >
                        <div className="space-y-4">
                          <HostedPasskeyAuth />
                          <div className="border-t border-[var(--color-border)] pt-4">
                            <HostedWalletLink />
                          </div>
                        </div>
                      </ActionSection>
                    )}
                    {shownAction === 'account' && (
                      <div className="px-5 pb-5">
                        <HostedWalletSignIn className="w-full justify-center" />
                        <details className="mt-4">
                          <summary className="cursor-pointer py-2 text-sm text-[var(--color-text-secondary)]">
                            Technical details
                          </summary>
                          <p className="mt-3 break-all text-sm">
                            {user ? shortWallet(user.walletAddress) : ''} · {environmentCopy.label}
                          </p>
                          <p className="mt-3 text-sm text-[var(--color-text-secondary)]">{environmentCopy.footer}</p>
                          <a
                            href={API_BASE + '/hosting/status'}
                            className="mt-3 inline-block text-sm text-brand-200 underline"
                          >
                            Runtime status
                          </a>
                        </details>
                      </div>
                    )}
                  </ConversationCard>
                </div>
              )}
              <div ref={conversationEnd} />
            </div>
          </div>
          {isAuthenticated && activeAvatar && providerReady && (
            <form
              onSubmit={(event) => void handleSend(event)}
              className="shrink-0 border-t border-[var(--color-border)] px-4 py-4 sm:px-8"
            >
              <div className="mx-auto flex max-w-4xl gap-2 sm:gap-3">
                <label htmlFor="hosted-message" className="sr-only">
                  Message
                </label>
                <input
                  ref={composer}
                  id="hosted-message"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  maxLength={4000}
                  placeholder={'Message ' + activeAvatar.name}
                  className="min-w-0 flex-1 rounded-xl border border-[var(--color-border-secondary)] bg-[var(--color-bg-secondary)] px-4 py-3 text-base outline-none focus:border-brand-400 focus:ring-1 focus:ring-brand-400"
                />
                <button
                  type="submit"
                  disabled={sending || !draft.trim()}
                  className="rounded-xl bg-brand-500 px-4 py-3 text-base font-semibold text-white hover:bg-brand-600 disabled:opacity-50 sm:px-6"
                >
                  Send
                </button>
              </div>
            </form>
          )}
        </section>
      </main>
    </div>
  );
}
