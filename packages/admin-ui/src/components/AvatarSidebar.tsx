/**
 * Avatar Sidebar - Discord-like avatar list with tiered access
 *
 * Access Tiers:
 * - Not signed in: Browse profiles only (read-only)
 * - Authenticated, no Orb: Browse + limited chat/create
 * - Authenticated + Orb: Full create access based on slots
 */
import React, { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { useAvatarStore } from '../store/avatars';
import { useAuth } from '../store/auth';
import { ThemeToggle } from './ThemeToggle';
import { PrivyLoginButton } from './PrivyLoginButton';
import { AvatarReassignModal } from './AvatarReassignModal';
import { useAvatarActivation } from '../hooks/useAvatarActivation';
import { useWorkspaceStore } from '../store/workspace';

// Lazy-load HealthDashboard — only shown when admin toggles the health panel
const HealthDashboard = lazy(() => import('./HealthDashboard').then(m => ({ default: m.HealthDashboard })));
import * as avatarApi from '../api/avatars';
import type { Avatar } from '../types';
import type { TFunction } from 'i18next';

interface AvatarDisplayProps {
  avatar: Avatar;
  size?: 'sm' | 'md' | 'lg';
  showStatus?: boolean;
}

/**
 * Get the display status color for an avatar based on health and tier
 * Priority: errors first, then activity, then tier
 */
function getAvatarStatusColor(avatar: Avatar, t: TFunction): { color: string; title: string } {
  // Error states take priority (red)
  if (avatar.healthStatus === 'error' || avatar.healthStatus === 'rate_limited') {
    return {
      color: 'bg-red-500',
      title: avatar.healthMessage || (avatar.healthStatus === 'rate_limited' ? t('avatar.rateLimited') : t('avatar.errorState')),
    };
  }

  // Inactive/paused/draft states (gray)
  if (avatar.healthStatus === 'inactive' || avatar.status === 'shell') {
    return { color: 'bg-gray-500', title: t('avatar.inactive') };
  }
  if (avatar.status === 'draft') {
    return { color: 'bg-gray-400', title: t('avatar.draft') };
  }
  if (avatar.status === 'paused') {
    return { color: 'bg-amber-500', title: t('avatar.paused') };
  }

  // Active - show tier
  // Green = orb-backed, Yellow = free slot
  if (avatar.slotType === 'orb') {
    return { color: 'bg-green-500', title: t('avatar.activeOrb') };
  }
  if (avatar.slotType === 'nft') {
    return { color: 'bg-cyan-500', title: t('avatar.activeNft') };
  }

  // Free slot or unknown slot type
  if (avatar.slotType === 'free') {
    return { color: 'bg-yellow-500', title: t('avatar.activeFree') };
  }

  // Fallback to legacy status colors for avatars without slotType
  const legacyColors: Record<string, string> = {
    configured: 'bg-yellow-500',
    active: 'bg-green-500',
    error: 'bg-red-500',
  };
  return {
    color: legacyColors[avatar.status] || 'bg-gray-500',
    title: avatar.status,
  };
}

function AvatarDisplay({ avatar, size = 'md', showStatus = true }: AvatarDisplayProps) {
  const { t } = useTranslation();
  const sizeClasses = {
    sm: 'w-8 h-8',
    md: 'w-10 h-10',
    lg: 'w-12 h-12',
  };

  const { color: statusColor, title: statusTitle } = getAvatarStatusColor(avatar, t);

  return (
    <div className="relative">
      <div
        className={`${sizeClasses[size]} rounded-full overflow-hidden ring-2 ring-brand-600`}
        style={{ backgroundColor: avatar.color }}
      >
        {avatar.avatar ? (
          <img
            src={avatar.avatar}
            alt={avatar.name}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-white font-bold">
            {avatar.name.charAt(0).toUpperCase()}
          </div>
        )}
      </div>
      {showStatus && (
        <div
          className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-[var(--color-bg-secondary)] ${statusColor}`}
          title={statusTitle}
        />
      )}
    </div>
  );
}

interface AvatarListItemProps {
  avatar: Avatar;
  isActive: boolean;
  onClick: () => void;
  isAdmin?: boolean;
  onReassign?: (avatar: Avatar) => void;
}

function truncateWallet(wallet: string | undefined): string {
  if (!wallet) return '';
  return `${wallet.slice(0, 4)}...${wallet.slice(-4)}`;
}

/**
 * Derive connection health from avatar config.
 * Green: at least one platform integration connected
 * Yellow: persona set but no platform connected
 * Gray: no persona set (incomplete setup)
 */
function getConnectionHealth(avatar: Avatar, t: TFunction): { color: string; label: string } {
  const platforms = avatar.platforms ?? {};
  const connectedPlatforms: string[] = [];

  if (platforms.telegram?.enabled) connectedPlatforms.push('Telegram');
  if (platforms.discord?.enabled) connectedPlatforms.push('Discord');
  if (platforms.twitter?.enabled) connectedPlatforms.push('Twitter');

  // Also check secrets for platform tokens as a fallback
  if (connectedPlatforms.length === 0 && avatar.secrets?.length) {
    for (const secret of avatar.secrets) {
      if (secret.isSet && /telegram/i.test(secret.key) && !connectedPlatforms.includes('Telegram')) {
        connectedPlatforms.push('Telegram');
      }
      if (secret.isSet && /discord/i.test(secret.key) && !connectedPlatforms.includes('Discord')) {
        connectedPlatforms.push('Discord');
      }
      if (secret.isSet && /twitter/i.test(secret.key) && !connectedPlatforms.includes('Twitter')) {
        connectedPlatforms.push('Twitter');
      }
    }
  }

  if (connectedPlatforms.length > 0) {
    return {
      color: 'bg-green-400',
      label: t('sidebar.connectionStatus', { platforms: connectedPlatforms.join(', ') }),
    };
  }

  if (avatar.persona) {
    return {
      color: 'bg-yellow-400',
      label: t('sidebar.noPlatformsConnected'),
    };
  }

  return {
    color: 'bg-gray-400',
    label: t('sidebar.incompleteSetup'),
  };
}

function getStatusDescription(avatar: Avatar, t: TFunction): string {
  // Health status takes priority
  if (avatar.healthStatus === 'error') return avatar.healthMessage || t('common.error');
  if (avatar.healthStatus === 'rate_limited') return avatar.healthMessage || t('avatar.rateLimited');
  if (avatar.healthStatus === 'inactive') return t('sidebar.inactiveStatus');

  // Fall back to legacy status
  if (avatar.status === 'shell') return t('sidebar.unconfigured');
  if (avatar.status === 'draft') return t('sidebar.unconfigured');
  if (avatar.status === 'paused') return t('sidebar.pausedStatus');
  if (avatar.status === 'configured') return `${avatar.secrets?.filter(s => s.isSet).length || 0} secrets`;
  if (avatar.status === 'active') return t('sidebar.activeStatus');
  if (avatar.status === 'error') return t('common.error');

  return avatar.status;
}

/**
 * Compact energy indicator that fetches energy lazily
 */
function CompactEnergyBar({ avatarId, show, t }: { avatarId: string; show: boolean; t: TFunction }) {
  const [energy, setEnergy] = React.useState<{ current: number; max: number } | null>(null);
  const [loading, setLoading] = React.useState(false);
  const hasFetched = React.useRef(false);

  React.useEffect(() => {
    if (show && !hasFetched.current) {
      hasFetched.current = true;
      setLoading(true);
      avatarApi.getEnergyStatus(avatarId)
        .then((status) => {
          setEnergy({ current: status.currentEnergy, max: status.maxEnergy });
        })
        .catch(() => {
          // Silently fail - energy display is optional
        })
        .finally(() => setLoading(false));
    }
  }, [avatarId, show]);

  if (!show || loading || !energy) return null;

  const percent = Math.round((energy.current / energy.max) * 100);
  const color = percent > 60 ? 'bg-green-500' : percent > 25 ? 'bg-yellow-500' : 'bg-red-500';

  return (
    <div className="mt-1 flex items-center gap-1.5" title={`${t('energy.title')}: ${energy.current}/${energy.max}`}>
      <div className="flex-1 h-1 bg-[var(--color-bg-tertiary)] rounded-full overflow-hidden">
        <div className={`h-full ${color} transition-all`} style={{ width: `${percent}%` }} />
      </div>
      <span className="text-[10px] text-[var(--color-text-muted)] tabular-nums">{percent}%</span>
    </div>
  );
}

function AvatarListItem({ avatar, isActive, onClick, isAdmin, onReassign }: AvatarListItemProps) {
  const { t } = useTranslation();
  const [showContextMenu, setShowContextMenu] = React.useState(false);
  const contextMenuRef = React.useRef<HTMLDivElement>(null);

  // Close context menu when clicking outside
  React.useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (contextMenuRef.current && !contextMenuRef.current.contains(event.target as Node)) {
        setShowContextMenu(false);
      }
    }
    if (showContextMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showContextMenu]);

  const handleContextMenu = (e: React.MouseEvent) => {
    if (isAdmin && onReassign) {
      e.preventDefault();
      setShowContextMenu(true);
    }
  };

  return (
    <div className="relative">
      <button
        onClick={onClick}
        onContextMenu={handleContextMenu}
        className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg transition-colors text-left ${
          isActive
            ? 'bg-brand-600/20 text-[var(--color-text)] ring-1 ring-brand-600/50'
            : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)]'
        }`}
      >
        <AvatarDisplay avatar={avatar} size="sm" />
        <div className="flex-1 min-w-0">
          <div className="font-medium truncate">{avatar.name}</div>
          <div className="text-xs text-[var(--color-text-muted)] truncate flex items-center gap-1.5">
            <span
              className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${getConnectionHealth(avatar, t).color}`}
              title={getConnectionHealth(avatar, t).label}
            />
            {getStatusDescription(avatar, t)}
          </div>
          {/* Energy indicator for active avatar */}
          <CompactEnergyBar avatarId={avatar.id} show={isActive} t={t} />
          {/* Admin: show owner wallet badge */}
          {isAdmin && avatar.creatorWallet && (
            <div className="text-xs text-[var(--color-text-muted)] truncate mt-0.5 flex items-center gap-1">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-3 h-3 opacity-60">
                <path d="M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM12.735 14c.618 0 1.093-.561.872-1.139a6.002 6.002 0 0 0-11.215 0c-.22.578.254 1.139.872 1.139h9.47Z" />
              </svg>
              <span className="opacity-60">{truncateWallet(avatar.creatorWallet)}</span>
            </div>
          )}
        </div>
        {/* Admin: context menu button */}
        {isAdmin && onReassign && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setShowContextMenu(!showContextMenu);
            }}
            className="p-1 rounded hover:bg-[var(--color-bg-elevated)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            title={t('sidebar.options')}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
              <path d="M8 2a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM8 6.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM9.5 12.5a1.5 1.5 0 1 0-3 0 1.5 1.5 0 0 0 3 0Z" />
            </svg>
          </button>
        )}
      </button>

      {/* Context menu */}
      {showContextMenu && isAdmin && onReassign && (
        <div
          ref={contextMenuRef}
          className="absolute right-0 top-full mt-1 z-50 bg-[var(--color-bg-elevated)] border border-[var(--color-border)] rounded-lg shadow-lg py-1 min-w-[160px]"
        >
          <button
            onClick={() => {
              onClick();
              setShowContextMenu(false);
            }}
            className="w-full px-3 py-2 text-left text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] flex items-center gap-2"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
              <path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />
              <path fillRule="evenodd" d="M1.38 8.28a.87.87 0 0 1 0-.566 7.003 7.003 0 0 1 13.24.002.87.87 0 0 1 0 .566A7.003 7.003 0 0 1 1.38 8.28ZM11 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" clipRule="evenodd" />
            </svg>
            {t('sidebar.viewDetails')}
          </button>
          <button
            onClick={() => {
              onReassign(avatar);
              setShowContextMenu(false);
            }}
            className="w-full px-3 py-2 text-left text-sm text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] flex items-center gap-2"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor" className="w-4 h-4">
              <path d="M11 4V3a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h1v1a2 2 0 0 0 2 2h5a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-1ZM4 6.5a1 1 0 0 1 .872-.995L5 5.5h7a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-.5.5H7a1 1 0 0 1-1-1v-5a1 1 0 0 1-.872-.995L5 6.5H4Z" />
            </svg>
            {t('sidebar.reassignOwner')}
          </button>
          <div className="border-t border-[var(--color-border)] my-1" />
          <div className="px-3 py-1 text-xs text-[var(--color-text-muted)]">
            <div>{t('sidebar.creator')} {truncateWallet(avatar.creatorWallet) || t('sidebar.none')}</div>
          </div>
        </div>
      )}
    </div>
  );
}

function ActiveAvatarControls({ avatar }: { avatar: Avatar }) {
  const { t } = useTranslation();
  const activation = useAvatarActivation(avatar);
  const isActive = avatar.status === 'active';
  const status = getAvatarStatusColor(avatar, t);
  const openWorkspaceTab = (tab: 'settings' | 'activity') => {
    useWorkspaceStore.getState().setTab(tab, avatar.id);
  };

  return (
    <div className="mx-2 mb-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] p-3">
      <div className="flex items-start gap-3">
        <AvatarDisplay avatar={avatar} size="sm" />
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            {t('sidebar.activeAvatar')}
          </div>
          <div className="truncate text-sm font-semibold text-[var(--color-text)]">
            {avatar.name}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-xs text-[var(--color-text-muted)]">
            <span className={`h-2 w-2 rounded-full ${status.color}`} aria-hidden />
            <span className="truncate">{getStatusDescription(avatar, t)}</span>
          </div>
        </div>
      </div>

      {activation.hasConfiguredPlatformsButInactive && !activation.showPauseConfirm && (
        <div className="mt-3 rounded-md border border-amber-500/20 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-300">
          {t('chat.panel.platformIntegrationsConfiguredButInactive')}
        </div>
      )}

      {activation.error && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-red-500/25 bg-red-500/10 px-2 py-1.5 text-xs text-red-300">
          <span className="min-w-0 flex-1">{activation.error}</span>
          <button
            type="button"
            onClick={activation.clearError}
            className="rounded p-0.5 text-red-300 hover:bg-red-500/20 hover:text-red-200"
            aria-label={t('common.close')}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>
      )}

      <div className="mt-3 space-y-2">
        {activation.showPauseConfirm ? (
          <div className="space-y-2">
            <div className="rounded-md border border-amber-500/25 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-300">
              {t('chat.panel.pauseWarning')}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={activation.cancelPause}
                className="h-9 rounded-lg bg-[var(--color-bg-secondary)] text-xs font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-text)]"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={activation.toggleActivation}
                disabled={activation.isLoading}
                className="h-9 rounded-lg bg-amber-600 px-3 text-xs font-semibold text-amber-50 hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {activation.isLoading ? t('chat.panel.pausing') : t('chat.panel.confirmPause')}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={activation.toggleActivation}
            disabled={activation.isLoading}
            className={[
              'h-9 w-full rounded-lg px-3 text-sm font-semibold transition-colors',
              'flex items-center justify-center gap-2 disabled:cursor-not-allowed disabled:opacity-50',
              isActive
                ? 'text-amber-300 hover:bg-amber-900/20'
                : 'border border-green-500/30 bg-green-500/10 text-green-300 hover:bg-green-500/20',
            ].join(' ')}
            title={isActive ? t('chat.panel.pauseAvatarTitle') : t('chat.panel.activateAvatarTitle')}
          >
            {activation.isLoading ? (
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            ) : isActive ? (
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                <path d="M5.75 3a.75.75 0 00-.75.75v12.5c0 .414.336.75.75.75h1.5a.75.75 0 00.75-.75V3.75A.75.75 0 007.25 3h-1.5zM12.75 3a.75.75 0 00-.75.75v12.5c0 .414.336.75.75.75h1.5a.75.75 0 00.75-.75V3.75a.75.75 0 00-.75-.75h-1.5z" />
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                <path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z" />
              </svg>
            )}
            <span>
              {activation.isLoading
                ? isActive ? t('chat.panel.pausing') : t('sidebar.activating')
                : isActive ? t('chat.panel.pause') : t('chat.panel.activate')}
            </span>
          </button>
        )}

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => openWorkspaceTab('settings')}
            className="h-8 rounded-lg bg-[var(--color-bg-secondary)] px-2 text-xs font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-text)]"
          >
            {t('chat.panel.settings')}
          </button>
          <button
            type="button"
            onClick={() => openWorkspaceTab('activity')}
            className="h-8 rounded-lg bg-[var(--color-bg-secondary)] px-2 text-xs font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-elevated)] hover:text-[var(--color-text)]"
          >
            {t('workspace.tabs.activity')}
          </button>
        </div>
      </div>
    </div>
  );
}

interface AvatarSidebarProps {
  className?: string;
  onClose?: () => void;
  onSelectAvatar?: (avatarId: string) => void;
}

export function AvatarSidebar({ className, onClose, onSelectAvatar }: AvatarSidebarProps) {
  const { t } = useTranslation();
  const { avatars, activeAvatarId, createAvatar, setActiveAvatar, isLoading, error, fetchAvatars } = useAvatarStore();
  const { isAuthenticated, user, gateStatus, account } = useAuth();
  const [reassignAvatarData, setReassignAvatarData] = React.useState<Avatar | null>(null);
  const [showHealth, setShowHealth] = React.useState(false);
  const [isScanningNfts, setIsScanningNfts] = React.useState(false);
  const [scanMessage, setScanMessage] = React.useState<string | null>(null);
  const [scanError, setScanError] = React.useState<string | null>(null);

  const isAdmin = account?.role === 'admin';

  // Handler for opening the reassign modal
  const handleReassign = (avatar: Avatar) => {
    setReassignAvatarData(avatar);
  };

  // Handler for closing the reassign modal
  const handleReassignClose = () => {
    setReassignAvatarData(null);
  };

  // Handler for successful reassignment
  const handleReassignSuccess = () => {
    fetchAvatars();
  };

  // Determine access level
  const walletAddress = user?.walletAddress;
  const canCreate = gateStatus?.canCreate || false;

  const bypassRestrictions = isAdmin;
  const activeAvatar = avatars.find((avatar) => avatar.id === activeAvatarId) ?? null;
  const canManageActiveAvatar = Boolean(
    activeAvatar &&
      isAuthenticated &&
      (isAdmin || activeAvatar.creatorWallet === walletAddress)
  );

  const filteredAvatars = avatars;

  // Sort avatars: created by user first, then by name.
  const sortedAvatars = [...filteredAvatars].sort((a, b) => {
    const aCreatedByMe = a.creatorWallet === walletAddress;
    const bCreatedByMe = b.creatorWallet === walletAddress;
    if (aCreatedByMe && !bCreatedByMe) return -1;
    if (bCreatedByMe && !aCreatedByMe) return 1;
    // Then by name
    return a.name.localeCompare(b.name);
  });

  const handleCreateAvatar = async () => {
    try {
      await createAvatar();
    } catch (e) {
      // Error is already set in store
      console.error('Failed to create avatar:', e);
    }
  };

  const handleScanNftAvatars = async () => {
    setIsScanningNfts(true);
    setScanMessage(null);
    setScanError(null);

    try {
      const result = await avatarApi.scanNftAvatars();
      await fetchAvatars();

      if (result.created.length > 0) {
        setScanMessage(
          result.capped
            ? t('sidebar.scanNftCapped', { count: result.created.length, available: result.available })
            : t('sidebar.scanNftCreated', { count: result.created.length }),
        );
      } else {
        setScanMessage(t('sidebar.scanNftNone'));
      }
    } catch (e) {
      setScanError(e instanceof Error ? e.message : t('sidebar.scanNftFailed'));
    } finally {
      setIsScanningNfts(false);
    }
  };

  const handleSelectAvatar = (avatarId: string) => {
    if (onSelectAvatar) {
      // Use callback from parent to handle URL state sync
      onSelectAvatar(avatarId);
    } else {
      setActiveAvatar(avatarId);
    }
    onClose?.();
  };

  // Determine if create button should be shown (visible when authenticated, but may be disabled)
  const showCreateButton = isAuthenticated;
  const canCreateAvatar = canCreate;

  const gateNftsHeld = gateStatus?.nftsHeld ?? 0;
  const gateAvatarsCreated = gateStatus?.avatarsCreated ?? 0;
  const totalSlotsRaw = 1 + gateNftsHeld;
  const totalSlots = Number.isFinite(totalSlotsRaw) ? totalSlotsRaw : 1;
  const usedSlots = Math.max(0, Math.min(totalSlots, totalSlots - (gateStatus?.availableSlots ?? 0)));
  const maxSlotOrbs = 10;
  const displaySlots = Math.min(totalSlots, maxSlotOrbs);
  const hiddenSlots = Math.max(0, totalSlots - displaySlots);

  // Get reason why creation is disabled (for tooltip)
  const getCreateDisabledReason = (): string | null => {
    if (!isAuthenticated) return t('sidebar.signInToCreate');
    if (canCreate) return null;
    if ((gateStatus?.availableSlots ?? 0) <= 0) {
      return gateStatus?.nftsHeld === 0
        ? t('sidebar.needOrbToCreate')
        : t('sidebar.noAvailableSlots');
    }
    return t('sidebar.cannotCreateAvatar');
  };
  const createDisabledReason = getCreateDisabledReason();

  return (
    <div className={`w-72 lg:w-64 bg-[var(--color-bg-secondary)] border-r border-[var(--color-border)] flex flex-col h-full ${className || ''}`}>
      {/* Header */}
      <div className="p-4 border-b border-[var(--color-border)]">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img src="/swarm.svg" alt="Swarm" className="w-7 h-7" />
            <h2 className="font-semibold text-[var(--color-text)]">{t('avatar.sidebarTitle')}</h2>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            {showCreateButton && (
              <button
                onClick={handleCreateAvatar}
                disabled={isLoading || !canCreateAvatar}
                className={`w-8 h-8 flex items-center justify-center rounded-lg bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-elevated)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors ${
                  isLoading || !canCreateAvatar ? 'opacity-50 cursor-not-allowed' : ''
                }`}
                title={createDisabledReason || `Create new avatar (${gateStatus?.availableSlots || 0} slots available)`}
                data-testid="create-avatar-button"
                aria-label={t('sidebar.createNewAvatar')}
              >
                {isLoading ? (
                  <svg className="w-5 h-5 animate-spin" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                ) : (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    className="w-5 h-5"
                  >
                    <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
                  </svg>
                )}
              </button>
            )}
            {/* Close button - only on mobile */}
            {onClose && (
              <button
                onClick={onClose}
                className="w-8 h-8 flex items-center justify-center rounded-lg bg-[var(--color-bg-tertiary)] hover:bg-[var(--color-bg-elevated)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors lg:hidden"
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                  <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                </svg>
              </button>
            )}
          </div>
        </div>
        {error && (
          <div className="mt-2 text-xs text-red-400 bg-red-900/20 rounded px-2 py-1">
            {error}
          </div>
        )}
      </div>

      {/* Avatar List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {/* Slot Orbs (wallet gating) - visible for all authenticated users including admins */}
        {isAuthenticated && gateStatus && (
          <div className="px-2 py-2 mb-2 rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider">
                {t('sidebar.slots')}
              </div>
              <div className="text-xs text-[var(--color-text-muted)]">
                {gateStatus.availableSlots} available • {gateAvatarsCreated} used
              </div>
            </div>

            <div className="flex items-center gap-2">
              {Array.from({ length: displaySlots }).map((_, idx) => {
                const slotIndex = idx + 1;
                const isFree = slotIndex === 1;
                const isUsed = idx < usedSlots;
                const isAvailable = !isUsed;
                const clickable = isAvailable && canCreateAvatar && !isLoading;

                const baseClass =
                  'w-7 h-7 rounded-full flex items-center justify-center border transition-colors';
                const className = isUsed
                  ? `${baseClass} bg-brand-600/70 border-brand-500/70`
                  : `${baseClass} bg-[var(--color-bg-secondary)] border-[var(--color-border)] hover:border-brand-500/60`;

                return (
                  <button
                    key={idx}
                    type="button"
                    onClick={clickable ? handleCreateAvatar : undefined}
                    disabled={!clickable}
                    className={`${className} ${clickable ? 'cursor-pointer' : 'cursor-default opacity-80'}`}
                    title={
                      isFree
                        ? isUsed
                          ? t('sidebar.freeSlotUsed')
                          : clickable
                          ? t('sidebar.freeSlotClickToCreate')
                          : t('sidebar.freeSlot')
                        : isUsed
                        ? t('sidebar.orbSlotUsed')
                        : clickable
                        ? t('sidebar.orbSlotClickToCreate')
                        : t('sidebar.orbSlot')
                    }
                    aria-label={isFree ? t('sidebar.freeSlot') : t('sidebar.orbSlot')}
                  >
                    <div
                      className={
                        isFree
                          ? 'w-3 h-3 rounded-full bg-yellow-300/90'
                          : 'w-3 h-3 rounded-full bg-white/90'
                      }
                    />
                  </button>
                );
              })}

              {hiddenSlots > 0 && (
                <div className="text-xs text-[var(--color-text-muted)] px-1">
                  +{hiddenSlots}
                </div>
              )}
            </div>

            <div className="mt-2 text-xs text-[var(--color-text-muted)]">
              {bypassRestrictions ? (
                <span className="text-brand-400">{t('sidebar.adminAccess')}</span>
              ) : (
                t('sidebar.freeSlots')
              )}
            </div>
          </div>
        )}

        {/* Prominent New Avatar Button */}
        {showCreateButton && (
          <button
            onClick={handleCreateAvatar}
            disabled={isLoading || !canCreateAvatar}
            className={`w-full flex items-center gap-3 px-3 py-3 mb-2 rounded-lg border-2 border-dashed transition-all ${
              isLoading || !canCreateAvatar
                ? 'opacity-50 cursor-not-allowed border-gray-500/30 text-gray-500'
                : 'border-brand-500/50 hover:border-brand-500 hover:bg-brand-500/10 text-brand-400 hover:text-brand-300'
            }`}
            data-testid="create-avatar-button"
            aria-label={createDisabledReason || 'Create new avatar'}
            title={createDisabledReason || undefined}
          >
            {isLoading ? (
              <svg className="w-5 h-5 animate-spin" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            ) : !canCreateAvatar ? (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                className="w-5 h-5"
              >
                <path fillRule="evenodd" d="M10 1a4.5 4.5 0 00-4.5 4.5V9H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-.5V5.5A4.5 4.5 0 0010 1zm3 8V5.5a3 3 0 10-6 0V9h6z" clipRule="evenodd" />
              </svg>
            ) : (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                className="w-5 h-5"
              >
                <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
              </svg>
            )}
            <span className="font-medium">
              {!canCreateAvatar ? t('sidebar.getOrbToCrate') : t('sidebar.createAvatar')}
            </span>
            {canCreateAvatar && gateStatus?.availableSlots !== undefined && (
              <span className="ml-auto text-xs text-[var(--color-text-muted)] bg-[var(--color-bg-tertiary)] px-2 py-0.5 rounded-full" aria-hidden="true">
                {gateStatus.availableSlots === 1 && gateStatus.nftsHeld === 0
                  ? t('sidebar.oneFreSlot')
                  : `${gateStatus.availableSlots} slot${gateStatus.availableSlots !== 1 ? 's' : ''}`}
              </span>
            )}
          </button>
        )}

        {isAuthenticated && (
          <>
            <button
              onClick={handleScanNftAvatars}
              disabled={isScanningNfts || isLoading}
              className={`w-full flex items-center gap-3 px-3 py-2 mb-2 rounded-lg border transition-all ${
                isScanningNfts || isLoading
                  ? 'opacity-50 cursor-wait border-gray-500/30 text-gray-500'
                  : 'border-cyan-500/40 hover:border-cyan-500 hover:bg-cyan-500/10 text-cyan-300'
              }`}
              data-testid="scan-nft-avatars-button"
            >
              {isScanningNfts ? (
                <svg className="w-5 h-5 animate-spin" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
              ) : (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  className="w-5 h-5"
                >
                  <path fillRule="evenodd" d="M9 3.5a5.5 5.5 0 103.473 9.765l3.131 3.131a.75.75 0 101.061-1.061l-3.131-3.131A5.5 5.5 0 009 3.5zM5 9a4 4 0 118 0 4 4 0 01-8 0z" clipRule="evenodd" />
                </svg>
              )}
              <span className="font-medium">
                {isScanningNfts ? t('sidebar.scanningNftAvatars') : t('sidebar.scanNftAvatars')}
              </span>
            </button>

            {(scanMessage || scanError) && (
              <div className={`mb-2 rounded px-3 py-2 text-xs ${
                scanError
                  ? 'bg-red-900/20 text-red-300'
                  : 'bg-cyan-500/10 text-cyan-200'
              }`}>
                {scanError || scanMessage}
              </div>
            )}
          </>
        )}

        {activeAvatar && canManageActiveAvatar && (
          <ActiveAvatarControls avatar={activeAvatar} />
        )}

        {isLoading && avatars.length === 0 ? (
          <div className="text-center py-8 text-[var(--color-text-muted)]">
            <svg className="w-6 h-6 animate-spin mx-auto mb-2" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <p className="text-sm">{t('sidebar.loadingAvatars')}</p>
          </div>
        ) : sortedAvatars.length === 0 ? (
          <div className="text-center py-8 text-[var(--color-text-muted)]">
            <p className="text-sm">{t('sidebar.noAvatars')}</p>
          </div>
        ) : (
          sortedAvatars.map((avatar) => (
            <AvatarListItem
              key={avatar.id}
              avatar={avatar}
              isActive={avatar.id === activeAvatarId}
              onClick={() => handleSelectAvatar(avatar.id)}
              isAdmin={isAdmin}
              onReassign={isAdmin ? handleReassign : undefined}
            />
          ))
        )}
      </div>

      {/* Admin Health Dashboard */}
      {isAdmin && (
        <div className="border-t border-[var(--color-border)]">
          <button
            onClick={() => setShowHealth((prev) => !prev)}
            className="w-full px-4 py-2 flex items-center justify-between text-xs font-medium text-[var(--color-text-muted)] uppercase tracking-wider hover:text-[var(--color-text)] transition-colors"
          >
            <span>{t('sidebar.healthDashboard')}</span>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className={`w-4 h-4 transition-transform ${showHealth ? 'rotate-180' : ''}`}
            >
              <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
            </svg>
          </button>
          {showHealth && (
            <div className="max-h-72 overflow-y-auto">
              <Suspense fallback={null}><HealthDashboard onSelectAvatar={(id) => handleSelectAvatar(id)} /></Suspense>
            </div>
          )}
        </div>
      )}

      {/* Login Footer */}
      <div className="p-3 border-t border-[var(--color-border)]">
        <PrivyLoginButton />
      </div>

      {/* Admin: Reassign Modal */}
      {reassignAvatarData && (
        <AvatarReassignModal
          avatar={reassignAvatarData}
          onClose={handleReassignClose}
          onSuccess={handleReassignSuccess}
        />
      )}
    </div>
  );
}

export { AvatarDisplay };
