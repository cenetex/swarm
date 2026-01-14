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

export interface WalletServices {
  listWallets: (agentId: string) => Promise<WalletInfo[]>;
  
  createWallet: (agentId: string, name: string, chain?: string) => Promise<{
    publicKey: string;
    address?: string;
    walletType: string;
  }>;
  
  getBalance: (publicKey: string, agentId: string, chain?: string) => Promise<{
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
  agentId: string
): Promise<string | undefined> {
  const wallets = await services.listWallets(agentId);
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
      return buildWalletContext(services, context.agentId);
    },
    execute: async (_input, context): Promise<ToolResult> => {
      const walletsData = await services.listWallets(context.agentId);

      // Enrich with balances
      const enriched = await Promise.all(
        walletsData.map(async (w) => {
          try {
            const balance = await services.getBalance(w.publicKey, context.agentId, w.walletType);
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

  defineTool({
    name: 'create_solana_wallet',
    description: 'Create a new Solana wallet. The private key is stored securely.',
    category: 'wallet',
    platforms: ['admin-ui', 'api'],
    inputSchema: z.object({
      name: z.string().min(1).describe('A friendly name for this wallet'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      const result = await services.createWallet(context.agentId, input.name, 'solana');

      return {
        success: true,
        data: {
          message: `Solana wallet "${input.name}" created!`,
          publicKey: result.publicKey,
          address: result.address,
        },
      };
    },
  }),

  defineTool({
    name: 'create_ethereum_wallet',
    description: 'Create a new Ethereum wallet. The private key is stored securely.',
    category: 'wallet',
    platforms: ['admin-ui', 'api'],
    inputSchema: z.object({
      name: z.string().min(1).describe('A friendly name for this wallet'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      const result = await services.createWallet(context.agentId, input.name, 'ethereum');

      return {
        success: true,
        data: {
          message: `Ethereum wallet "${input.name}" created!`,
          address: result.address,
          publicKey: result.publicKey,
        },
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
        const balance = await services.getBalance(input.address, context.agentId, input.chain);
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
