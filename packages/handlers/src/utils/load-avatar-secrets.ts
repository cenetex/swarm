import type { SecretsService } from '@swarm/core';

export type LoadedAvatarSecrets = Record<string, string>;

async function tryGetSecret(
  secretsService: SecretsService,
  secretId: string
): Promise<string | undefined> {
  try {
    return await secretsService.getSecret(secretId);
  } catch {
    return undefined;
  }
}

async function getFirstSecret(
  secretsService: SecretsService,
  candidates: string[]
): Promise<string | undefined> {
  for (const id of candidates) {
    const value = await tryGetSecret(secretsService, id);
    if (value) return value;
  }
  return undefined;
}

function secretCandidates(
  secretPrefix: string,
  avatarId: string,
  name: string,
  environment?: string
): string[] {
  // We currently have multiple conventions in the system:
  // - JSON blob: `${prefix}/${avatarId}/secrets` (handled separately)
  // - Per-secret, with /default suffix: `${prefix}/${avatarId}/${name}/default`
  // - Per-secret, without /default suffix: `${prefix}/${avatarId}/${name}`
  // - Global/shared fallbacks for some handlers
  const envName = environment?.trim();
  const variants = Array.from(new Set([
    name,
    name.replaceAll('_', '-'),
  ]));

  const ids: string[] = [];
  for (const variant of variants) {
    const base = `${secretPrefix}/${avatarId}/${variant}`;
    const globalBase = `${secretPrefix}/global/${variant}`;
    const sharedBase = `${secretPrefix}/shared/${variant}`;
    const envBase = envName ? `${secretPrefix}/${envName}/${variant}` : undefined;

    ids.push(
      `${base}/default`,
      base,
      `${globalBase}/default`,
      `${globalBase}/global-bot`,
      globalBase,
      `${sharedBase}/default`,
      sharedBase,
    );

    if (envBase) {
      ids.push(`${envBase}/default`, envBase);
    }
  }

  return ids;

}

function secretCandidatesWithNames(
  secretPrefix: string,
  avatarId: string,
  secretType: string,
  secretNames: string[],
  environment?: string
): string[] {
  const envName = environment?.trim();
  const typeVariants = Array.from(new Set([
    secretType,
    secretType.replaceAll('_', '-'),
  ]));

  const nameVariants = Array.from(new Set(
    secretNames.flatMap(n => [n, n.replaceAll('_', '-'), n.replaceAll('-', '_')])
  ));

  const ids: string[] = [];
  for (const typeVariant of typeVariants) {
    for (const nameVariant of nameVariants) {
      const base = `${secretPrefix}/${avatarId}/${typeVariant}/${nameVariant}`;
      const globalBase = `${secretPrefix}/global/${typeVariant}/${nameVariant}`;
      const sharedBase = `${secretPrefix}/shared/${typeVariant}/${nameVariant}`;
      const envBase = envName ? `${secretPrefix}/${envName}/${typeVariant}/${nameVariant}` : undefined;

      ids.push(base, globalBase, sharedBase);
      if (envBase) ids.push(envBase);
    }
  }
  return ids;
}

type TwitterAppCredentials = {
  TWITTER_APP_KEY?: string;
  TWITTER_APP_SECRET?: string;
  consumer_key?: string;
  consumer_secret?: string;
  consumerKey?: string;
  consumerSecret?: string;
};

async function tryGetTwitterAppCredentials(
  secretsService: SecretsService,
  secretPrefix: string,
): Promise<{ appKey: string; appSecret: string } | undefined> {
  const candidates = [
    `${secretPrefix}/global/twitter-app-credentials`,
    `${secretPrefix}/global/twitter-app-credentials/default`,
  ];

  for (const id of candidates) {
    try {
      const parsed = await secretsService.getSecretJson<TwitterAppCredentials>(id);
      const appKey = parsed.TWITTER_APP_KEY || parsed.consumer_key || parsed.consumerKey;
      const appSecret = parsed.TWITTER_APP_SECRET || parsed.consumer_secret || parsed.consumerSecret;
      if (appKey && appSecret) {
        return { appKey, appSecret };
      }
    } catch {
      // Try next.
    }
  }
  return undefined;
}

/**
 * Loads secrets for handlers.
 *
 * Primary: JSON secret at `${secretPrefix}/${avatarId}/secrets`.
 * Fallback: individual secrets (twitter + LLM/media basics) using several naming conventions.
 */
export async function loadAvatarSecrets(
  secretsService: SecretsService,
  avatarId: string,
  secretPrefix: string = 'swarm',
  preferredJsonSecretId?: string
): Promise<LoadedAvatarSecrets> {
  const environment = process.env.ENVIRONMENT;

  // 1) Prefer a JSON blob (existing behavior for many handlers)
  const jsonCandidates = [preferredJsonSecretId, `${secretPrefix}/${avatarId}/secrets`]
    .filter(Boolean) as string[];

  for (const id of jsonCandidates) {
    try {
      return await secretsService.getSecretJson<LoadedAvatarSecrets>(id);
    } catch {
      // Try next.
    }
  }

  // 2) Fallback to a minimal set of per-secret keys required by Twitter + tweet generation.
  // Expand this list as we standardize secret naming.
  const keys: Array<{ secretName: string; envKey: string }> = [
    // Telegram
    { secretName: 'telegram_bot_token', envKey: 'TELEGRAM_BOT_TOKEN' },

    // Discord
    { secretName: 'discord_bot_token', envKey: 'DISCORD_BOT_TOKEN' },

    // Twitter
    { secretName: 'twitter_api_key', envKey: 'TWITTER_API_KEY' },
    { secretName: 'twitter_api_secret', envKey: 'TWITTER_API_SECRET' },
    { secretName: 'twitter_access_token', envKey: 'TWITTER_ACCESS_TOKEN' },
    { secretName: 'twitter_access_secret', envKey: 'TWITTER_ACCESS_SECRET' },

    // LLM (common)
    { secretName: 'openrouter_api_key', envKey: 'OPENROUTER_API_KEY' },

    // Media (common)
    { secretName: 'replicate_api_key', envKey: 'REPLICATE_API_KEY' },
    { secretName: 'replicate_api_token', envKey: 'REPLICATE_API_TOKEN' },

    // Signal (shared game server token)
    { secretName: 'signal_api_token', envKey: 'SIGNAL_API_TOKEN' },
  ];

  const result: LoadedAvatarSecrets = {};
  await Promise.all(keys.map(async ({ secretName, envKey }) => {
    const baseCandidates = secretCandidates(secretPrefix, avatarId, secretName, environment);

    // Admin API Secrets Manager convention stores secrets as:
    // `${prefix}/${avatarId}/${secretType}/${name}` (e.g. twitter_access_token/access-token)
    // rather than `${prefix}/${avatarId}/${secretType}/default`.
    // Include common names used by admin-api for these secret types.
    const adminApiNameCandidates: string[] = [];
    if (secretName === 'twitter_access_token') {
      adminApiNameCandidates.push(...secretCandidatesWithNames(secretPrefix, avatarId, secretName, ['access-token'], environment));
    } else if (secretName === 'twitter_access_secret') {
      adminApiNameCandidates.push(...secretCandidatesWithNames(secretPrefix, avatarId, secretName, ['access-secret'], environment));
    } else if (secretName === 'twitter_api_key') {
      adminApiNameCandidates.push(...secretCandidatesWithNames(secretPrefix, avatarId, secretName, ['api-key'], environment));
    } else if (secretName === 'twitter_api_secret') {
      adminApiNameCandidates.push(...secretCandidatesWithNames(secretPrefix, avatarId, secretName, ['api-secret'], environment));
    } else if (secretName === 'twitter_bearer_token') {
      adminApiNameCandidates.push(...secretCandidatesWithNames(secretPrefix, avatarId, secretName, ['bearer-token'], environment));
    } else if (secretName === 'openrouter_api_key') {
      adminApiNameCandidates.push(...secretCandidatesWithNames(secretPrefix, avatarId, secretName, ['api-key'], environment));
    } else if (secretName === 'replicate_api_key') {
      adminApiNameCandidates.push(...secretCandidatesWithNames(secretPrefix, avatarId, secretName, ['api-key'], environment));
    } else if (secretName === 'replicate_api_token') {
      adminApiNameCandidates.push(...secretCandidatesWithNames(secretPrefix, avatarId, secretName, ['api-token'], environment));
    }

    let value = await getFirstSecret(secretsService, [
      ...baseCandidates,
      ...adminApiNameCandidates,
    ]);
    if (value) {
      // Unwrap JSON-wrapped secrets (e.g. {"DISCORD_BOT_TOKEN":"..."})
      // Some secrets are stored as JSON objects with the env key as property name.
      if (value.startsWith('{')) {
        try {
          const parsed = JSON.parse(value);
          const unwrapped = parsed[envKey] || parsed[secretName] || parsed[secretName.toUpperCase()];
          if (typeof unwrapped === 'string') {
            value = unwrapped;
          }
        } catch {
          // Not valid JSON, use raw value
        }
      }
      result[envKey] = value;
    }
  }));

  // If the avatar does not have per-secret Twitter app credentials, use the shared app credentials secret.
  if (!result.TWITTER_API_KEY || !result.TWITTER_API_SECRET) {
    const creds = await tryGetTwitterAppCredentials(secretsService, secretPrefix);
    if (creds) {
      result.TWITTER_API_KEY = result.TWITTER_API_KEY || creds.appKey;
      result.TWITTER_API_SECRET = result.TWITTER_API_SECRET || creds.appSecret;
    }
  }

  return result;
}
