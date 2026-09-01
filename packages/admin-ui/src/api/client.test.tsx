import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const originalFetch = globalThis.fetch;

describe('admin API client boundary', () => {
  beforeEach(() => {
    vi.resetModules();
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('routes browser-local API calls without replacing global fetch', async () => {
    const networkFetch = vi.fn(async () => new Response(null, { status: 502 }));
    globalThis.fetch = networkFetch as typeof fetch;
    window.history.replaceState({}, '', '/?local=1');
    const { apiFetch } = await import('./client');

    const response = await apiFetch('/api/health');

    expect(await response.json()).toEqual({ ok: true, mode: 'web-local' });
    expect(networkFetch).not.toHaveBeenCalled();
    expect(globalThis.fetch).toBe(networkFetch);
  });

  test('adds the local server capability token only through the API client', async () => {
    let capturedRequest: Request | undefined;
    const networkFetch = vi.fn(async (input: RequestInfo | URL) => {
      capturedRequest = input as Request;
      return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    });
    globalThis.fetch = networkFetch as typeof fetch;
    window.history.replaceState({}, '', '/?swarmLocalToken=test-capability-token');
    const { initializeLocalApiToken } = await import('./localToken');
    const { apiFetch } = await import('./client');

    initializeLocalApiToken();
    await apiFetch('/api/health');

    expect(capturedRequest?.headers.get('x-swarm-local-token')).toBe('test-capability-token');
    expect(window.location.search).toBe('');
    expect(globalThis.fetch).toBe(networkFetch);
  });
});
