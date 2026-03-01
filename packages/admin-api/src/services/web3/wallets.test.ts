/**
 * Wallet Service Tests
 * Tests wallet listing and balance checking with dependency injection
 *
 * Note: Wallet generation tests were removed when custodial wallet
 * generation was deprecated (#608). See wallets.ts deprecation notice.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getSolanaBalance,
  getEthereumBalance,
  listWallets,
  type WalletServiceDeps,
} from './wallets.js';

// Helper to create mock deps
function createMockDeps(): WalletServiceDeps {
  const mockGetBalance = vi.fn(() => Promise.resolve(1000000000)); // 1 SOL
  const mockGetParsedTokenAccounts = vi.fn(() => Promise.resolve({ value: [] }));
  const mockEthGetBalance = vi.fn(() => Promise.resolve(BigInt('1000000000000000000'))); // 1 ETH

  return {
    dynamoClient: {
      send: vi.fn(() => Promise.resolve({})) as unknown as WalletServiceDeps['dynamoClient']['send'],
    },
    solana: {
      Connection: class MockConnection {
        getBalance = mockGetBalance;
        getParsedTokenAccountsByOwner = mockGetParsedTokenAccounts;
      } as unknown as WalletServiceDeps['solana']['Connection'],
      PublicKey: class MockPublicKey {
        private _key: string;
        constructor(value: string | Buffer | Uint8Array) {
          this._key = typeof value === 'string' ? value : 'mock-public-key';
        }
        toBase58(): string {
          return this._key;
        }
      } as unknown as WalletServiceDeps['solana']['PublicKey'],
      LAMPORTS_PER_SOL: 1000000000,
    },
    ethereum: {
      JsonRpcProvider: class MockProvider {
        getBalance = mockEthGetBalance;
      } as unknown as WalletServiceDeps['ethereum']['JsonRpcProvider'],
      formatEther: (val: bigint) => (Number(val) / 1e18).toString(),
    },
    secrets: {
      _getSecretValueInternal: vi.fn(() => Promise.resolve(null)) as unknown as WalletServiceDeps['secrets']['_getSecretValueInternal'],
    },
    tableName: 'test-admin-table',
    solanaRpcUrl: 'https://api.mainnet-beta.solana.com',
    ethereumRpcUrl: 'https://cloudflare-eth.com',
  };
}

describe('WalletService', () => {
  let mockDeps: WalletServiceDeps;

  beforeEach(() => {
    mockDeps = createMockDeps();
  });

  describe('getSolanaBalance', () => {
    it('returns balance from Solana connection', async () => {
      const pubkey = '11111111111111111111111111111111';
      const balance = await getSolanaBalance(pubkey, undefined, mockDeps);

      expect(balance.solBalance).toBe(1);
      expect(balance.publicKey).toBe(pubkey);
      expect(balance.chain).toBe('solana');
    });

    it('includes balance in multiple formats', async () => {
      const balance = await getSolanaBalance('test-key', undefined, mockDeps);

      expect(balance.balance).toBe(1);
      expect(balance.balanceRaw).toBe('1000000000');
      expect(balance.solBalanceLamports).toBe(1000000000);
    });
  });

  describe('getEthereumBalance', () => {
    it('returns balance from Ethereum provider', async () => {
      const balance = await getEthereumBalance('0x123', undefined, mockDeps);

      expect(balance.balance).toBe(1);
      expect(balance.address).toBe('0x123');
      expect(balance.chain).toBe('ethereum');
    });

    it('includes balance in multiple formats', async () => {
      const balance = await getEthereumBalance('0x123', undefined, mockDeps);

      expect(balance.ethBalance).toBe(1);
      expect(balance.balanceRaw).toBe('1000000000000000000');
      expect(balance.ethBalanceWei).toBe('1000000000000000000');
    });
  });

  describe('listWallets', () => {
    it('queries DynamoDB for avatar wallets', async () => {
      (mockDeps.dynamoClient.send as ReturnType<typeof vi.fn>).mockImplementation(() =>
        Promise.resolve({
          Items: [
            { id: 'a1-solana-main', avatarId: 'a1', publicKey: 'p1', walletType: 'solana', address: 'p1', name: 'main', createdAt: 1000, createdBy: 'test@example.com' },
          ],
        })
      );

      const wallets = await listWallets('a1', mockDeps);

      expect(wallets).toHaveLength(1);
      expect(wallets[0].publicKey).toBe('p1');
      expect(wallets[0].walletType).toBe('solana');
    });

    it('returns empty array when no avatarId provided', async () => {
      const wallets = await listWallets(undefined, mockDeps);
      expect(wallets).toHaveLength(0);
    });

    it('returns empty array when no wallets found', async () => {
      (mockDeps.dynamoClient.send as ReturnType<typeof vi.fn>).mockImplementation(() =>
        Promise.resolve({ Items: [] })
      );

      const wallets = await listWallets('a1', mockDeps);
      expect(wallets).toHaveLength(0);
    });
  });
});
