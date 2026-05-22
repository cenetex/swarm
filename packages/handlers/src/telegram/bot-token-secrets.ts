import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const secretsClient = new SecretsManagerClient({});

const DEFAULT_SECRET_PREFIX = 'swarm';
const TOKEN_SECRET_NAME = 'telegram_bot_token';

export interface TelegramBotTokenLookupOptions {
  allowGlobalFallback?: boolean;
}

export interface TelegramBotTokenLookupResult {
  token: string;
  source: string;
}

export function listTelegramBotTokenSecretIds(
  avatarId: string,
  options: TelegramBotTokenLookupOptions = {}
): string[] {
  const secretPrefix = process.env.SECRET_PREFIX || DEFAULT_SECRET_PREFIX;
  const environment = process.env.ENVIRONMENT?.trim();
  const variants = Array.from(new Set([
    TOKEN_SECRET_NAME,
    TOKEN_SECRET_NAME.replaceAll('_', '-'),
  ]));
  const ids: string[] = [];

  for (const variant of variants) {
    const avatarBase = `${secretPrefix}/${avatarId}/${variant}`;
    ids.push(`${avatarBase}/default`, avatarBase);

    if (options.allowGlobalFallback) {
      const globalBase = `${secretPrefix}/global/${variant}`;
      const sharedBase = `${secretPrefix}/shared/${variant}`;
      ids.push(
        `${globalBase}/default`,
        `${globalBase}/global-bot`,
        globalBase,
        `${sharedBase}/default`,
        sharedBase,
      );

      if (environment) {
        const environmentBase = `${secretPrefix}/${environment}/${variant}`;
        ids.push(`${environmentBase}/default`, environmentBase);
      }
    }
  }

  return Array.from(new Set(ids));
}

export async function getTelegramBotTokenFromSecrets(
  avatarId: string,
  options: TelegramBotTokenLookupOptions = {}
): Promise<TelegramBotTokenLookupResult | null> {
  const candidates = listTelegramBotTokenSecretIds(avatarId, options);

  for (const secretId of candidates) {
    try {
      const response = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretId }));
      const token = response.SecretString || '';
      if (token) {
        return { token, source: secretId };
      }
    } catch {
      // Try the next supported secret convention.
    }
  }

  return null;
}
