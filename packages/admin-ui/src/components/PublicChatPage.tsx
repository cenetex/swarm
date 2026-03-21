/**
 * Public Chat Page - Wrapper for subdomain chat access
 *
 * This component:
 * 1. Fetches avatar info publicly (no ownership required)
 * 2. Renders SharedChatPanel for group chat functionality
 * 3. Shows avatar profile header with name, image, persona summary
 * 4. Displays connected platform badges
 * 5. Sets dynamic meta tags for social link previews
 * 6. Includes "Powered by Swarm" footer
 */
import { useEffect, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../store/auth';
import { bootstrapAuthFromBackendSession } from '../auth/bootstrap';
import { PrivyLoginButton } from './PrivyLoginButton';
import { SharedChatPanel } from './SharedChatPanel';
import { getChannelAvatar, type ChannelAvatarInfo } from '../api/sharedChat';

interface PublicChatPageProps {
  botId: string;
}

/* ---- Platform Badge Icons (inline SVG) ---- */

const PLATFORM_META: Record<string, { label: string; color: string }> = {
  telegram: { label: 'Telegram', color: 'bg-[#2AABEE]/15 text-[#2AABEE] border-[#2AABEE]/25' },
  discord:  { label: 'Discord',  color: 'bg-[#5865F2]/15 text-[#5865F2] border-[#5865F2]/25' },
  twitter:  { label: 'X',        color: 'bg-white/10 text-white/80 border-white/20' },
};

function PlatformIcon({ platform }: { platform: string }) {
  switch (platform) {
    case 'telegram':
      return (
        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
          <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
        </svg>
      );
    case 'discord':
      return (
        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
          <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189z" />
        </svg>
      );
    case 'twitter':
      return (
        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
        </svg>
      );
    default:
      return null;
  }
}

function PlatformBadges({ platforms }: { platforms: string[] }) {
  if (!platforms.length) return null;
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {platforms.map((p) => {
        const meta = PLATFORM_META[p];
        if (!meta) return null;
        return (
          <span
            key={p}
            className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full border ${meta.color}`}
          >
            <PlatformIcon platform={p} />
            {meta.label}
          </span>
        );
      })}
    </div>
  );
}

function PoweredByFooter() {
  const { t } = useTranslation();
  return (
    <footer className="shrink-0 py-2 text-center border-t border-[var(--color-border)]">
      <a
        href="https://swarm.rati.chat"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] transition-colors"
      >
        <img src="/swarm.svg" alt="" className="w-3.5 h-3.5 opacity-60" />
        {t('publicChat.poweredBySwarm')}
      </a>
    </footer>
  );
}

function AvatarImage({ info, size = 'md' }: { info: ChannelAvatarInfo | null; size?: 'sm' | 'md' | 'lg' }) {
  const sizeClasses = {
    sm: 'w-10 h-10',
    md: 'w-12 h-12',
    lg: 'w-20 h-20',
  };
  return (
    <div className={`${sizeClasses[size]} shrink-0 rounded-xl overflow-hidden bg-gradient-to-br from-brand-500 to-brand-700`}>
      {info?.profileImageUrl ? (
        <img
          src={info.profileImageUrl}
          alt={info.name}
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="h-full w-full flex items-center justify-center text-white text-lg font-bold">
          {info?.name?.[0]?.toUpperCase() || '?'}
        </div>
      )}
    </div>
  );
}

/** Update document meta tags for social link previews */
function useMetaTags(avatarInfo: ChannelAvatarInfo | null) {
  useEffect(() => {
    if (!avatarInfo) return;

    const title = `Chat with ${avatarInfo.name} — Swarm`;
    const desc = avatarInfo.description || `Talk to ${avatarInfo.name} on Swarm`;

    document.title = title;

    const setMeta = (selector: string, attr: string, value: string) => {
      let el = document.querySelector(selector);
      if (!el) {
        el = document.createElement('meta');
        const [k, v] = selector.replace(/^meta\[/, '').replace(/\]$/, '').split('=');
        el.setAttribute(k, v.replace(/"/g, ''));
        document.head.appendChild(el);
      }
      el.setAttribute(attr, value);
    };

    setMeta('meta[property="og:title"]', 'content', title);
    setMeta('meta[property="og:description"]', 'content', desc);
    setMeta('meta[property="og:type"]', 'content', 'website');
    setMeta('meta[property="og:url"]', 'content', window.location.href);
    if (avatarInfo.profileImageUrl) {
      setMeta('meta[property="og:image"]', 'content', avatarInfo.profileImageUrl);
    }
    setMeta('meta[name="twitter:title"]', 'content', title);
    setMeta('meta[name="twitter:description"]', 'content', desc);
    setMeta('meta[name="description"]', 'content', desc);

    return () => {
      document.title = 'Swarm — AI Avatars on Solana';
    };
  }, [avatarInfo]);
}

function DescriptionText({ description }: { description: string }) {
  if (!description) return null;
  if (description.length > 60) {
    return (
      <div className="mt-0.5 min-w-0">
        <span
          className="text-xs text-[var(--color-text-muted)] marquee"
          aria-label={description}
          style={{
            ['--marquee-duration' as never]: `${Math.min(140, Math.max(36, Math.round(description.length * 0.45)))}s`,
          }}
        >
          <span className="marquee__inner">{description}</span>
        </span>
      </div>
    );
  }
  return <p className="truncate text-xs text-[var(--color-text-muted)]">{description}</p>;
}

export function PublicChatPage({ botId }: PublicChatPageProps) {
  const { t } = useTranslation();
  const { isAuthenticated, isLoading: authLoading, gateStatus } = useAuth();

  const [authChecked, setAuthChecked] = useState(false);

  const [avatarInfo, setAvatarInfo] = useState<ChannelAvatarInfo | null>(null);
  const [loadingAvatar, setLoadingAvatar] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Set dynamic meta tags for social link previews
  useMetaTags(avatarInfo);

  // Bootstrap auth from backend cookie/session on public subdomains.
  // Without this, Privy sessions can exist (cookie) while the UI still thinks
  // it's unauthenticated because provider localStorage is origin-scoped.
  useEffect(() => {
    if (authChecked) return;

    let mounted = true;

    const doAuthCheck = async () => {
      await bootstrapAuthFromBackendSession();
      if (mounted) setAuthChecked(true);
    };

    const timeoutId = setTimeout(() => {
      if (mounted) {
        console.warn('[PublicChatPage] Auth check timeout');
        setAuthChecked(true);
      }
    }, 10000);

    void doAuthCheck();

    return () => {
      mounted = false;
      clearTimeout(timeoutId);
    };
  }, [authChecked]);

  // Fetch avatar info on mount (public endpoint, no auth required)
  useEffect(() => {
    async function fetchAvatar() {
      try {
        const result = await getChannelAvatar(botId);
        if (result.avatar) {
          setAvatarInfo(result.avatar);
        } else {
          setError(t('publicChat.avatarNotFound'));
        }
      } catch (err) {
        console.error('Failed to load avatar info:', err);
        setError(err instanceof Error ? err.message : t('publicChat.failedToLoadAvatar'));
      } finally {
        setLoadingAvatar(false);
      }
    }
    void fetchAvatar();
  }, [botId, t]);

  // Display name for header
  const displayName = useMemo(() => {
    if (loadingAvatar) return t('common.loading');
    return avatarInfo?.name || botId;
  }, [loadingAvatar, avatarInfo, botId, t]);

  const description = avatarInfo?.description || '';
  const connectedPlatforms = avatarInfo?.connectedPlatforms || [];
  const personaSummary = avatarInfo?.persona
    ? avatarInfo.persona.length > 120
      ? avatarInfo.persona.slice(0, 117) + '...'
      : avatarInfo.persona
    : '';

  // Loading state
  if (!authChecked || loadingAvatar || authLoading) {
    return (
      <div className="min-h-[100dvh] bg-[var(--color-bg)] text-[var(--color-text)] flex flex-col">
        <header className="sticky top-0 z-20 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]/80 backdrop-blur">
          <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-4">
            <div className="h-12 w-12 shrink-0 rounded-xl overflow-hidden bg-gradient-to-br from-brand-500 to-brand-700">
              <div className="h-full w-full animate-pulse bg-[var(--color-bg-tertiary)]" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs uppercase tracking-[0.2em] text-[var(--color-text-tertiary)]">{t('publicChat.chatWith')}</p>
              <h1 className="truncate text-lg font-semibold">{t('common.loading')}</h1>
            </div>
          </div>
        </header>
        <div className="flex-1 flex items-center justify-center">
          <div className="w-6 h-6 border-2 border-brand-500 border-t-transparent rounded-full animate-spin" />
        </div>
        <PoweredByFooter />
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="min-h-[100dvh] bg-[var(--color-bg)] text-[var(--color-text)] flex flex-col">
        <header className="sticky top-0 z-20 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]/80 backdrop-blur">
          <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-4">
            <div className="h-12 w-12 shrink-0 rounded-xl overflow-hidden bg-gradient-to-br from-brand-500 to-brand-700 flex items-center justify-center">
              <span className="text-white text-lg font-bold">?</span>
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-xs uppercase tracking-[0.2em] text-[var(--color-text-tertiary)]">{t('publicChat.chatWith')}</p>
              <h1 className="truncate text-lg font-semibold">{botId}</h1>
            </div>
          </div>
        </header>
        <div className="flex-1 flex items-center justify-center">
          <div className="rounded-2xl border border-red-500/40 bg-red-500/10 px-6 py-4 text-center">
            <p className="text-red-200">{error}</p>
          </div>
        </div>
        <PoweredByFooter />
      </div>
    );
  }

  // Not authenticated - show login prompt with avatar profile
  if (!isAuthenticated) {
    return (
      <div className="min-h-[100dvh] bg-[var(--color-bg)] text-[var(--color-text)] flex flex-col relative overflow-hidden">
        {/* Background gradients (same pattern as LandingPage) */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_80%_50%_at_50%_-20%,rgba(122,99,149,0.3),transparent)]" />
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_40%_at_80%_60%,rgba(167,139,250,0.08),transparent)]" />
        </div>

        {/* Header */}
        <header className="sticky top-0 z-20 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]/80 backdrop-blur">
          <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-3">
            <AvatarImage info={avatarInfo} size="md" />
            <div className="min-w-0 flex-1">
              <p className="text-xs uppercase tracking-[0.2em] text-[var(--color-text-tertiary)]">{t('publicChat.chatWith')}</p>
              <h1 className="truncate text-lg font-semibold">{displayName}</h1>
            </div>
            <div className="ml-auto shrink-0">
              <PrivyLoginButton />
            </div>
          </div>
        </header>

        {/* Profile card */}
        <div className="flex-1 flex items-center justify-center p-4 z-10">
          <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-secondary)]/80 backdrop-blur-sm p-6 sm:p-8 text-center max-w-md w-full">
            <AvatarImage info={avatarInfo} size="lg" />
            <h2 className="mt-4 text-xl font-semibold">{displayName}</h2>

            {/* Persona summary */}
            {personaSummary && (
              <p className="mt-2 text-sm text-[var(--color-text-secondary)] leading-relaxed italic">
                &ldquo;{personaSummary}&rdquo;
              </p>
            )}

            {/* Description */}
            {description && !personaSummary && (
              <p className="mt-2 text-sm text-[var(--color-text-muted)]">
                {description}
              </p>
            )}

            {/* Connected platform badges */}
            {connectedPlatforms.length > 0 && (
              <div className="mt-4 flex justify-center">
                <PlatformBadges platforms={connectedPlatforms} />
              </div>
            )}

            <div className="mt-6">
              <PrivyLoginButton className="w-full justify-center" />
            </div>
            <p className="mt-3 text-xs text-[var(--color-text-tertiary)]">
              {t('publicChat.signInToChat')}
            </p>
          </div>
        </div>

        <PoweredByFooter />
      </div>
    );
  }

  // Determine if user is an Orb holder (affects message limits)
  const isOrbHolder = (gateStatus?.nftsHeld ?? 0) > 0;
  const dailyLimit = isOrbHolder ? 100 : 10;

  // Authenticated - render SharedChatPanel with the public avatar
  return (
    <div className="h-[100dvh] flex flex-col bg-[var(--color-bg)]">
      {/* Custom header for public chat */}
      <header className="bg-[var(--color-bg-secondary)]/80 backdrop-blur-sm border-b border-[var(--color-border)] px-4 py-3">
        <div className="max-w-3xl mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <AvatarImage info={avatarInfo} size="sm" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <h1 className="text-base font-semibold text-[var(--color-text)] truncate">
                  {displayName}
                </h1>
                {/* Limited Mode indicator */}
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                    isOrbHolder
                      ? 'bg-brand-500/20 text-brand-400'
                      : 'bg-yellow-500/20 text-yellow-400'
                  }`}
                  title={isOrbHolder ? t('publicChat.orbHolderTooltip', { limit: dailyLimit }) : t('publicChat.limitedTooltip', { limit: dailyLimit })}
                >
                  {isOrbHolder ? t('publicChat.orbBadge') : t('publicChat.limitedBadge')}
                </span>
              </div>
              {/* Platform badges + description row */}
              <div className="flex items-center gap-2 mt-0.5">
                {connectedPlatforms.length > 0 && (
                  <div className="hidden sm:flex">
                    <PlatformBadges platforms={connectedPlatforms} />
                  </div>
                )}
                {description ? (
                  <div className="hidden sm:block min-w-0 flex-1">
                    <DescriptionText description={description} />
                  </div>
                ) : null}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <PrivyLoginButton />
          </div>
        </div>
      </header>

      {/* Content */}
      <div className="flex-1 min-h-0">
        <SharedChatPanel channelId={botId} />
      </div>

      <PoweredByFooter />
    </div>
  );
}
