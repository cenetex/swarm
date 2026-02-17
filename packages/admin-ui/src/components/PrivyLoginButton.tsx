/**
 * Simple Privy Login Button
 * For use in public pages like shared chat where we only want Privy auth
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePrivy } from '@privy-io/react-auth';
import { useAuth, useAuthStore } from '../store/auth';

interface PrivyLoginButtonProps {
  className?: string;
}

interface WalletLike {
  address?: string;
  publicKey?: string;
}

interface LinkedAccountLike {
  type?: string;
  address?: string;
  chainType?: string;
  chain_type?: string; // Privy API uses snake_case
}

interface PrivyUserLike {
  wallet?: WalletLike & { chainType?: string };
  embeddedWallet?: WalletLike;
  wallets?: WalletLike[];
  linkedWallets?: WalletLike[];
  linkedAccounts?: LinkedAccountLike[];
  linked_accounts?: LinkedAccountLike[];
}

/**
 * Extract Solana wallet address from Privy user object
 * More permissive version that checks multiple fields
 */
function getSolanaWalletAddressFromPrivyUser(user: unknown): string | null {
  if (!user || typeof user !== 'object') return null;
  const privyUser = user as PrivyUserLike;

  // Check direct wallet fields (embedded wallet may not have chainType set initially)
  const direct =
    privyUser?.wallet?.address ||
    privyUser?.wallet?.publicKey ||
    privyUser?.embeddedWallet?.address ||
    privyUser?.embeddedWallet?.publicKey;
  if (typeof direct === 'string' && direct.length >= 32) return direct;

  // Check wallets array
  const wallets = privyUser?.wallets || privyUser?.linkedWallets;
  if (Array.isArray(wallets)) {
    const first = wallets.find((w) => typeof w?.address === 'string')?.address;
    if (typeof first === 'string' && first.length >= 32) return first;
  }

  // Check linked accounts (with Solana chainType preference)
  // Privy SDK may use either linkedAccounts or linked_accounts, and chain_type or chainType
  const accounts = privyUser?.linkedAccounts || (privyUser as { linked_accounts?: LinkedAccountLike[] })?.linked_accounts;
  if (Array.isArray(accounts)) {
    // First try to find a Solana wallet specifically (check both chainType and chain_type)
    const solanaWallet = accounts.find(
      (acc) => acc?.type === 'wallet' &&
        (acc?.chainType === 'solana' || acc?.chain_type === 'solana') &&
        typeof acc?.address === 'string'
    );
    if (typeof solanaWallet?.address === 'string' && solanaWallet.address.length >= 32) {
      return solanaWallet.address;
    }
    // Fall back to any wallet
    const anyWallet = accounts.find(
      (acc) => acc?.type === 'wallet' && typeof acc?.address === 'string'
    );
    if (typeof anyWallet?.address === 'string' && anyWallet.address.length >= 32) {
      return anyWallet.address;
    }
  }

  return null;
}

export function PrivyLoginButton({ className = '' }: PrivyLoginButtonProps) {
  const { login, logout: privyLogout, ready, authenticated, user: privyUser, getAccessToken } = usePrivy();
  const { isAuthenticated, isLoading, user, logout: authLogout } = useAuth();
  const authStore = useAuthStore();
  const [walletWaitTimedOut, setWalletWaitTimedOut] = useState(false);

  // Track sync attempts to prevent infinite loops
  const syncAttemptedRef = useRef(false);
  const lastTokenRef = useRef<string | null>(null);
  const lastWalletAddressRef = useRef<string | null>(null);

  const walletAddress = getSolanaWalletAddressFromPrivyUser(privyUser);

  // Track if we're waiting for wallet creation
  const isWaitingForWalletCreation = ready && authenticated && privyUser && !walletAddress;

  // Surface common Privy integration failures as a store error.
  useEffect(() => {
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      const raw = (event.reason instanceof Error ? event.reason.message : String(event.reason || '')).toLowerCase();
      if (!raw) return;

      const isPrivyOriginError = raw.includes('origin not allowed') || raw.includes('not allowed');
      const isPrivyIframeError = raw.includes('frame-ancestors') || raw.includes('recipient has origin null');

      if (!isPrivyOriginError && !isPrivyIframeError) return;

      const origin = window.location.origin;
      const hint = isPrivyOriginError
        ? `Privy rejected this origin (${origin}). Add it to your Privy app's allowed domains.`
        : `Privy embedded wallet iframe was blocked (CSP/frame-ancestors). Ensure ${origin} is allowed for embedded wallets in Privy.`;

      authStore.setError(hint);
    };

    window.addEventListener('unhandledrejection', onUnhandledRejection);
    return () => window.removeEventListener('unhandledrejection', onUnhandledRejection);
  }, [authStore]);

  // Sync Privy auth state with backend when Privy is authenticated and wallet is ready
  useEffect(() => {
    if (!ready) return;
    if (!authenticated) return;
    if (!privyUser) return;
    if (authStore.isAuthenticated) return;
    // Wait for wallet to be available before syncing
    if (!walletAddress) return;

    const doSync = async () => {
      try {
        const token = await getAccessToken();
        if (!token) return;

        const isNewToken = token !== lastTokenRef.current;
        const isNewWallet = walletAddress !== lastWalletAddressRef.current;
        if (syncAttemptedRef.current && !isNewToken && !isNewWallet) return;

        syncAttemptedRef.current = true;
        lastTokenRef.current = token;
        lastWalletAddressRef.current = walletAddress;

        await authStore.syncWithBackend(token, {
          id: (privyUser as { id: string }).id,
          email: (privyUser as { email?: string })?.email,
          walletAddress,
        });
      } catch (error) {
        console.error('[PrivyLoginButton] Privy backend sync error:', error);
        syncAttemptedRef.current = false;
      }
    };

    void doSync();
  }, [ready, authenticated, privyUser, getAccessToken, walletAddress, authStore]);

  // Poll for wallet creation when Privy is authenticated but wallet isn't ready yet
  // This handles the async nature of embedded wallet creation
  useEffect(() => {
    if (!isWaitingForWalletCreation) return;
    if (authStore.isAuthenticated) return;

    setWalletWaitTimedOut(false);

    // The wallet should appear in privyUser when Privy finishes creating it
    // The walletAddress variable will update, triggering the sync effect above

    // If wallet creation/linking never completes, show a more actionable hint.
    const timeoutId = window.setTimeout(() => {
      if (!getSolanaWalletAddressFromPrivyUser(privyUser)) {
        console.warn('[PrivyLoginButton] Embedded wallet creation is taking longer than expected');
        setWalletWaitTimedOut(true);
      }
    }, 12_000);

    return () => window.clearTimeout(timeoutId);
  }, [isWaitingForWalletCreation, privyUser, authStore.isAuthenticated]);

  const handleLogin = useCallback(async () => {
    // If Privy is already authenticated but backend sync hasn't happened yet, force sync
    if (ready && authenticated && privyUser && !authStore.isAuthenticated) {
      authStore.setLoading(true);
      try {
        const token = await getAccessToken();
        if (token) {
          await authStore.syncWithBackend(token, {
            id: (privyUser as { id: string }).id,
            email: (privyUser as { email?: string })?.email,
            walletAddress: getSolanaWalletAddressFromPrivyUser(privyUser) ?? undefined,
          });
        }
      } catch (error) {
        console.error('[PrivyLoginButton] Privy backend sync error:', error);
      } finally {
        authStore.setLoading(false);
      }
      return;
    }

    // Otherwise, trigger Privy login flow
    login({
      walletChainType: 'solana-only',
      loginMethods: ['wallet', 'email', 'google', 'twitter'],
    });
  }, [login, ready, authenticated, privyUser, authStore, getAccessToken]);

  const handleLogout = useCallback(async () => {
    // Logout from both Privy SDK AND clear backend session/store
    await Promise.all([
      privyLogout(),
      authLogout(),
    ]);
    // Force page reload to clear any stale state
    window.location.reload();
  }, [privyLogout, authLogout]);

  // Determine if we're waiting for backend sync (Privy is authenticated but our store isn't)
  const isWaitingForSync = ready && authenticated && privyUser && !authStore.isAuthenticated;
  // Waiting for wallet = Privy authenticated but embedded wallet not yet created
  const isWaitingForWallet = isWaitingForSync && !walletAddress;

  // Loading state - show when auth is loading OR when Privy is authenticated but backend sync pending
  if (isLoading || authStore.isLoading || isWaitingForSync) {
    const loadingMessage = isWaitingForWallet
      ? walletWaitTimedOut
        ? 'Wallet setup blocked'
        : 'Creating wallet...'
      : isWaitingForSync
      ? 'Syncing...'
      : 'Connecting...';

    return (
      <button
        className={`flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)] ${className}`}
        disabled
      >
        <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
        <span className="text-sm">{loadingMessage}</span>
      </button>
    );
  }

  // Authenticated state
  if (isAuthenticated && user) {
    const displayName = user.displayName || user.email || `${user.walletAddress.slice(0, 6)}...${user.walletAddress.slice(-4)}`;

    return (
      <div className={`flex items-center gap-3 ${className}`}>
        {/* User avatar */}
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-brand-400 to-brand-600 flex items-center justify-center text-white text-xs font-bold overflow-hidden">
          {user.avatarUrl ? (
            <img src={user.avatarUrl} alt="" className="w-full h-full object-cover" />
          ) : (
            displayName[0]?.toUpperCase() || '?'
          )}
        </div>

        {/* User info */}
        <div className="flex flex-col min-w-0">
          <span className="text-sm font-medium text-[var(--color-text)] truncate">
            {displayName}
          </span>
        </div>

        {/* Logout button */}
        <button
          onClick={handleLogout}
          className="p-1.5 rounded-lg hover:bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          title="Sign out"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
          </svg>
        </button>
      </div>
    );
  }

  // Not authenticated - show login button
  return (
    <button
      onClick={handleLogin}
      className={`flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-brand-500 to-brand-600 hover:from-brand-600 hover:to-brand-700 text-white font-medium text-sm transition-all shadow-lg shadow-brand-500/25 ${className}`}
    >
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
      </svg>
      <span>Login with Privy</span>
    </button>
  );
}
