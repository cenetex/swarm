import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { API_BASE } from './api/apiBase';
import { PrivyLoginButton } from './components/PrivyLoginButton';
import {
  createHostedAvatar,
  disconnectHostedProvider,
  enqueueHostedMessage,
  getHostedHistory,
  getHostedProviderStatus,
  listHostedAvatars,
  openRouterConnectUrl,
  openRouterResult,
  waitForHostedJob,
  type HostedAvatar,
  type HostedChatMessage,
  type HostedProviderStatus,
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

function StatusDot({ ready }: { ready: boolean }) {
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${ready ? 'bg-emerald-400' : 'bg-amber-400'}`} />;
}

export function HostedApp() {
  const { isAuthenticated, user } = useAuth();
  const [oauthResult] = useState(() => openRouterResult(window.location.search));
  const [provider, setProvider] = useState<HostedProviderStatus | null>(null);
  const [avatars, setAvatars] = useState<HostedAvatar[]>([]);
  const [activeAvatarId, setActiveAvatarId] = useState('');
  const [messages, setMessages] = useState<HostedChatMessage[]>([]);
  const [avatarName, setAvatarName] = useState('My hosted avatar');
  const [draft, setDraft] = useState('');
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
      return;
    }
    void refreshProvider();
  }, [isAuthenticated, refreshProvider]);

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
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Unable to create the avatar.');
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

  return (
    <div className="min-h-[100dvh] bg-[var(--color-bg)] text-[var(--color-text)]">
      <header className="border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-4">
          <div className="flex items-center gap-3">
            <img src="/swarm.svg" alt="" className="h-9 w-9" />
            <div>
              <h1 className="text-lg font-semibold">Swarm Hosted</h1>
              <p className="text-xs text-[var(--color-text-muted)]">Private preview</p>
            </div>
          </div>
          <PrivyLoginButton showIcon={!isAuthenticated} />
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-6 px-5 py-8 lg:grid-cols-[22rem_minmax(0,1fr)]">
        <section className="space-y-5">
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-300">Your runtime</p>
            {!isAuthenticated || !user ? (
              <div className="mt-4 space-y-3">
                <h2 className="text-xl font-semibold">Sign in with your wallet</h2>
                <p className="text-sm leading-6 text-[var(--color-text-secondary)]">
                  Your wallet creates a domain-bound session. Swarm never asks for a seed phrase or transaction.
                </p>
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm text-[var(--color-text-muted)]">Signed in as</p>
                    <p className="font-mono text-sm">{shortWallet(user.walletAddress)}</p>
                  </div>
                  <span className="rounded-full bg-emerald-400/10 px-3 py-1 text-xs text-emerald-300">Session active</span>
                </div>
                <div className="border-t border-[var(--color-border)] pt-4">
                  <div className="flex items-center gap-2">
                    <StatusDot ready={Boolean(provider?.connected)} />
                    <h2 className="font-semibold">OpenRouter</h2>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-[var(--color-text-secondary)]">
                    OAuth uses PKCE S256. The exchanged credential is encrypted for your account and never returned to this page.
                  </p>
                  {provider?.connected ? (
                    <button
                      type="button"
                      onClick={() => void handleDisconnect()}
                      disabled={loading}
                      className="mt-4 w-full rounded-xl border border-red-400/30 px-4 py-2.5 text-sm font-medium text-red-300 transition hover:bg-red-400/10 disabled:opacity-50"
                    >
                      Disconnect OpenRouter
                    </button>
                  ) : (
                    <a
                      href={openRouterConnectUrl()}
                      className="mt-4 block w-full rounded-xl bg-brand-500 px-4 py-2.5 text-center text-sm font-semibold text-white transition hover:bg-brand-600"
                    >
                      Connect OpenRouter securely
                    </a>
                  )}
                </div>
              </div>
            )}
          </div>

          {isAuthenticated && provider?.connected && (
            <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-5">
              <div className="flex items-center justify-between">
                <h2 className="font-semibold">Hosted avatars</h2>
                <span className="text-xs text-[var(--color-text-muted)]">{avatars.length}/100</span>
              </div>
              {avatars.length > 0 && (
                <div className="mt-3 space-y-2">
                  {avatars.map((avatar) => (
                    <button
                      type="button"
                      key={avatar.avatarId}
                      onClick={() => setActiveAvatarId(avatar.avatarId)}
                      className={`w-full rounded-xl border px-3 py-2.5 text-left text-sm transition ${
                        avatar.avatarId === activeAvatarId
                          ? 'border-brand-400 bg-brand-500/15'
                          : 'border-[var(--color-border)] hover:bg-[var(--color-bg-tertiary)]'
                      }`}
                    >
                      {avatar.name}
                    </button>
                  ))}
                </div>
              )}
              <form onSubmit={(event) => void handleCreateAvatar(event)} className="mt-4 space-y-2">
                <label htmlFor="avatar-name" className="text-xs text-[var(--color-text-muted)]">New avatar name</label>
                <input
                  id="avatar-name"
                  value={avatarName}
                  onChange={(event) => setAvatarName(event.target.value)}
                  maxLength={80}
                  className="w-full rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2.5 text-sm outline-none focus:border-brand-400"
                />
                <button
                  type="submit"
                  disabled={loading || !avatarName.trim()}
                  className="w-full rounded-xl bg-[var(--color-bg-tertiary)] px-4 py-2.5 text-sm font-medium transition hover:bg-[var(--color-bg-elevated)] disabled:opacity-50"
                >
                  Create hosted avatar
                </button>
              </form>
            </div>
          )}
        </section>

        <section className="flex min-h-[34rem] flex-col overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
          <div className="border-b border-[var(--color-border)] px-5 py-4">
            <h2 className="font-semibold">{activeAvatar?.name ?? 'Hosted chat'}</h2>
            <p className="mt-1 text-xs text-[var(--color-text-muted)]">
              Queue-backed, account-isolated, and available while your browser is closed.
            </p>
          </div>
          <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-5" aria-live="polite">
            {!isAuthenticated && (
              <p className="m-auto max-w-md text-center text-sm leading-6 text-[var(--color-text-muted)]">
                Connect a wallet, then authorize OpenRouter to start a hosted avatar.
              </p>
            )}
            {isAuthenticated && !provider?.connected && !loading && (
              <p className="m-auto max-w-md text-center text-sm leading-6 text-[var(--color-text-muted)]">
                OpenRouter is not connected. Authorize it from the secure setup card to enable chat.
              </p>
            )}
            {provider?.connected && !activeAvatar && !loading && (
              <p className="m-auto max-w-md text-center text-sm leading-6 text-[var(--color-text-muted)]">
                Create your first hosted avatar to begin.
              </p>
            )}
            {messages.map((message, index) => (
              <div
                key={`${message.role}-${index}`}
                className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-6 ${
                  message.role === 'user'
                    ? 'ml-auto bg-brand-500 text-white'
                    : 'bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)]'
                }`}
              >
                {message.content}
              </div>
            ))}
            {sending && <p className="text-sm text-[var(--color-text-muted)]">Waiting for the hosted response…</p>}
          </div>
          {activeAvatar && provider?.connected && (
            <form onSubmit={(event) => void handleSend(event)} className="flex gap-3 border-t border-[var(--color-border)] p-4">
              <label htmlFor="hosted-message" className="sr-only">Message</label>
              <input
                id="hosted-message"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                maxLength={4000}
                placeholder={`Message ${activeAvatar.name}`}
                className="min-w-0 flex-1 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3 text-sm outline-none focus:border-brand-400"
              />
              <button
                type="submit"
                disabled={sending || !draft.trim()}
                className="rounded-xl bg-brand-500 px-5 py-3 text-sm font-semibold text-white transition hover:bg-brand-600 disabled:opacity-50"
              >
                Send
              </button>
            </form>
          )}
        </section>

        {(error || oauthResult) && (
          <div className="lg:col-span-2" role="status">
            {oauthResult === 'connected' && !error && (
              <p className="rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-4 py-3 text-sm text-emerald-200">
                OpenRouter connected. The credential was exchanged and stored server-side.
              </p>
            )}
            {(oauthResult === 'error' || error) && (
              <p className="rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-3 text-sm text-red-200">
                {error || 'OpenRouter authorization did not complete. Please try again.'}
              </p>
            )}
          </div>
        )}
      </main>

      <footer className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 pb-8 text-xs text-[var(--color-text-muted)]">
        <span>Preview data is isolated from production.</span>
        <a href={`${API_BASE}/hosting/status`} className="hover:text-[var(--color-text)]">Runtime status</a>
      </footer>
    </div>
  );
}
