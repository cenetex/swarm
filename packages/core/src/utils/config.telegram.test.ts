import { describe, it, expect } from 'vitest';
import { loadAvatarConfigFromEnv } from './config.js';

describe('config loader (telegram allowlists)', () => {
  it('parses snake_case allowlists and coerces values to strings', () => {
    process.env.AGENT_CONFIG_TEST = JSON.stringify({
      id: 'test',
      name: 'Test',
      platforms: {
        telegram: {
          enabled: true,
          bot_username: 'testbot',
          webhook_path: '/webhook/telegram/test',
          allowed_chat_ids: [-1001, '-1002'],
          allowed_dm_user_ids: [111, '222'],
        },
      },
      llm: { provider: 'openrouter', model: 'anthropic/claude-sonnet-4', temperature: 0.8, max_tokens: 128 },
      media: { image: { provider: 'replicate', model: 'black-forest-labs/flux-schnell' } },
      scheduling: {},
      behavior: {},
    });

    const cfg = loadAvatarConfigFromEnv('test');

    expect(cfg.platforms.telegram?.allowedChatIds).toEqual(['-1001', '-1002']);
    expect(cfg.platforms.telegram?.allowedDmUserIds).toEqual(['111', '222']);
  });

  it('parses camelCase allowlists and coerces values to strings', () => {
    process.env.AGENT_CONFIG_TEST2 = JSON.stringify({
      id: 'test2',
      name: 'Test2',
      platforms: {
        telegram: {
          enabled: true,
          botUsername: 'testbot2',
          webhookPath: '/webhook/telegram/test2',
          allowedChatIds: ['-1003', -1004],
          allowedDmUserIds: ['333', 444],
        },
      },
      llm: { provider: 'openrouter', model: 'anthropic/claude-sonnet-4', temperature: 0.8, maxTokens: 128 },
      media: { image: { provider: 'replicate', model: 'black-forest-labs/flux-schnell' } },
      scheduling: {},
      behavior: {},
    });

    const cfg = loadAvatarConfigFromEnv('test2');

    expect(cfg.platforms.telegram?.allowedChatIds).toEqual(['-1003', '-1004']);
    expect(cfg.platforms.telegram?.allowedDmUserIds).toEqual(['333', '444']);
  });
});
