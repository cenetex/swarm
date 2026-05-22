import { describe, expect, it } from 'bun:test';
import { listTelegramBotTokenSecretIds } from './bot-token-secrets.js';

describe('listTelegramBotTokenSecretIds', () => {
  it('uses per-avatar token candidates by default', () => {
    const ids = listTelegramBotTokenSecretIds('avatar-1');

    expect(ids).toContain('swarm/avatar-1/telegram_bot_token/default');
    expect(ids).toContain('swarm/avatar-1/telegram_bot_token');
    expect(ids).not.toContain('swarm/global/telegram_bot_token/default');
  });

  it('includes shared token candidates for managed admin bots', () => {
    const ids = listTelegramBotTokenSecretIds('admin-bot', { allowGlobalFallback: true });

    expect(ids).toContain('swarm/admin-bot/telegram_bot_token/default');
    expect(ids).toContain('swarm/global/telegram_bot_token/default');
    expect(ids).toContain('swarm/global/telegram_bot_token/global-bot');
    expect(ids).toContain('swarm/shared/telegram_bot_token/default');
    expect(ids).toContain('swarm/global/telegram-bot-token/default');
  });
});
