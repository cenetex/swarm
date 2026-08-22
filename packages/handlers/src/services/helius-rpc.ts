/**
 * Helius RPC URL resolver (handlers)
 *
 * Minimal version of admin-api's helper so webhook handlers can resolve the
 * current on-chain owner of an NFT without depending on admin-api internals.
 *
 * Reads the API key from either:
 *   - `process.env.HELIUS_API_KEY` (preferred, direct env var)
 *   - `process.env.HELIUS_API_KEY_ARN` (Secrets Manager reference, fetched lazily)
 *
 * Both env vars are wired into handler Lambdas via
 * `packages/infra/src/constructs/shared-handlers.ts`. If neither is set, this
 * returns `null` and callers must treat the failure as `verification_unavailable`.
 */
import { getSecretsClient } from './aws-clients.js';
import { GetSecretValueCommand } from '@swarm/core';

let heliusApiKey: string | null = process.env.HELIUS_API_KEY || null;
let heliusApiKeyFetched = false;

const secretsClient = getSecretsClient();

/** @internal Test-only: reset cached key so env changes take effect. */
export function _resetHeliusCache(): void {
  heliusApiKey = process.env.HELIUS_API_KEY || null;
  heliusApiKeyFetched = false;
}

async function getHeliusApiKey(): Promise<string | null> {
  if (heliusApiKey) return heliusApiKey;
  if (heliusApiKeyFetched) return null;
  heliusApiKeyFetched = true;

  const arn = process.env.HELIUS_API_KEY_ARN;
  if (!arn) return null;

  try {
    const response = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: arn }),
    );
    heliusApiKey = response.SecretString || null;
    return heliusApiKey;
  } catch (error) {
    // eslint-disable-next-line no-console -- Secrets fetch failures need visibility even if structured logger is not initialized in this module.
    console.error(
      '[handlers/helius-rpc] Failed to fetch Helius API key from Secrets Manager:',
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

export async function getHeliusRpcUrl(): Promise<string | null> {
  const apiKey = await getHeliusApiKey();
  return apiKey ? `https://mainnet.helius-rpc.com/?api-key=${apiKey}` : null;
}
