/**
 * Helius DAS API Pagination Helper
 *
 * Fetches all pages of results from getAssetsByOwner, handling the case where
 * large wallets have more assets than fit in a single page (default 1000).
 *
 * Safety cap: max 10 pages (10,000 assets) to prevent runaway loops.
 */
import { createSystemLogger } from '../structured-logger.js';

const log = createSystemLogger('helius-pagination');

/** Minimal asset shape returned by getAssetsByOwner */
export interface DasAsset {
  id: string;
  content?: {
    metadata?: {
      name?: string;
      symbol?: string;
      description?: string;
      attributes?: Array<{ trait_type: string; value: string }>;
    };
    json_uri?: string;
    files?: Array<{ uri: string; cdn_uri?: string }>;
    links?: { image?: string };
  };
  grouping?: Array<{ group_key: string; group_value: string }>;
  ownership?: { owner: string };
}

export interface FetchAllAssetsOptions {
  /** Display options forwarded to the Helius RPC call */
  displayOptions?: Record<string, unknown>;
  /** Page size (default 1000 — Helius maximum) */
  pageSize?: number;
  /** Maximum number of pages to fetch (default 10 = 10,000 assets) */
  maxPages?: number;
}

/**
 * Fetch function signature — allows dependency injection for testing.
 * Matches the global `fetch` signature for the subset we use.
 */
export type FetchFn = (
  url: string,
  init: RequestInit,
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * Paginate through all results of a Helius getAssetsByOwner call.
 *
 * @param heliusRpcUrl  Full Helius RPC URL (with API key)
 * @param walletAddress Solana wallet address to query
 * @param options       Pagination and display options
 * @param fetchImpl     Optional fetch implementation (for testing)
 * @returns All assets across all pages
 */
export async function fetchAllAssetsByOwner(
  heliusRpcUrl: string,
  walletAddress: string,
  options: FetchAllAssetsOptions = {},
  fetchImpl: FetchFn = globalThis.fetch as unknown as FetchFn,
): Promise<DasAsset[]> {
  const pageSize = options.pageSize ?? 1000;
  const maxPages = options.maxPages ?? 10;
  const allItems: DasAsset[] = [];
  let page = 1;

  while (page <= maxPages) {
    const response = await fetchImpl(heliusRpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `paginated-assets-p${page}`,
        method: 'getAssetsByOwner',
        params: {
          ownerAddress: walletAddress,
          page,
          limit: pageSize,
          ...(options.displayOptions ? { displayOptions: options.displayOptions } : {}),
        },
      }),
    });

    if (!response.ok) {
      log.error('pagination', 'api_error', {
        page,
        status: response.status,
        walletAddress,
      });
      break;
    }

    const data = (await response.json()) as {
      error?: { message?: string };
      result?: { items?: DasAsset[] };
    };

    if (data.error) {
      log.error('pagination', 'rpc_error', {
        page,
        error: data.error,
        walletAddress,
      });
      break;
    }

    const items = data.result?.items ?? [];
    allItems.push(...items);

    // If we got fewer items than the page size, we've reached the last page
    if (items.length < pageSize) {
      break;
    }

    page++;
  }

  return allItems;
}
