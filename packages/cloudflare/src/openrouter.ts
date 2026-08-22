import type { HostedSecretStore } from '@swarm/core';
import type { CloudflareHostedBindings } from './bindings.js';
import { randomToken, sha256, type HostedSession } from './auth.js';
import { createCloudflareSecretCipher } from './platform.js';

const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth';
const OPENROUTER_KEY_EXCHANGE_URL = 'https://openrouter.ai/api/v1/auth/keys';
const OAUTH_TRANSACTION_TTL_MS = 10 * 60 * 1000;

type OAuthTransactionRow = {
  account_id: string;
  session_hash: string;
  verifier_envelope: string;
  expires_at: number;
};

type Fetch = typeof fetch;

function oauthVerifierContext(accountId: string, sessionHash: string, stateHash: string): string {
  return JSON.stringify(['oauth', 'openrouter', accountId, sessionHash, stateHash]);
}

export async function beginOpenRouterConnect(
  env: CloudflareHostedBindings,
  session: HostedSession,
  callbackUrl: string,
  now = Date.now(),
): Promise<string> {
  const verifier = randomToken(32);
  const challenge = await sha256(verifier);
  const state = randomToken(32);
  const stateHash = await sha256(state);
  const verifierEnvelope = await createCloudflareSecretCipher(env).seal(
    verifier,
    oauthVerifierContext(session.accountId, session.sessionHash, stateHash),
  );
  const result = await env.SWARM_STATE.prepare(
    `insert into swarm_oauth_transactions
       (state_hash, account_id, session_hash, provider, verifier_envelope, created_at, expires_at)
     values (?, ?, ?, 'openrouter', ?, ?, ?)`,
  )
    .bind(
      stateHash,
      session.accountId,
      session.sessionHash,
      JSON.stringify(verifierEnvelope),
      now,
      now + OAUTH_TRANSACTION_TTL_MS,
    )
    .run();
  if (!result.success) throw new Error(result.error ?? 'Unable to store OpenRouter OAuth transaction.');

  const authorizationUrl = new URL(OPENROUTER_AUTH_URL);
  authorizationUrl.searchParams.set('callback_url', callbackUrl);
  authorizationUrl.searchParams.set('code_challenge', challenge);
  authorizationUrl.searchParams.set('code_challenge_method', 'S256');
  authorizationUrl.searchParams.set('state', state);
  return authorizationUrl.toString();
}

async function consumeOpenRouterTransaction(
  env: CloudflareHostedBindings,
  session: HostedSession,
  state: string,
  now: number,
): Promise<string | null> {
  if (!state || state.length > 256) return null;
  const stateHash = await sha256(state);
  const transaction = await env.SWARM_STATE.prepare(
    `delete from swarm_oauth_transactions
     where state_hash = ? and account_id = ? and session_hash = ?
       and provider = 'openrouter' and expires_at > ?
     returning account_id, session_hash, verifier_envelope, expires_at`,
  )
    .bind(stateHash, session.accountId, session.sessionHash, now)
    .first<OAuthTransactionRow>();
  if (!transaction) return null;
  return createCloudflareSecretCipher(env).open(
    transaction.verifier_envelope,
    oauthVerifierContext(transaction.account_id, transaction.session_hash, stateHash),
  );
}

async function exchangeOpenRouterCode(code: string, verifier: string, fetchImpl: Fetch): Promise<string> {
  const response = await fetchImpl(OPENROUTER_KEY_EXCHANGE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      code,
      code_verifier: verifier,
      code_challenge_method: 'S256',
    }),
  });
  if (!response.ok) throw new Error(`OpenRouter key exchange failed with status ${response.status}.`);
  const body = (await response.json()) as { key?: unknown };
  if (typeof body.key !== 'string' || !body.key.trim() || body.key.length > 16_384) {
    throw new Error('OpenRouter key exchange returned an invalid key.');
  }
  return body.key;
}

export async function completeOpenRouterConnect(input: {
  env: CloudflareHostedBindings;
  session: HostedSession;
  secrets: HostedSecretStore;
  code: string;
  state: string;
  now?: number;
  fetchImpl?: Fetch;
}): Promise<boolean> {
  if (!input.code || input.code.length > 4096) return false;
  const verifier = await consumeOpenRouterTransaction(input.env, input.session, input.state, input.now ?? Date.now());
  if (!verifier) return false;
  const key = await exchangeOpenRouterCode(input.code, verifier, input.fetchImpl ?? fetch);
  const scope = { accountId: input.session.accountId };
  await input.secrets.putUserSecret(scope, 'llm-api-key', key);
  await input.secrets.putUserSecret(scope, 'llm-provider', 'openrouter');
  return true;
}

export async function getOpenRouterConnectionStatus(
  secrets: HostedSecretStore,
  session: HostedSession,
): Promise<{ connected: boolean; provider: 'openrouter' | null }> {
  const scope = { accountId: session.accountId };
  const [key, provider] = await Promise.all([
    secrets.hasUserSecret(scope, 'llm-api-key'),
    secrets.getUserSecret(scope, 'llm-provider'),
  ]);
  return {
    connected: key && provider === 'openrouter',
    provider: provider === 'openrouter' ? 'openrouter' : null,
  };
}

export async function disconnectOpenRouter(secrets: HostedSecretStore, session: HostedSession): Promise<void> {
  const scope = { accountId: session.accountId };
  await Promise.all([secrets.deleteUserSecret(scope, 'llm-api-key'), secrets.deleteUserSecret(scope, 'llm-provider')]);
}
