import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

let cachedSystemOpenRouterApiKey: string | null | undefined;

function parseApiKey(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const candidate =
      parsed.api_key ||
      parsed.apiKey ||
      parsed.OPENROUTER_API_KEY ||
      parsed.LLM_API_KEY ||
      parsed.API_KEY ||
      parsed.value;
    return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
  } catch {
    return trimmed;
  }
}

export function _resetSystemOpenRouterApiKeyCache(): void {
  cachedSystemOpenRouterApiKey = undefined;
}

export async function getSystemOpenRouterApiKey(): Promise<string | null> {
  const envKey =
    process.env.OPENROUTER_API_KEY ||
    process.env.openrouter_api_key ||
    process.env.LLM_API_KEY;
  const parsedEnvKey = envKey ? parseApiKey(envKey) : null;
  if (parsedEnvKey) return parsedEnvKey;

  if (cachedSystemOpenRouterApiKey !== undefined) {
    return cachedSystemOpenRouterApiKey;
  }

  const secretArn = process.env.OPENROUTER_API_KEY_SECRET_ARN || process.env.LLM_API_KEY_SECRET_ARN;
  if (!secretArn) {
    cachedSystemOpenRouterApiKey = null;
    return null;
  }

  try {
    const client = new SecretsManagerClient({});
    const response = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
    cachedSystemOpenRouterApiKey = response.SecretString ? parseApiKey(response.SecretString) : null;
    return cachedSystemOpenRouterApiKey;
  } catch {
    cachedSystemOpenRouterApiKey = null;
    return null;
  }
}

export async function hasSystemOpenRouterApiKey(): Promise<boolean> {
  return Boolean(await getSystemOpenRouterApiKey());
}
