import type { SecretsService } from '@swarm/core';

const DEFAULT_SECRET_PREFIX = 'swarm';

export interface DiscordBotTokenLookupResult {
  token: string;
  source: 'loaded-avatar-secrets' | 'avatar-secret' | 'global-secret';
  secretId?: string;
}

export function parseDiscordTokenSecret(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, string>;
    return parsed.DISCORD_BOT_TOKEN || parsed.discord_bot_token || parsed.token || raw;
  } catch {
    return raw;
  }
}

export function listAvatarDiscordBotTokenSecretIds(
  avatarId: string,
  secretPrefix = DEFAULT_SECRET_PREFIX,
): string[] {
  return [
    `${secretPrefix}/${avatarId}/discord_bot_token/default`,
    `${secretPrefix}/${avatarId}/discord_bot_token`,
    `${secretPrefix}/${avatarId}/discord-bot-token/default`,
    `${secretPrefix}/${avatarId}/discord-bot-token`,
  ];
}

export function listGlobalDiscordBotTokenSecretIds(
  secretPrefix = DEFAULT_SECRET_PREFIX,
): string[] {
  return [
    `${secretPrefix}/global/discord_bot_token/global-bot`,
    `${secretPrefix}/global/discord-bot-token/global-bot`,
    `${secretPrefix}/global/discord_bot_token/default`,
    `${secretPrefix}/global/discord-bot-token/default`,
  ];
}

export async function resolveDiscordVoiceBotToken(params: {
  avatarId: string;
  loadedSecrets: Record<string, string>;
  secretsService: SecretsService;
  secretPrefix?: string;
}): Promise<DiscordBotTokenLookupResult | null> {
  const loadedToken = params.loadedSecrets.DISCORD_BOT_TOKEN
    || params.loadedSecrets.discord_bot_token;
  if (loadedToken) {
    return {
      token: loadedToken,
      source: 'loaded-avatar-secrets',
    };
  }

  const secretPrefix = params.secretPrefix || DEFAULT_SECRET_PREFIX;
  const candidates: Array<{
    source: DiscordBotTokenLookupResult['source'];
    secretId: string;
  }> = [
    ...listAvatarDiscordBotTokenSecretIds(params.avatarId, secretPrefix)
      .map((secretId) => ({ source: 'avatar-secret' as const, secretId })),
    ...listGlobalDiscordBotTokenSecretIds(secretPrefix)
      .map((secretId) => ({ source: 'global-secret' as const, secretId })),
  ];

  for (const candidate of candidates) {
    try {
      const token = parseDiscordTokenSecret(
        await params.secretsService.getSecret(candidate.secretId),
      );
      if (token) {
        return {
          token,
          source: candidate.source,
          secretId: candidate.secretId,
        };
      }
    } catch {
      // Try the next supported per-avatar or global token convention.
    }
  }

  return null;
}
