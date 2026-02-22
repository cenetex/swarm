import type { SecretsService } from '@swarm/core';

function parseReplicateApiKeyFromJson(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const candidate =
      parsed.api_key ||
      parsed.apiKey ||
      parsed.REPLICATE_API_KEY ||
      parsed.REPLICATE_API_TOKEN ||
      parsed.token ||
      parsed.value;

    return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
  } catch {
    return undefined;
  }
}

export async function getSystemReplicateKey(secretsService: SecretsService): Promise<string | undefined> {
  const envKey = process.env.REPLICATE_API_TOKEN || process.env.REPLICATE_API_KEY;
  if (envKey) return envKey;

  const arn = process.env.REPLICATE_API_KEY_SECRET_ARN;
  if (arn) {
    try {
      const raw = await secretsService.getSecret(arn);
      const parsed = parseReplicateApiKeyFromJson(raw);
      const trimmedRaw = raw.trim();
      const result = parsed || (trimmedRaw ? trimmedRaw : undefined);
      if (result) return result;
    } catch {
      // ARN lookup failed, try fallback by name below
    }
  }

  // Fallback: try common secret name patterns.
  // Handles mismatch between `replicate-api` and `replicate-api-key` naming.
  const secretPrefix = process.env.SECRET_PREFIX || 'swarm';
  const environment = process.env.ENVIRONMENT || 'staging';
  const nameCandidates = [
    `${secretPrefix}/${environment}/replicate-api-key`,
    `${secretPrefix}/${environment}/replicate-api`,
    `${secretPrefix}/global/replicate-api-key`,
    `${secretPrefix}/global/replicate-api`,
  ];

  for (const name of nameCandidates) {
    try {
      const raw = await secretsService.getSecret(name);
      const parsed = parseReplicateApiKeyFromJson(raw);
      const trimmedRaw = raw.trim();
      const result = parsed || (trimmedRaw ? trimmedRaw : undefined);
      if (result) return result;
    } catch {
      // Try next candidate
    }
  }

  return undefined;
}

export async function ensureReplicateKey(
  secrets: Record<string, string>,
  secretsService: SecretsService
): Promise<boolean> {
  const hasKey =
    Boolean(secrets.REPLICATE_API_TOKEN) ||
    Boolean(secrets.REPLICATE_API_KEY) ||
    Boolean(secrets.replicate_api_key) ||
    Boolean((secrets as Record<string, string | undefined>).replicate_api_token);

  if (hasKey) return true;

  const systemKey = await getSystemReplicateKey(secretsService);
  if (!systemKey) return false;

  // Prefer the canonical name used across the repo.
  secrets.REPLICATE_API_KEY = systemKey;
  return true;
}
