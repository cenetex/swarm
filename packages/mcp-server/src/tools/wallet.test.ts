/**
 * Wallet Tools Tests
 *
 * Tests for Solana wallet management tools.
 * Note: Wallet creation tool tests removed — custodial generation deprecated (#608).
 */
import { describe, it, expect } from 'vitest';
import { createWalletTools, type WalletServices } from './wallet.js';

const mockWalletServices: WalletServices = {
  listWallets: async (avatarId: string) => {
    if (avatarId === 'empty') return [];
    return [
      {
        name: 'Main Wallet',
        publicKey: 'RATi7Nx8K2YQhNea5qV3HqHqYfqWvYzwmK8L9VU4pump',
        walletType: 'solana',
        solBalance: 1.5,
      },
      {
        name: 'Trading Wallet',
        publicKey: 'PUMP4K2YQhNea5qV3HqHqYfqWvYzwmK8L9VU4ratz',
        walletType: 'solana',
        solBalance: 0.25,
      },
    ];
  },

  getBalance: async (publicKey: string, _avatarId: string, chain?: string) => {
    const balances: Record<string, number> = {
      'RATi7Nx8K2YQhNea5qV3HqHqYfqWvYzwmK8L9VU4pump': 1.5,
      'PUMP4K2YQhNea5qV3HqHqYfqWvYzwmK8L9VU4ratz': 0.25,
    };
    return {
      balance: balances[publicKey] || 0,
      chain: chain || 'solana',
      solBalance: chain === 'solana' ? balances[publicKey] : undefined,
    };
  },
};

describe('Wallet Tools - get_my_wallets', () => {
  it('returns list of wallets with balances', async () => {
    const tools = createWalletTools(mockWalletServices);
    const tool = tools.find(t => t.name === 'get_my_wallets');
    expect(tool).toBeDefined();

    const result = await (tool!.execute as any)({}, {
      avatarId: 'test',
      platform: 'admin-ui',
    });

    expect(result.success).toBe(true);
    expect(result.data).toBeInstanceOf(Array);
    expect(result.data.length).toBe(2);
    expect(result.data[0]).toHaveProperty('name', 'Main Wallet');
    expect(result.data[0]).toHaveProperty('solBalance', 1.5);
  });

  it('returns empty array when no wallets exist', async () => {
    const tools = createWalletTools(mockWalletServices);
    const tool = tools.find(t => t.name === 'get_my_wallets');

    const result = await (tool!.execute as any)({}, {
      avatarId: 'empty',
      platform: 'admin-ui',
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
  });

  it('enriches wallet data with current balances', async () => {
    const tools = createWalletTools(mockWalletServices);
    const tool = tools.find(t => t.name === 'get_my_wallets');

    const result = await (tool!.execute as any)({}, {
      avatarId: 'test',
      platform: 'admin-ui',
    });

    expect(result.success).toBe(true);
    expect(result.data[0].balance).toBeDefined();
  });

  it('has correct category and description', () => {
    const tools = createWalletTools(mockWalletServices);
    const tool = tools.find(t => t.name === 'get_my_wallets');

    expect(tool?.category).toBe('wallet');
    expect(tool?.description).toContain('Solana wallet');
  });
});

describe('Wallet Tools - get_wallet_balance', () => {
  it('exists as a tool', () => {
    const tools = createWalletTools(mockWalletServices);
    const tool = tools.find(t => t.name === 'get_wallet_balance');
    expect(tool).toBeDefined();
  });

  it('requires address parameter', () => {
    const tools = createWalletTools(mockWalletServices);
    const tool = tools.find(t => t.name === 'get_wallet_balance');

    const valid = tool!.inputSchema.safeParse({
      address: 'RATi7Nx8K2YQhNea5qV3HqHqYfqWvYzwmK8L9VU4pump',
    });
    const missing = tool!.inputSchema.safeParse({});

    expect(valid.success).toBe(true);
    expect(missing.success).toBe(false);
  });

  it('has optional chain parameter with default', () => {
    const tools = createWalletTools(mockWalletServices);
    const tool = tools.find(t => t.name === 'get_wallet_balance');

    const withChain = tool!.inputSchema.safeParse({
      address: 'test',
      chain: 'ethereum',
    });
    const withoutChain = tool!.inputSchema.safeParse({
      address: 'test',
    });

    expect(withChain.success).toBe(true);
    expect(withoutChain.success).toBe(true);

    // Check default is applied
    const parsed = tool!.inputSchema.parse({ address: 'test' });
    expect(parsed.chain).toBe('solana');
  });
});

describe('Wallet Tools - Context Builder', () => {
  it('builds context for wallets', async () => {
    const tools = createWalletTools(mockWalletServices);
    const tool = tools.find(t => t.name === 'get_my_wallets');

    expect(tool?.contextBuilder).toBeDefined();

    const context = await tool!.contextBuilder!({
      avatarId: 'test',
      platform: 'admin-ui',
    });

    expect(context).toContain('My wallets');
  });

  it('shows "No wallets" message when empty', async () => {
    const tools = createWalletTools(mockWalletServices);
    const tool = tools.find(t => t.name === 'get_my_wallets');

    const context = await tool!.contextBuilder!({
      avatarId: 'empty',
      platform: 'admin-ui',
    });

    expect(context).toBe('No wallets created yet');
  });

  it('shows wallet summaries with balances', async () => {
    const tools = createWalletTools(mockWalletServices);
    const tool = tools.find(t => t.name === 'get_my_wallets');

    const context = await tool!.contextBuilder!({
      avatarId: 'test',
      platform: 'admin-ui',
    });

    expect(context).toContain('SOL');
    expect(context).toContain('Main Wallet');
  });
});

describe('Wallet Tools - Service Interface', () => {
  it('all tools use the service interface correctly', () => {
    const tools = createWalletTools(mockWalletServices);

    expect(tools.length).toBeGreaterThan(0);
    tools.forEach(tool => {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toBeDefined();
    });
  });

  it('wallet tools have wallet category', () => {
    const tools = createWalletTools(mockWalletServices);
    const walletTools = tools.filter(t => t.category === 'wallet');

    expect(walletTools.length).toBeGreaterThan(0);
  });
});
