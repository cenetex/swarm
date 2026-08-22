import { describe, expect, it } from 'bun:test';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { createWalletChallenge, getHostedSession, hostedSessionCookie, verifyWalletChallenge } from './auth.js';
import type { CloudflareD1Database, CloudflareD1PreparedStatement, CloudflareHostedBindings } from './bindings.js';
import {
  beginOpenRouterConnect,
  completeOpenRouterConnect,
  disconnectOpenRouter,
  getOpenRouterConnectionStatus,
} from './openrouter.js';
import { createCloudflareHostedPlatform } from './platform.js';
import { encodeHostedSecretKey } from './secret-crypto.js';
import worker from './worker.js';

type Challenge = { wallet_address: string; message: string; expires_at: number };
type Session = { account_id: string; wallet_address: string; expires_at: number };
type OAuthTransaction = {
  account_id: string;
  session_hash: string;
  verifier_envelope: string;
  expires_at: number;
};

class MemoryD1 implements CloudflareD1Database {
  readonly accounts = new Set<string>();
  readonly identities = new Map<string, string>();
  readonly challenges = new Map<string, Challenge>();
  readonly rateLimits = new Map<string, { windowStart: number; count: number; expiresAt: number }>();
  readonly sessions = new Map<string, Session>();
  readonly oauthTransactions = new Map<string, OAuthTransaction>();
  readonly secrets = new Map<string, { envelope: string; keyVersion: string }>();

  prepare(query: string): CloudflareD1PreparedStatement {
    return new MemoryStatement(this, query.replace(/\s+/gu, ' ').trim().toLowerCase());
  }
}

class MemoryStatement implements CloudflareD1PreparedStatement {
  private values: unknown[] = [];

  constructor(
    private readonly db: MemoryD1,
    private readonly query: string,
  ) {}

  bind(...values: unknown[]): CloudflareD1PreparedStatement {
    this.values = values;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    if (this.query.startsWith('insert into swarm_auth_rate_limits')) {
      const [rateKey, windowStart, expiresAt] = this.values as [string, number, number];
      const existing = this.db.rateLimits.get(rateKey);
      const count = existing?.windowStart === windowStart ? existing.count + 1 : 1;
      this.db.rateLimits.set(rateKey, { windowStart, count, expiresAt });
      return { count } as T;
    }
    if (this.query.startsWith('select account_id from swarm_identities')) {
      const accountId = this.db.identities.get(String(this.values[0]));
      return (accountId ? { account_id: accountId } : null) as T | null;
    }
    if (this.query.startsWith('delete from swarm_auth_challenges')) {
      const [nonceHash, walletAddress, now] = this.values as [string, string, number];
      const challenge = this.db.challenges.get(nonceHash);
      if (!challenge || challenge.wallet_address !== walletAddress || challenge.expires_at <= now) return null;
      this.db.challenges.delete(nonceHash);
      return challenge as T;
    }
    if (this.query.startsWith('select account_id, wallet_address, expires_at from swarm_sessions')) {
      const [sessionHash, now] = this.values as [string, number];
      const session = this.db.sessions.get(sessionHash);
      return (session && session.expires_at > now ? session : null) as T | null;
    }
    if (this.query.startsWith('delete from swarm_oauth_transactions')) {
      const [stateHash, accountId, sessionHash, now] = this.values as [string, string, string, number];
      const transaction = this.db.oauthTransactions.get(stateHash);
      if (
        !transaction ||
        transaction.account_id !== accountId ||
        transaction.session_hash !== sessionHash ||
        transaction.expires_at <= now
      )
        return null;
      this.db.oauthTransactions.delete(stateHash);
      return transaction as T;
    }
    if (this.query.startsWith('select envelope from swarm_user_secrets')) {
      const [accountId, tenantId, name] = this.values.map(String);
      const secret = this.db.secrets.get(`${accountId}|${tenantId}|${name}`);
      return (secret ? { envelope: secret.envelope } : null) as T | null;
    }
    if (this.query.startsWith('select 1 as present from swarm_user_secrets')) {
      const [accountId, tenantId, name] = this.values.map(String);
      return (this.db.secrets.has(`${accountId}|${tenantId}|${name}`) ? { present: 1 } : null) as T | null;
    }
    return null;
  }

  async all<T = unknown>(): Promise<{ success: boolean; results: T[] }> {
    return { success: true, results: [] };
  }

  async run(): Promise<{ success: boolean }> {
    if (this.query.startsWith('insert into swarm_auth_challenges')) {
      const [nonceHash, walletAddress, message, , expiresAt] = this.values as [string, string, string, number, number];
      this.db.challenges.set(nonceHash, {
        wallet_address: walletAddress,
        message,
        expires_at: expiresAt,
      });
    } else if (this.query.startsWith('insert into swarm_accounts')) {
      this.db.accounts.add(String(this.values[0]));
    } else if (this.query.startsWith('insert into swarm_identities')) {
      const [walletAddress, accountId] = this.values.map(String);
      if (!this.db.identities.has(walletAddress)) this.db.identities.set(walletAddress, accountId);
    } else if (this.query.startsWith('insert into swarm_sessions')) {
      const [sessionHash, accountId, walletAddress, , expiresAt] = this.values as [
        string,
        string,
        string,
        number,
        number,
      ];
      this.db.sessions.set(sessionHash, {
        account_id: accountId,
        wallet_address: walletAddress,
        expires_at: expiresAt,
      });
    } else if (this.query.startsWith('delete from swarm_sessions')) {
      this.db.sessions.delete(String(this.values[0]));
    } else if (this.query.startsWith('insert into swarm_oauth_transactions')) {
      const [stateHash, accountId, sessionHash, verifierEnvelope, , expiresAt] = this.values as [
        string,
        string,
        string,
        string,
        number,
        number,
      ];
      this.db.oauthTransactions.set(stateHash, {
        account_id: accountId,
        session_hash: sessionHash,
        verifier_envelope: verifierEnvelope,
        expires_at: expiresAt,
      });
    } else if (this.query.startsWith('insert into swarm_user_secrets')) {
      const [accountId, tenantId, name, envelope, keyVersion] = this.values.map(String);
      this.db.secrets.set(`${accountId}|${tenantId}|${name}`, { envelope, keyVersion });
    } else if (this.query.startsWith('delete from swarm_user_secrets')) {
      const [accountId, tenantId, name] = this.values.map(String);
      this.db.secrets.delete(`${accountId}|${tenantId}|${name}`);
    }
    return { success: true };
  }
}

function testEnv(db: MemoryD1): CloudflareHostedBindings {
  return {
    SWARM_STATE: db,
    SWARM_BLOBS: {
      get: async () => null,
      put: async () => ({}),
      delete: async () => {},
    },
    SWARM_ENV: 'test',
    SWARM_PUBLIC_URL: 'https://swarm.example',
    SWARM_USER_SECRET_KEK: encodeHostedSecretKey(new Uint8Array(32).fill(11)),
    SWARM_USER_SECRET_KEY_VERSION: 'v1',
  };
}

async function signedInSession(env: CloudflareHostedBindings, now = 1_000_000) {
  const keyPair = nacl.sign.keyPair();
  const walletAddress = bs58.encode(keyPair.publicKey);
  const request = new Request('https://swarm.example/api/auth/wallet/challenge', { method: 'POST' });
  const challenge = await createWalletChallenge(env, request, walletAddress, now);
  const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(challenge.message), keyPair.secretKey));
  const session = await verifyWalletChallenge(
    env,
    {
      walletAddress,
      nonce: challenge.nonce,
      signature,
    },
    now + 100,
  );
  if (!session) throw new Error('Expected wallet session.');
  return { challenge, session, walletAddress };
}

describe('Cloudflare hosted authentication flow', () => {
  it('creates a one-use SIWS challenge and an HttpOnly session', async () => {
    const db = new MemoryD1();
    const env = testEnv(db);
    const { challenge, session, walletAddress } = await signedInSession(env);
    expect(session.accountId).toStartWith('acct_');

    const request = new Request('https://swarm.example/api/auth/me', {
      headers: { Cookie: hostedSessionCookie(session.sessionToken) },
    });
    const restored = await getHostedSession(env, request, 1_000_200);
    expect(restored?.walletAddress).toBe(walletAddress);
    expect(hostedSessionCookie(session.sessionToken)).toContain('HttpOnly; Secure; SameSite=Lax');

    const replay = await verifyWalletChallenge(
      env,
      {
        walletAddress,
        nonce: challenge.nonce,
        signature: bs58.encode(new Uint8Array(64)),
      },
      1_000_300,
    );
    expect(replay).toBeNull();
  });

  it('rate-limits repeated wallet challenges by source and wallet', async () => {
    const db = new MemoryD1();
    const env = testEnv(db);
    const walletAddress = bs58.encode(nacl.sign.keyPair().publicKey);
    const request = new Request('https://swarm.example/api/auth/challenge', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': '203.0.113.1' },
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(createWalletChallenge(env, request, walletAddress, 3_000_000 + attempt)).resolves.toHaveProperty(
        'nonce',
      );
    }
    await expect(createWalletChallenge(env, request, walletAddress, 3_000_010)).rejects.toMatchObject({
      name: 'HostedRateLimitError',
      retryAfter: 60,
    });
  });

  it('rejects cross-origin session and credential requests', async () => {
    const db = new MemoryD1();
    const env = testEnv(db);
    const response = await worker.fetch(
      new Request('https://swarm.example/api/auth/challenge', {
        method: 'POST',
        headers: {
          Origin: 'https://evil.example',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ walletAddress: bs58.encode(nacl.sign.keyPair().publicKey) }),
      }),
      env,
    );
    expect(response.status).toBe(403);
    expect(db.challenges.size).toBe(0);
  });

  it('binds PKCE state to the session and stores only encrypted OpenRouter credentials', async () => {
    const db = new MemoryD1();
    const env = testEnv(db);
    const { session } = await signedInSession(env);
    const authorizationUrl = new URL(
      await beginOpenRouterConnect(env, session, 'https://swarm.example/api/auth/openrouter/callback', 2_000_000),
    );
    const state = authorizationUrl.searchParams.get('state') ?? '';
    expect(authorizationUrl.origin).toBe('https://openrouter.ai');
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');

    const platform = createCloudflareHostedPlatform(env);
    const exchangedBodies: string[] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      exchangedBodies.push(String(init?.body));
      return Response.json({ key: 'sk-or-user-key' });
    }) as typeof fetch;
    await expect(
      completeOpenRouterConnect({
        env,
        session,
        secrets: platform.secrets,
        code: 'authorization-code',
        state,
        now: 2_000_100,
        fetchImpl,
      }),
    ).resolves.toBe(true);

    expect(exchangedBodies[0]).toContain('code_verifier');
    expect([...db.secrets.values()].some((secret) => secret.envelope.includes('sk-or-user-key'))).toBe(false);
    await expect(getOpenRouterConnectionStatus(platform.secrets, session)).resolves.toEqual({
      connected: true,
      provider: 'openrouter',
    });
    await expect(
      completeOpenRouterConnect({
        env,
        session,
        secrets: platform.secrets,
        code: 'replay',
        state,
        now: 2_000_200,
        fetchImpl,
      }),
    ).resolves.toBe(false);

    await disconnectOpenRouter(platform.secrets, session);
    await expect(getOpenRouterConnectionStatus(platform.secrets, session)).resolves.toEqual({
      connected: false,
      provider: null,
    });
  });

  it('serves the existing admin UI auth and manual BYOK routes', async () => {
    const db = new MemoryD1();
    const env = testEnv(db);
    const { session } = await signedInSession(env, Date.now());
    const cookie = hostedSessionCookie(session.sessionToken).split(';', 1)[0] ?? '';

    const meResponse = await worker.fetch(
      new Request('https://swarm.example/api/auth/me', {
        headers: { Cookie: cookie },
      }),
      env,
    );
    expect(meResponse.status).toBe(200);
    expect(await meResponse.json()).toMatchObject({
      authenticated: true,
      account: { accountId: session.accountId },
    });

    const saveResponse = await worker.fetch(
      new Request('https://swarm.example/api/secrets/llm-api-key', {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Origin: 'https://swarm.example',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ value: 'sk-manual-byok' }),
      }),
      env,
    );
    expect(saveResponse.status).toBe(200);
    expect(JSON.stringify([...db.secrets.values()])).not.toContain('sk-manual-byok');

    const statusResponse = await worker.fetch(
      new Request('https://swarm.example/api/llm/status', {
        headers: { Cookie: cookie },
      }),
      env,
    );
    expect(await statusResponse.json()).toMatchObject({
      configured: true,
      provider: 'openrouter',
      openrouter: { configured: true },
    });
  });
});
