/**
 * NFT Ownership Cache (handlers binding)
 *
 * Thin wrapper around `@swarm/core`'s `createNFTOwnershipCache` factory that
 * binds handler-side dependencies. Reads and writes the same DynamoDB row
 * (`NFT_OWNER#<mint>/CURRENT` in `SwarmAdminTable`) that admin-api writes,
 * so both packages share the cross-Lambda cache layer transparently.
 *
 * See #1385 PR 3 for the design rationale.
 */
import { type DynamoDBDocumentClient } from '@swarm/core';
import { createNFTOwnershipCache } from '@swarm/core/services';
import { getDynamoClient } from './dynamo-client.js';
import { getHeliusRpcUrl } from './helius-rpc.js';

const cache = createNFTOwnershipCache({
  dynamoClient: getDynamoClient(),
  getAdminTable: () => process.env.ADMIN_TABLE!,
  getHeliusRpcUrl: () => getHeliusRpcUrl(),
  metricNamespace: 'Swarm/Handlers',
});

export async function getCachedNFTOwner(mint: string): Promise<string | null> {
  return cache.getCachedNFTOwner(mint);
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
