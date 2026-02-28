/**
 * Wallet Generation Service
 * Generates and securely stores crypto wallet keys
 */
import { Keypair, Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import { Wallet, JsonRpcProvider, formatEther } from 'ethers';
import {
  PutCommand,
  QueryCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
import { storeSecret as storeSecretDefault, _getSecretValueInternal as _getSecretValueInternalDefault } from '../secrets.js';
import type { WalletInfo, UserSession } from '../../types.js';
import { getDynamoClient } from '../dynamo-client.js';

/**
 * Dependencies interface for wallet service (for testing)
 */
export interface WalletServiceDeps {
  dynamoClient: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    send: (command: any) => Promise<any>;
  };
  solana: {
    Keypair: {
      generate: () => {
        publicKey: { toBase58: () => string };
        secretKey: Uint8Array;
      };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Connection: any;
    PublicKey: new (value: string | Buffer | Uint8Array) => {
      toBase58: () => string;
    };
    LAMPORTS_PER_SOL: number;
  };
  ethereum: {
    Wallet: {
      createRandom: () => {
        address: string;
        privateKey: string;
      };
    };
    JsonRpcProvider: new (url: string) => {
      getBalance: (address: string) => Promise<bigint>;
    };
    formatEther: (value: bigint) => string;
  };
  secrets: {
    storeSecret: typeof storeSecretDefault;
    _getSecretValueInternal: typeof _getSecretValueInternalDefault;
  };
  bs58: {
    encode: (source: Uint8Array) => string;
  };
  tableName: string;
  solanaRpcUrl: string;
  ethereumRpcUrl: string;
}

// Default dependencies using real imports
const defaultDynamoClient = getDynamoClient();
const ADMIN_TABLE = process.env.ADMIN_TABLE!;

// Default Solana RPC - avatar can configure their own Helius key
const DEFAULT_SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

// Default Ethereum RPC
const DEFAULT_ETHEREUM_RPC = process.env.ETHEREUM_RPC_URL || 'https://cloudflare-eth.com';

// Default dependencies
const defaultDeps: WalletServiceDeps = {
  dynamoClient: defaultDynamoClient,
  solana: {
    Keypair,
    Connection,
    PublicKey,
    LAMPORTS_PER_SOL,
  },
  ethereum: {
    Wallet,
    JsonRpcProvider,
    formatEther,
  },
  secrets: {
    storeSecret: storeSecretDefault,
    _getSecretValueInternal: _getSecretValueInternalDefault,
  },
  bs58,
  tableName: ADMIN_TABLE,
  solanaRpcUrl: DEFAULT_SOLANA_RPC,
  ethereumRpcUrl: DEFAULT_ETHEREUM_RPC,
};

export interface WalletBalance {
  address: string;
  chain: 'solana' | 'ethereum';
  balance: number;
  balanceRaw: string;
  // Compatibility fields
  publicKey?: string;
  solBalance?: number;
  solBalanceLamports?: number;
  ethBalance?: number;
  ethBalanceWei?: string;
  tokens: Array<{
    mint: string;
    symbol?: string;
    balance: number;
    decimals: number;
  }>;
}

/**
 * Get Solana RPC URL for an avatar
 * Uses avatar's Helius API key if configured, otherwise default
 */
async function getSolanaRpcUrl(avatarId?: string, deps: WalletServiceDeps = defaultDeps): Promise<string> {
  if (avatarId) {
    const heliusKey = await deps.secrets._getSecretValueInternal(avatarId, 'helius_api_key', 'default');
    if (heliusKey) {
      return `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;
    }
  }
  return deps.solanaRpcUrl;
}

/**
 * Generate a new Solana wallet
 * - Generates keypair securely
 * - Stores private key in Secrets Manager
 * - Stores public info in DynamoDB
 */
export async function generateSolanaWallet(
  avatarId: string,
  name: string,
  session: UserSession,
  deps: WalletServiceDeps = defaultDeps
): Promise<WalletInfo> {
  // Generate new keypair
  const keypair = deps.solana.Keypair.generate();

  // Convert secret key to base58 for storage
  const secretKeyBase58 = deps.bs58.encode(keypair.secretKey);
  const publicKey = keypair.publicKey.toBase58();

  // Store the secret key securely
  await deps.secrets.storeSecret(
    avatarId,
    'solana_wallet_key',
    name,
    secretKeyBase58,
    session,
    `Solana wallet "${name}" for avatar ${avatarId}`
  );

  // Create wallet info record
  const walletId = `${avatarId}-solana-${name}`;
  const now = Date.now();

  const walletInfo: WalletInfo & { pk: string; sk: string } = {
    pk: `AVATAR#${avatarId}`,
    sk: `WALLET#solana#${name}`,
    id: walletId,
    avatarId,
    walletType: 'solana',
    publicKey,
    address: publicKey, // Solana uses public key as address
    name,
    createdAt: now,
    createdBy: session.email,
  };

  // Store wallet info in DynamoDB
  await deps.dynamoClient.send(new PutCommand({
    TableName: deps.tableName,
    Item: walletInfo,
  }));

  return {
    id: walletInfo.id,
    avatarId: walletInfo.avatarId,
    walletType: walletInfo.walletType,
    publicKey: walletInfo.publicKey,
    address: walletInfo.address,
    name: walletInfo.name,
    createdAt: walletInfo.createdAt,
    createdBy: walletInfo.createdBy,
  };
}

/**
 * Generate a new Ethereum wallet
 */
export async function generateEthereumWallet(
  avatarId: string,
  name: string,
  session: UserSession,
  deps: WalletServiceDeps = defaultDeps
): Promise<WalletInfo> {
  // Generate random wallet
  const wallet = deps.ethereum.Wallet.createRandom();
  const address = wallet.address;
  const privateKey = wallet.privateKey;

  // Store the private key securely
  await deps.secrets.storeSecret(
    avatarId,
    'ethereum_wallet_key',
    name,
    privateKey,
    session,
    `Ethereum wallet "${name}" for avatar ${avatarId}`
  );

  // Create wallet info record
  const walletId = `${avatarId}-ethereum-${name}`;
  const now = Date.now();

  const walletInfo: WalletInfo & { pk: string; sk: string } = {
    pk: `AVATAR#${avatarId}`,
    sk: `WALLET#ethereum#${name}`,
    id: walletId,
    avatarId,
    walletType: 'ethereum',
    publicKey: address,
    address,
    name,
    createdAt: now,
    createdBy: session.email,
  };

  // Store wallet info in DynamoDB
  await deps.dynamoClient.send(new PutCommand({
    TableName: deps.tableName,
    Item: walletInfo,
  }));

  return {
    id: walletInfo.id,
    avatarId: walletInfo.avatarId,
    walletType: walletInfo.walletType,
    publicKey: walletInfo.publicKey,
    address: walletInfo.address,
    name: walletInfo.name,
    createdAt: walletInfo.createdAt,
    createdBy: walletInfo.createdBy,
  };
}

/**
 * List wallets for an avatar
 */
export async function listWallets(avatarId?: string, deps: WalletServiceDeps = defaultDeps): Promise<WalletInfo[]> {
  if (avatarId) {
    const result = await deps.dynamoClient.send(new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
      ExpressionAttributeValues: {
        ':pk': `AVATAR#${avatarId}`,
        ':sk': 'WALLET#',
      },
    })) as { Items?: Record<string, unknown>[] };

    return (result.Items || []).map((item: Record<string, unknown>) => ({
      id: item.id as string,
      avatarId: item.avatarId as string,
      walletType: item.walletType as 'solana' | 'ethereum',
      publicKey: item.publicKey as string,
      address: item.address as string,
      name: item.name as string,
      createdAt: item.createdAt as number,
      createdBy: item.createdBy as string,
    }));
  }

  // For all wallets, we'd need a GSI or scan
  // For now, return empty when no avatarId
  return [];
}

/**
 * Get a specific wallet
 */
export async function getWallet(walletId: string, deps: WalletServiceDeps = defaultDeps): Promise<WalletInfo | null> {
  // Parse wallet ID to get avatarId and wallet info
  const parts = walletId.split('-');
  if (parts.length < 3) return null;

  const [avatarId, walletType, ...nameParts] = parts;
  const name = nameParts.join('-');

  const result = await deps.dynamoClient.send(new GetCommand({
    TableName: deps.tableName,
    Key: {
      pk: `AVATAR#${avatarId}`,
      sk: `WALLET#${walletType}#${name}`,
    },
  })) as { Item?: Record<string, unknown> };

  if (!result.Item) return null;

  return {
    id: result.Item.id as string,
    avatarId: result.Item.avatarId as string,
    walletType: result.Item.walletType as 'solana' | 'ethereum',
    publicKey: result.Item.publicKey as string,
    address: result.Item.address as string,
    name: result.Item.name as string,
    createdAt: result.Item.createdAt as number,
    createdBy: result.Item.createdBy as string,
  };
}

/**
 * Get Solana wallet balance (SOL and tokens)
 */
export async function getSolanaBalance(publicKeyStr: string, avatarId?: string, deps: WalletServiceDeps = defaultDeps): Promise<WalletBalance> {
  const rpcUrl = await getSolanaRpcUrl(avatarId, deps);
  const connection = new deps.solana.Connection(rpcUrl, 'confirmed');
  const publicKey = new deps.solana.PublicKey(publicKeyStr);

  // Get SOL balance
  const balanceLamports = await connection.getBalance(publicKey);
  const balanceSol = balanceLamports / deps.solana.LAMPORTS_PER_SOL;

  // Get token accounts
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(publicKey, {
    programId: new deps.solana.PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
  });

  const tokens = (tokenAccounts.value as Array<{ account: { data: { parsed: { info: { mint: string; tokenAmount: { uiAmountString?: string; decimals: number } } } } } }>).map(account => {
    const info = account.account.data.parsed.info;
    return {
      mint: info.mint,
      balance: parseFloat(info.tokenAmount.uiAmountString || '0'),
      decimals: info.tokenAmount.decimals,
    };
  }).filter(t => t.balance > 0);

  return {
    address: publicKeyStr,
    chain: 'solana',
    balance: balanceSol,
    balanceRaw: balanceLamports.toString(),
    // Compatibility
    publicKey: publicKeyStr,
    solBalance: balanceSol,
    solBalanceLamports: balanceLamports,
    tokens,
  };
}

/**
 * Get Ethereum wallet balance
 */
export async function getEthereumBalance(address: string, _avatarId?: string, deps: WalletServiceDeps = defaultDeps): Promise<WalletBalance> {
  const rpcUrl = deps.ethereumRpcUrl;
  const provider = new deps.ethereum.JsonRpcProvider(rpcUrl);

  const balanceWei = await provider.getBalance(address);
  const balanceEth = parseFloat(deps.ethereum.formatEther(balanceWei));

  return {
    address,
    chain: 'ethereum',
    balance: balanceEth,
    balanceRaw: balanceWei.toString(),
    // Compatibility
    ethBalance: balanceEth,
    ethBalanceWei: balanceWei.toString(),
    tokens: [], // ERC20 token support can be added later
  };
}

/**
 * Vanity wallet generation result
 */
export interface VanityWalletResult {
  publicKey: string;
  secretKey: string;
  attempts: number;
  elapsedMs: number;
  pattern: string;
  matchStart: boolean;
}

/**
 * Generate a vanity Solana wallet with a specific pattern
 * This is CPU-intensive and may take time depending on pattern complexity
 * 
 * @param pattern - The pattern to search for (e.g., "RATi")
 * @param matchStart - If true, pattern must be at start of address
 * @param maxAttempts - Maximum attempts before giving up (default 10M)
 * @returns VanityWalletResult or null if max attempts exceeded
 */
export async function generateVanityWallet(
  pattern: string,
  matchStart: boolean = false,
  maxAttempts: number = 10_000_000,
  deps: WalletServiceDeps = defaultDeps
): Promise<VanityWalletResult | null> {
  const startTime = Date.now();
  let attempts = 0;
  
  // Validate pattern (Base58 only)
  const BASE58_CHARS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  for (const char of pattern) {
    if (!BASE58_CHARS.includes(char)) {
      throw new Error(`Invalid character '${char}' in pattern. Base58 excludes: 0, O, I, l`);
    }
  }
  
  while (attempts < maxAttempts) {
    attempts++;
    
    const keypair = deps.solana.Keypair.generate();
    const publicKey = keypair.publicKey.toBase58();
    
    const matches = matchStart 
      ? publicKey.startsWith(pattern)
      : publicKey.includes(pattern);
    
    if (matches) {
      return {
        publicKey,
        secretKey: deps.bs58.encode(keypair.secretKey),
        attempts,
        elapsedMs: Date.now() - startTime,
        pattern,
        matchStart,
      };
    }
    
    // Yield occasionally to prevent blocking
    if (attempts % 10000 === 0) {
      await new Promise(resolve => setImmediate(resolve));
    }
  }
  
  return null;
}

/**
 * Generate and save a vanity Solana wallet
 */
export async function generateAndSaveVanityWallet(
  avatarId: string,
  name: string,
  pattern: string,
  matchStart: boolean,
  session: UserSession,
  maxAttempts: number = 10_000_000,
  deps: WalletServiceDeps = defaultDeps
): Promise<WalletInfo & { attempts: number; elapsedMs: number }> {
  // Generate vanity wallet
  const result = await generateVanityWallet(pattern, matchStart, maxAttempts, deps);
  
  if (!result) {
    throw new Error(`Could not find vanity wallet with pattern "${pattern}" in ${maxAttempts.toLocaleString()} attempts`);
  }
  
  // Store the secret key securely
  await deps.secrets.storeSecret(
    avatarId,
    'solana_wallet_key',
    name,
    result.secretKey,
    session,
    `Vanity Solana wallet "${name}" (pattern: ${pattern}) for avatar ${avatarId}`
  );

  // Create wallet info record
  const walletId = `${avatarId}-solana-${name}`;
  const now = Date.now();

  const walletInfo: WalletInfo & { pk: string; sk: string } = {
    pk: `AVATAR#${avatarId}`,
    sk: `WALLET#solana#${name}`,
    id: walletId,
    avatarId,
    walletType: 'solana',
    publicKey: result.publicKey,
    address: result.publicKey,
    name,
    createdAt: now,
    createdBy: session.email,
  };

  // Store wallet info in DynamoDB
  await deps.dynamoClient.send(new PutCommand({
    TableName: deps.tableName,
    Item: walletInfo,
  }));

  return {
    id: walletInfo.id,
    avatarId: walletInfo.avatarId,
    walletType: walletInfo.walletType,
    publicKey: walletInfo.publicKey,
    address: walletInfo.address,
    name: walletInfo.name,
    createdAt: walletInfo.createdAt,
    createdBy: walletInfo.createdBy,
    attempts: result.attempts,
    elapsedMs: result.elapsedMs,
  };
}
