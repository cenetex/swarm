/**
 * Unified Authentication Store
 *
 * Single Zustand store that owns all auth-related state:
 *   - Privy-backed login / backend session sync
 *   - Gate status (NFT gating)
 *   - Account & linked-wallet metadata
 *   - Wallet-adapter UI errors (previously in walletUi store)
 *
 * Consumers should import `useAuthStore` (the raw Zustand hook with selectors)
 * or `useAuth()` (a convenience hook that returns a flat snapshot).
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { API_BASE } from '../api/apiBase';
import type { GateStatus } from './gateStatus';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type AuthProvider = 'wallet' | 'privy' | null;

export interface AuthUser {
  id: string;
  walletAddress: string;
  displayName?: string;
  avatarUrl?: string;
  email?: string;
}

export interface AccountSummary {
  accountId: string;
  role: 'user' | 'admin';
  identities: Array<{ type: 'wallet' | 'privy'; providerId: string }>;
}

// ---------------------------------------------------------------------------
// Store shape
// ---------------------------------------------------------------------------

interface AuthState {
  // Core session
  isAuthenticated: boolean;
  isLoading: boolean;
  user: AuthUser | null;
  authProvider: AuthProvider;
  account: AccountSummary | null;
  error: string | null;

  // Gate / NFT status
  gateStatus: GateStatus | null;
  gateWallet: string | null;
  gateStatusByWallet: Record<string, GateStatus> | null;

  // Wallet-adapter UI error (migrated from walletUi store)
  walletError: string | null;

  // Actions – backend sync

  // Actions – session lifecycle
  logout: () => Promise<void>;
  resetLocal: () => void;

  // Actions – account refresh (e.g. after linking a wallet)
  refreshAccount: () => Promise<boolean>;

  // Actions – error management
  clearError: () => void;
  setError: (error: string | null) => void;
  setLoading: (loading: boolean) => void;
  setWalletError: (error: string | null) => void;
  clearWalletError: () => void;
}

// ---------------------------------------------------------------------------
// Default (unauthenticated) state slice – used by resetLocal & initial state.
// ---------------------------------------------------------------------------

const UNAUTHENTICATED_STATE = {
  isAuthenticated: false,
  isLoading: false,
  user: null,
  authProvider: null as AuthProvider,
  account: null,
  gateStatus: null,
  gateWallet: null,
  gateStatusByWallet: null,
  error: null,
  walletError: null,
} as const;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useAuthStore = create<AuthState>()(
  persist(
    (set, _get) => ({
      ...UNAUTHENTICATED_STATE,


      // -- Account refresh (e.g. after linking a wallet) ----------------------

      refreshAccount: async () => {
        try {
          const response = await fetch(`${API_BASE}/auth/me`, {
            credentials: 'include',
          });
          if (!response.ok) return false;
          const data = await response.json();
          if (data.authenticated && data.account) {
            set({
              account: data.account,
              gateStatus: data.gateStatus || null,
              gateWallet: data.gateWallet || null,
              gateStatusByWallet: data.gateStatusByWallet || null,
            });
            return true;
          }
          return false;
        } catch (error) {
          console.error('[AuthStore] Refresh account error:', error instanceof Error ? error.message : String(error));
          return false;
        }
      },

      // -- Session lifecycle --------------------------------------------------

      logout: async () => {
        set({ isLoading: true });
        try {
          await fetch(`${API_BASE}/auth/logout`, {
            method: 'POST',
            credentials: 'include',
          });
        } catch (error) {
          console.error('[AuthStore] Logout error:', error instanceof Error ? error.message : String(error));
        } finally {
          set({ ...UNAUTHENTICATED_STATE });
        }
      },

      resetLocal: () => {
        set({ ...UNAUTHENTICATED_STATE });
      },

      // -- Error management ---------------------------------------------------

      clearError: () => set({ error: null }),
      setError: (error) => set({ error }),
      setLoading: (loading) => set({ isLoading: loading }),
      setWalletError: (error) => set({ walletError: error }),
      clearWalletError: () => set({ walletError: null }),
    }),
    {
      name: 'swarm-auth',
      partialize: (state) => ({
        isAuthenticated: state.isAuthenticated,
        user: state.user,
        authProvider: state.authProvider,
        account: state.account,
        gateWallet: state.gateWallet,
        gateStatusByWallet: state.gateStatusByWallet,
        gateStatus: state.gateStatus,
      }),
    },
  ),
);

// ---------------------------------------------------------------------------
// Convenience hooks & selectors
// ---------------------------------------------------------------------------

/** Derived list of linked wallet addresses from account identities. */
export function useLinkedWallets(): string[] {
  return useAuthStore((state) =>
    state.account?.identities
      ?.filter((i) => i.type === 'wallet')
      .map((i) => i.providerId) ?? []
  );
}

/**
 * Convenience hook that returns a flat auth snapshot.
 *
 * Most components only need a handful of fields (`isAuthenticated`, `user`,
 * `gateStatus`, etc.) – they should prefer targeted selectors on
 * `useAuthStore` to minimise re-renders. This hook exists for call-sites
 * that historically consumed `useAuth()`.
 */
export function useAuth() {
  const state = useAuthStore();
  const linkedWallets = state.account?.identities
    ?.filter((i) => i.type === 'wallet')
    .map((i) => i.providerId) ?? [];

  return {
    isAuthenticated: state.isAuthenticated,
    isLoading: state.isLoading,
    user: state.user,
    authProvider: state.authProvider,
    gateStatus: state.gateStatus,
    gateWallet: state.gateWallet,
    gateStatusByWallet: state.gateStatusByWallet,
    account: state.account,
    linkedWallets,
    error: state.error,
    logout: state.logout,
    clearError: state.clearError,
  };
}


// Re-export types for convenience
export type { GateStatus };
