import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  disconnectHostedProvider,
  getHostedProviderStatus,
  openRouterConnectUrl,
  openRouterResult,
} from './hosted-api';

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
});
