import { useAuthStore } from '../store/auth';
import { API_BASE } from '../api/apiBase';
import { apiFetch as fetch } from '../api/client';
import type { AccountSummary, AuthUser, GateStatus } from '../store/auth';

export type BackendAuthSessionPayload = {
  authenticated?: boolean;
  authProvider?: 'wallet' | 'passkey' | 'privy';
  user?: Partial<AuthUser> & { walletAddress?: string };
  account?: AccountSummary | null;
  gateStatus?: GateStatus | null;
  gateWallet?: string | null;
  gateStatusByWallet?: Record<string, GateStatus> | null;
};

export function applyAuthenticatedBackendSession(data: BackendAuthSessionPayload): boolean {
  if (!data.authenticated || !data.user?.walletAddress) return false;
  useAuthStore.setState({
    isAuthenticated: true,
    isLoading: false,
    authProvider: data.authProvider ?? 'wallet',
    error: null,
    user: {
      id: data.account?.accountId || data.user.walletAddress,
      email: data.user.email,
      walletAddress: data.user.walletAddress,
      displayName: data.user.displayName || data.user.email,
      avatarUrl: data.user.avatarUrl,
    },
    account: data.account || null,
    gateStatus: data.gateStatus || null,
    gateWallet: data.gateWallet || null,
    gateStatusByWallet: data.gateStatusByWallet || null,
  });
  return true;
}

/**
 * Bootstraps auth from the backend session.
 *
 * Source of truth: `/auth/me`.
 * If there is no authenticated backend session (or the call fails), clear any
 * persisted local auth state so it cannot "resurrect" the UI.
 */
export async function bootstrapAuthFromBackendSession(): Promise<void> {
  try {
    const response = await fetch(`${API_BASE}/auth/me`, {
      credentials: 'include',
    });

    if (!response.ok) {
      useAuthStore.getState().resetLocal();
      return;
    }

    const data = await response.json();
    if (!applyAuthenticatedBackendSession(data)) {
      useAuthStore.getState().resetLocal();
    }
  } catch (err) {
    console.error('[bootstrapAuth] Auth bootstrap failed:', err);
    useAuthStore.getState().resetLocal();
  }
}
