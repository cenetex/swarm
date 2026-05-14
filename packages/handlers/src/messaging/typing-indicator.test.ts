import { afterEach, describe, expect, it } from 'vitest';
import { createTypingSender } from './typing-indicator.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('typing indicator sender', () => {
  it('creates a Telegram typing sender', async () => {
    let capturedUrl = '';
    let capturedBody = '';

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedBody = String(init?.body);
      return new Response('', { status: 200 });
    }) as typeof fetch;

    const sender = createTypingSender('telegram', { TELEGRAM_BOT_TOKEN: 'tg-token' }, '12345');

    expect(sender).toBeDefined();
    await sender?.();
    expect(capturedUrl).toBe('https://api.telegram.org/bottg-token/sendChatAction');
    expect(JSON.parse(capturedBody)).toEqual({ chat_id: '12345', action: 'typing' });
  });

  it('creates a Discord typing sender', async () => {
    let capturedUrl = '';
    let capturedMethod = '';
    let capturedHeaders: Record<string, string> = {};

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedMethod = init?.method || '';
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response('', { status: 204 });
    }) as typeof fetch;

    const sender = createTypingSender('discord', { DISCORD_BOT_TOKEN: 'discord-token' }, 'channel-1');

    expect(sender).toBeDefined();
    await sender?.();
    expect(capturedUrl).toBe('https://discord.com/api/v10/channels/channel-1/typing');
    expect(capturedMethod).toBe('POST');
    expect(capturedHeaders.Authorization).toBe('Bot discord-token');
  });

  it('uses lowercase Discord secret fallback', async () => {
    let capturedHeaders: Record<string, string> = {};

    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response('', { status: 204 });
    }) as typeof fetch;

    const sender = createTypingSender('discord', { discord_bot_token: 'lower-token' }, 'channel-1');

    await sender?.();
    expect(capturedHeaders.Authorization).toBe('Bot lower-token');
  });

  it('skips unsupported platforms and missing tokens', () => {
    expect(createTypingSender('twitter', {}, 'conv')).toBeUndefined();
    expect(createTypingSender('discord', {}, 'conv')).toBeUndefined();
    expect(createTypingSender('telegram', {}, 'conv')).toBeUndefined();
  });

  it('does not throw when the platform request fails', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as typeof fetch;

    const sender = createTypingSender('discord', { DISCORD_BOT_TOKEN: 'discord-token' }, 'channel-1');

    await expect(sender?.()).resolves.toBeUndefined();
  });
});
