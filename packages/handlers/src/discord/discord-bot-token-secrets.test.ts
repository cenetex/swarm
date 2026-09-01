import { describe, expect, it } from 'bun:test';
import type { SecretsService } from '@swarm/core';
import {
  listGlobalDiscordBotTokenSecretIds,
  resolveDiscordVoiceBotToken,
} from './discord-bot-token-secrets.js';

function makeSecretsService(
  getSecret: SecretsService['getSecret'],
): SecretsService {
  return {
    getSecret,
    getSecretJson: async () => {
      throw new Error('not used');
    },
  };
}

describe('resolveDiscordVoiceBotToken', () => {
  it('prefers a token already loaded for the avatar', async () => {
    const requestedSecretIds: string[] = [];
    const result = await resolveDiscordVoiceBotToken({
      avatarId: 'ruby',
      loadedSecrets: { DISCORD_BOT_TOKEN: 'avatar-token' },
      secretsService: makeSecretsService(async (secretId) => {
        requestedSecretIds.push(secretId);
        return 'global-token';
      }),
    });

    expect(result).toEqual({
      token: 'avatar-token',
      source: 'loaded-avatar-secrets',
    });
    expect(requestedSecretIds).toEqual([]);
  });

  it('checks per-avatar secret paths before the global fallback', async () => {
    const requestedSecretIds: string[] = [];
    const result = await resolveDiscordVoiceBotToken({
      avatarId: 'ruby',
      loadedSecrets: {},
      secretsService: makeSecretsService(async (secretId) => {
        requestedSecretIds.push(secretId);
        if (secretId === 'swarm/ruby/discord_bot_token/default') {
          return 'per-avatar-token';
        }
        if (secretId === 'swarm/global/discord_bot_token/global-bot') {
          return 'global-token';
        }
        throw new Error('not found');
      }),
    });

    expect(result).toEqual({
      token: 'per-avatar-token',
      source: 'avatar-secret',
      secretId: 'swarm/ruby/discord_bot_token/default',
    });
    expect(requestedSecretIds).toEqual([
      'swarm/ruby/discord_bot_token/default',
    ]);
  });

  it('falls back to the JSON-wrapped global bot token', async () => {
    const requestedSecretIds: string[] = [];
    const result = await resolveDiscordVoiceBotToken({
      avatarId: 'ruby',
      loadedSecrets: {},
      secretsService: makeSecretsService(async (secretId) => {
        requestedSecretIds.push(secretId);
        if (secretId === 'custom/global/discord_bot_token/global-bot') {
          return JSON.stringify({ DISCORD_BOT_TOKEN: 'global-token' });
        }
        throw new Error('not found');
      }),
      secretPrefix: 'custom',
    });

    expect(result).toEqual({
      token: 'global-token',
      source: 'global-secret',
      secretId: 'custom/global/discord_bot_token/global-bot',
    });
    expect(requestedSecretIds.at(-1)).toBe('custom/global/discord_bot_token/global-bot');
    expect(requestedSecretIds.slice(0, 4).every((id) => id.startsWith('custom/ruby/')))
      .toBe(true);
  });

  it('keeps the global secret paths aligned with the gateway worker', () => {
    expect(listGlobalDiscordBotTokenSecretIds('custom')).toEqual([
      'custom/global/discord_bot_token/global-bot',
      'custom/global/discord-bot-token/global-bot',
      'custom/global/discord_bot_token/default',
      'custom/global/discord-bot-token/default',
    ]);
  });
});
