import {
  TransactWriteCommand,
} from '@swarm/core';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { createBurnInstruction } from '@solana/spl-token';
import bs58 from 'bs58';

import { _getSecretValueInternal } from '../secrets.js';
import { addEnergyBankCredits } from './energy.js';
import { getDynamoClient } from '../dynamo-client.js';

const ADMIN_TABLE = process.env.ADMIN_TABLE!;

const dynamoClient = getDynamoClient();

export interface BurnToEnergyConfig {
  allowedMints: string[];
  tokensPerEnergyCredit: number;
}

export interface BurnQuote {
  mint: string;
  decimals: number;
  tokensPerEnergyCredit: number;
  availableAmountRaw: bigint;
  burnAmountRaw: bigint;
  energyCredits: number;
  remainderRaw: bigint;
}

export interface BurnToEnergyResult {
  success: boolean;
  avatarId: string;
  mint: string;
  energyCreditsAdded?: number;
  burnAmountRaw?: string;
  signature?: string;
  error?: string;
}

export function getBurnToEnergyConfig(): BurnToEnergyConfig {
  const allowedMints = (process.env.ENERGY_BURN_ALLOWED_MINTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const defaultMint = (process.env.ENERGY_BURN_DEFAULT_MINT || '').trim();
  if (defaultMint && !allowedMints.includes(defaultMint)) {
    allowedMints.unshift(defaultMint);
  }

  const tokensPerEnergyCredit = Number.parseInt(process.env.ENERGY_BURN_RATE || '100', 10);

  return {
    allowedMints,
    tokensPerEnergyCredit: Number.isFinite(tokensPerEnergyCredit) && tokensPerEnergyCredit > 0
      ? tokensPerEnergyCredit
      : 100,
  };
}

export function quoteBurnToEnergy(params: {
  mint: string;
  decimals: number;
  availableAmountRaw: bigint;
  tokensPerEnergyCredit: number;
}): BurnQuote {
  const { mint, decimals, availableAmountRaw, tokensPerEnergyCredit } = params;
  if (tokensPerEnergyCredit <= 0) {
    return {
      mint,
      decimals,
      tokensPerEnergyCredit,
      availableAmountRaw,
      burnAmountRaw: 0n,
      energyCredits: 0,
      remainderRaw: availableAmountRaw,
    };
  }

  const unit = 10n ** BigInt(decimals);
  const requiredRawPerCredit = BigInt(tokensPerEnergyCredit) * unit;
  if (requiredRawPerCredit <= 0n) {
    return {
      mint,
      decimals,
      tokensPerEnergyCredit,
      availableAmountRaw,
      burnAmountRaw: 0n,
      energyCredits: 0,
      remainderRaw: availableAmountRaw,
    };
  }

  const credits = availableAmountRaw / requiredRawPerCredit;
  const burnAmountRaw = credits * requiredRawPerCredit;
  const remainderRaw = availableAmountRaw - burnAmountRaw;

  return {
    mint,
    decimals,
    tokensPerEnergyCredit,
    availableAmountRaw,
    burnAmountRaw,
    energyCredits: Number(credits),
    remainderRaw,
  };
}

async function getSolanaRpcUrlForAvatar(avatarId: string): Promise<string> {
  // Prefer avatar-specific Helius key if configured.
  const heliusKey = await _getSecretValueInternal(avatarId, 'helius_api_key', 'default');
  if (heliusKey) {
    return `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`;
  }

  return process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
}

async function getAvatarSolanaKeypair(avatarId: string): Promise<Keypair> {
  const secret = await _getSecretValueInternal(avatarId, 'solana_wallet_key', 'default');
  if (!secret) {
    throw new Error('Missing solana_wallet_key secret (name=default)');
  }

  const secretBytes = bs58.decode(secret);
  return Keypair.fromSecretKey(secretBytes);
}

async function getTokenAccountsForMint(params: {
  connection: Connection;
  owner: PublicKey;
  mint: PublicKey;
}): Promise<Array<{ tokenAccount: PublicKey; amountRaw: bigint; decimals: number }>> {
  const { connection, owner, mint } = params;

  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(owner, { mint });

  const out: Array<{ tokenAccount: PublicKey; amountRaw: bigint; decimals: number }> = [];
  for (const ta of tokenAccounts.value) {
    const parsed = ta.account.data.parsed;
    const info = parsed?.info;
    const tokenAmount = info?.tokenAmount;
    const amount = tokenAmount?.amount;
    const decimals = tokenAmount?.decimals;

    if (typeof amount !== 'string' || typeof decimals !== 'number') continue;
    const amountRaw = BigInt(amount);
    if (amountRaw <= 0n) continue;

    out.push({ tokenAccount: ta.pubkey, amountRaw, decimals });
  }

  return out;
}

function sumRaw(items: Array<{ amountRaw: bigint }>): bigint {
  return items.reduce((acc, x) => acc + x.amountRaw, 0n);
}

export async function burnDepositedTokensForEnergy(params: {
  avatarId: string;
  mint?: string;
  actorId: string;
}): Promise<BurnToEnergyResult> {
  const { avatarId, mint: requestedMint, actorId } = params;

  const cfg = getBurnToEnergyConfig();
  const mint = requestedMint || cfg.allowedMints[0];
  if (!mint) {
    return {
      success: false,
      avatarId,
      mint: requestedMint || 'unknown',
      error: 'No mint provided and ENERGY_BURN_ALLOWED_MINTS is empty',
    };
  }

  if (cfg.allowedMints.length > 0 && !cfg.allowedMints.includes(mint)) {
    return {
      success: false,
      avatarId,
      mint,
      error: 'Mint not allowed for burn-to-energy',
    };
  }

  let signature: string | undefined;

  try {
    const rpcUrl = await getSolanaRpcUrlForAvatar(avatarId);
    const connection = new Connection(rpcUrl, 'confirmed');
    const keypair = await getAvatarSolanaKeypair(avatarId);

    const mintPubkey = new PublicKey(mint);

    const tokenAccounts = await getTokenAccountsForMint({
      connection,
      owner: keypair.publicKey,
      mint: mintPubkey,
    });

    if (tokenAccounts.length === 0) {
      return { success: true, avatarId, mint, energyCreditsAdded: 0, burnAmountRaw: '0' };
    }

    const decimals = tokenAccounts[0].decimals;
    // If multiple accounts somehow disagree on decimals, prefer the first.
    const availableAmountRaw = sumRaw(tokenAccounts);

    const quote = quoteBurnToEnergy({
      mint,
      decimals,
      availableAmountRaw,
      tokensPerEnergyCredit: cfg.tokensPerEnergyCredit,
    });

    if (quote.energyCredits <= 0 || quote.burnAmountRaw <= 0n) {
      return {
        success: true,
        avatarId,
        mint,
        energyCreditsAdded: 0,
        burnAmountRaw: '0',
      };
    }

    // Build burn tx across token accounts until we cover burnAmountRaw.
    let remaining = quote.burnAmountRaw;
    const transaction = new Transaction();

    for (const acc of tokenAccounts) {
      if (remaining <= 0n) break;
      const take = acc.amountRaw >= remaining ? remaining : acc.amountRaw;
      if (take <= 0n) continue;

      transaction.add(
        createBurnInstruction(
          acc.tokenAccount,
          mintPubkey,
          keypair.publicKey,
          take
        )
      );

      remaining -= take;
    }

    if (remaining > 0n) {
      return {
        success: false,
        avatarId,
        mint,
        error: 'Insufficient token balance to construct burn transaction',
      };
    }

    signature = await sendAndConfirmTransaction(connection, transaction, [keypair], {
      commitment: 'confirmed',
    });

    // Record + credit in one Dynamo transaction (idempotent per signature).
    const now = Date.now();
    const pk = `AVATAR#${avatarId}`;
    const sk = `ENERGY_BURN#${signature}`;

    // We store a small audit record for reconciliation.
    const burnRecord = {
      pk,
      sk,
      avatarId,
      mint,
      burnAmountRaw: quote.burnAmountRaw.toString(),
      energyCredits: quote.energyCredits,
      actorId,
      createdAt: now,
    };

    // Use TransactWrite so record + bank credit are applied together.
    await dynamoClient.send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: ADMIN_TABLE,
            Item: burnRecord,
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
        {
          Update: {
            TableName: ADMIN_TABLE,
            Key: { pk, sk: 'CREDIT#energy_bank' },
            UpdateExpression: 'SET toolName = :toolName, avatarId = :avatarId, credits = if_not_exists(credits, :zero) + :amount, updatedAt = :now',
            ExpressionAttributeValues: {
              ':toolName': 'energy_bank',
              ':avatarId': avatarId,
              ':zero': 0,
              ':amount': quote.energyCredits,
              ':now': now,
            },
          },
        },
      ],
    }));

    // Also keep energy.ts helper up-to-date (no-op beyond the transaction above, but provides a public API).
    // If the transaction succeeds, this will just increment again unless we skip it.
    // So we do NOT call addEnergyBankCredits here.

    return {
      success: true,
      avatarId,
      mint,
      energyCreditsAdded: quote.energyCredits,
      burnAmountRaw: quote.burnAmountRaw.toString(),
      signature,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      avatarId,
      mint: requestedMint || 'unknown',
      signature,
      error: signature
        ? `Burn tx succeeded (signature=${signature}) but crediting failed: ${msg}`
        : msg,
    };
  }
}

// Back-compat export (used by future code paths)
export async function creditEnergyBank(avatarId: string, amount: number): Promise<void> {
  // Atomic increment implemented in energy.ts; keep here as a convenience.
  await addEnergyBankCredits(avatarId, amount);
}
