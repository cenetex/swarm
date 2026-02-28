/**
 * Wallet Service Tests
 * Tests wallet generation and balance checking with dependency injection
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  generateSolanaWallet,
  generateEthereumWallet,
  getSolanaBalance,
  getEthereumBalance,
  listWallets,
  type WalletServiceDeps,
} from './wallets.js';
import type { UserSession } from '../../types.js';

// Helper to create mock deps
function createMockDeps(): WalletServiceDeps {
  const mockSend = vi.fn(() => Promise.resolve({}));
  const mockGetBalance = vi.fn(() => Promise.resolve(1000000000)); // 1 SOL
  const mockGetParsedTokenAccounts = vi.fn(() => Promise.resolve({ value: [] }));
  const mockEthGetBalance = vi.fn(() => Promise.resolve(BigInt('1000000000000000000'))); // 1 ETH

  return {
    dynamoClient: {
      send: mockSend as unknown as WalletServiceDeps['dynamoClient']['send'],
    },
    solana: {
      Keypair: {
        generate: () => ({
          publicKey: {
            toBase58: () => '11111111111111111111111111111111',
          },
          secretKey: new Uint8Array(64),
        }),
      },
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
      Wallet: {
        createRandom: () => ({
          address: '0x1234567890123456789012345678901234567890',
          privateKey: '0xabcdef',
        }),
      },
      JsonRpcProvider: class MockProvider {
        getBalance = mockEthGetBalance;
      } as unknown as WalletServiceDeps['ethereum']['JsonRpcProvider'],
      formatEther: (val: bigint) => (Number(val) / 1e18).toString(),
    },
    secrets: {
      storeSecret: vi.fn(() => Promise.resolve()) as unknown as WalletServiceDeps['secrets']['storeSecret'],
      _getSecretValueInternal: vi.fn(() => Promise.resolve(null)) as unknown as WalletServiceDeps['secrets']['_getSecretValueInternal'],
    },
    bs58: {
      encode: () => 'encoded-secret-key',
    },
    tableName: 'test-admin-table',
    solanaRpcUrl: 'https://api.mainnet-beta.solana.com',
    ethereumRpcUrl: 'https://cloudflare-eth.com',
  };
}

// Helper to create test session
function createTestSession(): UserSession {
  return {
    email: 'test@example.com',
    userId: 'user-123',
    isAdmin: true,
    accessToken: 'test-token',
  };
}

describe('WalletService', () => {
  let mockDeps: WalletServiceDeps;
  const session = createTestSession();

  beforeEach(() => {
    mockDeps = createMockDeps();
  });

  describe('generateSolanaWallet', () => {
    it('generates a keypair and stores it', async () => {
      const wallet = await generateSolanaWallet('avatar-1', 'main', session, mockDeps);

      expect(wallet.publicKey).toBeDefined();
      expect(wallet.walletType).toBe('solana');
      expect(wallet.avatarId).toBe('avatar-1');
      expect(wallet.name).toBe('main');
      expect(mockDeps.secrets.storeSecret).toHaveBeenCalled();
      expect(mockDeps.dynamoClient.send).toHaveBeenCalled();
    });

    it('returns correct wallet info structure', async () => {
      const wallet = await generateSolanaWallet('avatar-1', 'trading', session, mockDeps);

      expect(wallet.id).toBe('avatar-1-solana-trading');
      expect(wallet.address).toBe(wallet.publicKey);
      expect(wallet.createdBy).toBe('test@example.com');
      expect(typeof wallet.createdAt).toBe('number');
    });
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

  describe('generateEthereumWallet', () => {
    it('generates a wallet and stores it', async () => {
      const wallet = await generateEthereumWallet('avatar-1', 'main', session, mockDeps);

      expect(wallet.address).toBe('0x1234567890123456789012345678901234567890');
      expect(wallet.walletType).toBe('ethereum');
      expect(mockDeps.secrets.storeSecret).toHaveBeenCalled();
      expect(mockDeps.dynamoClient.send).toHaveBeenCalled();
    });

    it('returns correct wallet info structure', async () => {
      const wallet = await generateEthereumWallet('avatar-1', 'trading', session, mockDeps);

      expect(wallet.id).toBe('avatar-1-ethereum-trading');
      expect(wallet.publicKey).toBe(wallet.address);
      expect(wallet.createdBy).toBe('test@example.com');
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
