/**
 * NFT Ownership Cache (admin-api binding)
 *
 * Thin wrapper around `@swarm/core`'s `createNFTOwnershipCache` factory that
 * binds admin-api's DynamoDB client + Helius helper. The shared cache layer
 * lives in core so webhook handlers can read/write the same row (see #1385
 * PR 3).
 *
 * The public API here (function names, signatures, return semantics) is
 * unchanged from the original implementation so existing admin-api callers
 * and tests do not need to be touched.
 */
import { type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createNFTOwnershipCache } from '@swarm/core/services';
import { getDynamoClient } from './dynamo-client.js';
import { getHeliusRpcUrl } from './web3/nft-gate.js';

export {
  IN_MEMORY_TTL_MS,
  DYNAMO_TTL_SECONDS,
  NFT_OWNER_PK_PREFIX,
  NFT_OWNER_SK,
  nftOwnerCacheKey,
  type CachedNFTOwnerItem,
} from '@swarm/core/services';

const cache = createNFTOwnershipCache({
  dynamoClient: getDynamoClient(),
  getAdminTable: () => process.env.ADMIN_TABLE!,
  // Lazy re-lookup so `mock.module('./web3/nft-gate.js', ...)` in tests
  // reaches this call path after the wrapper has already been loaded.
  getHeliusRpcUrl: () => getHeliusRpcUrl(),
  metricNamespace: 'Swarm/AdminApi',
});

export async function getCachedNFTOwner(mint: string): Promise<string | null> {
  return cache.getCachedNFTOwner(mint);
}

export async function primeNFTOwnerCache(mint: string, owner: string | null): Promise<void> {
  return cache.primeNFTOwnerCache(mint, owner);
}

export async function invalidateNFTOwnerCache(mint: string): Promise<void> {
  return cache.invalidateNFTOwnerCache(mint);
}

/** @internal Test-only: inject a mock DynamoDB client. Pass null to restore the default. */
export function _setNFTOwnershipDynamoClient(
  client: DynamoDBDocumentClient | null,
): void {
  cache._setDynamoClient(client);
}

/** @internal Test-only: drop the entire in-memory micro-cache. */
export function _resetNFTOwnershipMemoryCache(): void {
  cache._resetMemoryCache();
}
