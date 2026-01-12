/**
 * Wallet Login Button
 * Handles Solana wallet connection and authentication
 */
import { useCallback, useEffect, useRef } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { useWalletAuth } from '../store/walletAuth';

// Collection for NFT gating
const ORB_COLLECTION = '8GCAyy5L2o2ZPdQKo3EtYAYNKYT8Y6sqGHweintLTSJ';
const MAGIC_EDEN_URL = `https://magiceden.io/marketplace/${ORB_COLLECTION}`;

interface WalletLoginProps {
  className?: string;
}

export function WalletLogin({ className = '' }: WalletLoginProps) {
  const { publicKey, connected, signMessage, disconnect } = useWallet();
  const { setVisible } = useWalletModal();
  const { 
    isAuthenticated, 
    isLoading, 
    user, 
    login, 
    logout, 
    checkAuth,
    error,
    nftGateError,
    clearError,
  } = useWalletAuth();

  // Track if we've attempted login for current wallet connection
  // Prevents infinite loop when login fails
  const loginAttemptedRef = useRef<string | null>(null);

  // Check auth on mount
  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  // When wallet connects, trigger login flow (only once per connection)
  useEffect(() => {
    if (connected && publicKey && signMessage && !isAuthenticated && !isLoading) {
      const publicKeyStr = publicKey.toBase58();
      
      // Only attempt login if we haven't already tried for this wallet
      if (loginAttemptedRef.current === publicKeyStr) {
        return; // Already attempted, don't loop
      }
      
      loginAttemptedRef.current = publicKeyStr;
      login(signMessage, publicKeyStr).catch((err) => {
        console.error('Login failed:', err);
        // Keep loginAttemptedRef set to prevent retry loop
      });
    }
    
    // Reset attempt tracker when wallet disconnects
    if (!connected) {
      loginAttemptedRef.current = null;
    }
  }, [connected, publicKey, signMessage, isAuthenticated, isLoading, login]);

  // Handle connect button click
  const handleConnect = useCallback(() => {
    loginAttemptedRef.current = null; // Allow fresh attempt
    clearError();
    setVisible(true);
  }, [setVisible, clearError]);

  // Handle disconnect/logout
  const handleDisconnect = useCallback(async () => {
    loginAttemptedRef.current = null;
    await logout();
    await disconnect();
  }, [logout, disconnect]);

  // Format wallet address for display
  const formatAddress = (address: string) => {
    return `${address.slice(0, 4)}...${address.slice(-4)}`;
  };

  // Loading state
  if (isLoading) {
    return (
      <button
        className={`flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)] ${className}`}
        disabled
      >
        <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
        <span className="text-sm">Connecting...</span>
      </button>
    );
  }

  // Authenticated state
  if (isAuthenticated && user) {
    return (
      <div className={`flex items-center gap-2 ${className}`}>
        {/* User avatar or ghost icon */}
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-brand-400 to-brand-600 flex items-center justify-center text-white text-xs font-bold">
          {user.displayName?.[0]?.toUpperCase() || '👻'}
        </div>
        
        {/* User info */}
        <div className="flex flex-col">
          <span className="text-xs font-medium text-[var(--color-text)]">
            {user.displayName || formatAddress(user.walletAddress)}
          </span>
          {user.displayName && (
            <span className="text-xs text-[var(--color-text-muted)]">
              {formatAddress(user.walletAddress)}
            </span>
          )}
        </div>

        {/* Disconnect button */}
        <button
          onClick={handleDisconnect}
          className="p-1.5 rounded-lg hover:bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] transition-colors"
          title="Disconnect wallet"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
          </svg>
        </button>
      </div>
    );
  }

  // Not authenticated - show connect button
  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      {/* NFT Gate Error - Show prominent message */}
      {nftGateError && (
        <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30">
          <div className="flex items-center gap-2 text-amber-400 mb-2">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span className="font-medium text-sm">Orb NFT Required</span>
          </div>
          <p className="text-xs text-[var(--color-text-muted)] mb-2">
            You need to own at least one Orb NFT to access this app.
          </p>
          <a
            href={MAGIC_EDEN_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-brand-400 hover:text-brand-300"
          >
            Get one on Magic Eden
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        </div>
      )}

      <button
        onClick={handleConnect}
        className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gradient-to-r from-brand-500 to-brand-600 hover:from-brand-600 hover:to-brand-700 text-white font-medium text-sm transition-all shadow-lg shadow-brand-500/25"
      >
        {/* Phantom/Solana icon */}
        <svg className="w-4 h-4" viewBox="0 0 128 128" fill="currentColor">
          <circle cx="64" cy="64" r="64" fill="currentColor" opacity="0.2" />
          <path d="M110.5 64c0-25.6-20.9-46.5-46.5-46.5S17.5 38.4 17.5 64s20.9 46.5 46.5 46.5 46.5-20.9 46.5-46.5zm-72.8 0c0-14.5 11.8-26.3 26.3-26.3s26.3 11.8 26.3 26.3-11.8 26.3-26.3 26.3S37.7 78.5 37.7 64z" />
        </svg>
        <span>{nftGateError ? 'Try Again' : 'Connect Wallet'}</span>
      </button>
      
      {/* Error message (non-NFT errors) */}
      {error && !nftGateError && (
        <span className="text-xs text-red-400">{error}</span>
      )}
    </div>
  );
}

/**
 * Ghost icon for unauthenticated users in chat
 */
export function GhostAvatar({ className = '' }: { className?: string }) {
  return (
    <div className={`w-8 h-8 rounded-full bg-[var(--color-bg-secondary)] border border-[var(--color-border)] flex items-center justify-center ${className}`}>
      <span className="text-base opacity-50">👻</span>
    </div>
  );
}

/**
 * User avatar (shows agent avatar if inhabited, ghost if not)
 */
export function UserAvatar({ 
  walletAddress,
  displayName,
  avatarUrl,
  size = 'md',
  className = '',
}: {
  walletAddress?: string;
  displayName?: string;
  avatarUrl?: string;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const sizeClasses = {
    sm: 'w-6 h-6 text-xs',
    md: 'w-8 h-8 text-sm',
    lg: 'w-10 h-10 text-base',
  };

  // No wallet = ghost
  if (!walletAddress) {
    return <GhostAvatar className={className} />;
  }

  // Has avatar URL (inhabited agent)
  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt={displayName || 'User'}
        className={`${sizeClasses[size]} rounded-full object-cover ${className}`}
      />
    );
  }

  // Wallet connected but no avatar - show gradient with initial
  const initial = displayName?.[0]?.toUpperCase() || walletAddress.slice(0, 2);
  
  return (
    <div className={`${sizeClasses[size]} rounded-full bg-gradient-to-br from-brand-400 to-brand-600 flex items-center justify-center text-white font-bold ${className}`}>
      {initial}
    </div>
  );
}
