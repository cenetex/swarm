/**
 * Wallet Balance Service
 *
 * Gets token balances for avatar creator wallets
 * Used for dynamic energy refill rate calculation
 */
import { Connection, PublicKey } from '@solana/web3.js';
import type { AvatarRecord } from '../../types.js';
import { createSystemLogger } from '../structured-logger.js';

const log = createSystemLogger('wallet-balance');

// Cache token balances for 5 minutes to avoid excessive RPC calls
const BALANCE_CACHE_TTL_MS = 5 * 60 * 1000;
const balanceCache = new Map<string, { balance: number; timestamp: number }>();

// =============================================================================
// DEPENDENCY INJECTION
// =============================================================================

export interface WalletBalanceDeps {
  getAvatar: (avatarId: string) => Promise<AvatarRecord | null>;
  getSolanaRpcUrl: () => string;
  getAccountIdForIdentity?: (identity: { type: 'wallet' | 'privy'; providerId: string }) => Promise<string | null>;
  getAccountIdentities?: (accountId: string) => Promise<Array<{ type: 'wallet' | 'privy'; providerId: string }>>;
}

let defaultDeps: WalletBalanceDeps | null = null;

async function getDefaultDeps(): Promise<WalletBalanceDeps> {
  if (!defaultDeps) {
    const { getAvatar } = await import('../avatars.js');
    const { getAccountIdForIdentity, getAccountIdentities } = await import('../accounts/index.js');
    
    defaultDeps = {
      getAvatar,
      getSolanaRpcUrl: () => process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
      getAccountIdForIdentity,
      getAccountIdentities,
    };
  }
  return defaultDeps;
}

// =============================================================================
// TOKEN BALANCE QUERIES
// =============================================================================

/**
 * Get the owner wallet for an avatar
 * Uses creatorWallet only.
 */
export async function getOwnerWallet(
  avatarId: string,
  deps?: WalletBalanceDeps
): Promise<string | null> {
  const d = deps ?? await getDefaultDeps();
  const avatar = await d.getAvatar(avatarId);
  
  if (!avatar) {
    return null;
  }
  
  return avatar.creatorWallet || null;
}

/**
 * Get all linked wallets for an avatar's owner account
 */
export async function getOwnerWallets(
  avatarId: string,
  deps?: WalletBalanceDeps
): Promise<string[]> {
  const d = deps ?? await getDefaultDeps();
  const ownerWallet = await getOwnerWallet(avatarId, d);
  if (!ownerWallet) return [];

  const wallets = new Set<string>([ownerWallet]);

  if (!d.getAccountIdForIdentity || !d.getAccountIdentities) {
    return Array.from(wallets);
  }

  try {
    const accountId = await d.getAccountIdForIdentity({
      type: 'wallet',
      providerId: ownerWallet,
    });

    if (!accountId) {
      return Array.from(wallets);
    }

    const identities = await d.getAccountIdentities(accountId);
    for (const identity of identities) {
      if (identity.type === 'wallet' && identity.providerId) {
        wallets.add(identity.providerId);
      }
    }
  } catch {
    // Fallback to the owner wallet when account identity lookups fail.
  }

  return Array.from(wallets);
}

/**
 * Get SPL token balance for a wallet
 */
export async function getTokenBalance(
  walletAddress: string,
  tokenMint: string,
  rpcUrl?: string
): Promise<number> {
  // Check cache first
  const cacheKey = `${walletAddress}:${tokenMint}`;
  const cached = balanceCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < BALANCE_CACHE_TTL_MS) {
    return cached.balance;
  }

  try {
    const connection = new Connection(rpcUrl || process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');
    const walletPubkey = new PublicKey(walletAddress);
    const tokenMintPubkey = new PublicKey(tokenMint);
    
    // Get token accounts for this wallet and mint
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(walletPubkey, {
      mint: tokenMintPubkey,
    });

    let totalBalance = 0;
    for (const account of tokenAccounts.value) {
      const info = account.account.data.parsed?.info;
      if (info?.tokenAmount?.uiAmount) {
        totalBalance += info.tokenAmount.uiAmount;
      }
    }

    // Cache the result
    balanceCache.set(cacheKey, { balance: totalBalance, timestamp: Date.now() });
    
    return totalBalance;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);

    if (msg.includes('could not find mint')) {
      log.warn('solana', 'mint_not_found', { mint: tokenMint, wallet: walletAddress });
    } else {
      log.error('solana', 'token_balance_error', { wallet: walletAddress, message: msg });
    }

    // Return cached value if available, even if stale
    if (cached) {
      return cached.balance;
    }

    return 0;
  }
}

/**
 * Get total token balance across all owner wallets for an avatar
 */
export async function getOwnerTokenBalance(
  avatarId: string,
  tokenMint: string,
  deps?: WalletBalanceDeps
): Promise<number> {
  const d = deps ?? await getDefaultDeps();
  const wallets = await getOwnerWallets(avatarId, d);
  
  if (wallets.length === 0) {
    return 0;
  }

  // Get balance from all wallets
  const balances = await Promise.all(
    wallets.map(wallet => getTokenBalance(wallet, tokenMint, d.getSolanaRpcUrl()))
  );

  // Sum up all balances
  return balances.reduce((sum, balance) => sum + balance, 0);
}

/**
 * Get average token balance across owner wallets
 * (Same as total for now since we typically have one wallet)
 */
export async function getOwnerTokenBalanceAverage(
  avatarId: string,
  tokenMint: string,
  deps?: WalletBalanceDeps
): Promise<number> {
  const d = deps ?? await getDefaultDeps();
  const wallets = await getOwnerWallets(avatarId, d);
  
  if (wallets.length === 0) {
    return 0;
  }

  const total = await getOwnerTokenBalance(avatarId, tokenMint, d);
  return total / wallets.length;
}

/**
 * Clear the balance cache (for testing or forced refresh)
 */
export function clearBalanceCache(): void {
  balanceCache.clear();
}

/**
 * Get cache stats (for debugging)
 */
export function getBalanceCacheStats(): { size: number; ttlMs: number } {
  return {
    size: balanceCache.size,
    ttlMs: BALANCE_CACHE_TTL_MS,
  };
}
