import { describe, it, expect } from 'vitest';
import { fetchAllAssetsByOwner, type DasAsset, type FetchFn } from './helius-pagination.js';

/** Build a fake DasAsset with just an id */
function asset(id: string): DasAsset {
  return { id };
}

/** Build N assets with sequential ids */
function makeAssets(count: number, prefix = 'asset'): DasAsset[] {
  return Array.from({ length: count }, (_, i) => asset(`${prefix}-${i}`));
}

/**
 * Create a mock fetch that returns pages of assets.
 * `pages` is an array where each element is the list of items for that page.
 */
function createMockFetch(pages: DasAsset[][]): { fetchFn: FetchFn; calls: unknown[] } {
  const calls: unknown[] = [];
  const fetchFn: FetchFn = async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    calls.push(body);
    const page: number = body.params?.page ?? 1;
    const items = pages[page - 1] ?? [];
    return {
      ok: true,
      status: 200,
      json: async () => ({ result: { items } }),
    };
  };
  return { fetchFn, calls };
}

describe('fetchAllAssetsByOwner', () => {
  const RPC_URL = 'https://mainnet.helius-rpc.com/?api-key=test-key';
  const WALLET = 'TestWallet111';

  it('returns all items from a single page (fewer than pageSize)', async () => {
    const items = makeAssets(5);
    const { fetchFn, calls } = createMockFetch([items]);

    const result = await fetchAllAssetsByOwner(RPC_URL, WALLET, { pageSize: 10 }, fetchFn);

    expect(result).toHaveLength(5);
    expect(result.map((a) => a.id)).toEqual(items.map((a) => a.id));
    expect(calls).toHaveLength(1);
  });

  it('paginates across multiple pages', async () => {
    const page1 = makeAssets(10, 'p1');
    const page2 = makeAssets(10, 'p2');
    const page3 = makeAssets(3, 'p3'); // partial page = last page
    const { fetchFn, calls } = createMockFetch([page1, page2, page3]);

    const result = await fetchAllAssetsByOwner(RPC_URL, WALLET, { pageSize: 10 }, fetchFn);

    expect(result).toHaveLength(23);
    expect(calls).toHaveLength(3);
    // Verify page numbers were sent correctly
    expect((calls[0] as { params: { page: number } }).params.page).toBe(1);
    expect((calls[1] as { params: { page: number } }).params.page).toBe(2);
    expect((calls[2] as { params: { page: number } }).params.page).toBe(3);
  });

  it('stops at exactly pageSize items on last full page followed by empty page', async () => {
    const page1 = makeAssets(10, 'p1');
    const page2 = makeAssets(10, 'p2');
    // Page 3 is empty — signals no more results
    const { fetchFn, calls } = createMockFetch([page1, page2, []]);

    const result = await fetchAllAssetsByOwner(RPC_URL, WALLET, { pageSize: 10 }, fetchFn);

    expect(result).toHaveLength(20);
    expect(calls).toHaveLength(3);
  });

  it('respects maxPages safety cap', async () => {
    // All pages are full — would loop forever without the cap
    const fullPage = makeAssets(10, 'full');
    const pages = Array.from({ length: 20 }, () => fullPage);
    const { fetchFn, calls } = createMockFetch(pages);

    const result = await fetchAllAssetsByOwner(
      RPC_URL,
      WALLET,
      { pageSize: 10, maxPages: 3 },
      fetchFn,
    );

    // Should have fetched exactly 3 pages
    expect(calls).toHaveLength(3);
    expect(result).toHaveLength(30);
  });

  it('default maxPages is 10', async () => {
    const fullPage = makeAssets(1000, 'full');
    const pages = Array.from({ length: 15 }, () => fullPage);
    const { fetchFn, calls } = createMockFetch(pages);

    const result = await fetchAllAssetsByOwner(RPC_URL, WALLET, {}, fetchFn);

    expect(calls).toHaveLength(10);
    expect(result).toHaveLength(10_000);
  });

  it('returns empty array when API returns error', async () => {
    const fetchFn: FetchFn = async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    });

    const result = await fetchAllAssetsByOwner(RPC_URL, WALLET, {}, fetchFn);
    expect(result).toEqual([]);
  });

  it('returns empty array when RPC returns error object', async () => {
    const fetchFn: FetchFn = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ error: { message: 'rate limited' } }),
    });

    const result = await fetchAllAssetsByOwner(RPC_URL, WALLET, {}, fetchFn);
    expect(result).toEqual([]);
  });

  it('forwards displayOptions to the RPC call', async () => {
    const items = makeAssets(2);
    const { fetchFn, calls } = createMockFetch([items]);

    await fetchAllAssetsByOwner(
      RPC_URL,
      WALLET,
      { pageSize: 10, displayOptions: { showCollectionMetadata: true } },
      fetchFn,
    );

    const body = calls[0] as { params: { displayOptions: unknown } };
    expect(body.params.displayOptions).toEqual({ showCollectionMetadata: true });
  });

  it('returns partial results when a mid-pagination page fails', async () => {
    const page1 = makeAssets(10, 'p1');
    let callCount = 0;
    const fetchFn: FetchFn = async (_url, init) => {
      callCount++;
      const body = JSON.parse(init.body as string);
      if (body.params.page === 2) {
        return { ok: false, status: 429, json: async () => ({}) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ result: { items: page1 } }),
      };
    };

    const result = await fetchAllAssetsByOwner(RPC_URL, WALLET, { pageSize: 10 }, fetchFn);

    // Should return page 1 results, stop on page 2 error
    expect(result).toHaveLength(10);
    expect(callCount).toBe(2);
  });
});
