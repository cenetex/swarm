import { describe, it, expect } from 'vitest';
import { diagnoseTelegram } from './telegram-admin.js';

describe('telegram diagnostics', () => {
  it('reports missing token and returns early', async () => {
    const result = await diagnoseTelegram('avatar-1', {
      getAvatar: async () => ({
        id: 'avatar-1',
        name: 'A',
        platforms: { telegram: { enabled: true } },
        llmConfig: { provider: 'x', model: 'y', temperature: 0.7, maxTokens: 1000 },
      } as any),
      getSecretValueForAvatar: async (_avatarId, secretType) => {
        if (secretType === 'telegram_bot_token') return null;
        if (secretType === 'telegram_webhook_secret') return 'whsec';
        return null;
      },
      getLastTelegramUpdateSnapshot: async () => undefined,
    });

    expect(result.tokenPresent).toBe(false);
    expect(result.issues.some(i => i.code === 'missing_bot_token')).toBe(true);
  });

  it('includes webhook mismatch and pending updates', async () => {
    const result = await diagnoseTelegram('avatar-1', {
      now: () => 1_700_000_000_000,
      getAvatar: async () => ({
        id: 'avatar-1',
        name: 'A',
        platforms: { telegram: { enabled: true } },
        llmConfig: { provider: 'x', model: 'y', temperature: 0.7, maxTokens: 1000 },
      } as any),
      getSecretValueForAvatar: async (_avatarId, secretType) => {
        if (secretType === 'telegram_bot_token') return 'token';
        if (secretType === 'telegram_webhook_secret') return 'whsec';
        return null;
      },
      validateTelegramToken: async () => ({
        valid: true,
        botInfo: { id: 1, username: 'bot', firstName: 'Bot' },
      }),
      getTelegramWebhookInfoDetailed: async () => ({
        url: 'https://wrong.example/webhook/telegram/avatar-1',
        pending_update_count: 3,
        last_error_message: 'failed',
        last_error_date: 1700000000,
      }),
      getTelegramWebhookUrlForAvatar: () => 'https://expected.example/webhook/telegram/avatar-1',
      getLastTelegramUpdateSnapshot: async () => ({
        receivedAt: 1_700_000_000_000 - 12_000,
        updateId: 123,
        chatId: 1,
        chatType: 'private',
        messageId: 9,
        textPreview: 'hello',
      }),
    });

    expect(result.webhook.isCorrectUrl).toBe(false);
    expect(result.webhook.pendingUpdateCount).toBe(3);
    expect(result.lastUpdate?.secondsAgo).toBe(12);
    expect(result.issues.some(i => i.code === 'webhook_url_mismatch')).toBe(true);
    expect(result.issues.some(i => i.code === 'webhook_pending_updates')).toBe(true);
    expect(result.issues.some(i => i.code === 'webhook_last_error')).toBe(true);
  });
});
