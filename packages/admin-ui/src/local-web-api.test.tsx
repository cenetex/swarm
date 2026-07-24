import { beforeEach, describe, expect, test, vi } from 'vitest';

function installMemoryLocalStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
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
}

describe('web-local credential boundary', () => {
  let storage: Storage;

  beforeEach(() => {
    vi.resetModules();
    storage = installMemoryLocalStorage();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: storage,
    });
  });

  test('migrates legacy plaintext credentials out of persistent state', async () => {
    storage.setItem('swarm:web-local:v1', JSON.stringify({
      avatars: [],
      chats: {
        global: Array.from({ length: 105 }, (_, index) => ({
          role: 'user',
          content: `message-${index}`,
        })),
      },
      secrets: {
        'llm-api-key': 'provider-secret',
      },
      avatarSecrets: {
        avatar: { telegram: 'avatar-secret' },
      },
      agentBackends: {
        global: {
          backend: 'custom',
          endpoint: 'http://localhost:9000',
          apiKey: 'backend-secret',
          deploymentTarget: 'local',
        },
      },
    }));

    const { readLocalWebState } = await import('./local-web-api');
    const state = readLocalWebState();
    const persisted = storage.getItem('swarm:web-local:v1') ?? '';

    expect(state.chats.global).toHaveLength(100);
    expect(state.credentialMigrationRequired).toBe(true);
    expect(persisted).not.toContain('provider-secret');
    expect(persisted).not.toContain('avatar-secret');
    expect(persisted).not.toContain('backend-secret');
  });

  test('rejects browser-local secret writes', async () => {
    const { routeLocalApi } = await import('./local-web-api');
    const response = await routeLocalApi(new Request('http://localhost/api/secrets/llm-api-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'must-not-persist' }),
    }));

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(501);
    expect(storage.getItem('swarm:web-local:v1')).toBeNull();
  });

  test('allows activation only on loopback hosts', async () => {
    const { isWebLocalHostAllowed } = await import('./local-web-api');

    expect(isWebLocalHostAllowed('localhost')).toBe(true);
    expect(isWebLocalHostAllowed('127.0.0.1')).toBe(true);
    expect(isWebLocalHostAllowed('rati.chat')).toBe(false);
    expect(isWebLocalHostAllowed('www.rati.chat')).toBe(false);
    expect(isWebLocalHostAllowed('swarm.rati.chat')).toBe(false);
  });
});
