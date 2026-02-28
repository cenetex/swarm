import { describe, it, expect, vi } from 'vitest';
import { registerTelegramWebhook } from './telegram.js';

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
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
