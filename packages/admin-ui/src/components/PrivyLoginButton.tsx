/**
 * Login Button — wallet-based sign-in only.
 *
 * No Privy SDK dependency. In local mode, the server manages auth via
 * password unlock; in cloud mode, wallet-based SIWS is used.
 */
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../store/auth';
import { useAvatarStore } from '../store/avatars';

interface LoginButtonProps {
  className?: string;
  label?: string;
  showIcon?: boolean;
}

export function PrivyLoginButton({ className = '', label, showIcon = true }: LoginButtonProps) {
  const { t } = useTranslation();
  const { isAuthenticated, isLoading, user, logout } = useAuth();

  const handleLogout = useCallback(async () => {
    await logout();
    useAvatarStore.getState().resetChatState();
    window.location.reload();
  }, [logout]);

  if (isLoading) {
    return (
      <button
        className={`flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)] ${className}`}
        disabled
      >
        <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
        <span className="text-sm">{t('auth.connecting')}</span>
      </button>
    );
  }

  if (isAuthenticated && user) {
    const displayName = user.displayName || user.email || `${user.walletAddress.slice(0, 6)}...${user.walletAddress.slice(-4)}`;

    return (
      <div className={`flex items-center gap-3 ${className}`}>
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-brand-400 to-brand-600 flex items-center justify-center text-white text-xs font-bold overflow-hidden">
          {user.avatarUrl ? (
            <img src={user.avatarUrl} alt="" className="w-full h-full object-cover" />
          ) : (
            displayName[0]?.toUpperCase() || '?'
          )}
        </div>
        <div className="flex flex-col min-w-0">
          <span className="text-sm font-medium text-[var(--color-text)] truncate">
            {displayName}
          </span>
        </div>
        <button
          onClick={handleLogout}
          className="p-1.5 rounded-lg hover:bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          title={t('common.signOut')}
          aria-label={t('common.signOut')}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
          </svg>
        </button>
      </div>
    );
  }

  return (
    <button
      className={`flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-brand-500 to-brand-600 hover:from-brand-600 hover:to-brand-700 text-white font-medium text-sm transition-all shadow-lg shadow-brand-500/25 ${className}`}
      disabled
    >
      {showIcon && (
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
        </svg>
      )}
      <span>{label ?? t('auth.loginWithPrivy')}</span>
    </button>
  );
}
