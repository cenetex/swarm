/**
 * Wallet Generation Service
 * Generates and securely stores crypto wallet keys
 */
import { Keypair, Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import { Wallet, JsonRpcProvider, formatEther } from 'ethers';
import {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
import { storeSecret, _getSecretValueInternal } from './secrets.js';
import type { WalletInfo, UserSession } from '../types.js';

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const ADMIN_TABLE = process.env.ADMIN_TABLE!;

// Default Solana RPC - agent can configure their own Helius key
const DEFAULT_SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

// Default Ethereum RPC
const DEFAULT_ETHEREUM_RPC = process.env.ETHEREUM_RPC_URL || 'https://cloudflare-eth.com';

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
 * Get Solana RPC URL for an agent
 * Uses agent's Helius API key if configured, otherwise default
 */
async function getSolanaRpcUrl(agentId?: string): Promise<string> {
  if (agentId) {
    const heliusKey = await _getSecretValueInternal(agentId, 'helius_api_key', 'default');
    if (heliusKey) {
      return `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;
    }
  }
  return DEFAULT_SOLANA_RPC;
}

/**
 * Generate a new Solana wallet
 * - Generates keypair securely
 * - Stores private key in Secrets Manager
 * - Stores public info in DynamoDB
 */
export async function generateSolanaWallet(
  agentId: string,
  name: string,
  session: UserSession
): Promise<WalletInfo> {
  // Generate new keypair
  const keypair = Keypair.generate();
  
  // Convert secret key to base58 for storage
  const secretKeyBase58 = bs58.encode(keypair.secretKey);
  const publicKey = keypair.publicKey.toBase58();
  
  // Store the secret key securely
  await storeSecret(
    agentId,
    'solana_wallet_key',
    name,
    secretKeyBase58,
    session,
    `Solana wallet "${name}" for agent ${agentId}`
  );
  
  // Create wallet info record
  const walletId = `${agentId}-solana-${name}`;
  const now = Date.now();
  
  const walletInfo: WalletInfo & { pk: string; sk: string } = {
    pk: `AGENT#${agentId}`,
    sk: `WALLET#solana#${name}`,
    id: walletId,
    agentId,
    walletType: 'solana',
    publicKey,
    address: publicKey, // Solana uses public key as address
    name,
    createdAt: now,
    createdBy: session.email,
  };
  
  // Store wallet info in DynamoDB
  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: walletInfo,
  }));
  
  return {
    id: walletInfo.id,
    agentId: walletInfo.agentId,
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
  agentId: string,
  name: string,
  session: UserSession
): Promise<WalletInfo> {
  // Generate random wallet
  const wallet = Wallet.createRandom();
  const address = wallet.address;
  const privateKey = wallet.privateKey;

  // Store the private key securely
  await storeSecret(
    agentId,
    'ethereum_wallet_key',
    name,
    privateKey,
    session,
    `Ethereum wallet "${name}" for agent ${agentId}`
  );

  // Create wallet info record
  const walletId = `${agentId}-ethereum-${name}`;
  const now = Date.now();

  const walletInfo: WalletInfo & { pk: string; sk: string } = {
    pk: `AGENT#${agentId}`,
    sk: `WALLET#ethereum#${name}`,
    id: walletId,
    agentId,
    walletType: 'ethereum',
    publicKey: address,
    address,
    name,
    createdAt: now,
    createdBy: session.email,
  };

  // Store wallet info in DynamoDB
  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: walletInfo,
  }));

  return {
    id: walletInfo.id,
    agentId: walletInfo.agentId,
    walletType: walletInfo.walletType,
    publicKey: walletInfo.publicKey,
    address: walletInfo.address,
    name: walletInfo.name,
    createdAt: walletInfo.createdAt,
    createdBy: walletInfo.createdBy,
  };
}

/**
 * List wallets for an agent
 */
export async function listWallets(agentId?: string): Promise<WalletInfo[]> {
  if (agentId) {
    const result = await dynamoClient.send(new QueryCommand({
      TableName: ADMIN_TABLE,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
      ExpressionAttributeValues: {
        ':pk': `AGENT#${agentId}`,
        ':sk': 'WALLET#',
      },
    }));
    
    return (result.Items || []).map(item => ({
      id: item.id,
      agentId: item.agentId,
      walletType: item.walletType,
      publicKey: item.publicKey,
      address: item.address,
      name: item.name,
      createdAt: item.createdAt,
      createdBy: item.createdBy,
    }));
  }
  
  // For all wallets, we'd need a GSI or scan
  // For now, return empty when no agentId
  return [];
}

/**
 * Get a specific wallet
 */
export async function getWallet(walletId: string): Promise<WalletInfo | null> {
  // Parse wallet ID to get agentId and wallet info
  const parts = walletId.split('-');
  if (parts.length < 3) return null;
  
  const [agentId, walletType, ...nameParts] = parts;
  const name = nameParts.join('-');
  
  const result = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: `AGENT#${agentId}`,
      sk: `WALLET#${walletType}#${name}`,
    },
  }));
  
  if (!result.Item) return null;
  
  return {
    id: result.Item.id,
    agentId: result.Item.agentId,
    walletType: result.Item.walletType,
    publicKey: result.Item.publicKey,
    address: result.Item.address,
    name: result.Item.name,
    createdAt: result.Item.createdAt,
    createdBy: result.Item.createdBy,
  };
}

/**
 * Get Solana wallet balance (SOL and tokens)
 */
export async function getSolanaBalance(publicKeyStr: string, agentId?: string): Promise<WalletBalance> {
  const rpcUrl = await getSolanaRpcUrl(agentId);
  const connection = new Connection(rpcUrl, 'confirmed');
  const publicKey = new PublicKey(publicKeyStr);
  
  // Get SOL balance
  const balanceLamports = await connection.getBalance(publicKey);
  const balanceSol = balanceLamports / LAMPORTS_PER_SOL;
  
  // Get token accounts
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(publicKey, {
    programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
  });
  
  const tokens = tokenAccounts.value.map(account => {
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
export async function getEthereumBalance(address: string, _agentId?: string): Promise<WalletBalance> {
  const rpcUrl = DEFAULT_ETHEREUM_RPC;
  const provider = new JsonRpcProvider(rpcUrl);

  const balanceWei = await provider.getBalance(address);
  const balanceEth = parseFloat(formatEther(balanceWei));

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
