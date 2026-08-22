/**
 * NFT Ownership Cache (shared)
 *
 * Resolves the current on-chain owner of an NFT mint with two-tier caching.
 * Originally lived in admin-api (see #1385 PR 1); promoted here so webhook
 * handlers can share the same cache layer (see #1385 PR 3).
 *
 * Two-tier cache:
 *   1. Per-instance `Map` with a short (10s) TTL absorbs bursts within a
 *      single Lambda invocation or warm container.
 *   2. DynamoDB items in the caller-provided admin table with a 60s TTL
 *      serve as the cross-Lambda source of truth. The `ttl` attribute is an
 *      epoch-seconds value so DynamoDB TTL sweeps the row, but readers must
 *      ALSO treat an expired row as a miss (TTL deletion is best-effort and
 *      may lag).
 *
 * DynamoDB schema:
 *   pk: `NFT_OWNER#<mint>`
 *   sk: `CURRENT`
 *   owner:     wallet address string (or null when the NFT is unowned)
 *   checkedAt: ms timestamp when the Helius lookup happened
 *   ttl:       epoch-seconds after which the entry MUST be treated as expired
 *
 * Failure mode: fail-closed. If Helius throws or times out and no fresh
 * cache entry exists, `getCachedNFTOwner` throws so callers can translate
 * the failure into a "verification unavailable" error.
 */
import {
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
} from '@swarm/core';
import { logger } from '../utils/logger.js';

// ── Cache knobs ─────────────────────────────────────────────────────────────
export const IN_MEMORY_TTL_MS = 10_000;
export const DYNAMO_TTL_SECONDS = 60;

// ── DynamoDB key contract (stable across packages) ──────────────────────────
export const NFT_OWNER_PK_PREFIX = 'NFT_OWNER#';
export const NFT_OWNER_SK = 'CURRENT';

export function nftOwnerCacheKey(mint: string): { pk: string; sk: string } {
  return { pk: `${NFT_OWNER_PK_PREFIX}${mint}`, sk: NFT_OWNER_SK };
}

export interface CachedNFTOwnerItem {
  pk: string;
  sk: string;
  owner: string | null;
  checkedAt: number;
  ttl: number;
}

// ── Minimal Helius DAS shape (getAsset response) ────────────────────────────
interface HeliusAssetResult {
  id?: string;
  ownership?: { owner?: string | null };
}

// ── Factory deps ────────────────────────────────────────────────────────────
export interface NFTOwnershipCacheDeps {
  /** DynamoDB Document client. Callers keep ownership of the connection. */
  dynamoClient: DynamoDBDocumentClient;
  /** Lazily resolves the admin table name — evaluated on every call so tests can set `process.env.ADMIN_TABLE` mid-test. */
  getAdminTable: () => string;
  /** Lazily resolves the Helius RPC URL (or `null` if unavailable). */
  getHeliusRpcUrl: () => Promise<string | null>;
  /**
   * EMF metric emitter for cache misses. Defaults to a stdout JSON line
   * compatible with CloudWatch Embedded Metrics Format. Override to `() => {}`
   * in tests or when running outside Lambda.
   */
  emitCacheMissMetric?: (mint: string) => void;
  /** Namespace used in default EMF metric emission. Defaults to `Swarm/Core`. */
  metricNamespace?: string;
}

export interface NFTOwnershipCache {
  /**
   * Return the current on-chain owner wallet for `mint`, preferring cached
   * values and falling back to Helius.
   *
   * Return semantics:
   *   - string — cached/fresh owner wallet
   *   - null   — the NFT legitimately has no owner (burned/unindexed)
   *   - throws — Helius was required and was unavailable (fail closed)
   */
  getCachedNFTOwner(mint: string): Promise<string | null>;
  /** Write a verified owner into both cache layers without another Helius read. */
  primeNFTOwnerCache(mint: string, owner: string | null): Promise<void>;
  /** Drop any cached owner for `mint` when it is known stale. */
  invalidateNFTOwnerCache(mint: string): Promise<void>;
  /** @internal Test-only: swap the DynamoDB client. Pass `null` to restore the original. */
  _setDynamoClient(client: DynamoDBDocumentClient | null): void;
  /** @internal Test-only: drop the per-instance micro-cache. */
  _resetMemoryCache(): void;
}

// ── Default EMF emitter ─────────────────────────────────────────────────────
function defaultEmitCacheMissMetric(namespace: string) {
  return (mint: string): void => {
    const payload = {
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: namespace,
            Dimensions: [[]],
            Metrics: [{ Name: 'NFTOwnershipCacheMiss', Unit: 'Count' }],
          },
        ],
      },
      NFTOwnershipCacheMiss: 1,
      mintPrefix: mint.slice(0, 8),
    };
    console.log(JSON.stringify(payload));
  };
}

// ── Factory ─────────────────────────────────────────────────────────────────
export function createNFTOwnershipCache(deps: NFTOwnershipCacheDeps): NFTOwnershipCache {
  const originalClient = deps.dynamoClient;
  let dynamoClient: DynamoDBDocumentClient = originalClient;

  const emit = deps.emitCacheMissMetric
    ?? defaultEmitCacheMissMetric(deps.metricNamespace ?? 'Swarm/Core');

  interface MemEntry {
    owner: string | null;
    expiresAt: number; // ms epoch
  }
  const memCache = new Map<string, MemEntry>();

  async function fetchNFTOwnerFromHelius(mint: string): Promise<string | null> {
    const heliusRpcUrl = await deps.getHeliusRpcUrl();
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
      result?: HeliusAssetResult;
    };

    if (data.error) {
      throw new Error(`Helius RPC error: ${data.error.message || 'unknown'}`);
    }

    const asset = data.result;
    if (!asset) {
      return null;
    }

    return asset.ownership?.owner ?? null;
  }

  async function getCachedNFTOwner(mint: string): Promise<string | null> {
    const nowMs = Date.now();

    const mem = memCache.get(mint);
    if (mem && mem.expiresAt > nowMs) {
      return mem.owner;
    }
    if (mem) {
      memCache.delete(mint);
    }

    try {
      const result = await dynamoClient.send(
        new GetCommand({
          TableName: deps.getAdminTable(),
          Key: nftOwnerCacheKey(mint),
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
      logger.warn('nft-ownership-cache dynamo read failed', {
        mintPrefix: mint.slice(0, 8),
        error: err instanceof Error ? err.message : String(err),
      });
    }

    emit(mint);
    const owner = await fetchNFTOwnerFromHelius(mint);

    await primeNFTOwnerCache(mint, owner, nowMs);

    return owner;
  }

  async function primeNFTOwnerCache(
    mint: string,
    owner: string | null,
    checkedAtMs = Date.now(),
  ): Promise<void> {
    const ttlSeconds = Math.floor(checkedAtMs / 1000) + DYNAMO_TTL_SECONDS;
    memCache.set(mint, {
      owner,
      expiresAt: checkedAtMs + IN_MEMORY_TTL_MS,
    });

    try {
      await dynamoClient.send(
        new PutCommand({
          TableName: deps.getAdminTable(),
          Item: {
            ...nftOwnerCacheKey(mint),
            owner,
            checkedAt: checkedAtMs,
            ttl: ttlSeconds,
          },
        }),
      );
    } catch (err) {
      logger.warn('nft-ownership-cache dynamo write failed', {
        mintPrefix: mint.slice(0, 8),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function invalidateNFTOwnerCache(mint: string): Promise<void> {
    memCache.delete(mint);
    try {
      await dynamoClient.send(
        new DeleteCommand({
          TableName: deps.getAdminTable(),
          Key: nftOwnerCacheKey(mint),
        }),
      );
    } catch (err) {
      logger.warn('nft-ownership-cache dynamo invalidate failed', {
        mintPrefix: mint.slice(0, 8),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    getCachedNFTOwner,
    primeNFTOwnerCache,
    invalidateNFTOwnerCache,
    _setDynamoClient(client) {
      dynamoClient = client ?? originalClient;
    },
    _resetMemoryCache() {
      memCache.clear();
    },
  };
}
