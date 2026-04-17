/**
 * NFT Ownership Cache (admin-api)
 *
 * Caches the current on-chain owner of an NFT mint so the per-request
 * ownership check performed by `assertAvatarOwnership` doesn't hit Helius
 * on every access.
 *
 * Two-tier cache:
 *   1. Process-local `Map` with a short (10s) TTL absorbs bursts within a
 *      single Lambda invocation or warm container.
 *   2. `SwarmAdminTable` DynamoDB items with a 60s TTL serve as the cross-
 *      Lambda source of truth. The `ttl` attribute is an epoch-seconds
 *      value so DynamoDB TTL sweeps the row, but readers must ALSO treat
 *      an expired row as a miss (TTL deletion is best-effort and may lag).
 *
 * Schema:
 *   pk: `NFT_OWNER#<mint>`
 *   sk: `CURRENT`
 *   owner:    wallet address string
 *   checkedAt: ms timestamp when the Helius lookup happened
 *   ttl:       epoch-seconds after which the entry MUST be treated as expired
 *
 * Failure mode: fail-closed. If Helius throws or times out and no fresh
 * cache entry exists, `getCachedNFTOwner` throws so callers (currently
 * `assertAvatarOwnership` in `avatars.ts`) can translate the failure into
 * an `AvatarOwnershipError({ code: 'verification_unavailable' })`.
 *
 * See #1385 for the enforcement wiring.
 */
import {
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { getDynamoClient } from './dynamo-client.js';
import { createSystemLogger } from './structured-logger.js';
import { getHeliusRpcUrl } from './web3/nft-gate.js';
import type { NFTAsset } from './web3/nft-gate.js';

const log = createSystemLogger('nft-ownership');

let dynamoClient: DynamoDBDocumentClient = getDynamoClient();

function getAdminTable(): string {
  return process.env.ADMIN_TABLE!;
}

/** @internal Test-only: inject a mock DynamoDB client. Pass null to restore the default. */
export function _setNFTOwnershipDynamoClient(
  client: DynamoDBDocumentClient | null,
): void {
  if (client) {
    dynamoClient = client;
  } else {
    dynamoClient = getDynamoClient();
  }
}

// ── Cache knobs ─────────────────────────────────────────────────────────────
export const IN_MEMORY_TTL_MS = 10_000;
export const DYNAMO_TTL_SECONDS = 60;

interface MemEntry {
  owner: string | null;
  expiresAt: number; // ms epoch
}

// Per-process micro-cache. Keyed on NFT mint.
const memCache = new Map<string, MemEntry>();

/** @internal Test-only: drop the entire in-memory micro-cache. */
export function _resetNFTOwnershipMemoryCache(): void {
  memCache.clear();
}

// ── EMF metric emission ─────────────────────────────────────────────────────
/**
 * Emit a CloudWatch Embedded Metric Format log so dashboards can count how
 * often we fall through to Helius.
 *
 * structured-logger.ts is the canonical console emitter everywhere else in
 * admin-api; EMF requires a specific JSON shape so we write one extra line
 * directly. Consumers that filter on log level will still see this as INFO.
 */
function emitCacheMissMetric(mint: string): void {
  const payload = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [
        {
          Namespace: 'Swarm/AdminApi',
          Dimensions: [[]],
          Metrics: [{ Name: 'NFTOwnershipCacheMiss', Unit: 'Count' }],
        },
      ],
    },
    NFTOwnershipCacheMiss: 1,
    mintPrefix: mint.slice(0, 8),
  };
  // eslint-disable-next-line no-console -- EMF must be written to stdout for CloudWatch
  console.log(JSON.stringify(payload));
}

// ── Helius lookup ───────────────────────────────────────────────────────────
/**
 * Resolve the current on-chain owner of an NFT via Helius `getAsset`.
 * Returns the owner wallet string, or `null` if the asset is unowned
 * (e.g., burned/frozen). Throws if Helius is unreachable or returns an
 * error — callers must treat throws as "verification unavailable".
 */
async function fetchNFTOwnerFromHelius(mint: string): Promise<string | null> {
  const heliusRpcUrl = await getHeliusRpcUrl();
  if (!heliusRpcUrl) {
    throw new Error('Helius API key not configured');
  }

  const response = await fetch(heliusRpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'nft-ownership-cache-get-owner',
      method: 'getAsset',
      params: { id: mint },
    }),
  });

  if (!response.ok) {
    throw new Error(`Helius API error: ${response.status}`);
  }

  const data = (await response.json()) as {
    error?: { message?: string };
    result?: NFTAsset;
  };

  if (data.error) {
    throw new Error(`Helius RPC error: ${data.error.message || 'unknown'}`);
  }

  const asset = data.result;
  if (!asset) {
    // Asset not found in index; treat as unowned so callers see this as
    // "no owner" rather than a transient failure.
    return null;
  }

  return asset.ownership?.owner ?? null;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Return the current on-chain owner wallet for `mint`, preferring cached
 * values and falling back to Helius.
 *
 * Return semantics:
 *   - string — cached/fresh owner wallet
 *   - null   — the NFT legitimately has no owner (burned/unindexed)
 *   - throws — Helius was required and was unavailable (fail closed)
 */
export async function getCachedNFTOwner(
  mint: string,
): Promise<string | null> {
  const nowMs = Date.now();

  // Tier 1: in-memory micro-cache
  const mem = memCache.get(mint);
  if (mem && mem.expiresAt > nowMs) {
    return mem.owner;
  }
  if (mem) {
    memCache.delete(mint);
  }

  // Tier 2: DynamoDB
  try {
    const result = await dynamoClient.send(
      new GetCommand({
        TableName: getAdminTable(),
        Key: { pk: `NFT_OWNER#${mint}`, sk: 'CURRENT' },
      }),
    );
    const item = result.Item as
      | { owner?: string | null; ttl?: number }
      | undefined;
    if (item && typeof item.ttl === 'number' && item.ttl * 1000 > nowMs) {
      const owner = typeof item.owner === 'string' ? item.owner : null;
      memCache.set(mint, {
        owner,
        expiresAt: nowMs + IN_MEMORY_TTL_MS,
      });
      return owner;
    }
  } catch (err) {
    // DynamoDB failure alone does not fail-closed — we can still ask
    // Helius. Log and fall through.
    log.warn('cache', 'dynamo_read_failed', {
      mintPrefix: mint.slice(0, 8),
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Tier 3: Helius (cache miss) — fail closed on errors.
  emitCacheMissMetric(mint);
  const owner = await fetchNFTOwnerFromHelius(mint);

  const ttlSeconds = Math.floor(nowMs / 1000) + DYNAMO_TTL_SECONDS;
  memCache.set(mint, {
    owner,
    expiresAt: nowMs + IN_MEMORY_TTL_MS,
  });

  try {
    await dynamoClient.send(
      new PutCommand({
        TableName: getAdminTable(),
        Item: {
          pk: `NFT_OWNER#${mint}`,
          sk: 'CURRENT',
          owner,
          checkedAt: nowMs,
          ttl: ttlSeconds,
        },
      }),
    );
  } catch (err) {
    // A write failure is non-fatal — the mem cache has the value and the
    // next process will just refetch from Helius.
    log.warn('cache', 'dynamo_write_failed', {
      mintPrefix: mint.slice(0, 8),
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return owner;
}

/**
 * Drop any cached owner for `mint`. Call this after a fresh claim so we
 * never serve a stale entry for a mint we just wrote to.
 */
export async function invalidateNFTOwnerCache(mint: string): Promise<void> {
  memCache.delete(mint);
  try {
    await dynamoClient.send(
      new DeleteCommand({
        TableName: getAdminTable(),
        Key: { pk: `NFT_OWNER#${mint}`, sk: 'CURRENT' },
      }),
    );
  } catch (err) {
    log.warn('cache', 'dynamo_invalidate_failed', {
      mintPrefix: mint.slice(0, 8),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
