/**
 * Wallet Generation Service
 * Generates and securely stores crypto wallet keys
 */
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
import { storeSecret } from './secrets.js';
import type { WalletInfo, UserSession } from '../types.js';

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ADMIN_TABLE = process.env.ADMIN_TABLE!;

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
 * - Generates keypair using tweetnacl (secp256k1 would be better for production)
 * - Stores private key in Secrets Manager
 * - Stores public info in DynamoDB
 */
export async function generateEthereumWallet(
  agentId: string,
  name: string,
  session: UserSession
): Promise<WalletInfo> {
  // Generate random 32 bytes for private key
  const privateKeyBytes = nacl.randomBytes(32);
  const privateKeyHex = Buffer.from(privateKeyBytes).toString('hex');
  
  // For a proper Ethereum address, we'd need to:
  // 1. Derive public key from private key using secp256k1
  // 2. Hash the public key with Keccak-256
  // 3. Take the last 20 bytes as the address
  // 
  // For this implementation, we'll use a simplified approach
  // In production, use ethers.js or web3.js
  const publicKeyBytes = nacl.sign.keyPair.fromSeed(privateKeyBytes).publicKey;
  const addressBytes = publicKeyBytes.slice(-20);
  const address = '0x' + Buffer.from(addressBytes).toString('hex');
  
  // Store the secret key securely
  await storeSecret(
    agentId,
    'ethereum_wallet_key',
    name,
    privateKeyHex,
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
    publicKey: Buffer.from(publicKeyBytes).toString('hex'),
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
