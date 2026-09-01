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
    window.history.replaceState({}, '', '/');
    storage = installMemoryLocalStorage();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: storage,
    });
  });

  test('migrates legacy plaintext credentials out of persistent state', async () => {
    storage.setItem('swarm:web-local:v1', JSON.stringify({
      avatars: [{
        avatarId: 'avatar',
        name: 'Legacy',
        status: 'draft',
        createdAt: 1,
        updatedAt: 1,
        createdBy: 'local-web',
        llmConfig: { model: 'safe-model', apiKey: 'nested-avatar-key' },
      }],
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
          endpoint: 'http://user:password@localhost:9000/?_token=endpoint-secret',
          apiKey: 'backend-secret',
          deploymentTarget: 'local',
        },
      },
    }));

    const { readLocalWebState, routeLocalApi } = await import('./local-web-api');
    const state = readLocalWebState();
    const persisted = storage.getItem('swarm:web-local:v1') ?? '';
    const chatResponse = await routeLocalApi(new Request('http://localhost/api/chat?avatarId=global')) as Response;
    const chatPage = await chatResponse.json() as { history: Array<{ content: string }> };

    expect(chatPage.history).toHaveLength(100);
    expect(chatPage.history[0].content).toBe('message-5');
    expect(state.credentialMigrationRequired).toBe(true);
    expect(JSON.parse(persisted)).not.toHaveProperty('chats');
    expect(persisted).not.toContain('provider-secret');
    expect(persisted).not.toContain('avatar-secret');
    expect(persisted).not.toContain('backend-secret');
    expect(persisted).not.toContain('nested-avatar-key');
    expect(persisted).not.toContain('endpoint-secret');
    expect(persisted).not.toContain('password');
  });

  test('rejects browser-local secret writes', async () => {
    const { routeLocalApi } = await import('./local-web-api');
    const providerResponse = await routeLocalApi(new Request('http://localhost/api/secrets/llm-api-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 'must-not-persist' }),
    }));
    const backendResponse = await routeLocalApi(new Request('http://localhost/api/agent-backends/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backend: 'custom', apiKey: 'also-must-not-persist' }),
    }));

    expect(providerResponse).toBeInstanceOf(Response);
    expect((providerResponse as Response).status).toBe(501);
    expect((backendResponse as Response).status).toBe(501);
    expect(storage.getItem('swarm:web-local:v1')).toBeNull();
  });

  test('allows only non-sensitive avatar and endpoint fields into persistent state', async () => {
    const { routeLocalApi } = await import('./local-web-api');
    const created = await routeLocalApi(new Request('http://localhost/api/avatars', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Safe avatar' }),
    })) as Response;
    const avatar = await created.json() as { avatarId: string };

    await routeLocalApi(new Request(`http://localhost/api/avatars/${avatar.avatarId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Updated avatar',
        apiKey: 'top-level-key',
        secrets: [{ key: 'OPENROUTER_API_KEY', value: 'avatar-secret-value' }],
        llmConfig: { model: 'safe-model', apiKey: 'nested-key' },
      }),
    }));
    await routeLocalApi(new Request('http://localhost/api/agent-backends/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        backend: 'custom',
        endpoint: 'http://user:password@localhost:9000/?api_key=endpoint-key&mode=safe',
      }),
    }));

    const persisted = storage.getItem('swarm:web-local:v1') ?? '';
    expect(persisted).toContain('Updated avatar');
    expect(persisted).toContain('safe-model');
    expect(persisted).toContain('mode=safe');
    expect(persisted).not.toContain('top-level-key');
    expect(persisted).not.toContain('avatar-secret-value');
    expect(persisted).not.toContain('nested-key');
    expect(persisted).not.toContain('endpoint-key');
    expect(persisted).not.toContain('password');
  });

  test('allows activation only on loopback hosts', async () => {
    const { isWebLocalHostAllowed } = await import('./local-web-api');

    expect(isWebLocalHostAllowed('localhost')).toBe(true);
    expect(isWebLocalHostAllowed('127.0.0.1')).toBe(true);
    expect(isWebLocalHostAllowed('rati.chat')).toBe(false);
    expect(isWebLocalHostAllowed('www.rati.chat')).toBe(false);
    expect(isWebLocalHostAllowed('swarm.rati.chat')).toBe(false);
  });

  test('runs the plaintext purge even when the web-local adapter is not installed', async () => {
    storage.setItem('swarm:web-local:v1', JSON.stringify({
      secrets: { provider: 'legacy-provider-key' },
      avatars: [],
      chats: {},
      agentBackends: {},
    }));
    const originalFetch = window.fetch;
    const { initializeLocalWebApi } = await import('./local-web-api');

    initializeLocalWebApi();

    expect(window.fetch).toBe(originalFetch);
    expect(storage.getItem('swarm:web-local:v1')).not.toContain('legacy-provider-key');
  });

  test('paginates bounded chat history outside localStorage', async () => {
    storage.setItem('swarm:web-local:v1', JSON.stringify({
      avatars: [],
      chats: {
        global: Array.from({ length: 105 }, (_, index) => ({ role: 'user', content: `message-${index}` })),
      },
      agentBackends: {},
    }));
    const { routeLocalApi } = await import('./local-web-api');

    const latestResponse = await routeLocalApi(new Request('http://localhost/api/chat?avatarId=global&limit=10')) as Response;
    const latest = await latestResponse.json() as { history: Array<{ content: string }>; nextCursor: string | null };
    const olderResponse = await routeLocalApi(new Request(`http://localhost/api/chat?avatarId=global&limit=10&before=${latest.nextCursor}`)) as Response;
    const older = await olderResponse.json() as { history: Array<{ content: string }>; nextCursor: string | null };

    expect(latest.history.map((message) => message.content)).toEqual(
      Array.from({ length: 10 }, (_, index) => `message-${index + 95}`),
    );
    expect(older.history.map((message) => message.content)).toEqual(
      Array.from({ length: 10 }, (_, index) => `message-${index + 85}`),
    );
    await routeLocalApi(new Request('http://localhost/api/chat/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ avatarId: 'global', message: { role: 'user', content: 'x'.repeat(40_000) } }),
    }));
    const boundedResponse = await routeLocalApi(new Request('http://localhost/api/chat?avatarId=global&limit=1')) as Response;
    const bounded = await boundedResponse.json() as { history: Array<{ content: string }> };
    expect(bounded.history[0].content).toHaveLength(32_000);
    expect(JSON.parse(storage.getItem('swarm:web-local:v1') ?? '{}')).not.toHaveProperty('chats');
  });

  test('bounds the number of persisted conversations', async () => {
    const { localWebChatStore, MAX_LOCAL_CHAT_CONVERSATIONS } = await import('./local-web-chat-store');

    for (let index = 0; index <= MAX_LOCAL_CHAT_CONVERSATIONS; index += 1) {
      await localWebChatStore.replaceHistory(`avatar-${String(index).padStart(3, '0')}`, [
        { role: 'user', content: `message-${index}` },
      ]);
    }

    expect((await localWebChatStore.getPage('avatar-000')).history).toEqual([]);
    expect((await localWebChatStore.getPage(`avatar-${String(MAX_LOCAL_CHAT_CONVERSATIONS).padStart(3, '0')}`)).history)
      .toEqual([{ role: 'user', content: `message-${MAX_LOCAL_CHAT_CONVERSATIONS}` }]);
  });

  test('clears the rotation warning only after acknowledgement', async () => {
    storage.setItem('swarm:web-local:v1', JSON.stringify({
      avatars: [],
      chats: {},
      avatarSecrets: { avatar: { token: 'legacy-avatar-secret' } },
      agentBackends: {},
    }));
    const { acknowledgeCredentialRotation, migrateLegacyLocalWebState, readLocalWebState } = await import('./local-web-api');

    expect(migrateLegacyLocalWebState()).toBe(true);
    acknowledgeCredentialRotation();

    expect(readLocalWebState().credentialMigrationRequired).toBe(false);
  });

  test('previews and saves persona edits in browser-local mode', async () => {
    const { routeLocalApi } = await import('./local-web-api');
    const created = await routeLocalApi(new Request('http://localhost/api/avatars', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Opus' }),
    })) as Response;
    const avatar = await created.json() as { avatarId: string };

    const preview = await routeLocalApi(new Request(`http://localhost/api/avatars/${avatar.avatarId}/persona/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persona: 'Warm and playful' }),
    })) as Response;
    const previewBody = await preview.json() as { diff: { added: string[] } };
    expect(previewBody.diff.added).toEqual(['Warm and playful']);

    const saved = await routeLocalApi(new Request(`http://localhost/api/avatars/${avatar.avatarId}/persona`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persona: 'Warm and playful' }),
    })) as Response;
    expect((await saved.json() as { persona: string }).persona).toBe('Warm and playful');

    const current = await routeLocalApi(new Request(`http://localhost/api/avatars/${avatar.avatarId}/persona`)) as Response;
    expect((await current.json() as { persona: string }).persona).toBe('Warm and playful');
  });
});
