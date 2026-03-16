/**
 * Wallet Tools
 * 
 * Tools for managing Solana wallets.
 */
import { z } from 'zod';
import { defineTool, withTaskAction, type ToolResult } from '../registry.js';

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

export interface WalletServices {
  listWallets: (avatarId: string) => Promise<WalletInfo[]>;

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

      return withTaskAction(
        {
          success: true,
          data: enriched,
        },
        {
          task: {
            type: 'wallet_link',
            title: 'Wallet Overview',
            summary: enriched.length > 0
              ? `${enriched.length} wallet${enriched.length !== 1 ? 's' : ''}`
              : 'No wallets found',
            props: { wallets: enriched },
          },
          workspace: {
            focus: false,
            surface: 'side_panel',
          },
        },
      );
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
