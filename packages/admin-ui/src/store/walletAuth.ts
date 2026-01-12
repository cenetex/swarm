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

export interface UnclaimedAgent {
  agentId: string;
  name: string;
  description?: string;
  avatarUrl?: string;
  currentEra: number;
}

export interface InhabitationInfo {
  isGhost: boolean;
  inhabitsAgent: boolean;
  agentId?: string;
  agentName?: string;
  avatarUrl?: string;
  era?: number;
  gateStatus?: GateStatus;
}

export interface CanAbandonResult {
  canAbandon: boolean;
  gateStatus: GateStatus;
  inhabitedAgent: {
    agentId: string;
    name: string;
    avatarUrl?: string;
    currentEra: number;
  } | null;
}

export interface AbandonResult {
  success: boolean;
  error?: string;
  agentId?: string;
  agentName?: string;
  era?: number;
  lineageNftMint?: string;
  burnedMint?: string;
  lineageMetadata?: {
    agentId: string;
    agentName: string;
    era: number;
    isGenesis: boolean;
    abandonedAt: number;
    inhabitantWallet: string;
    avatarUrl?: string;
  };
  gateStatus?: GateStatus;
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

  // Inhabitation actions
  fetchUnclaimedAgents: () => Promise<UnclaimedAgent[]>;
  getInhabitationStatus: () => Promise<InhabitationInfo | null>;
  inhabitAgent: (agentId: string) => Promise<{ success: boolean; error?: string; avatarUrl?: string }>;
  checkCanAbandon: () => Promise<CanAbandonResult | null>;
  abandonAgent: (burnTxSignature: string) => Promise<AbandonResult>;
}

export const useWalletAuth = create<WalletAuthState>()(
  persist(
    (set, get) => ({
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
              gateStatus: data.gateStatus || null,
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
       * Fetch list of unclaimed agents available for inhabitation
       */
      fetchUnclaimedAgents: async () => {
        try {
          const response = await fetch(`${API_BASE}/auth/unclaimed-agents`, {
            credentials: 'include',
          });

          if (!response.ok) {
            console.error('[WalletAuth] Failed to fetch unclaimed agents');
            return [];
          }

          const data = await response.json();
          return data.agents || [];
        } catch (error) {
          console.error('[WalletAuth] Fetch unclaimed agents error:', error);
          return [];
        }
      },

      /**
       * Get current inhabitation status (ghost vs avatar)
       */
      getInhabitationStatus: async () => {
        const { isAuthenticated } = get();
        if (!isAuthenticated) return null;

        try {
          const response = await fetch(`${API_BASE}/auth/inhabitation`, {
            credentials: 'include',
          });

          if (!response.ok) {
            console.error('[WalletAuth] Failed to get inhabitation status');
            return null;
          }

          return await response.json();
        } catch (error) {
          console.error('[WalletAuth] Get inhabitation status error:', error);
          return null;
        }
      },

      /**
       * Inhabit an unclaimed agent (FREE - no NFT required)
       */
      inhabitAgent: async (agentId: string) => {
        try {
          const response = await fetch(`${API_BASE}/auth/inhabit`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId }),
            credentials: 'include',
          });

          const data = await response.json();

          if (!response.ok) {
            return { success: false, error: data.error || 'Failed to inhabit agent' };
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
          console.error('[WalletAuth] Inhabit agent error:', error);
          return { success: false, error: 'Failed to inhabit agent' };
        }
      },

      /**
       * Check if user can abandon their current agent
       * Requires holding at least 1 Gate NFT (which will be burned)
       */
      checkCanAbandon: async () => {
        const { isAuthenticated } = get();
        if (!isAuthenticated) return null;

        try {
          const response = await fetch(`${API_BASE}/auth/can-abandon`, {
            method: 'GET',
            credentials: 'include',
          });

          if (!response.ok) {
            console.error('[WalletAuth] Failed to check can abandon');
            return null;
          }

          return await response.json();
        } catch (error) {
          console.error('[WalletAuth] Check can abandon error:', error);
          return null;
        }
      },

      /**
       * Abandon the currently inhabited agent
       * REQUIRES burning a Gate NFT first - pass the burn transaction signature
       *
       * Flow:
       * 1. User burns Gate NFT via wallet (get signature)
       * 2. Call this function with the burn signature
       * 3. Backend verifies burn on-chain
       * 4. Backend releases the agent
       * 5. Returns lineage metadata for optional NFT minting
       */
      abandonAgent: async (burnTxSignature: string) => {
        try {
          const response = await fetch(`${API_BASE}/auth/abandon`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ burnTxSignature }),
            credentials: 'include',
          });

          const data = await response.json();

          if (!response.ok) {
            return {
              success: false,
              error: data.error || 'Failed to abandon agent',
              gateStatus: data.gateStatus,
            };
          }

          // Clear inhabited agent from user
          set((state) => ({
            user: state.user ? {
              ...state.user,
              inhabitedAgentId: undefined,
              avatarUrl: undefined,
            } : null,
            gateStatus: data.gateStatus || state.gateStatus,
          }));

          return {
            success: true,
            agentId: data.agentId,
            agentName: data.agentName,
            era: data.era,
            lineageMetadata: data.lineageMetadata,
            gateStatus: data.gateStatus,
          };
        } catch (error) {
          console.error('[WalletAuth] Abandon agent error:', error);
          return { success: false, error: 'Failed to abandon agent' };
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
