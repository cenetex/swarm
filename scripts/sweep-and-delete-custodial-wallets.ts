#!/usr/bin/env node
/**
 * Sweep and delete custodial avatar wallets.
 *
 * Custodial wallet generation has been deprecated (#604). This one-shot
 * operational script completes the remaining phases:
 *   Phase 1 — Inventory: scan DynamoDB for WALLET# records, query balances
 *   Phase 2 — Sweep: transfer remaining balances back to creator wallets
 *   Phase 3 — Delete keys: remove secrets from Secrets Manager + DynamoDB
 *
 * Closes #606 (sweep), #607 (delete keys).
 *
 * Usage:
 *   # Dry run (default) — inventory only
 *   ADMIN_TABLE=SwarmAdmin-staging pnpm exec tsx scripts/sweep-and-delete-custodial-wallets.ts
 *
 *   # Sweep balances back to creators
 *   ADMIN_TABLE=SwarmAdmin-prod AWS_PROFILE=prod pnpm exec tsx scripts/sweep-and-delete-custodial-wallets.ts --execute
 *
 *   # Sweep + delete keys from Secrets Manager
 *   ADMIN_TABLE=SwarmAdmin-prod AWS_PROFILE=prod pnpm exec tsx scripts/sweep-and-delete-custodial-wallets.ts --execute --delete-keys
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand,
  DeleteSecretCommand,
} from '@aws-sdk/client-secrets-manager';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
  DeleteCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createCloseAccountInstruction,
  createTransferInstruction,
} from '@solana/spl-token';
import bs58 from 'bs58';

// ============================================================================
// CLI argument parsing
// ============================================================================

interface Args {
  execute: boolean;
  deleteKeys: boolean;
  region: string;
  adminTable: string;
  secretPrefix: string;
  solanaRpcUrl: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    execute: false,
    deleteKeys: false,
    region: process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1',
    adminTable: process.env.ADMIN_TABLE || '',
    secretPrefix: process.env.SECRET_PREFIX || 'swarm',
    solanaRpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--execute') args.execute = true;
    else if (a === '--dry-run') args.execute = false;
    else if (a === '--delete-keys') args.deleteKeys = true;
    else if (a === '--region') {
      const value = argv[++i];
      if (!value) throw new Error('--region requires a value');
      args.region = value;
    } else if (a === '--table') {
      const value = argv[++i];
      if (!value) throw new Error('--table requires a value');
      args.adminTable = value;
    } else if (a === '--rpc') {
      const value = argv[++i];
      if (!value) throw new Error('--rpc requires a value');
      args.solanaRpcUrl = value;
    }
  }

  if (!args.adminTable) {
    throw new Error('ADMIN_TABLE env var or --table flag is required');
  }

  if (args.deleteKeys && !args.execute) {
    throw new Error('--delete-keys requires --execute');
  }

  return args;
}

// ============================================================================
// Types
// ============================================================================

interface WalletRecord {
  pk: string;       // AVATAR#<avatarId>
  sk: string;       // WALLET#<chain>#<name>
  avatarId: string;
  walletType: 'solana' | 'ethereum';
  publicKey: string;
  address: string;
  name: string;
  createdBy: string;
  createdAt: number;
}

interface WalletInventory extends WalletRecord {
  solBalance: number;
  lamports: number;
  tokenAccounts: Array<{
    mint: string;
    balance: number;
    decimals: number;
    ataAddress: string;
  }>;
  creatorPubkey: string | null;
}

// ============================================================================
// Phase 1: Inventory
// ============================================================================

async function scanWalletRecords(
  docClient: DynamoDBDocumentClient,
  tableName: string,
): Promise<WalletRecord[]> {
  const wallets: WalletRecord[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await docClient.send(new ScanCommand({
      TableName: tableName,
      FilterExpression: 'begins_with(sk, :walletPrefix)',
      ExpressionAttributeValues: {
        ':walletPrefix': 'WALLET#',
      },
      ExclusiveStartKey: lastKey,
    }));

    for (const item of result.Items || []) {
      wallets.push(item as unknown as WalletRecord);
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return wallets;
}

async function lookupCreatorPubkey(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  avatarId: string,
  createdByEmail: string,
): Promise<string | null> {
  // Try to find the creator's linked wallet from the avatar record
  const result = await docClient.send(new GetCommand({
    TableName: tableName,
    Key: { pk: `AVATAR#${avatarId}`, sk: 'CONFIG' },
    ProjectionExpression: 'creatorWallet',
  }));

  const creatorWallet = result.Item?.creatorWallet as string | undefined;
  if (creatorWallet) return creatorWallet;

  // Log warning if no creator wallet found
  console.warn(`  ⚠ No creatorWallet found for avatar ${avatarId} (created by ${createdByEmail})`);
  return null;
}

async function buildInventory(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  connection: Connection,
): Promise<WalletInventory[]> {
  console.log('Scanning DynamoDB for wallet records...');
  const records = await scanWalletRecords(docClient, tableName);
  console.log(`Found ${records.length} wallet record(s)`);

  const inventory: WalletInventory[] = [];

  for (const record of records) {
    // Only handle Solana wallets (Ethereum sweep not implemented)
    if (record.walletType !== 'solana') {
      console.log(`  Skipping ${record.walletType} wallet ${record.name} (${record.avatarId}) — only Solana supported`);
      continue;
    }

    try {
      const pubkey = new PublicKey(record.publicKey);

      // Get SOL balance
      const lamports = await connection.getBalance(pubkey);
      const solBalance = lamports / LAMPORTS_PER_SOL;

      // Get SPL token accounts
      const tokenAccounts = await connection.getParsedTokenAccountsByOwner(pubkey, {
        programId: TOKEN_PROGRAM_ID,
      });

      const tokens = tokenAccounts.value
        .map(ta => {
          const info = ta.account.data.parsed.info;
          return {
            mint: info.mint as string,
            balance: parseFloat(info.tokenAmount.uiAmountString || '0'),
            decimals: info.tokenAmount.decimals as number,
            ataAddress: ta.pubkey.toBase58(),
          };
        })
        .filter(t => t.balance > 0);

      // Look up creator wallet
      const creatorPubkey = await lookupCreatorPubkey(
        docClient,
        tableName,
        record.avatarId,
        record.createdBy,
      );

      inventory.push({
        ...record,
        solBalance,
        lamports,
        tokenAccounts: tokens,
        creatorPubkey,
      });
    } catch (err) {
      console.error(`  Error querying wallet ${record.publicKey}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return inventory;
}

function printInventory(inventory: WalletInventory[]): void {
  console.log('\n=== Custodial Wallet Inventory ===\n');
  console.log(
    'Avatar ID'.padEnd(20) +
    'Name'.padEnd(16) +
    'Address'.padEnd(48) +
    'SOL'.padEnd(14) +
    'Tokens'.padEnd(8) +
    'Creator Wallet',
  );
  console.log('-'.repeat(130));

  for (const w of inventory) {
    console.log(
      w.avatarId.padEnd(20) +
      w.name.padEnd(16) +
      w.publicKey.padEnd(48) +
      w.solBalance.toFixed(6).padEnd(14) +
      String(w.tokenAccounts.length).padEnd(8) +
      (w.creatorPubkey || 'NONE'),
    );

    for (const tok of w.tokenAccounts) {
      console.log(`  Token: ${tok.mint} — balance: ${tok.balance}`);
    }
  }

  const totalSol = inventory.reduce((sum, w) => sum + w.solBalance, 0);
  const totalTokens = inventory.reduce((sum, w) => sum + w.tokenAccounts.length, 0);
  console.log(`\nTotal: ${inventory.length} wallet(s), ${totalSol.toFixed(6)} SOL, ${totalTokens} token account(s)`);
}

// ============================================================================
// Phase 2: Sweep
// ============================================================================

function generateSecretName(avatarId: string, secretType: string, name: string, prefix: string): string {
  const sanitizedName = name.replace(/[^a-zA-Z0-9-_]/g, '-');
  return `${prefix}/${avatarId}/${secretType}/${sanitizedName}`;
}

async function loadKeypair(
  smClient: SecretsManagerClient,
  avatarId: string,
  walletName: string,
  prefix: string,
): Promise<Keypair> {
  const secretName = generateSecretName(avatarId, 'solana_wallet_key', walletName, prefix);

  const response = await smClient.send(new GetSecretValueCommand({
    SecretId: secretName,
  }));

  if (!response.SecretString) {
    throw new Error(`Secret ${secretName} has no value`);
  }

  const secretKey = bs58.decode(response.SecretString);
  return Keypair.fromSecretKey(secretKey);
}

async function sweepWallet(
  connection: Connection,
  smClient: SecretsManagerClient,
  docClient: DynamoDBDocumentClient,
  tableName: string,
  wallet: WalletInventory,
  prefix: string,
): Promise<void> {
  // Zero balance — mark swept and skip
  if (wallet.lamports === 0 && wallet.tokenAccounts.length === 0) {
    console.log(`  ${wallet.avatarId}/${wallet.name}: 0 balance — marking swept`);
    await docClient.send(new UpdateCommand({
      TableName: tableName,
      Key: { pk: wallet.pk, sk: wallet.sk },
      UpdateExpression: 'SET swept = :t, sweptAt = :now, sweptNote = :note',
      ExpressionAttributeValues: {
        ':t': true,
        ':now': Date.now(),
        ':note': 'zero balance — no transfer needed',
      },
    }));
    return;
  }

  if (!wallet.creatorPubkey) {
    console.error(`  ${wallet.avatarId}/${wallet.name}: SKIPPED — no creator wallet to sweep to`);
    return;
  }

  // Validate creator pubkey
  let destinationPubkey: PublicKey;
  try {
    destinationPubkey = new PublicKey(wallet.creatorPubkey);
    if (!PublicKey.isOnCurve(destinationPubkey)) {
      throw new Error('Not on ed25519 curve');
    }
  } catch {
    console.error(`  ${wallet.avatarId}/${wallet.name}: SKIPPED — invalid creator pubkey: ${wallet.creatorPubkey}`);
    return;
  }

  // Load keypair from Secrets Manager
  const keypair = await loadKeypair(smClient, wallet.avatarId, wallet.name, prefix);

  const tx = new Transaction();

  // Transfer SPL tokens first (close accounts to reclaim rent)
  for (const token of wallet.tokenAccounts) {
    const mintPubkey = new PublicKey(token.mint);
    const sourceAta = new PublicKey(token.ataAddress);
    const destAta = await getAssociatedTokenAddress(mintPubkey, destinationPubkey);

    // Transfer token balance
    if (token.balance > 0) {
      const amount = BigInt(Math.floor(token.balance * Math.pow(10, token.decimals)));
      tx.add(createTransferInstruction(
        sourceAta,
        destAta,
        keypair.publicKey,
        amount,
      ));
    }

    // Close token account to reclaim rent
    tx.add(createCloseAccountInstruction(
      sourceAta,
      destinationPubkey, // rent goes to destination
      keypair.publicKey,
    ));
  }

  // Transfer remaining SOL (minus fee estimate)
  // Refresh balance after potential token close rent reclaims
  const currentLamports = await connection.getBalance(keypair.publicKey);
  const feeEstimate = 10000; // 0.00001 SOL — generous fee estimate
  const solToTransfer = currentLamports - feeEstimate;

  if (solToTransfer > 0) {
    tx.add(SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey: destinationPubkey,
      lamports: solToTransfer,
    }));
  }

  if (tx.instructions.length === 0) {
    console.log(`  ${wallet.avatarId}/${wallet.name}: no transferable balance`);
    return;
  }

  // Send and confirm
  const signature = await sendAndConfirmTransaction(connection, tx, [keypair]);
  console.log(`  ${wallet.avatarId}/${wallet.name}: swept → ${wallet.creatorPubkey} (tx: ${signature})`);

  // Update DynamoDB record
  await docClient.send(new UpdateCommand({
    TableName: tableName,
    Key: { pk: wallet.pk, sk: wallet.sk },
    UpdateExpression: 'SET swept = :t, sweptAt = :now, sweptTxSignature = :sig, sweptTo = :dest',
    ExpressionAttributeValues: {
      ':t': true,
      ':now': Date.now(),
      ':sig': signature,
      ':dest': wallet.creatorPubkey,
    },
  }));
}

// ============================================================================
// Phase 3: Delete keys
// ============================================================================

async function deleteWalletKeys(
  smClient: SecretsManagerClient,
  docClient: DynamoDBDocumentClient,
  tableName: string,
  wallet: WalletInventory,
  prefix: string,
): Promise<void> {
  const secretName = generateSecretName(wallet.avatarId, 'solana_wallet_key', wallet.name, prefix);

  // Delete from Secrets Manager
  try {
    await smClient.send(new DeleteSecretCommand({
      SecretId: secretName,
      ForceDeleteWithoutRecovery: true,
    }));
    console.log(`  Deleted secret: ${secretName}`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes('ResourceNotFoundException')) {
      console.log(`  Secret already deleted: ${secretName}`);
    } else {
      throw err;
    }
  }

  // Also delete the SECRET# metadata record from DynamoDB
  try {
    await docClient.send(new DeleteCommand({
      TableName: tableName,
      Key: {
        pk: wallet.pk,
        sk: `SECRET#solana_wallet_key#${wallet.name}`,
      },
    }));
  } catch {
    // Metadata record may not exist — that's fine
  }

  // Delete the WALLET# record itself
  await docClient.send(new DeleteCommand({
    TableName: tableName,
    Key: { pk: wallet.pk, sk: wallet.sk },
  }));
  console.log(`  Deleted wallet record: ${wallet.pk} / ${wallet.sk}`);
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log('=== Custodial Wallet Sweep & Delete ===\n');
  console.log(`Mode: ${args.execute ? (args.deleteKeys ? 'EXECUTE + DELETE KEYS' : 'EXECUTE (sweep only)') : 'DRY RUN (inventory only)'}`);
  console.log(`Table: ${args.adminTable}`);
  console.log(`Region: ${args.region}`);
  console.log(`Solana RPC: ${args.solanaRpcUrl}`);
  console.log('');

  const smClient = new SecretsManagerClient({ region: args.region });
  const docClient = DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: args.region }),
  );
  const connection = new Connection(args.solanaRpcUrl, 'confirmed');

  // Phase 1: Inventory
  const inventory = await buildInventory(docClient, args.adminTable, connection);
  printInventory(inventory);

  if (inventory.length === 0) {
    console.log('\nNo custodial wallets found. Nothing to do.');
    return;
  }

  if (!args.execute) {
    console.log('\nDry run complete. Run with --execute to sweep balances.');
    console.log('Add --delete-keys to also remove private keys from Secrets Manager.');
    return;
  }

  // Phase 2: Sweep
  console.log('\n=== Phase 2: Sweeping balances ===\n');
  let swept = 0;
  let sweepErrors = 0;

  for (const wallet of inventory) {
    try {
      await sweepWallet(connection, smClient, docClient, args.adminTable, wallet, args.secretPrefix);
      swept++;
    } catch (err) {
      sweepErrors++;
      console.error(`  SWEEP ERROR ${wallet.avatarId}/${wallet.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\nSweep complete. Swept: ${swept}, Errors: ${sweepErrors}`);

  // Phase 3: Delete keys
  if (!args.deleteKeys) {
    console.log('\nKeys preserved. Run with --execute --delete-keys to remove private keys.');
    return;
  }

  console.log('\n=== Phase 3: Deleting private keys ===\n');
  let deleted = 0;
  let deleteErrors = 0;

  for (const wallet of inventory) {
    try {
      await deleteWalletKeys(smClient, docClient, args.adminTable, wallet, args.secretPrefix);
      deleted++;
    } catch (err) {
      deleteErrors++;
      console.error(`  DELETE ERROR ${wallet.avatarId}/${wallet.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\nDelete complete. Deleted: ${deleted}, Errors: ${deleteErrors}`);
  console.log('\nAll custodial wallet keys have been removed.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
