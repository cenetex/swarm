/**
 * Wallet Tools
 * 
 * Tools for managing Solana wallets.
 */
import { z } from 'zod';
import { defineTool, type ToolResult } from '../registry.js';

// ============================================================================
// Service Interface
// ============================================================================

export interface WalletInfo {
  name: string;
  publicKey: string;
  address?: string;
  walletType: 'solana' | 'ethereum';
  solBalance?: number | null;
  ethBalance?: number | null;
  balance?: number | null;
}

export interface VanityWalletResult {
  publicKey: string;
  attempts: number;
  elapsedMs: number;
  pattern: string;
  matchStart: boolean;
}

export interface WalletServices {
  listWallets: (avatarId: string) => Promise<WalletInfo[]>;
  
  createWallet: (avatarId: string, name: string, chain?: string) => Promise<{
    publicKey: string;
    address?: string;
    walletType: string;
  }>;
  
  createVanityWallet?: (avatarId: string, name: string, pattern: string, matchStart: boolean) => Promise<{
    publicKey: string;
    address?: string;
    walletType: string;
    attempts: number;
    elapsedMs: number;
  }>;
  
  getBalance: (publicKey: string, avatarId: string, chain?: string) => Promise<{
    balance: number;
    chain: string;
    solBalance?: number;
    solBalanceLamports?: number;
    ethBalance?: number;
    ethBalanceWei?: string;
    tokens?: unknown[];
  }>;
}

// ============================================================================
// Context Builders
// ============================================================================

export async function buildWalletContext(
  services: WalletServices,
  avatarId: string
): Promise<string | undefined> {
  const wallets = await services.listWallets(avatarId);
  if (wallets.length === 0) {
    return 'No wallets created yet';
  }

  const summaries = wallets.slice(0, 3).map(w => {
    const label = w.name || w.publicKey.slice(0, 8);
    const unit = w.walletType === 'solana' ? 'SOL' : 'ETH';
    const balanceVal = w.walletType === 'solana' ? w.solBalance : w.ethBalance;
    const balance = balanceVal != null ? ` (${balanceVal.toFixed(4)} ${unit})` : '';
    return `${label}${balance}`;
  });

  return `My wallets: ${summaries.join(', ')}`;
}

// ============================================================================
// Tool Definitions
// ============================================================================

export const createWalletTools = (services: WalletServices) => [
  defineTool({
    name: 'get_my_wallets',
    description: 'Get my Solana wallet addresses and balances.',
    category: 'wallet',
    inputSchema: z.object({}),
    contextBuilder: async (context) => {
      return buildWalletContext(services, context.avatarId);
    },
    execute: async (_input, context): Promise<ToolResult> => {
      const walletsData = await services.listWallets(context.avatarId);

      // Enrich with balances
      const enriched = await Promise.all(
        walletsData.map(async (w) => {
          try {
            const balance = await services.getBalance(w.publicKey, context.avatarId, w.walletType);
            return { 
              ...w, 
              balance: balance.balance,
              solBalance: balance.chain === 'solana' ? balance.balance : undefined,
              ethBalance: balance.chain === 'ethereum' ? balance.balance : undefined,
            };
          } catch {
            return { ...w, balance: null };
          }
        })
      );

      return {
        success: true,
        data: enriched,
      };
    },
  }),

  // ── Wallet generation tools DEPRECATED (see #604) ──────────────────────
  // Custodial wallet generation has been disabled to eliminate custody
  // liability. Users should connect their own wallets instead.
  // These tools return a clear deprecation message rather than silently
  // failing, so avatars/users understand why generation no longer works.

  defineTool({
    name: 'create_solana_wallet',
    description: 'Deprecated — custodial wallet generation has been disabled. Connect your own wallet instead.',
    category: 'wallet',
    platforms: ['admin-ui', 'api'],
    inputSchema: z.object({
      name: z.string().min(1).describe('A friendly name for this wallet'),
    }),
    execute: async (): Promise<ToolResult> => {
      return {
        success: false,
        error: 'Custodial wallet generation has been deprecated (see issue #604). Connect your own Solana wallet instead using Sign-In With Solana.',
      };
    },
  }),

  defineTool({
    name: 'create_vanity_solana_wallet',
    description: 'Deprecated — custodial wallet generation has been disabled. Connect your own wallet instead.',
    category: 'wallet',
    platforms: ['admin-ui', 'api'],
    inputSchema: z.object({
      name: z.string().min(1).describe('A friendly name for this wallet'),
      pattern: z.string().min(1).max(6).describe('Pattern to include in address'),
      matchStart: z.boolean().default(false).describe('If true, pattern must be at the START of the address'),
    }),
    execute: async (): Promise<ToolResult> => {
      return {
        success: false,
        error: 'Custodial wallet generation has been deprecated (see issue #604). Connect your own Solana wallet instead using Sign-In With Solana.',
      };
    },
  }),

  defineTool({
    name: 'create_ethereum_wallet',
    description: 'Deprecated — custodial wallet generation has been disabled. Connect your own wallet instead.',
    category: 'wallet',
    platforms: ['admin-ui', 'api'],
    inputSchema: z.object({
      name: z.string().min(1).describe('A friendly name for this wallet'),
    }),
    execute: async (): Promise<ToolResult> => {
      return {
        success: false,
        error: 'Custodial wallet generation has been deprecated (see issue #604). Connect your own Ethereum wallet instead.',
      };
    },
  }),

  defineTool({
    name: 'get_wallet_balance',
    description: 'Get the balance of a specific wallet.',
    category: 'wallet',
    inputSchema: z.object({
      address: z.string().describe('The wallet address (public key) to check'),
      chain: z.enum(['solana', 'ethereum']).default('solana').describe('The blockchain to check'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      try {
        const balance = await services.getBalance(input.address, context.avatarId, input.chain);
        return {
          success: true,
          data: {
            address: input.address,
            chain: input.chain,
            balance: balance.balance,
            tokens: balance.tokens || [],
          },
        };
      } catch (error) {
        return {
          success: false,
          error: `Failed to get balance: ${error instanceof Error ? error.message : 'Unknown error'}`,
        };
      }
    },
  }),
];

export default createWalletTools;
