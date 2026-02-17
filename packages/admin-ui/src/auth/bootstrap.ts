import { useAuthStore } from '../store/auth';
import { API_BASE } from '../api/apiBase';

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
    if (!data?.authenticated || !data?.user?.walletAddress) {
      useAuthStore.getState().resetLocal();
      return;
    }

    useAuthStore.setState({
      isAuthenticated: true,
      isLoading: false,
      authProvider: 'privy',
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
  } catch (err) {
    console.error('[bootstrapAuth] Auth bootstrap failed:', err);
    useAuthStore.getState().resetLocal();
  }
}
