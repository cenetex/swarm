import { describe, it, expect, vi } from 'vitest';
import { setupTelegramIntegration } from './telegram-admin.js';

const session = { email: 'test@example.com', userId: 'wallet-1', expiresAt: 0, isAdmin: false, accessToken: '' };

describe('telegram setup', () => {
  it('bails out when token is invalid', async () => {
    const updateAvatar = vi.fn(async () => undefined);
    const storeSecret = vi.fn(async () => undefined);
    const registerTelegramWebhook = vi.fn(async () => ({ success: true, message: 'ok', secretToken: 'secret' }));

    const result = await setupTelegramIntegration({
      avatarId: 'avatar-1',
      token: 'bad-token',
      session,
      deps: {
        validateTelegramToken: async () => ({ valid: false, error: 'Invalid' }),
        registerTelegramWebhook,
        generateWebhookSecret: () => 'secret',
        updateAvatar,
        storeSecret,
      },
    });

    expect(result.success).toBe(false);
    expect(updateAvatar).toHaveBeenCalledTimes(0);
    expect(storeSecret).toHaveBeenCalledTimes(0);
    expect(registerTelegramWebhook).toHaveBeenCalledTimes(0);
  });

  it('does not persist if webhook registration fails', async () => {
    const updateAvatar = vi.fn(async () => undefined);
    const storeSecret = vi.fn(async () => undefined);
    const registerTelegramWebhook = vi.fn(async () => ({ success: false, message: 'Failed' }));

    const result = await setupTelegramIntegration({
      avatarId: 'avatar-1',
      token: 'token',
      session,
      deps: {
        validateTelegramToken: async () => ({ valid: true, botInfo: { username: 'bot' } }),
        registerTelegramWebhook,
        generateWebhookSecret: () => 'secret',
        updateAvatar,
        storeSecret,
      },
    });

    expect(result.success).toBe(false);
    expect(updateAvatar).toHaveBeenCalledTimes(0);
    expect(storeSecret).toHaveBeenCalledTimes(0);
  });

  it('stores secrets after successful webhook registration', async () => {
    const calls: string[] = [];

    const updateAvatar = vi.fn(async () => {
      calls.push('updateAvatar');
    });
    const storeSecret = vi.fn(async () => {
      calls.push('storeSecret');
    });
    const registerTelegramWebhook = vi.fn(async () => {
      calls.push('registerWebhook');
      return { success: true, message: 'ok', secretToken: 'secret-token', webhookUrl: 'https://hook' };
    });

    const result = await setupTelegramIntegration({
      avatarId: 'avatar-1',
      token: 'token',
      session,
      deps: {
        validateTelegramToken: async () => ({ valid: true, botInfo: { username: 'bot', id: 1 } }),
        registerTelegramWebhook,
        generateWebhookSecret: () => 'secret-token',
        updateAvatar,
        storeSecret,
      },
    });

    expect(result.success).toBe(true);
    expect(calls[0]).toBe('registerWebhook');
    expect(updateAvatar).toHaveBeenCalledTimes(1);
    expect(storeSecret).toHaveBeenCalledTimes(2);
  });
});
