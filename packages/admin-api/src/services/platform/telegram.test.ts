import { describe, it, expect, vi } from 'vitest';
import { getManagedBotToken, registerTelegramWebhook } from './telegram.js';

describe('telegram service', () => {
  it('registerTelegramWebhook includes my_chat_member in allowed_updates', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      calls.push({ url: urlStr, init });

      if (urlStr.includes('/setWebhook')) {
        return {
          json: async () => ({ ok: true }),
        } as any;
      }

      if (urlStr.includes('/getWebhookInfo')) {
        return {
          json: async () => ({ ok: true, result: { url: 'https://example.com/webhook/telegram/avatar-1' } }),
        } as any;
      }

      return {
        json: async () => ({ ok: true }),
      } as any;
    }) as any;

    try {
      const result = await registerTelegramWebhook('bot-token', 'avatar-1', 'secret');
      expect(result.success).toBe(true);

      const setWebhookCall = calls.find(c => c.url.includes('/setWebhook'));
      expect(setWebhookCall).toBeTruthy();

      const body = JSON.parse(String(setWebhookCall!.init?.body ?? '{}')) as {
        allowed_updates?: string[];
      };

      expect(Array.isArray(body.allowed_updates)).toBe(true);
      expect(body.allowed_updates).toContain('my_chat_member');
      expect(body.allowed_updates).toContain('managed_bot');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('getManagedBotToken fetches a managed bot token by bot user ID', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      calls.push({ url: urlStr, init });

      return {
        json: async () => ({ ok: true, result: '987654321:managed-token' }),
      } as any;
    }) as any;

    try {
      const result = await getManagedBotToken('manager-token', 987654321);
      expect(result).toEqual({ success: true, token: '987654321:managed-token' });

      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toContain('/botmanager-token/getManagedBotToken');
      expect(calls[0]!.init?.method).toBe('POST');
      expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ user_id: 987654321 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('getManagedBotToken reports Telegram failures without a token', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => ({
      json: async () => ({ ok: false, description: 'Bad Request: managed bot unavailable' }),
    })) as any;

    try {
      const result = await getManagedBotToken('manager-token', 987654321);
      expect(result.success).toBe(false);
      expect(result.token).toBeUndefined();
      expect(result.error).toBe('Bad Request: managed bot unavailable');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
