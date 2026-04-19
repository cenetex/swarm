/**
 * Signal Station MCP Services
 *
 * HTTP client for the Signal space mining game station REST API.
 * Connects aws-swarm avatars to the game server so they can govern
 * stations: observe state, set prices, build modules, broadcast hails.
 *
 * Authentication: a single shared bearer token loaded from Secrets Manager
 * (`SIGNAL_API_TOKEN_SECRET_ARN`) or, for local dev, the `SIGNAL_API_TOKEN`
 * env var. The shared-token model matches admin chat usage where the operator
 * acts on behalf of any avatar; the per-avatar token model used by the
 * scheduled `station-agent-runner` is intentionally separate.
 */
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { SignalStationServices, StationState, CommandResult } from '@swarm/mcp-server';

const SIGNAL_API_BASE = process.env.SIGNAL_API_URL || 'https://signal-ws.ratimics.com';

let cachedToken: string | null = null;
let cachedTokenPromise: Promise<string> | null = null;

async function resolveToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  if (cachedTokenPromise) return cachedTokenPromise;

  const inlineToken = process.env.SIGNAL_API_TOKEN;
  if (inlineToken) {
    cachedToken = inlineToken;
    return inlineToken;
  }

  const secretArn = process.env.SIGNAL_API_TOKEN_SECRET_ARN;
  if (!secretArn) {
    throw new Error('SIGNAL_API_TOKEN_SECRET_ARN not configured');
  }

  cachedTokenPromise = (async () => {
    const client = new SecretsManagerClient({});
    const response = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
    if (!response.SecretString) {
      throw new Error('SIGNAL_API_TOKEN secret value is empty');
    }
    let token = response.SecretString;
    if (token.startsWith('{')) {
      try {
        const parsed = JSON.parse(token);
        const unwrapped = parsed.SIGNAL_API_TOKEN || parsed.signal_api_token || parsed.token;
        if (typeof unwrapped === 'string') token = unwrapped;
      } catch {
        // not JSON, use raw
      }
    }
    cachedToken = token;
    return token;
  })();

  try {
    return await cachedTokenPromise;
  } finally {
    cachedTokenPromise = null;
  }
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await resolveToken();
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  };
}

export function createSignalStationServices(): SignalStationServices {
  return {
    getStationState: async (stationId) => {
      const headers = await authHeaders();
      const res = await fetch(`${SIGNAL_API_BASE}/api/station/${stationId}/state`, { headers });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Station state failed (${res.status}): ${body}`);
      }
      return res.json() as Promise<StationState>;
    },

    sendCommand: async (stationId, command) => {
      const headers = await authHeaders();
      const res = await fetch(`${SIGNAL_API_BASE}/api/station/${stationId}/command`, {
        method: 'POST',
        headers,
        body: JSON.stringify(command),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Station command failed (${res.status}): ${body}`);
      }
      return res.json() as Promise<CommandResult>;
    },
  };
}

/** True when admin-api has either inline token or secret ARN configured. */
export function isSignalStationConfigured(): boolean {
  return Boolean(process.env.SIGNAL_API_TOKEN || process.env.SIGNAL_API_TOKEN_SECRET_ARN);
}

/** @internal exposed for tests */
export function _resetSignalStationTokenCache(): void {
  cachedToken = null;
  cachedTokenPromise = null;
}
