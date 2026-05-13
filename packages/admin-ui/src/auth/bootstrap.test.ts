import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

function installMemoryLocalStorage() {
  const store = new Map<string, string>();
  const localStorage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
  };

  // @ts-expect-error - test polyfill
  globalThis.localStorage = localStorage;
  return localStorage;
}

describe('auth bootstrap reliability', () => {
  const originalFetch = globalThis.fetch;
  let ls: Storage;

  beforeEach(() => {
    ls = installMemoryLocalStorage() as unknown as Storage;
    ls.clear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('clears persisted auth when backend session is unauthenticated', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ authenticated: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const { useAuthStore } = await import('../store/auth');
    const { bootstrapAuthFromBackendSession } = await import('./bootstrap');

    useAuthStore.setState({
      isAuthenticated: true,
      user: { id: 'u1', walletAddress: 'wallet1', email: 'a@b.com' },
    } as never);

    await bootstrapAuthFromBackendSession();

    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.user).toBe(null);
  });

  test('clears persisted auth when /auth/me fails (e.g., network/401)', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response('oops', { status: 401 });
    });

    const { useAuthStore } = await import('../store/auth');
    const { bootstrapAuthFromBackendSession } = await import('./bootstrap');

    useAuthStore.setState({
      isAuthenticated: true,
      user: { id: 'u1', walletAddress: 'wallet1' },
    } as never);

    await bootstrapAuthFromBackendSession();

    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.user).toBe(null);
  });

  test('force sync refreshes backend session even when local auth is already set', async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({
        success: true,
        user: {
          walletAddress: 'So11111111111111111111111111111111111111112',
          email: 'user@example.com',
        },
        account: null,
        gateStatus: null,
        gateWallet: null,
        gateStatusByWallet: null,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    globalThis.fetch = fetchMock;

    const { useAuthStore } = await import('../store/auth');

    useAuthStore.setState({
      isAuthenticated: true,
      isLoading: false,
      user: {
        id: 'u1',
        walletAddress: 'So11111111111111111111111111111111111111112',
        email: 'user@example.com',
      },
    } as never);

    await useAuthStore.getState().syncWithBackend('fresh-token', {
      id: 'privy-1',
      email: 'user@example.com',
      walletAddress: 'So11111111111111111111111111111111111111112',
    }, { force: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0];
    expect(request[0]).toContain('/auth/privy/verify');
    expect(JSON.parse((request[1] as RequestInit).body as string).accessToken).toBe('fresh-token');
    expect((request[1] as RequestInit).credentials).toBe('include');
  });
});
