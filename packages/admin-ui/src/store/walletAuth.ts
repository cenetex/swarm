/**
 * Wallet Authentication Store
 * Manages Solana wallet connection and user session
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

const API_BASE = import.meta.env.VITE_API_URL || '';

export interface WalletUser {
  walletAddress: string;
  displayName?: string;
  avatarUrl?: string;
  inhabitedAgentId?: string;
  createdAt?: number;
  sessionCount?: number;
}

interface WalletAuthState {
  // Auth state
  isAuthenticated: boolean;
  isLoading: boolean;
  user: WalletUser | null;
  error: string | null;

  // Actions
  checkAuth: () => Promise<void>;
  login: (signMessage: (message: Uint8Array) => Promise<Uint8Array>, publicKey: string) => Promise<void>;
  logout: () => Promise<void>;
  clearError: () => void;
}

export const useWalletAuth = create<WalletAuthState>()(
  persist(
    (set) => ({
      isAuthenticated: false,
      isLoading: false,
      user: null,
      error: null,

      /**
       * Check if user is already authenticated (from cookie)
       */
      checkAuth: async () => {
        set({ isLoading: true, error: null });
        try {
          const response = await fetch(`${API_BASE}/auth/me`, {
            credentials: 'include',
          });

          if (!response.ok) {
            throw new Error('Failed to check auth status');
          }

          const data = await response.json();
          
          if (data.authenticated && data.user) {
            set({
              isAuthenticated: true,
              user: data.user,
              isLoading: false,
            });
          } else {
            set({
              isAuthenticated: false,
              user: null,
              isLoading: false,
            });
          }
        } catch (error) {
          console.error('[WalletAuth] Check auth error:', error);
          set({
            isAuthenticated: false,
            user: null,
            isLoading: false,
          });
        }
      },

      /**
       * Login with Solana wallet signature
       */
      login: async (signMessage, publicKey) => {
        set({ isLoading: true, error: null });
        try {
          // 1. Get challenge from server
          const challengeResponse = await fetch(`${API_BASE}/auth/challenge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ walletAddress: publicKey }),
            credentials: 'include',
          });

          if (!challengeResponse.ok) {
            const error = await challengeResponse.json();
            throw new Error(error.error || 'Failed to get challenge');
          }

          const { nonce, message } = await challengeResponse.json();

          // 2. Sign the challenge message
          const messageBytes = new TextEncoder().encode(message);
          const signatureBytes = await signMessage(messageBytes);
          
          // Convert signature to base58
          const signature = base58Encode(signatureBytes);

          // 3. Verify signature with server
          const verifyResponse = await fetch(`${API_BASE}/auth/verify`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              signature,
              publicKey,
              nonce,
            }),
            credentials: 'include',
          });

          if (!verifyResponse.ok) {
            const error = await verifyResponse.json();
            throw new Error(error.error || 'Authentication failed');
          }

          const data = await verifyResponse.json();

          if (data.success && data.user) {
            set({
              isAuthenticated: true,
              user: data.user,
              isLoading: false,
            });
          } else {
            throw new Error('Authentication failed');
          }
        } catch (error) {
          console.error('[WalletAuth] Login error:', error);
          set({
            isAuthenticated: false,
            user: null,
            isLoading: false,
            error: error instanceof Error ? error.message : 'Login failed',
          });
          throw error;
        }
      },

      /**
       * Logout and clear session
       */
      logout: async () => {
        set({ isLoading: true });
        try {
          await fetch(`${API_BASE}/auth/logout`, {
            method: 'POST',
            credentials: 'include',
          });
        } catch (error) {
          console.error('[WalletAuth] Logout error:', error);
        } finally {
          set({
            isAuthenticated: false,
            user: null,
            isLoading: false,
            error: null,
          });
        }
      },

      clearError: () => set({ error: null }),
    }),
    {
      name: 'wallet-auth',
      partialize: (state) => ({
        // Only persist user info, not loading/error states
        isAuthenticated: state.isAuthenticated,
        user: state.user,
      }),
    }
  )
);

/**
 * Base58 encoding (Solana standard)
 */
function base58Encode(bytes: Uint8Array): string {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  
  // Count leading zeros
  let zeros = 0;
  for (const byte of bytes) {
    if (byte === 0) zeros++;
    else break;
  }

  // Convert bytes to big integer
  let num = BigInt(0);
  for (const byte of bytes) {
    num = num * BigInt(256) + BigInt(byte);
  }

  // Convert to base58
  let result = '';
  while (num > 0) {
    result = ALPHABET[Number(num % BigInt(58))] + result;
    num = num / BigInt(58);
  }

  // Add leading '1's for zeros
  return '1'.repeat(zeros) + result;
}
