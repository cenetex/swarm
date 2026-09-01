import type { HostedSession } from './auth.js';
import { randomToken, sha256 } from './auth.js';
import type { CloudflareHostedBindings } from './bindings.js';
import { generateHostedReply, getHostedAvatar, storeHostedAssistantMessage } from './hosted-chat.js';
import { createCloudflareHostedPlatform } from './platform.js';

const X_API_ORIGIN = 'https://api.x.com';
const OAUTH_TTL_MS = 10 * 60 * 1_000;
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_MENTION_ATTEMPTS = 3;
const MAX_REPLY_CODE_POINTS = 240;
const ACCESS_TOKEN_SECRET = 'x-access-token';
const ACCESS_TOKEN_SECRET_SECRET = 'x-access-token-secret';
const OAUTH_REQUEST_SECRET_PREFIX = 'x-oauth-request-';

type XIntegrationRow = {
  account_id: string;
  avatar_id: string;
  integration_id: string;
  x_user_id: string;
  username: string;
  status: 'connected' | 'reauth_required';
  since_id: string | null;
  last_polled_at: number | null;
  poll_after: number | null;
  last_error_code: string | null;
  created_at: number;
  updated_at: number;
};

type XOAuthTransactionRow = {
  token_hash: string;
  account_id: string;
  avatar_id: string;
  session_hash: string;
  created_at: number;
  expires_at: number;
};

type XMentionRow = {
  integration_id: string;
  mention_id: string;
  account_id: string;
  avatar_id: string;
  thread_id: string;
  author_id: string;
  author_username: string | null;
  conversation_id: string;
  request_id: string;
  job_id: string;
  status: 'received' | 'queued' | 'processing' | 'retry' | 'sending' | 'completed' | 'failed' | 'unknown';
  attempts: number;
  max_attempts: number;
  response_text: string | null;
  reply_post_id: string | null;
  error_code: string | null;
  source_text: string;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
};

type XMention = {
  id?: unknown;
  text?: unknown;
  author_id?: unknown;
  conversation_id?: unknown;
};

type XMentionsResponse = {
  data?: XMention[];
  includes?: { users?: Array<{ id?: unknown; username?: unknown }> };
  meta?: { newest_id?: unknown };
};

type XPostResponse = { data?: { id?: unknown; text?: unknown } };

type QueueDisposition = { action: 'ack' } | { action: 'retry'; delaySeconds: number };

export type HostedXStatus = {
  connected: boolean;
  status: 'disconnected' | 'connected' | 'reauth_required';
  username?: string;
  userId?: string;
  lastPolledAt?: number;
  lastErrorCode?: string;
};

export type HostedXConnectResult = HostedXStatus & { avatarId: string };

export type HostedXQueueMessage = {
  type: 'swarm.hosted.x.mention';
  payload: { integrationId: string; jobId: string };
  enqueuedAt: number;
};

export class HostedXConfigurationError extends Error {
  constructor(message = 'Hosted X is not configured.') {
    super(message);
    this.name = 'HostedXConfigurationError';
  }
}

export class HostedXConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostedXConflictError';
  }
}

export class HostedXNotFoundError extends Error {
  constructor(message = 'X connector was not found.') {
    super(message);
    this.name = 'HostedXNotFoundError';
  }
}

export class HostedXProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfter?: number,
    readonly ambiguous = false,
    readonly stage: 'signing' | 'network' | 'response' = 'response',
    readonly networkDetail?: string,
  ) {
    super(message);
    this.name = 'HostedXProviderError';
  }
}

function ensureWrite(result: { success: boolean; error?: string }, fallback: string): void {
  if (!result.success) throw new Error(result.error ?? fallback);
}

type HostedXAppBindings = Pick<CloudflareHostedBindings, 'SWARM_X_API_KEY' | 'SWARM_X_API_SECRET'>;

function xAppCredentials(env: HostedXAppBindings): { apiKey: string; apiSecret: string } {
  const apiKey = env.SWARM_X_API_KEY?.trim();
  const apiSecret = env.SWARM_X_API_SECRET?.trim();
  if (!apiKey || !apiSecret) throw new HostedXConfigurationError();
  return { apiKey, apiSecret };
}

function safeNetworkDetail(error: unknown, sensitiveValues: string[]): string {
  const rawName = error instanceof Error ? error.name : 'UnknownError';
  const name = rawName.replace(/[^a-z0-9_.-]/giu, '').slice(0, 40) || 'Error';
  let message = error instanceof Error ? error.message : String(error);
  for (const value of sensitiveValues) {
    if (value) message = message.split(value).join('[redacted]');
  }
  message = message.split('\r').join(' ').split('\n').join(' ').trim().slice(0, 200);
  return message ? `${name}: ${message}` : name;
}

function secretScope(accountId: string, avatarId: string) {
  return { accountId, tenantId: avatarId };
}

function oauthRequestSecretName(tokenHash: string): string {
  return `${OAUTH_REQUEST_SECRET_PREFIX}${tokenHash}`;
}

function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function createHostedXAuthorizationHeader(input: {
  method: string;
  url: string;
  apiKey: string;
  apiSecret: string;
  token?: string;
  tokenSecret?: string;
  oauth?: Record<string, string>;
  now?: number;
  nonce?: string;
}): Promise<string> {
  const oauth: Record<string, string> = {
    oauth_consumer_key: input.apiKey,
    oauth_nonce: input.nonce ?? randomToken(24),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor((input.now ?? Date.now()) / 1_000)),
    oauth_version: '1.0',
    ...(input.token ? { oauth_token: input.token } : {}),
    ...(input.oauth ?? {}),
  };
  const url = new URL(input.url);
  const signatureParameters: Array<[string, string]> = [...url.searchParams.entries(), ...Object.entries(oauth)];
  signatureParameters.sort(([leftKey, leftValue], [rightKey, rightValue]) => {
    const keyOrder = rfc3986(leftKey).localeCompare(rfc3986(rightKey));
    return keyOrder || rfc3986(leftValue).localeCompare(rfc3986(rightValue));
  });
  const normalized = signatureParameters
    .map(([key, value]) => `${rfc3986(key)}=${rfc3986(value)}`)
    .join('&');
  const baseUrl = `${url.protocol}//${url.host}${url.pathname}`;
  const signatureBase = [input.method.toUpperCase(), rfc3986(baseUrl), rfc3986(normalized)].join('&');
  const signingKey = `${rfc3986(input.apiSecret)}&${rfc3986(input.tokenSecret ?? '')}`;
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingKey),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const signature = bytesToBase64(new Uint8Array(await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    new TextEncoder().encode(signatureBase),
  )));
  return `OAuth ${Object.entries({ ...oauth, oauth_signature: signature })
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${rfc3986(key)}="${rfc3986(value)}"`)
    .join(', ')}`;
}

function retryAfter(response: Response, now: number): number | undefined {
  const seconds = Number(response.headers.get('Retry-After'));
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(900, Math.ceil(seconds));
  const reset = Number(response.headers.get('x-rate-limit-reset'));
  if (Number.isFinite(reset) && reset > 0) {
    return Math.min(900, Math.max(1, Math.ceil(reset - now / 1_000)));
  }
  return undefined;
}

async function oauthFormRequest(input: {
  env: HostedXAppBindings;
  method: 'POST';
  url: string;
  token?: string;
  tokenSecret?: string;
  oauth?: Record<string, string>;
  fetchImpl: typeof fetch;
  now: number;
}): Promise<URLSearchParams> {
  const credentials = xAppCredentials(input.env);
  let authorization: string;
  try {
    authorization = await createHostedXAuthorizationHeader({
      method: input.method,
      url: input.url,
      ...credentials,
      ...(input.token ? { token: input.token } : {}),
      ...(input.tokenSecret ? { tokenSecret: input.tokenSecret } : {}),
      ...(input.oauth ? { oauth: input.oauth } : {}),
      now: input.now,
    });
  } catch {
    throw new HostedXProviderError('Hosted X could not sign the OAuth request.', 0, undefined, false, 'signing');
  }
  let response: Response;
  try {
    response = await input.fetchImpl.call(globalThis, input.url, {
      method: input.method,
      headers: {
        Authorization: authorization,
        Accept: 'application/x-www-form-urlencoded',
      },
    });
  } catch (error) {
    throw new HostedXProviderError(
      'X could not be reached.',
      0,
      undefined,
      false,
      'network',
      safeNetworkDetail(error, [credentials.apiKey, credentials.apiSecret]),
    );
  }
  if (!response.ok) {
    throw new HostedXProviderError(
      response.status === 401 || response.status === 403
        ? 'X rejected the app API Key, API Key Secret, or callback URL.'
        : response.status === 429
          ? 'X rate limit reached. Try again later.'
          : response.status >= 500
            ? 'X is temporarily unavailable.'
            : 'X rejected the OAuth request.',
      response.status,
      retryAfter(response, input.now),
      false,
      'response',
    );
  }
  return new URLSearchParams(await response.text());
}

function xRequestToken(response: URLSearchParams): { requestToken: string; requestSecret: string } {
  const requestToken = response.get('oauth_token')?.trim() ?? '';
  const requestSecret = response.get('oauth_token_secret')?.trim() ?? '';
  if (!requestToken || !requestSecret || response.get('oauth_callback_confirmed') !== 'true') {
    throw new HostedXConfigurationError('X did not confirm the configured OAuth callback.');
  }
  return { requestToken, requestSecret };
}

export async function probeHostedXConfiguration(
  env: HostedXAppBindings,
  callbackUrl: string,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<void> {
  const response = await oauthFormRequest({
    env,
    method: 'POST',
    url: `${X_API_ORIGIN}/oauth/request_token`,
    oauth: { oauth_callback: callbackUrl },
    fetchImpl,
    now,
  });
  xRequestToken(response);
}

async function xJsonRequest<T>(input: {
  env: CloudflareHostedBindings;
  method: 'GET' | 'POST';
  url: string;
  accessToken: string;
  accessSecret: string;
  body?: Record<string, unknown>;
  fetchImpl: typeof fetch;
  now: number;
  delivery?: boolean;
}): Promise<T> {
  const credentials = xAppCredentials(input.env);
  let authorization: string;
  try {
    authorization = await createHostedXAuthorizationHeader({
      method: input.method,
      url: input.url,
      ...credentials,
      token: input.accessToken,
      tokenSecret: input.accessSecret,
      now: input.now,
    });
  } catch {
    throw new HostedXProviderError('Hosted X could not sign the API request.', 0, undefined, false, 'signing');
  }
  let response: Response;
  try {
    response = await input.fetchImpl.call(globalThis, input.url, {
      method: input.method,
      headers: {
        Authorization: authorization,
        Accept: 'application/json',
        ...(input.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(input.body ? { body: JSON.stringify(input.body) } : {}),
    });
  } catch (error) {
    throw new HostedXProviderError(
      'X could not be reached.',
      0,
      undefined,
      input.delivery === true,
      'network',
      safeNetworkDetail(error, [
        credentials.apiKey,
        credentials.apiSecret,
        input.accessToken,
        input.accessSecret,
      ]),
    );
  }
  if (!response.ok) {
    throw new HostedXProviderError(
      response.status === 401 || response.status === 403
        ? 'X authorization is no longer valid.'
        : response.status === 429
          ? 'X rate limit reached.'
          : response.status >= 500
            ? 'X is temporarily unavailable.'
            : 'X rejected the request.',
      response.status,
      retryAfter(response, input.now),
      input.delivery === true && response.status >= 500,
      'response',
    );
  }
  try {
    return await response.json() as T;
  } catch {
    throw new HostedXProviderError(
      'X returned an invalid response.',
      response.status,
      undefined,
      input.delivery === true,
      'response',
    );
  }
}

function integrationSelect(where: string): string {
  return `select account_id, avatar_id, integration_id, x_user_id, username, status, since_id,
                 last_polled_at, poll_after, last_error_code, created_at, updated_at
          from swarm_hosted_x_integrations where ${where}`;
}

async function findOwnedIntegration(
  env: CloudflareHostedBindings,
  accountId: string,
  avatarId: string,
): Promise<XIntegrationRow | null> {
  return env.SWARM_STATE.prepare(integrationSelect('account_id = ? and avatar_id = ?'))
    .bind(accountId, avatarId)
    .first<XIntegrationRow>();
}

function statusFromRow(row: XIntegrationRow): HostedXStatus {
  return {
    connected: true,
    status: row.status,
    username: row.username,
    userId: row.x_user_id,
    ...(row.last_polled_at === null ? {} : { lastPolledAt: row.last_polled_at }),
    ...(row.last_error_code === null ? {} : { lastErrorCode: row.last_error_code }),
  };
}

async function clearOldOAuthTransactions(
  env: CloudflareHostedBindings,
  accountId: string,
  avatarId: string,
): Promise<void> {
  const old = await env.SWARM_STATE.prepare(
    `select token_hash, account_id, avatar_id, session_hash, created_at, expires_at
     from swarm_hosted_x_oauth_transactions where account_id = ? and avatar_id = ?`,
  ).bind(accountId, avatarId).all<XOAuthTransactionRow>();
  const secrets = createCloudflareHostedPlatform(env).secrets;
  for (const transaction of old.results ?? []) {
    await secrets.deleteUserSecret(
      secretScope(transaction.account_id, transaction.avatar_id),
      oauthRequestSecretName(transaction.token_hash),
    );
  }
  const removed = await env.SWARM_STATE.prepare(
    'delete from swarm_hosted_x_oauth_transactions where account_id = ? and avatar_id = ?',
  ).bind(accountId, avatarId).run();
  ensureWrite(removed, 'Unable to replace the X authorization request.');
}

export async function beginHostedXConnect(
  env: CloudflareHostedBindings,
  session: HostedSession,
  input: { avatarId: string; publicOrigin: string },
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<{ authorizationUrl: string }> {
  if (!(await getHostedAvatar(env, session, input.avatarId))) {
    throw new HostedXNotFoundError('Hosted avatar was not found.');
  }
  xAppCredentials(env);
  const callbackUrl = `${new URL(input.publicOrigin).origin}/api/auth/x/callback`;
  const response = await oauthFormRequest({
    env,
    method: 'POST',
    url: `${X_API_ORIGIN}/oauth/request_token`,
    oauth: { oauth_callback: callbackUrl },
    fetchImpl,
    now,
  });
  const { requestToken, requestSecret } = xRequestToken(response);
  const tokenHash = await sha256(requestToken);
  const secrets = createCloudflareHostedPlatform(env).secrets;
  const scope = secretScope(session.accountId, input.avatarId);
  await clearOldOAuthTransactions(env, session.accountId, input.avatarId);
  await secrets.putUserSecret(scope, oauthRequestSecretName(tokenHash), requestSecret);
  const stored = await env.SWARM_STATE.prepare(
    `insert into swarm_hosted_x_oauth_transactions
       (token_hash, account_id, avatar_id, session_hash, created_at, expires_at)
     values (?, ?, ?, ?, ?, ?)`,
  ).bind(tokenHash, session.accountId, input.avatarId, session.sessionHash, now, now + OAUTH_TTL_MS).run();
  if (!stored.success) {
    await secrets.deleteUserSecret(scope, oauthRequestSecretName(tokenHash));
    throw new Error(stored.error ?? 'Unable to store the X authorization request.');
  }
  return { authorizationUrl: `${X_API_ORIGIN}/oauth/authorize?oauth_token=${encodeURIComponent(requestToken)}` };
}

async function xCredentialsForRow(
  env: CloudflareHostedBindings,
  row: Pick<XIntegrationRow, 'account_id' | 'avatar_id'>,
): Promise<{ accessToken: string; accessSecret: string } | null> {
  const secrets = createCloudflareHostedPlatform(env).secrets;
  const scope = secretScope(row.account_id, row.avatar_id);
  const [accessToken, accessSecret] = await Promise.all([
    secrets.getUserSecret(scope, ACCESS_TOKEN_SECRET),
    secrets.getUserSecret(scope, ACCESS_TOKEN_SECRET_SECRET),
  ]);
  return accessToken && accessSecret ? { accessToken, accessSecret } : null;
}

async function fetchMentions(
  env: CloudflareHostedBindings,
  row: Pick<XIntegrationRow, 'x_user_id'>,
  credentials: { accessToken: string; accessSecret: string },
  sinceId: string | null,
  fetchImpl: typeof fetch,
  now: number,
): Promise<XMentionsResponse> {
  const url = new URL(`${X_API_ORIGIN}/2/users/${encodeURIComponent(row.x_user_id)}/mentions`);
  url.searchParams.set('max_results', '100');
  url.searchParams.set('tweet.fields', 'author_id,conversation_id,created_at');
  url.searchParams.set('expansions', 'author_id');
  url.searchParams.set('user.fields', 'username');
  if (sinceId) url.searchParams.set('since_id', sinceId);
  return xJsonRequest<XMentionsResponse>({
    env,
    method: 'GET',
    url: url.toString(),
    ...credentials,
    fetchImpl,
    now,
  });
}

function newestMentionId(page: XMentionsResponse): string | null {
  const metaId = typeof page.meta?.newest_id === 'string' ? page.meta.newest_id : null;
  const ids = (page.data ?? [])
    .map((mention) => typeof mention.id === 'string' ? mention.id : '')
    .filter((id) => /^\d{1,20}$/u.test(id));
  if (metaId && /^\d{1,20}$/u.test(metaId)) ids.push(metaId);
  return ids.reduce<string | null>((newest, id) => {
    if (!newest) return id;
    return BigInt(id) > BigInt(newest) ? id : newest;
  }, null);
}

export async function completeHostedXConnect(
  env: CloudflareHostedBindings,
  session: HostedSession,
  input: { oauthToken: string; oauthVerifier: string },
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<HostedXConnectResult> {
  const tokenHash = await sha256(input.oauthToken);
  const transaction = await env.SWARM_STATE.prepare(
    `delete from swarm_hosted_x_oauth_transactions
     where token_hash = ? and account_id = ? and session_hash = ? and expires_at > ?
     returning token_hash, account_id, avatar_id, session_hash, created_at, expires_at`,
  ).bind(tokenHash, session.accountId, session.sessionHash, now).first<XOAuthTransactionRow>();
  if (!transaction) throw new HostedXNotFoundError('X authorization expired. Start again from Studio.');
  const secrets = createCloudflareHostedPlatform(env).secrets;
  const scope = secretScope(transaction.account_id, transaction.avatar_id);
  const requestSecretName = oauthRequestSecretName(tokenHash);
  const requestSecret = await secrets.getUserSecret(scope, requestSecretName);
  await secrets.deleteUserSecret(scope, requestSecretName);
  if (!requestSecret) throw new HostedXNotFoundError('X authorization expired. Start again from Studio.');
  const response = await oauthFormRequest({
    env,
    method: 'POST',
    url: `${X_API_ORIGIN}/oauth/access_token`,
    token: input.oauthToken,
    tokenSecret: requestSecret,
    oauth: { oauth_verifier: input.oauthVerifier },
    fetchImpl,
    now,
  });
  const accessToken = response.get('oauth_token')?.trim() ?? '';
  const accessSecret = response.get('oauth_token_secret')?.trim() ?? '';
  const userId = response.get('user_id')?.trim() ?? '';
  const username = response.get('screen_name')?.trim() ?? '';
  if (!accessToken || !accessSecret || !/^\d{1,20}$/u.test(userId) || !/^[A-Za-z0-9_]{1,15}$/u.test(username)) {
    throw new HostedXConfigurationError('X did not return a valid account identity.');
  }
  const used = await env.SWARM_STATE.prepare(
    'select account_id, avatar_id from swarm_hosted_x_integrations where x_user_id = ?',
  ).bind(userId).first<{ account_id: string; avatar_id: string }>();
  if (used && (used.account_id !== session.accountId || used.avatar_id !== transaction.avatar_id)) {
    throw new HostedXConflictError('This X account is already connected to another companion.');
  }
  let sinceId: string | null = null;
  let lastErrorCode: string | null = null;
  try {
    sinceId = newestMentionId(await fetchMentions(
      env,
      { x_user_id: userId },
      { accessToken, accessSecret },
      null,
      fetchImpl,
      now,
    ));
  } catch (error) {
    if (error instanceof HostedXProviderError && (error.status === 401 || error.status === 403)) {
      throw new HostedXConfigurationError('X did not grant the read and write permissions needed for mentions and replies.');
    }
    lastErrorCode = error instanceof HostedXProviderError && error.status === 429
      ? 'x_rate_limited'
      : 'x_bootstrap_failed';
  }
  const existing = await findOwnedIntegration(env, session.accountId, transaction.avatar_id);
  if (existing && existing.x_user_id !== userId) {
    throw new HostedXConflictError('Disconnect the current X account before connecting a different one.');
  }
  const integrationId = existing?.integration_id ?? `x_${randomToken(24)}`;
  try {
    await secrets.putUserSecret(scope, ACCESS_TOKEN_SECRET, accessToken);
    await secrets.putUserSecret(scope, ACCESS_TOKEN_SECRET_SECRET, accessSecret);
  } catch (error) {
    await Promise.all([
      secrets.deleteUserSecret(scope, ACCESS_TOKEN_SECRET),
      secrets.deleteUserSecret(scope, ACCESS_TOKEN_SECRET_SECRET),
    ]);
    throw error;
  }
  const saved = await env.SWARM_STATE.prepare(
    `insert into swarm_hosted_x_integrations
       (account_id, avatar_id, integration_id, x_user_id, username, status, since_id,
        last_polled_at, poll_after, last_error_code, created_at, updated_at)
     values (?, ?, ?, ?, ?, 'connected', ?, ?, null, ?, ?, ?)
     on conflict(account_id, avatar_id) do update set
       x_user_id = excluded.x_user_id,
       username = excluded.username,
       status = 'connected',
       since_id = excluded.since_id,
       last_polled_at = excluded.last_polled_at,
       poll_after = null,
       last_error_code = excluded.last_error_code,
       updated_at = excluded.updated_at`,
  ).bind(
    session.accountId,
    transaction.avatar_id,
    integrationId,
    userId,
    username,
    sinceId,
    now,
    lastErrorCode,
    existing?.created_at ?? now,
    now,
  ).run();
  if (!saved.success) {
    await Promise.all([
      secrets.deleteUserSecret(scope, ACCESS_TOKEN_SECRET),
      secrets.deleteUserSecret(scope, ACCESS_TOKEN_SECRET_SECRET),
    ]);
    throw new HostedXConflictError('This X account or companion is already connected.');
  }
  const row = await findOwnedIntegration(env, session.accountId, transaction.avatar_id);
  if (!row) throw new Error('Unable to read the connected X account.');
  return { ...statusFromRow(row), avatarId: row.avatar_id };
}

export async function getHostedXStatus(
  env: CloudflareHostedBindings,
  session: HostedSession,
  avatarId: string,
): Promise<HostedXStatus> {
  const row = await findOwnedIntegration(env, session.accountId, avatarId);
  return row ? statusFromRow(row) : { connected: false, status: 'disconnected' };
}

export async function disconnectHostedX(
  env: CloudflareHostedBindings,
  session: HostedSession,
  avatarId: string,
): Promise<{ disconnected: true }> {
  const row = await findOwnedIntegration(env, session.accountId, avatarId);
  if (!row) return { disconnected: true };
  const scope = secretScope(row.account_id, row.avatar_id);
  const secrets = createCloudflareHostedPlatform(env).secrets;
  await Promise.all([
    secrets.deleteUserSecret(scope, ACCESS_TOKEN_SECRET),
    secrets.deleteUserSecret(scope, ACCESS_TOKEN_SECRET_SECRET),
    clearOldOAuthTransactions(env, row.account_id, row.avatar_id),
  ]);
  const removed = await env.SWARM_STATE.prepare(
    'delete from swarm_hosted_x_integrations where account_id = ? and avatar_id = ?',
  ).bind(row.account_id, row.avatar_id).run();
  ensureWrite(removed, 'Unable to disconnect X.');
  return { disconnected: true };
}

async function ensureXConversation(
  env: CloudflareHostedBindings,
  row: XIntegrationRow,
  conversationId: string,
  now: number,
): Promise<string> {
  const existing = await env.SWARM_STATE.prepare(
    'select thread_id from swarm_hosted_x_conversations where integration_id = ? and conversation_id = ?',
  ).bind(row.integration_id, conversationId).first<{ thread_id: string }>();
  if (existing) return existing.thread_id;
  const threadId = `thread_x_${randomToken(12)}`;
  const thread = await env.SWARM_STATE.prepare(
    `insert into swarm_hosted_chat_threads (account_id, avatar_id, thread_id, created_at, updated_at)
     values (?, ?, ?, ?, ?)`,
  ).bind(row.account_id, row.avatar_id, threadId, now, now).run();
  ensureWrite(thread, 'Unable to create an X conversation.');
  const mapped = await env.SWARM_STATE.prepare(
    `insert into swarm_hosted_x_conversations
       (integration_id, account_id, avatar_id, conversation_id, thread_id, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)
     on conflict(integration_id, conversation_id) do nothing`,
  ).bind(row.integration_id, row.account_id, row.avatar_id, conversationId, threadId, now, now).run();
  ensureWrite(mapped, 'Unable to map the X conversation.');
  const resolved = await env.SWARM_STATE.prepare(
    'select thread_id from swarm_hosted_x_conversations where integration_id = ? and conversation_id = ?',
  ).bind(row.integration_id, conversationId).first<{ thread_id: string }>();
  if (!resolved) throw new Error('Unable to read the X conversation.');
  if (resolved.thread_id !== threadId) {
    await env.SWARM_STATE.prepare(
      'delete from swarm_hosted_chat_threads where account_id = ? and avatar_id = ? and thread_id = ?',
    ).bind(row.account_id, row.avatar_id, threadId).run();
  }
  return resolved.thread_id;
}

function validMention(value: XMention): value is XMention & {
  id: string;
  text: string;
  author_id: string;
  conversation_id?: string;
} {
  return typeof value.id === 'string'
    && /^\d{1,20}$/u.test(value.id)
    && typeof value.text === 'string'
    && value.text.trim().length > 0
    && typeof value.author_id === 'string'
    && /^\d{1,20}$/u.test(value.author_id)
    && (value.conversation_id === undefined
      || (typeof value.conversation_id === 'string' && /^\d{1,20}$/u.test(value.conversation_id)));
}

async function storeMention(
  env: CloudflareHostedBindings,
  row: XIntegrationRow,
  mention: {
    id: string;
    text: string;
    author_id: string;
    conversation_id?: string;
  },
  usernames: Map<string, string>,
  now: number,
): Promise<void> {
  if (mention.author_id === row.x_user_id) return;
  const conversationId = mention.conversation_id ?? mention.id;
  const threadId = await ensureXConversation(env, row, conversationId, now);
  const requestId = `x_${row.integration_id}_${mention.id}`;
  const jobId = `xjob_${randomToken(18)}`;
  const authorUsername = usernames.get(mention.author_id);
  const sourceText = mention.text.trim().slice(0, 4_000);
  const userContent = `${authorUsername ? `@${authorUsername}` : 'Someone'} on X:\n${sourceText}`;
  const userMessage = await env.SWARM_STATE.prepare(
    `insert into swarm_hosted_chat_messages
       (account_id, avatar_id, thread_id, message_id, request_id, role, content, created_at)
     values (?, ?, ?, ?, ?, 'user', ?, ?)
     on conflict(account_id, avatar_id, request_id, role) do nothing`,
  ).bind(
    row.account_id,
    row.avatar_id,
    threadId,
    `message_${randomToken(18)}`,
    requestId,
    userContent,
    now,
  ).run();
  ensureWrite(userMessage, 'Unable to store an X mention.');
  const inserted = await env.SWARM_STATE.prepare(
    `insert into swarm_hosted_x_mentions
       (integration_id, mention_id, account_id, avatar_id, thread_id, author_id, author_username,
        conversation_id, request_id, job_id, status, attempts, max_attempts, response_text,
        reply_post_id, error_code, source_text, created_at, updated_at, completed_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', 0, ?, null, null, null, ?, ?, ?, null)
     on conflict(integration_id, mention_id) do nothing`,
  ).bind(
    row.integration_id,
    mention.id,
    row.account_id,
    row.avatar_id,
    threadId,
    mention.author_id,
    authorUsername ?? null,
    conversationId,
    requestId,
    jobId,
    MAX_MENTION_ATTEMPTS,
    sourceText,
    now,
    now,
  ).run();
  ensureWrite(inserted, 'Unable to record an X mention.');
}

async function enqueuePendingMentions(
  env: CloudflareHostedBindings,
  integrationId: string,
  now: number,
): Promise<void> {
  if (!env.SWARM_QUEUE) throw new HostedXConfigurationError('Hosted X requires the Queue binding.');
  const pending = await env.SWARM_STATE.prepare(
    `select job_id from swarm_hosted_x_mentions
     where integration_id = ? and status in ('received', 'retry')
     order by created_at asc limit 100`,
  ).bind(integrationId).all<{ job_id: string }>();
  for (const mention of pending.results ?? []) {
    await env.SWARM_QUEUE.send({
      type: 'swarm.hosted.x.mention',
      payload: { integrationId, jobId: mention.job_id },
      enqueuedAt: now,
    } satisfies HostedXQueueMessage);
    const queued = await env.SWARM_STATE.prepare(
      `update swarm_hosted_x_mentions set status = 'queued', updated_at = ?
       where integration_id = ? and job_id = ? and status in ('received', 'retry')`,
    ).bind(now, integrationId, mention.job_id).run();
    ensureWrite(queued, 'Unable to queue an X mention.');
  }
}

async function recordPollFailure(
  env: CloudflareHostedBindings,
  row: XIntegrationRow,
  error: unknown,
  now: number,
): Promise<void> {
  const authenticationFailure = error instanceof HostedXProviderError
    && (error.status === 401 || error.status === 403);
  const errorCode = authenticationFailure
    ? 'x_reauthorization_required'
    : error instanceof HostedXProviderError && error.status === 429
      ? 'x_rate_limited'
      : 'x_poll_failed';
  const pollAfter = error instanceof HostedXProviderError && error.status === 429
    ? now + (error.retryAfter ?? 60) * 1_000
    : null;
  const updated = await env.SWARM_STATE.prepare(
    `update swarm_hosted_x_integrations
     set status = ?, last_polled_at = ?, poll_after = ?, last_error_code = ?, updated_at = ?
     where integration_id = ?`,
  ).bind(
    authenticationFailure ? 'reauth_required' : row.status,
    now,
    pollAfter,
    errorCode,
    now,
    row.integration_id,
  ).run();
  ensureWrite(updated, 'Unable to record the X polling failure.');
  console.warn(JSON.stringify({
    level: 'WARN',
    subsystem: 'hosted-x',
    event: 'mention_poll_failed',
    integrationId: row.integration_id,
    code: errorCode,
  }));
}

async function pollIntegration(
  env: CloudflareHostedBindings,
  row: XIntegrationRow,
  fetchImpl: typeof fetch,
  now: number,
): Promise<void> {
  await enqueuePendingMentions(env, row.integration_id, now);
  const credentials = await xCredentialsForRow(env, row);
  if (!credentials) {
    await recordPollFailure(env, row, new HostedXProviderError('X credentials are missing.', 401), now);
    return;
  }
  try {
    const page = await fetchMentions(env, row, credentials, row.since_id, fetchImpl, now);
    const newestId = newestMentionId(page);
    const usernames = new Map<string, string>();
    for (const user of page.includes?.users ?? []) {
      if (typeof user.id === 'string' && typeof user.username === 'string') usernames.set(user.id, user.username);
    }
    const mentions = (page.data ?? []).filter(validMention).sort((left, right) => {
      const leftId = BigInt(left.id);
      const rightId = BigInt(right.id);
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });
    for (const mention of mentions) await storeMention(env, row, mention, usernames, now);
    const updated = await env.SWARM_STATE.prepare(
      `update swarm_hosted_x_integrations
       set since_id = coalesce(?, since_id), last_polled_at = ?, poll_after = null,
           last_error_code = null, updated_at = ?
       where integration_id = ?`,
    ).bind(newestId, now, now, row.integration_id).run();
    ensureWrite(updated, 'Unable to update the X polling cursor.');
    await enqueuePendingMentions(env, row.integration_id, now);
  } catch (error) {
    await recordPollFailure(env, row, error, now);
  }
}

export async function pollHostedXIntegrations(
  env: CloudflareHostedBindings,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<void> {
  if (!env.SWARM_QUEUE || !env.SWARM_X_API_KEY || !env.SWARM_X_API_SECRET) return;
  const integrations = await env.SWARM_STATE.prepare(
    `${integrationSelect("status = 'connected' and coalesce(poll_after, 0) <= ?")}
     order by coalesce(last_polled_at, 0) asc limit 50`,
  ).bind(now).all<XIntegrationRow>();
  for (const row of integrations.results ?? []) await pollIntegration(env, row, fetchImpl, now);
}

async function claimMention(
  env: CloudflareHostedBindings,
  integrationId: string,
  jobId: string,
  now: number,
): Promise<XMentionRow | null> {
  return env.SWARM_STATE.prepare(
    `update swarm_hosted_x_mentions
     set status = 'processing', attempts = attempts + 1, updated_at = ?
     where integration_id = ? and job_id = ? and status in ('queued', 'retry')
     returning integration_id, mention_id, account_id, avatar_id, thread_id, author_id,
               author_username, conversation_id, request_id, job_id, status, attempts,
               max_attempts, response_text, reply_post_id, error_code, source_text,
               created_at, updated_at, completed_at`,
  ).bind(now, integrationId, jobId).first<XMentionRow>();
}

async function setMentionState(
  env: CloudflareHostedBindings,
  row: XMentionRow,
  status: XMentionRow['status'],
  now: number,
  errorCode: string | null = null,
  responseText: string | null = row.response_text,
  replyPostId: string | null = row.reply_post_id,
): Promise<void> {
  const result = await env.SWARM_STATE.prepare(
    `update swarm_hosted_x_mentions
     set status = ?, response_text = ?, reply_post_id = ?, error_code = ?, updated_at = ?, completed_at = ?
     where integration_id = ? and mention_id = ?`,
  ).bind(
    status,
    responseText,
    replyPostId,
    errorCode,
    now,
    ['completed', 'failed', 'unknown'].includes(status) ? now : null,
    row.integration_id,
    row.mention_id,
  ).run();
  ensureWrite(result, 'Unable to update the X reply state.');
}

async function retryOrFail(
  env: CloudflareHostedBindings,
  row: XMentionRow,
  errorCode: string,
  retryable: boolean,
  now: number,
  requestedDelay?: number,
): Promise<QueueDisposition> {
  const willRetry = retryable && row.attempts < row.max_attempts;
  await setMentionState(env, row, willRetry ? 'retry' : 'failed', now, errorCode);
  return willRetry
    ? { action: 'retry', delaySeconds: requestedDelay ?? Math.min(60, 2 ** row.attempts) }
    : { action: 'ack' };
}

function safeReplyText(content: string): string {
  const points = Array.from(content.trim());
  if (points.length <= MAX_REPLY_CODE_POINTS) return points.join('');
  return `${points.slice(0, MAX_REPLY_CODE_POINTS - 1).join('').trimEnd()}…`;
}

function validQueueMessage(value: unknown): value is HostedXQueueMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as { type?: unknown; payload?: unknown };
  if (message.type !== 'swarm.hosted.x.mention' || !message.payload || typeof message.payload !== 'object') return false;
  const payload = message.payload as { integrationId?: unknown; jobId?: unknown };
  return typeof payload.integrationId === 'string'
    && /^x_[A-Za-z0-9_-]{20,80}$/u.test(payload.integrationId)
    && typeof payload.jobId === 'string'
    && /^xjob_[A-Za-z0-9_-]{12,80}$/u.test(payload.jobId);
}

export async function processHostedXQueueMessage(
  env: CloudflareHostedBindings,
  value: unknown,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<QueueDisposition> {
  if (!validQueueMessage(value)) return { action: 'ack' };
  const mention = await claimMention(env, value.payload.integrationId, value.payload.jobId, now);
  if (!mention) return { action: 'ack' };
  const integration = await env.SWARM_STATE.prepare(integrationSelect('integration_id = ?'))
    .bind(mention.integration_id)
    .first<XIntegrationRow>();
  if (!integration || integration.status !== 'connected') {
    return retryOrFail(env, mention, 'x_connector_unavailable', false, now);
  }
  const credentials = await xCredentialsForRow(env, integration);
  if (!credentials) {
    await recordPollFailure(
      env,
      integration,
      new HostedXProviderError('X credentials are missing.', 401),
      now,
    );
    return retryOrFail(env, mention, 'x_credentials_missing', false, now);
  }
  let content = mention.response_text;
  let storeInHistory = false;
  if (!content) {
    const model = await generateHostedReply(env, {
      accountId: mention.account_id,
      avatarId: mention.avatar_id,
      threadId: mention.thread_id,
      requestId: mention.request_id,
    }, fetchImpl);
    if (!model.ok) return retryOrFail(env, mention, model.code, model.retryable, now);
    content = safeReplyText(model.content);
    storeInHistory = true;
    await setMentionState(env, mention, 'processing', now, null, content);
    mention.response_text = content;
  }
  await setMentionState(env, mention, 'sending', now, null, content);
  let posted: XPostResponse;
  try {
    posted = await xJsonRequest<XPostResponse>({
      env,
      method: 'POST',
      url: `${X_API_ORIGIN}/2/tweets`,
      ...credentials,
      body: {
        text: content,
        reply: { in_reply_to_tweet_id: mention.mention_id },
      },
      fetchImpl,
      now,
      delivery: true,
    });
  } catch (error) {
    if (error instanceof HostedXProviderError) {
      if (error.ambiguous) {
        await setMentionState(env, mention, 'unknown', now, 'x_delivery_unknown', content);
        return { action: 'ack' };
      }
      if (error.status === 401 || error.status === 403) {
        await recordPollFailure(env, integration, error, now);
        return retryOrFail(env, mention, 'x_reauthorization_required', false, now);
      }
      return retryOrFail(env, mention, 'x_reply_failed', error.status === 429, now, error.retryAfter);
    }
    await setMentionState(env, mention, 'unknown', now, 'x_delivery_unknown', content);
    return { action: 'ack' };
  }
  const replyPostId = typeof posted.data?.id === 'string' && /^\d{1,20}$/u.test(posted.data.id)
    ? posted.data.id
    : null;
  if (!replyPostId) {
    await setMentionState(env, mention, 'unknown', now, 'x_delivery_unknown', content);
    return { action: 'ack' };
  }
  if (storeInHistory) {
    await storeHostedAssistantMessage(env, {
      accountId: mention.account_id,
      avatarId: mention.avatar_id,
      threadId: mention.thread_id,
      requestId: mention.request_id,
      content,
      createdAt: now,
    });
  }
  await setMentionState(env, mention, 'completed', now, null, content, replyPostId);
  return { action: 'ack' };
}

export async function cleanupHostedXRuntime(
  env: CloudflareHostedBindings,
  now = Date.now(),
): Promise<void> {
  const expired = await env.SWARM_STATE.prepare(
    `select token_hash, account_id, avatar_id, session_hash, created_at, expires_at
     from swarm_hosted_x_oauth_transactions where expires_at <= ?`,
  ).bind(now).all<XOAuthTransactionRow>();
  const secrets = createCloudflareHostedPlatform(env).secrets;
  for (const transaction of expired.results ?? []) {
    await secrets.deleteUserSecret(
      secretScope(transaction.account_id, transaction.avatar_id),
      oauthRequestSecretName(transaction.token_hash),
    );
  }
  const oauthCleanup = await env.SWARM_STATE.prepare(
    'delete from swarm_hosted_x_oauth_transactions where expires_at <= ?',
  ).bind(now).run();
  ensureWrite(oauthCleanup, 'Unable to clean X authorization state.');
  const mentionCleanup = await env.SWARM_STATE.prepare(
    `delete from swarm_hosted_x_mentions
     where created_at <= ? and status in ('completed', 'failed', 'unknown')`,
  ).bind(now - TERMINAL_RETENTION_MS).run();
  ensureWrite(mentionCleanup, 'Unable to clean X delivery state.');
  const interrupted = await env.SWARM_STATE.prepare(
    `update swarm_hosted_x_mentions
     set status = 'unknown', error_code = 'worker_interrupted', updated_at = ?, completed_at = ?
     where status in ('processing', 'sending') and updated_at <= ?`,
  ).bind(now, now, now - 120_000).run();
  ensureWrite(interrupted, 'Unable to recover X delivery state.');
}
