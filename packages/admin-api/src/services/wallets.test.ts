/**
 * Wallet Service Tests
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

// Mock AWS
vi.mock('@aws-sdk/lib-dynamodb', () => {
  const mockSend = vi.fn();
  return {
    DynamoDBDocumentClient: {
      from: vi.fn(() => ({
        send: mockSend
      }))
    },
    PutCommand: vi.fn(),
    GetCommand: vi.fn(),
    QueryCommand: vi.fn(),
  };
});

// Mock Secrets
vi.mock('./secrets.js', () => ({
  storeSecret: vi.fn(),
  _getSecretValueInternal: vi.fn(),
}));

// Mock Solana
vi.mock('@solana/web3.js', () => {
  // Mock PublicKey class
  class MockPublicKey {
    private _key: Buffer;
    constructor(value: Buffer | Uint8Array | string) {
      if (typeof value === 'string') {
        this._key = Buffer.from(value, 'base64');
      } else {
        this._key = Buffer.from(value);
      }
    }
    toBase58(): string {
      return '11111111111111111111111111111111';
    }
    toBuffer(): Buffer {
      return this._key;
    }
  }
  return {
    PublicKey: MockPublicKey,
    Keypair: {
      generate: vi.fn(() => ({
        publicKey: new MockPublicKey(Buffer.alloc(32)),
        secretKey: new Uint8Array(64),
      })),
    },
    Connection: vi.fn(() => ({
      getBalance: vi.fn().mockResolvedValue(1000000000), // 1 SOL
      getParsedTokenAccountsByOwner: vi.fn().mockResolvedValue({ value: [] }),
    })),
    LAMPORTS_PER_SOL: 1000000000,
  };
});

// Mock Ethers
vi.mock('ethers', () => ({
  Wallet: {
    createRandom: vi.fn(() => ({
      address: '0x123',
      privateKey: '0xabc',
    })),
  },
  JsonRpcProvider: vi.fn(() => ({
    getBalance: vi.fn().mockResolvedValue(BigInt('1000000000000000000')), // 1 ETH
  })),
  formatEther: vi.fn((val) => (Number(val) / 1e18).toString()),
}));

let generateSolanaWallet: typeof import('./wallets.js').generateSolanaWallet;
let generateEthereumWallet: typeof import('./wallets.js').generateEthereumWallet;
let getSolanaBalance: typeof import('./wallets.js').getSolanaBalance;
let getEthereumBalance: typeof import('./wallets.js').getEthereumBalance;
let listWallets: typeof import('./wallets.js').listWallets;
let storeSecret: typeof import('./secrets.js').storeSecret;
let DynamoDBDocumentClient: typeof import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient;
let PutCommand: typeof import('@aws-sdk/lib-dynamodb').PutCommand;
let PublicKey: typeof import('@solana/web3.js').PublicKey;
let mockDynamo: any;

beforeAll(async () => {
  ({ generateSolanaWallet, generateEthereumWallet, getSolanaBalance, getEthereumBalance, listWallets } = await import('./wallets.js'));
  ({ storeSecret } = await import('./secrets.js'));
  ({ DynamoDBDocumentClient, PutCommand } = await import('@aws-sdk/lib-dynamodb'));
  ({ PublicKey } = await import('@solana/web3.js'));
});

describe('WalletService', () => {
  const session = { email: 'test@example.com' } as any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDynamo = (DynamoDBDocumentClient.from as any)().send;
  });

  describe('generateSolanaWallet', () => {
    it('generates a keypair and stores it', async () => {
      mockDynamo.mockResolvedValue({});
      
      const wallet = await generateSolanaWallet('agent-1', 'main', session);
      
      expect(wallet.publicKey).toBeDefined();
      expect(wallet.walletType).toBe('solana');
      expect(storeSecret).toHaveBeenCalled();
      expect(mockDynamo).toHaveBeenCalledWith(expect.any(PutCommand));
    });
  });

  describe('getSolanaBalance', () => {
    it('returns balance from Solana connection', async () => {
      const pubkey = new PublicKey(Buffer.alloc(32)).toBase58();
      const balance = await getSolanaBalance(pubkey);
      
      expect(balance.solBalance).toBe(1);
      expect(balance.publicKey).toBe(pubkey);
    });
  });

  describe('generateEthereumWallet', () => {
    it('generates a wallet and stores it', async () => {
      mockDynamo.mockResolvedValue({});
      
      const wallet = await generateEthereumWallet('agent-1', 'main', session);
      
      expect(wallet.address).toBe('0x123');
      expect(wallet.walletType).toBe('ethereum');
      expect(storeSecret).toHaveBeenCalled();
      expect(mockDynamo).toHaveBeenCalledWith(expect.any(PutCommand));
    });
  });

  describe('getEthereumBalance', () => {
    it('returns balance from Ethers connection', async () => {
      const balance = await getEthereumBalance('0x123');
      
      expect(balance.balance).toBe(1);
      expect(balance.address).toBe('0x123');
      expect(balance.chain).toBe('ethereum');
    });
  });

  describe('listWallets', () => {
    it('queries DynamoDB for agent wallets', async () => {
      mockDynamo.mockResolvedValue({
        Items: [
          { agentId: 'a1', publicKey: 'p1', chain: 'solana' }
        ]
      });

      const wallets = await listWallets('a1');
      expect(wallets).toHaveLength(1);
      expect(wallets[0].publicKey).toBe('p1');
    });
  });
});
