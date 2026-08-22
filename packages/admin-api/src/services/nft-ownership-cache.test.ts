import { beforeEach, afterEach, describe, expect, it, mock } from 'bun:test';
import { DeleteCommand, GetCommand, PutCommand } from '@swarm/core';

process.env.ADMIN_TABLE = process.env.ADMIN_TABLE || 'test-admin-table';

import {
  getCachedNFTOwner,
  primeNFTOwnerCache,
  invalidateNFTOwnerCache,
  _setNFTOwnershipDynamoClient,
  _resetNFTOwnershipMemoryCache,
  IN_MEMORY_TTL_MS,
} from './nft-ownership-cache.js';

/**
 * Mock Helius `getHeliusRpcUrl` module-level. We drive `fetch` directly so we
 * can assert call count on the Helius fallthrough.
 *
 * mock.module() is process-global — this file is run by the isolation
 * runner (scripts/test-isolated.sh) so that's fine.
 */
mock.module('./web3/nft-gate.js', () => ({
  getHeliusRpcUrl: async () => 'https://mock-helius.invalid/?api-key=test',
  verifyNFTOwnership: async () => false,
}));

const MINT = 'MINT_ABC';
const OWNER_A = 'OwnerWalletA';
const OWNER_B = 'OwnerWalletB';

// A mutable fetch stub. Each `it` installs its own behavior.
type FetchFn = typeof fetch;
const realFetch: FetchFn = globalThis.fetch;
let heliusFetchCount = 0;
let heliusNextOwner: string | null = OWNER_A;
let heliusNextThrows = false;

function installFetchStub(): void {
  heliusFetchCount = 0;
  globalThis.fetch = (async () => {
    heliusFetchCount += 1;
    if (heliusNextThrows) {
      throw new Error('network down');
    }
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 'nft-ownership-cache-get-owner',
        result: {
          id: MINT,
          ownership: { owner: heliusNextOwner },
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as FetchFn;
}

function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

// ── DynamoDB stub: in-memory map keyed on (pk, sk). ────────────────────────
type Item = { pk: string; sk: string; owner?: string | null; ttl?: number; checkedAt?: number };
let store = new Map<string, Item>();

function keyFor(pk: string, sk: string): string { return `${pk}|${sk}`; }

let sendMock = (_cmd: unknown): Promise<unknown> => Promise.resolve({});

function installDynamoStub(): void {
  store = new Map();
  sendMock = async (cmd: unknown) => {
    if (cmd instanceof GetCommand) {
      const key = cmd.input.Key as { pk: string; sk: string };
      const item = store.get(keyFor(key.pk, key.sk));
      return item ? { Item: item } : {};
    }
    if (cmd instanceof PutCommand) {
      const item = cmd.input.Item as Item;
      store.set(keyFor(item.pk, item.sk), item);
      return {};
    }
    if (cmd instanceof DeleteCommand) {
      const key = cmd.input.Key as { pk: string; sk: string };
      store.delete(keyFor(key.pk, key.sk));
      return {};
    }
    throw new Error(`Unexpected command: ${String((cmd as { constructor?: { name?: string } }).constructor?.name)}`);
  };
  _setNFTOwnershipDynamoClient({ send: sendMock } as unknown as DynamoDBDocumentClient);
}

describe('nft-ownership-cache', () => {
  beforeEach(() => {
    installDynamoStub();
    installFetchStub();
    _resetNFTOwnershipMemoryCache();
    heliusNextOwner = OWNER_A;
    heliusNextThrows = false;
  });

  afterEach(() => {
    restoreFetch();
    _setNFTOwnershipDynamoClient(null);
    _resetNFTOwnershipMemoryCache();
  });

  it('cache miss falls through to Helius and writes to both layers', async () => {
    const owner = await getCachedNFTOwner(MINT);
    expect(owner).toBe(OWNER_A);
    expect(heliusFetchCount).toBe(1);

    // DynamoDB layer has the entry
    const row = store.get(keyFor(`NFT_OWNER#${MINT}`, 'CURRENT'));
    expect(row).toBeDefined();
    expect(row?.owner).toBe(OWNER_A);
    expect(typeof row?.ttl).toBe('number');
    expect(row!.ttl! * 1000).toBeGreaterThan(Date.now());
  });

  it('priming writes both cache tiers without calling Helius', async () => {
    await primeNFTOwnerCache(MINT, OWNER_A);
    expect(heliusFetchCount).toBe(0);

    const owner = await getCachedNFTOwner(MINT);
    expect(owner).toBe(OWNER_A);
    expect(heliusFetchCount).toBe(0);

    const row = store.get(keyFor(`NFT_OWNER#${MINT}`, 'CURRENT'));
    expect(row).toBeDefined();
    expect(row?.owner).toBe(OWNER_A);
  });

  it('in-memory cache hit skips both DynamoDB and Helius', async () => {
    // Prime cache
    await getCachedNFTOwner(MINT);
    expect(heliusFetchCount).toBe(1);

    // Replace DynamoDB with a spy that rejects any read — the in-memory tier
    // should answer before DynamoDB is touched.
    _setNFTOwnershipDynamoClient({
      send: async () => { throw new Error('DynamoDB must not be hit on mem cache hit'); },
    } as unknown as DynamoDBDocumentClient);

    const owner2 = await getCachedNFTOwner(MINT);
    expect(owner2).toBe(OWNER_A);
    expect(heliusFetchCount).toBe(1); // no new Helius call
  });

  it('in-memory TTL expiry falls through to DynamoDB without calling Helius', async () => {
    // Prime (populates in-memory + DynamoDB)
    await getCachedNFTOwner(MINT);
    expect(heliusFetchCount).toBe(1);

    // Simulate in-memory TTL elapsing by advancing Date.now past IN_MEMORY_TTL_MS
    const originalNow = Date.now;
    const fakeNow = originalNow() + IN_MEMORY_TTL_MS + 1;
    Date.now = () => fakeNow;
    try {
      const owner2 = await getCachedNFTOwner(MINT);
      expect(owner2).toBe(OWNER_A);
      // DynamoDB row is still fresh (ttl 60s ahead of originalNow) — no Helius.
      expect(heliusFetchCount).toBe(1);
    } finally {
      Date.now = originalNow;
    }
  });

  it('DynamoDB TTL expiry forces a Helius refetch', async () => {
    // Prime
    await getCachedNFTOwner(MINT);
    expect(heliusFetchCount).toBe(1);

    // Expire both tiers by clearing in-memory and rewriting DynamoDB row
    // with a past ttl.
    _resetNFTOwnershipMemoryCache();
    const row = store.get(keyFor(`NFT_OWNER#${MINT}`, 'CURRENT'))!;
    store.set(keyFor(`NFT_OWNER#${MINT}`, 'CURRENT'), {
      ...row,
      ttl: Math.floor(Date.now() / 1000) - 10, // 10s in the past
    });

    // Helius now returns a DIFFERENT owner — proving the read came through.
    heliusNextOwner = OWNER_B;
    const owner2 = await getCachedNFTOwner(MINT);
    expect(owner2).toBe(OWNER_B);
    expect(heliusFetchCount).toBe(2);
  });

  it('fail-closed when Helius throws and no cached entry exists', async () => {
    heliusNextThrows = true;
    await expect(getCachedNFTOwner(MINT)).rejects.toThrow();
  });

  it('invalidation clears both cache tiers', async () => {
    await getCachedNFTOwner(MINT);
    expect(store.size).toBe(1);

    await invalidateNFTOwnerCache(MINT);
    expect(store.has(keyFor(`NFT_OWNER#${MINT}`, 'CURRENT'))).toBe(false);

    // Next read should hit Helius again (in-mem cleared, DynamoDB cleared)
    heliusNextOwner = OWNER_B;
    const owner2 = await getCachedNFTOwner(MINT);
    expect(owner2).toBe(OWNER_B);
    expect(heliusFetchCount).toBe(2);
  });
});
