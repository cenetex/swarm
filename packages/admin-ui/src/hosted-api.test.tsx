import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  connectHostedTelegram,
  disconnectHostedTelegram,
  disconnectHostedProvider,
  forgetHostedTelegramGroup,
  getHostedProviderStatus,
  getHostedTelegramStatus,
  importHostedAvatar,
  listPublicHostedAvatars,
  openRouterConnectUrl,
  openRouterResult,
  setHostedTelegramGroupEnabled,
  updateHostedAvatarProfile,
} from './hosted-api';

const testBotToken = `123456789:${'A'.repeat(36)}`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('hosted API client', () => {
  it('recognizes only safe OpenRouter callback results', () => {
    expect(openRouterResult('?openrouter=connected')).toBe('connected');
    expect(openRouterResult('?openrouter=error')).toBe('error');
    expect(openRouterResult('?openrouter=sk-secret')).toBeNull();
    expect(openRouterConnectUrl()).toMatch(/\/auth\/openrouter$/u);
  });

  it('loads connection status through the cookie-backed same-origin API', async () => {
    const fetchMock = vi.fn(async () => Response.json({ connected: true, provider: 'openrouter' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(getHostedProviderStatus()).resolves.toEqual({ connected: true, provider: 'openrouter' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toMatch(/\/auth\/openrouter\/status$/u);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: 'include' });
  });

  it('disconnects without returning or sending a credential', async () => {
    const fetchMock = vi.fn(async () => Response.json({ connected: false, provider: null }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(disconnectHostedProvider()).resolves.toEqual({ connected: false, provider: null });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'DELETE', credentials: 'include' });
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();
  });

  it('uses an avatar-scoped Telegram API and never receives the BotFather token back', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => Response.json({
      connected: true,
      status: 'binding_required',
      ownerBound: false,
      bot: { id: '123', username: 'JaxSwarmBot', name: 'Jax' },
      ownerBindUrl: 'https://t.me/JaxSwarmBot?start=code',
    }, { status: init?.method === 'POST' ? 201 : 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const status = await connectHostedTelegram(
      'avatar/one',
      testBotToken,
    );
    expect(status).not.toHaveProperty('botToken');
    expect(fetchMock.mock.calls[0]?.[0]).toMatch(/\/avatars\/avatar%2Fone\/integrations\/telegram$/u);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      botToken: testBotToken,
    });

    await getHostedTelegramStatus('avatar/one');
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBeUndefined();
  });

  it('disconnects Telegram without sending a stored credential', async () => {
    const fetchMock = vi.fn(async () => Response.json({ disconnected: true }));
    vi.stubGlobal('fetch', fetchMock);

    await disconnectHostedTelegram('avatar-1');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'DELETE', credentials: 'include' });
    expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();
  });

  it('saves companion identity and prompt through the avatar route', async () => {
    const fetchMock = vi.fn(async () => Response.json({
      avatarId: 'avatar/one',
      name: 'Ada',
      persona: 'Be direct.',
    }));
    vi.stubGlobal('fetch', fetchMock);

    await updateHostedAvatarProfile('avatar/one', {
      name: 'Ada',
      description: 'Research companion',
      persona: 'Be direct.',
    });

    expect(fetchMock.mock.calls[0]?.[0]).toMatch(/\/avatars\/avatar%2Fone$/u);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'PATCH',
      credentials: 'include',
      body: JSON.stringify({
        name: 'Ada',
        description: 'Research companion',
        persona: 'Be direct.',
      }),
    });
  });

  it('reads the public registry without auth headers and imports a portable artifact', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => Response.json(
      init?.method === 'POST' ? { avatarId: 'avatar-1' } : [],
      { status: init?.method === 'POST' ? 201 : 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await listPublicHostedAvatars();
    expect(fetchMock.mock.calls[0]?.[0]).toMatch(/\/public\/avatars$/u);

    const bundle = { schema: 'swarm.avatar/v1' };
    await importHostedAvatar(bundle);
    expect(fetchMock.mock.calls[1]?.[0]).toMatch(/\/avatars\/import$/u);
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ bundle });
  });

  it('uses avatar-scoped routes for Telegram group controls', async () => {
    const fetchMock = vi.fn(async () => Response.json({
      connected: true,
      status: 'connected',
      ownerBound: true,
      groups: [],
    }));
    vi.stubGlobal('fetch', fetchMock);

    await setHostedTelegramGroupEnabled('avatar/one', '-1001', false);
    expect(fetchMock.mock.calls[0]?.[0]).toMatch(
      /\/avatars\/avatar%2Fone\/integrations\/telegram\/groups\/-1001$/u,
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'PATCH',
      credentials: 'include',
      body: JSON.stringify({ enabled: false }),
    });

    await forgetHostedTelegramGroup('avatar/one', '-1001');
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'DELETE', credentials: 'include' });
  });
});
