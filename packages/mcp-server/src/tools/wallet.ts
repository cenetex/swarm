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
  walletType: 'solana';
  solBalance?: number | null;
}

export interface WalletServices {
  listWallets: (agentId: string) => Promise<WalletInfo[]>;
  
  createWallet: (agentId: string, name: string) => Promise<{
    publicKey: string;
    address: string;
  }>;
  
  getBalance: (publicKey: string, agentId: string) => Promise<{
    solBalance: number;
    tokens?: Array<{ mint: string; balance: number }>;
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
    const balance = w.solBalance != null ? ` (${w.solBalance.toFixed(2)} SOL)` : '';
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
      const wallets = await services.listWallets(context.agentId);

      // Enrich with balances
      const enriched = await Promise.all(
        wallets.map(async (w) => {
          try {
            const balance = await services.getBalance(w.publicKey, context.agentId);
            return { ...w, solBalance: balance.solBalance };
          } catch {
            return { ...w, solBalance: null };
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
    platforms: ['admin-ui', 'api'], // Not exposed to Telegram for security
    inputSchema: z.object({
      name: z.string().min(1).describe('A friendly name for this wallet'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      const result = await services.createWallet(context.agentId, input.name);

      return {
        success: true,
        data: {
          message: `Wallet "${input.name}" created!`,
          publicKey: result.publicKey,
          address: result.address,
        },
      };
    },
  }),

  defineTool({
    name: 'get_wallet_balance',
    description: 'Get the balance of a specific wallet.',
    category: 'wallet',
    inputSchema: z.object({
      publicKey: z.string().describe('The wallet public key to check'),
    }),
    execute: async (input, context): Promise<ToolResult> => {
      try {
        const balance = await services.getBalance(input.publicKey, context.agentId);
        return {
          success: true,
          data: {
            publicKey: input.publicKey,
            solBalance: balance.solBalance,
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
