import { describe, it, expect, vi } from 'vitest';
import { setupDiscordIntegration } from './discord-admin.js';
import type { DiscordBotWarning } from './discord.js';

const session = { email: 'test@example.com', userId: 'wallet-1', expiresAt: 0, isAdmin: false, accessToken: '' };

describe('discord setup', () => {
  it('bails out when token is invalid', async () => {
    const updateAvatar = vi.fn(async () => undefined);
    const storeSecret = vi.fn(async () => undefined);

    const result = await setupDiscordIntegration({
      avatarId: 'avatar-1',
      token: 'bad-token',
      session,
      deps: {
        validateBotToken: async () => ({ valid: false, error: 'Invalid bot token', warnings: [] }),
        updateAvatar,
        storeSecret,
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe('Invalid bot token');
    expect(result.warnings).toEqual([]);
    expect(updateAvatar).toHaveBeenCalledTimes(0);
    expect(storeSecret).toHaveBeenCalledTimes(0);
  });

  it('stores secret and updates avatar config on valid token', async () => {
    const updateAvatar = vi.fn(async () => undefined);
    const storeSecret = vi.fn(async () => undefined);

    const result = await setupDiscordIntegration({
      avatarId: 'avatar-1',
      token: 'valid-token',
      session,
      deps: {
        validateBotToken: async () => ({
          valid: true,
          botInfo: { id: '123456', username: 'TestBot' },
          warnings: [],
        }),
        updateAvatar,
        storeSecret,
      },
    });

    expect(result.success).toBe(true);
    expect(result.botInfo).toEqual({ id: '123456', username: 'TestBot' });
    expect(result.warnings).toEqual([]);

    expect(updateAvatar).toHaveBeenCalledTimes(1);
    expect(updateAvatar).toHaveBeenCalledWith(
      'avatar-1',
      {
        platforms: {
          discord: {
            enabled: true,
            mode: 'bot',
            botUsername: 'TestBot',
            botId: '123456',
            respondToMentions: true,
            respondInDMs: true,
          },
        },
      },
      session
    );

    expect(storeSecret).toHaveBeenCalledTimes(1);
    expect(storeSecret).toHaveBeenCalledWith(
      'avatar-1',
      'discord_bot_token',
      'default',
      'valid-token',
      session,
      'Discord bot token for avatar-1'
    );
  });

  it('passes through warnings from validation on successful setup', async () => {
    const updateAvatar = vi.fn(async () => undefined);
    const storeSecret = vi.fn(async () => undefined);

    const mockWarnings: DiscordBotWarning[] = [
      {
        severity: 'error',
        code: 'missing_intent_message_content_intent',
        message: 'Message Content Intent is not enabled.',
      },
      {
        severity: 'warning',
        code: 'missing_intent_presence_intent',
        message: 'Presence Intent is not enabled.',
      },
    ];

    const result = await setupDiscordIntegration({
      avatarId: 'avatar-1',
      token: 'valid-token',
      session,
      deps: {
        validateBotToken: async () => ({
          valid: true,
          botInfo: { id: '123456', username: 'TestBot' },
          warnings: mockWarnings,
        }),
        updateAvatar,
        storeSecret,
      },
    });

    expect(result.success).toBe(true);
    expect(result.warnings).toEqual(mockWarnings);
    expect(result.warnings).toHaveLength(2);

    // Token should still be saved even with warnings
    expect(storeSecret).toHaveBeenCalledTimes(1);
    expect(updateAvatar).toHaveBeenCalledTimes(1);
  });

  it('propagates error when storeSecret fails', async () => {
    const updateAvatar = vi.fn(async () => undefined);
    const storeSecret = vi.fn(async () => {
      throw new Error('Secrets Manager unavailable');
    });

    await expect(
      setupDiscordIntegration({
        avatarId: 'avatar-1',
        token: 'valid-token',
        session,
        deps: {
          validateBotToken: async () => ({
            valid: true,
            botInfo: { id: '123456', username: 'TestBot' },
            warnings: [],
          }),
          updateAvatar,
          storeSecret,
        },
      })
    ).rejects.toThrow('Secrets Manager unavailable');
  });
});
