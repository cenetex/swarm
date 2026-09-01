import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'bun:test';
import { hostedSessionCookie, sha256, type HostedSession } from './auth.js';
import type {
  CloudflareD1Database,
  CloudflareD1PreparedStatement,
  CloudflareHostedBindings,
} from './bindings.js';
import { createCloudflareHostedPlatform } from './platform.js';
import { encodeHostedSecretKey } from './secret-crypto.js';
import {
  beginHostedXConnect,
  completeHostedXConnect,
  createHostedXAuthorizationHeader,
  disconnectHostedX,
  getHostedXStatus,
  HostedXProviderError,
  pollHostedXIntegrations,
  probeHostedXConfiguration,
  processHostedXQueueMessage,
  type HostedXQueueMessage,
} from './hosted-x.js';
import worker from './worker.js';

class SqliteStatement implements CloudflareD1PreparedStatement {
  private values: unknown[] = [];

  constructor(private readonly db: Database, private readonly query: string) {}

  bind(...values: unknown[]): CloudflareD1PreparedStatement {
    this.values = values;
    return this;
  }

  async first<T = unknown>(column?: string): Promise<T | null> {
    const statement = this.db.query(this.query) as unknown as { get(...values: unknown[]): unknown };
    const row = statement.get(...this.values) as Record<string, unknown> | null;
    if (!row) return null;
    return (column ? row[column] : row) as T | null;
  }

  async all<T = unknown>() {
    const statement = this.db.query(this.query) as unknown as { all(...values: unknown[]): unknown[] };
    return { success: true, results: statement.all(...this.values) as T[] };
  }

  async run() {
    const statement = this.db.query(this.query) as unknown as { run(...values: unknown[]): unknown };
    statement.run(...this.values);
    return { success: true };
  }
}

class SqliteD1 implements CloudflareD1Database {
  readonly db = new Database(':memory:');

  constructor() {
    this.db.exec('pragma foreign_keys = on');
    for (const migration of [
      '0002_hosted_identity_and_secrets.sql',
      '0003_hosted_chat_runtime.sql',
      '0006_portable_public_avatars.sql',
      '0008_hosted_x.sql',
      '0009_passkeys.sql',
      '0010_hosted_x_poll_backoff.sql',
    ]) {
      this.db.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
    }
  }

  prepare(query: string): CloudflareD1PreparedStatement {
    return new SqliteStatement(this.db, query);
  }

  close(): void {
    this.db.close();
  }
}

const session: HostedSession = {
  accountId: 'account-1',
  walletAddress: 'wallet-1',
  expiresAt: 9_999_999,
  sessionHash: 'session-1',
  authProvider: 'wallet',
};

const otherSession: HostedSession = {
  accountId: 'account-2',
  walletAddress: 'wallet-2',
  expiresAt: 9_999_999,
  sessionHash: 'session-2',
  authProvider: 'wallet',
};

function insertAccountAndAvatar(state: SqliteD1, accountId: string, avatarId: string, wallet: string): void {
  state.db.query('insert into swarm_accounts (account_id, created_at) values (?, ?)').run(accountId, 1);
  state.db.query(`insert into swarm_hosted_avatars
    (account_id, avatar_id, default_thread_id, name, description, persona, status, created_by, created_at, updated_at)
    values (?, ?, ?, ?, null, null, 'shell', ?, 1, 1)`).run(
      accountId,
      avatarId,
      `thread-browser-${accountId}`,
      accountId === 'account-1' ? 'Jax' : 'Nova',
      wallet,
    );
  state.db.query(`insert into swarm_hosted_chat_threads
    (account_id, avatar_id, thread_id, created_at, updated_at)
    values (?, ?, ?, 1, 1)`).run(accountId, avatarId, `thread-browser-${accountId}`);
}

function setup() {
  const state = new SqliteD1();
  insertAccountAndAvatar(state, 'account-1', 'avatar-1', 'wallet-1');
  insertAccountAndAvatar(state, 'account-2', 'avatar-2', 'wallet-2');
  const queued: HostedXQueueMessage[] = [];
  const env: CloudflareHostedBindings = {
    SWARM_STATE: state,
    SWARM_BLOBS: {
      get: async () => null,
      put: async () => undefined,
      delete: async () => undefined,
    },
    SWARM_QUEUE: { send: async (message) => queued.push(message as HostedXQueueMessage) },
    SWARM_HOSTED_ENABLED: '1',
    SWARM_PUBLIC_URL: 'https://next.swarm.rati.chat',
    SWARM_USER_SECRET_KEK: encodeHostedSecretKey(new Uint8Array(32).fill(13)),
    SWARM_USER_SECRET_KEY_VERSION: 'v1',
    SWARM_X_API_KEY: 'x-app-key',
    SWARM_X_API_SECRET: 'x-app-secret',
  };
  return { state, env, queued };
}

function oauthFetch(calls: Array<{ url: string; authorization: string; body?: string }>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      authorization: String(new Headers(init?.headers).get('Authorization') ?? ''),
      ...(init?.body ? { body: String(init.body) } : {}),
    });
    if (url.endsWith('/oauth/request_token')) {
      return new Response(
        'oauth_token=request-token&oauth_token_secret=request-secret&oauth_callback_confirmed=true',
      );
    }
    if (url.endsWith('/oauth/access_token')) {
      return new Response(
        'oauth_token=access-token&oauth_token_secret=access-secret&user_id=42&screen_name=JaxOnX',
      );
    }
    if (url.includes('/2/users/42/mentions')) {
      return Response.json({ data: [], meta: { newest_id: '100' } });
    }
    throw new Error(`Unexpected X request: ${url}`);
  }) as typeof fetch;
}

async function connect(env: CloudflareHostedBindings, calls: Array<{ url: string; authorization: string; body?: string }>) {
  const fetchImpl = oauthFetch(calls);
  const started = await beginHostedXConnect(env, session, {
    avatarId: 'avatar-1',
    publicOrigin: 'https://next.swarm.rati.chat',
  }, fetchImpl, 1_000);
  const status = await completeHostedXConnect(env, session, {
    oauthToken: 'request-token',
    oauthVerifier: 'verifier',
  }, fetchImpl, 1_100);
  return { started, status };
}

function xStartRequest(sessionToken: string, origin = 'https://next.swarm.rati.chat'): Request {
  return new Request('https://next.swarm.rati.chat/api/auth/x/start', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: hostedSessionCookie(sessionToken).split(';', 1)[0] ?? '',
      Origin: origin,
    },
    body: JSON.stringify({ avatarId: 'avatar-1' }),
  });
}

const resources: SqliteD1[] = [];
afterEach(() => {
  while (resources.length) resources.pop()?.close();
});

describe('hosted X connector', () => {
  it('matches the OAuth 1.0 signature example from RFC 5849', async () => {
    const authorization = await createHostedXAuthorizationHeader({
      method: 'GET',
      url: 'http://photos.example.net/photos?file=vacation.jpg&size=original',
      apiKey: 'dpf43f3p2l4k3l03',
      apiSecret: 'kd94hf93k423kf44',
      token: 'nnch734d00sl2jdk',
      tokenSecret: 'pfkkdhi9sl3r4s00',
      nonce: 'kllo9940pd9333jh',
      now: 1_191_242_096_000,
    });

    expect(authorization).toContain('oauth_signature="tR3%2BTy81lMeYAr%2FFid0kMTYa%2FWM%3D"');
  });

  it('probes the exact callback without exposing the request token', async () => {
    const { state, env } = setup();
    resources.push(state);
    const calls: Array<{ url: string; authorization: string; body?: string }> = [];

    await expect(probeHostedXConfiguration(
      env,
      'https://next.swarm.rati.chat/api/auth/x/callback',
      oauthFetch(calls),
      1_000,
    )).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorization).toContain(
      'oauth_callback="https%3A%2F%2Fnext.swarm.rati.chat%2Fapi%2Fauth%2Fx%2Fcallback"',
    );
  });

  it('returns a safe error when X rejects the app configuration', async () => {
    const { state, env } = setup();
    resources.push(state);
    const sessionToken = 'hosted-x-worker-session';
    const now = Date.now();
    state.db.query(`insert into swarm_sessions
      (session_hash, account_id, wallet_address, created_at, expires_at)
      values (?, 'account-1', 'wallet-1', ?, ?)`).run(await sha256(sessionToken), now, now + 60_000);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('private upstream detail', { status: 403 })) as typeof fetch;

    try {
      const response = await worker.fetch(xStartRequest(sessionToken), env);

      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        error: 'X rejected the app API Key, API Key Secret, or callback URL.',
        code: 'x_app_configuration_rejected',
        stage: 'response',
        upstreamStatus: 403,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps the Cloudflare fetch receiver when starting OAuth', async () => {
    const { state, env } = setup();
    resources.push(state);
    const sessionToken = 'hosted-x-fetch-receiver-session';
    const now = Date.now();
    state.db.query(`insert into swarm_sessions
      (session_hash, account_id, wallet_address, created_at, expires_at)
      values (?, 'account-1', 'wallet-1', ?, ?)`).run(await sha256(sessionToken), now, now + 60_000);
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = (async function (this: unknown) {
      expect(this).toBe(globalThis);
      called = true;
      return new Response(
        'oauth_token=request-token&oauth_token_secret=request-secret&oauth_callback_confirmed=true',
      );
    }) as typeof fetch;

    try {
      const response = await worker.fetch(xStartRequest(sessionToken), env);

      expect(called).toBeTrue();
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({
        authorizationUrl: 'https://api.x.com/oauth/authorize?oauth_token=request-token',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects a cross-origin request before starting OAuth', async () => {
    const { state, env } = setup();
    resources.push(state);
    const sessionToken = 'hosted-x-origin-session';
    const now = Date.now();
    state.db.query(`insert into swarm_sessions
      (session_hash, account_id, wallet_address, created_at, expires_at)
      values (?, 'account-1', 'wallet-1', ?, ?)`).run(await sha256(sessionToken), now, now + 60_000);

    const response = await worker.fetch(xStartRequest(sessionToken, 'https://attacker.example'), env);

    expect(response.status).toBe(403);
    expect(state.db.query('select count(*) as count from swarm_hosted_x_oauth_transactions').get())
      .toEqual({ count: 0 });
  });

  it('returns from the callback with the companion that started OAuth', async () => {
    const { state, env } = setup();
    resources.push(state);
    const sessionToken = 'hosted-x-callback-session';
    const now = Date.now();
    const sessionHash = await sha256(sessionToken);
    state.db.query(`insert into swarm_sessions
      (session_hash, account_id, wallet_address, created_at, expires_at)
      values (?, 'account-1', 'wallet-1', ?, ?)`).run(sessionHash, now, now + 60_000);
    const calls: Array<{ url: string; authorization: string; body?: string }> = [];
    const fetchImpl = oauthFetch(calls);
    await beginHostedXConnect(env, { ...session, sessionHash }, {
      avatarId: 'avatar-1',
      publicOrigin: 'https://next.swarm.rati.chat',
    }, fetchImpl, now);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchImpl;

    try {
      const response = await worker.fetch(new Request(
        'https://next.swarm.rati.chat/api/auth/x/callback?oauth_token=request-token&oauth_verifier=verifier',
        { headers: { Cookie: hostedSessionCookie(sessionToken).split(';', 1)[0] ?? '' } },
      ), env);

      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe(
        'https://next.swarm.rati.chat/studio?x=connected&xAvatarId=avatar-1',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps provider failures typed without retaining upstream response bodies', async () => {
    const { state, env } = setup();
    resources.push(state);
    const rejected = probeHostedXConfiguration(
      env,
      'https://next.swarm.rati.chat/api/auth/x/callback',
      (async () => new Response('private upstream detail', { status: 403 })) as typeof fetch,
      1_000,
    );

    await expect(rejected).rejects.toBeInstanceOf(HostedXProviderError);
    await expect(rejected).rejects.toMatchObject({
      status: 403,
      stage: 'response',
      message: 'X rejected the app API Key, API Key Secret, or callback URL.',
    });
  });

  it('returns a bounded redacted runtime detail for a network failure', async () => {
    const { state, env } = setup();
    resources.push(state);
    const sessionToken = 'hosted-x-network-session';
    const now = Date.now();
    state.db.query(`insert into swarm_sessions
      (session_hash, account_id, wallet_address, created_at, expires_at)
      values (?, 'account-1', 'wallet-1', ?, ?)`).run(await sha256(sessionToken), now, now + 60_000);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError(`connect failed for ${env.SWARM_X_API_KEY} using ${env.SWARM_X_API_SECRET}`);
    }) as typeof fetch;

    try {
      const response = await worker.fetch(xStartRequest(sessionToken), env);

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: 'X could not be reached.',
        code: 'x_unavailable',
        stage: 'network',
        upstreamStatus: 0,
        networkDetail: 'TypeError: connect failed for [redacted] using [redacted]',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('separates an outbound network failure from an X server response', async () => {
    const { state, env } = setup();
    resources.push(state);
    const callbackUrl = 'https://next.swarm.rati.chat/api/auth/x/callback';
    const networkFailure = probeHostedXConfiguration(
      env,
      callbackUrl,
      (async () => {
        throw new TypeError(`connection failed for ${env.SWARM_X_API_KEY} using ${env.SWARM_X_API_SECRET}`);
      }) as typeof fetch,
      1_000,
    );
    await expect(networkFailure).rejects.toMatchObject({
      status: 0,
      stage: 'network',
      message: 'X could not be reached.',
      networkDetail: 'TypeError: connection failed for [redacted] using [redacted]',
    });
    const providerFailure = probeHostedXConfiguration(
      env,
      callbackUrl,
      (async () => new Response('private upstream detail', { status: 503 })) as typeof fetch,
      1_000,
    );
    await expect(providerFailure).rejects.toMatchObject({
      status: 503,
      stage: 'response',
      message: 'X is temporarily unavailable.',
    });
  });

  it('uses three-legged OAuth and keeps request and access secrets encrypted', async () => {
    const { state, env } = setup();
    resources.push(state);
    const calls: Array<{ url: string; authorization: string; body?: string }> = [];

    const { started, status } = await connect(env, calls);

    expect(started.authorizationUrl).toBe('https://api.x.com/oauth/authorize?oauth_token=request-token');
    expect(status).toMatchObject({
      connected: true,
      status: 'connected',
      username: 'JaxOnX',
      userId: '42',
    });
    expect(JSON.stringify(status)).not.toContain('access-token');
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.authorization.startsWith('OAuth '))).toBeTrue();
    expect(calls[0]?.authorization).toContain('oauth_callback=');
    expect(calls[1]?.authorization).toContain('oauth_verifier=');
    expect(state.db.query('select count(*) as count from swarm_hosted_x_oauth_transactions').get())
      .toEqual({ count: 0 });
    const secrets = state.db.query('select name, envelope from swarm_user_secrets order by name').all() as Array<{
      name: string;
      envelope: string;
    }>;
    expect(secrets.map((row) => row.name)).toEqual(['x-access-token', 'x-access-token-secret']);
    expect(secrets.every((row) => !row.envelope.includes('access-token') && !row.envelope.includes('access-secret')))
      .toBeTrue();
  });

  it('keeps status and disconnect operations inside the owning account and avatar', async () => {
    const { state, env } = setup();
    resources.push(state);
    await connect(env, []);

    await expect(getHostedXStatus(env, otherSession, 'avatar-1')).resolves.toEqual({
      connected: false,
      status: 'disconnected',
    });
    await expect(disconnectHostedX(env, otherSession, 'avatar-1')).resolves.toEqual({ disconnected: true });
    await expect(getHostedXStatus(env, session, 'avatar-1')).resolves.toMatchObject({ username: 'JaxOnX' });

    await expect(disconnectHostedX(env, session, 'avatar-1')).resolves.toEqual({ disconnected: true });
    expect(state.db.query('select count(*) as count from swarm_hosted_x_integrations').get()).toEqual({ count: 0 });
    expect(state.db.query('select count(*) as count from swarm_user_secrets').get()).toEqual({ count: 0 });
  });

  it('polls, deduplicates, queues, and posts one reply in the source conversation', async () => {
    const { state, env, queued } = setup();
    resources.push(state);
    await connect(env, []);
    await createCloudflareHostedPlatform(env).secrets.putUserSecret(
      { accountId: 'account-1' },
      'llm-api-key',
      'openrouter-key',
    );
    const pollFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/2/users/42/mentions')) {
        return Response.json({
          data: [{ id: '101', text: '@JaxOnX hello', author_id: '77', conversation_id: '900' }],
          includes: { users: [{ id: '77', username: 'PenguinFriend' }] },
          meta: { newest_id: '101' },
        });
      }
      throw new Error(`Unexpected poll request: ${url}`);
    }) as typeof fetch;

    await pollHostedXIntegrations(env, pollFetch, 2_000);
    await pollHostedXIntegrations(env, pollFetch, 2_001);
    expect(queued).toHaveLength(1);
    expect(state.db.query('select count(*) as count from swarm_hosted_x_mentions').get()).toEqual({ count: 1 });
    expect(state.db.query(
      "select count(*) as count from swarm_hosted_chat_messages where role = 'user' and request_id like 'x_%'",
    ).get()).toEqual({ count: 1 });

    const deliveryCalls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    const deliveryFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
      deliveryCalls.push({ url, ...(body ? { body } : {}) });
      if (url.includes('openrouter.ai')) {
        return Response.json({ choices: [{ message: { content: 'Hello from Jax' } }] });
      }
      if (url.endsWith('/2/tweets')) {
        return Response.json({ data: { id: '500', text: 'Hello from Jax' } }, { status: 201 });
      }
      throw new Error(`Unexpected delivery request: ${url}`);
    }) as typeof fetch;
    await expect(processHostedXQueueMessage(env, queued[0], deliveryFetch, 3_000))
      .resolves.toEqual({ action: 'ack' });
    await expect(processHostedXQueueMessage(env, queued[0], deliveryFetch, 3_001))
      .resolves.toEqual({ action: 'ack' });
    const post = deliveryCalls.find((call) => call.url.endsWith('/2/tweets'));
    expect(post?.body).toEqual({
      text: 'Hello from Jax',
      reply: { in_reply_to_tweet_id: '101' },
    });
    expect(deliveryCalls.filter((call) => call.url.endsWith('/2/tweets'))).toHaveLength(1);
    expect(state.db.query(
      'select status, reply_post_id from swarm_hosted_x_mentions where mention_id = ?',
    ).get('101')).toEqual({ status: 'completed', reply_post_id: '500' });
    expect(state.db.query(
      "select count(*) as count from swarm_hosted_chat_messages where role = 'assistant' and request_id like 'x_%'",
    ).get()).toEqual({ count: 1 });
  });

  it('does not retry an ambiguous X delivery', async () => {
    const { state, env, queued } = setup();
    resources.push(state);
    await connect(env, []);
    await createCloudflareHostedPlatform(env).secrets.putUserSecret(
      { accountId: 'account-1' },
      'llm-api-key',
      'openrouter-key',
    );
    const pollFetch = (async () => Response.json({
      data: [{ id: '101', text: '@JaxOnX hello', author_id: '77', conversation_id: '900' }],
      meta: { newest_id: '101' },
    })) as typeof fetch;
    await pollHostedXIntegrations(env, pollFetch, 2_000);
    let postAttempts = 0;
    const ambiguousFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('openrouter.ai')) {
        return Response.json({ choices: [{ message: { content: 'One reply' } }] });
      }
      if (url.endsWith('/2/tweets')) {
        postAttempts += 1;
        throw new Error('connection reset after request write');
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    await expect(processHostedXQueueMessage(env, queued[0], ambiguousFetch, 3_000))
      .resolves.toEqual({ action: 'ack' });
    await expect(processHostedXQueueMessage(env, queued[0], ambiguousFetch, 3_001))
      .resolves.toEqual({ action: 'ack' });
    expect(postAttempts).toBe(1);
    expect(state.db.query(
      'select status, error_code from swarm_hosted_x_mentions where mention_id = ?',
    ).get('101')).toEqual({ status: 'unknown', error_code: 'x_delivery_unknown' });
  });

  it('retries a definite X rate limit with the same generated reply', async () => {
    const { state, env, queued } = setup();
    resources.push(state);
    await connect(env, []);
    await createCloudflareHostedPlatform(env).secrets.putUserSecret(
      { accountId: 'account-1' },
      'llm-api-key',
      'openrouter-key',
    );
    await pollHostedXIntegrations(env, (async () => Response.json({
      data: [{ id: '101', text: '@JaxOnX hello', author_id: '77', conversation_id: '900' }],
      meta: { newest_id: '101' },
    })) as typeof fetch, 2_000);
    let modelCalls = 0;
    let postCalls = 0;
    const rateLimitedFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('openrouter.ai')) {
        modelCalls += 1;
        return Response.json({ choices: [{ message: { content: 'Stable reply' } }] });
      }
      if (url.endsWith('/2/tweets')) {
        postCalls += 1;
        if (postCalls === 1) {
          return Response.json({ title: 'Too Many Requests' }, {
            status: 429,
            headers: { 'Retry-After': '7' },
          });
        }
        return Response.json({ data: { id: '501', text: 'Stable reply' } }, { status: 201 });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;

    await expect(processHostedXQueueMessage(env, queued[0], rateLimitedFetch, 3_000))
      .resolves.toEqual({ action: 'retry', delaySeconds: 7 });
    await expect(processHostedXQueueMessage(env, queued[0], rateLimitedFetch, 3_100))
      .resolves.toEqual({ action: 'ack' });
    expect(modelCalls).toBe(1);
    expect(postCalls).toBe(2);
    expect(state.db.query(
      'select status, reply_post_id from swarm_hosted_x_mentions where mention_id = ?',
    ).get('101')).toEqual({ status: 'completed', reply_post_id: '501' });
  });

  it('persists the mention polling rate-limit delay across scheduled runs', async () => {
    const { state, env } = setup();
    resources.push(state);
    await connect(env, []);
    let pollCalls = 0;
    const rateLimitedPoll = (async () => {
      pollCalls += 1;
      if (pollCalls === 1) {
        return Response.json({ title: 'Too Many Requests' }, {
          status: 429,
          headers: { 'Retry-After': '120' },
        });
      }
      return Response.json({ data: [], meta: { newest_id: '100' } });
    }) as typeof fetch;

    await pollHostedXIntegrations(env, rateLimitedPoll, 2_000);
    expect(state.db.query(
      'select poll_after, last_error_code from swarm_hosted_x_integrations where avatar_id = ?',
    ).get('avatar-1')).toEqual({ poll_after: 122_000, last_error_code: 'x_rate_limited' });

    await pollHostedXIntegrations(env, rateLimitedPoll, 62_000);
    expect(pollCalls).toBe(1);

    await pollHostedXIntegrations(env, rateLimitedPoll, 122_001);
    expect(pollCalls).toBe(2);
    expect(state.db.query(
      'select poll_after, last_error_code from swarm_hosted_x_integrations where avatar_id = ?',
    ).get('avatar-1')).toEqual({ poll_after: null, last_error_code: null });
  });

  it('marks the connector for reauthorization when X rejects polling credentials', async () => {
    const { state, env } = setup();
    resources.push(state);
    await connect(env, []);
    const unauthorized = (async () => Response.json({ title: 'Unauthorized' }, { status: 401 })) as typeof fetch;

    await pollHostedXIntegrations(env, unauthorized, 2_000);

    await expect(getHostedXStatus(env, session, 'avatar-1')).resolves.toMatchObject({
      connected: true,
      status: 'reauth_required',
      lastErrorCode: 'x_reauthorization_required',
    });
  });
});
