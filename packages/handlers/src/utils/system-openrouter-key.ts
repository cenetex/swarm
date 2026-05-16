import type { SecretsService } from '@swarm/core';

function parseOpenRouterApiKey(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const candidate =
      parsed.api_key ||
      parsed.apiKey ||
      parsed.OPENROUTER_API_KEY ||
      parsed.LLM_API_KEY ||
      parsed.API_KEY ||
      parsed.value;

    return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
  } catch {
    return trimmed;
  }
}

export async function getSystemOpenRouterKey(secretsService: SecretsService): Promise<string | undefined> {
  const envKey = process.env.OPENROUTER_API_KEY || process.env.openrouter_api_key || process.env.LLM_API_KEY;
  const parsedEnvKey = envKey ? parseOpenRouterApiKey(envKey) : undefined;
  if (parsedEnvKey) return parsedEnvKey;

  const arn = process.env.OPENROUTER_API_KEY_SECRET_ARN || process.env.LLM_API_KEY_SECRET_ARN;
  if (arn) {
    try {
      const raw = await secretsService.getSecret(arn);
      const parsed = parseOpenRouterApiKey(raw);
      if (parsed) return parsed;
    } catch {
      // ARN lookup failed, try fallback by name below.
    }
  }

  const secretPrefix = process.env.SECRET_PREFIX || 'swarm';
  const environment = process.env.ENVIRONMENT || 'staging';
  const nameCandidates = [
    `${secretPrefix}/${environment}/openrouter-api-key`,
    `${secretPrefix}/${environment}/openrouter-api`,
    `${secretPrefix}/global/openrouter-api-key`,
    `${secretPrefix}/global/openrouter-api`,
  ];

  for (const name of nameCandidates) {
    try {
      const parsed = parseOpenRouterApiKey(await secretsService.getSecret(name));
      if (parsed) return parsed;
    } catch {
      // Try next candidate.
    }
  }

  return undefined;
}

export async function ensureOpenRouterKey(
  secrets: Record<string, string>,
  secretsService: SecretsService
): Promise<boolean> {
  const hasKey = Boolean(secrets.OPENROUTER_API_KEY) || Boolean(secrets.openrouter_api_key);
  if (hasKey) return true;

  const systemKey = await getSystemOpenRouterKey(secretsService);
  if (!systemKey) return false;

  secrets.OPENROUTER_API_KEY = systemKey;
  return true;
}
