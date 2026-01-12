/**
 * Wallet Authentication Store
 * Manages Solana wallet connection and user session
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import bs58 from 'bs58';

const API_BASE = import.meta.env.VITE_API_URL || '';

export interface WalletUser {
  walletAddress: string;
  displayName?: string;
  avatarUrl?: string;
  inhabitedAgentId?: string;
  createdAt?: number;
  sessionCount?: number;
}

export interface NFTGateInfo {
  allowed: boolean;
  ownedCount: number;
  requiredCollection: string;
  ownedNFTs: Array<{
    id: string;
    name: string;
    image?: string;
  }>;
}

export interface GateStatus {
  nftsHeld: number;
  agentsCreated: number;
  availableSlots: number;
  canCreate: boolean;
  canAbandon: boolean;
}

interface WalletAuthState {
  // Auth state
  isAuthenticated: boolean;
  isLoading: boolean;
  user: WalletUser | null;
  error: string | null;
  
  // NFT gating state
  nftGateError: boolean;
  nftGateInfo: NFTGateInfo | null;
  gateStatus: GateStatus | null;

  // Actions
  checkAuth: () => Promise<void>;
  login: (signMessage: (message: Uint8Array) => Promise<Uint8Array>, publicKey: string) => Promise<void>;
  logout: () => Promise<void>;
  clearError: () => void;
  
  // Agent ownership actions
  claimAgent: (agentId: string) => Promise<{ success: boolean; error?: string; avatarUrl?: string }>;
  releaseAgent: () => Promise<{ success: boolean; error?: string }>;
}

export const useWalletAuth = create<WalletAuthState>()(
  persist(
    (set) => ({
      isAuthenticated: false,
      isLoading: false,
      user: null,
      error: null,
      nftGateError: false,
      nftGateInfo: null,
      gateStatus: null,

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
              gateStatus: data.gateStatus || null,
              isLoading: false,
            });
          } else {
            set({
              isAuthenticated: false,
              user: null,
              gateStatus: null,
              isLoading: false,
            });
          }
        } catch (error) {
          console.error('[WalletAuth] Check auth error:', error);
          set({
            isAuthenticated: false,
            user: null,
            gateStatus: null,
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

          // Convert signature to base58 using standard library
          const signature = bs58.encode(signatureBytes);

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
            const errorData = await verifyResponse.json();
            throw new Error(errorData.error || 'Authentication failed');
          }

          const data = await verifyResponse.json();

          if (data.success && data.user) {
            set({
              isAuthenticated: true,
              user: data.user,
              isLoading: false,
              nftGateError: false,
              nftGateInfo: data.nftGate || null,
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
            gateStatus: null,
            isLoading: false,
            error: null,
          });
        }
      },

      clearError: () => set({ error: null, nftGateError: false }),

      /**
       * Claim ownership of an agent (inhabit avatar)
       */
      claimAgent: async (agentId: string) => {
        try {
          const response = await fetch(`${API_BASE}/auth/claim`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId }),
            credentials: 'include',
          });

          const data = await response.json();

          if (!response.ok) {
            return { success: false, error: data.error || 'Failed to claim agent' };
          }

          // Update user with new inhabited agent info
          set((state) => ({
            user: state.user ? {
              ...state.user,
              inhabitedAgentId: data.agentId,
              avatarUrl: data.avatarUrl,
            } : null,
          }));

          return { success: true, avatarUrl: data.avatarUrl };
        } catch (error) {
          console.error('[WalletAuth] Claim agent error:', error);
          return { success: false, error: 'Failed to claim agent' };
        }
      },

      /**
       * Release ownership of current agent
       */
      releaseAgent: async () => {
        try {
          const response = await fetch(`${API_BASE}/auth/release`, {
            method: 'POST',
            credentials: 'include',
          });

          const data = await response.json();

          if (!response.ok) {
            return { success: false, error: data.error || 'Failed to release agent' };
          }

          // Clear inhabited agent from user
          set((state) => ({
            user: state.user ? {
              ...state.user,
              inhabitedAgentId: undefined,
              avatarUrl: undefined,
            } : null,
          }));

          return { success: true };
        } catch (error) {
          console.error('[WalletAuth] Release agent error:', error);
          return { success: false, error: 'Failed to release agent' };
        }
      },
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

