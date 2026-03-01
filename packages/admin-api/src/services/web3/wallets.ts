/**
 * Wallet Service
 *
 * DEPRECATION NOTICE: Custodial wallet generation (generateSolanaWallet,
 * generateEthereumWallet, generateVanityWallet) was removed in #608 to
 * eliminate custody liability. Users should connect their own wallets
 * via Sign-In With Solana (SIWS) instead. See #604 for background.
 *
 * Remaining functionality: list wallets, get wallet, check balances.
 */
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { JsonRpcProvider, formatEther } from 'ethers';
import {
  QueryCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
import { _getSecretValueInternal as _getSecretValueInternalDefault } from '../secrets.js';
import type { WalletInfo } from '../../types.js';
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Connection: any;
    PublicKey: new (value: string | Buffer | Uint8Array) => {
      toBase58: () => string;
    };
    LAMPORTS_PER_SOL: number;
  };
  ethereum: {
    JsonRpcProvider: new (url: string) => {
      getBalance: (address: string) => Promise<bigint>;
    };
    formatEther: (value: bigint) => string;
  };
  secrets: {
    _getSecretValueInternal: typeof _getSecretValueInternalDefault;
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
    Connection,
    PublicKey,
    LAMPORTS_PER_SOL,
  },
  ethereum: {
    JsonRpcProvider,
    formatEther,
  },
  secrets: {
    _getSecretValueInternal: _getSecretValueInternalDefault,
  },
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
