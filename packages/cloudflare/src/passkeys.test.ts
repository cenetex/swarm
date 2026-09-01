import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'bun:test';
import { isoBase64URL, isoCBOR } from '@simplewebauthn/server/helpers';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { hostedSessionCookie, HostedRateLimitError, type HostedSession } from './auth.js';
import type {
  CloudflareD1Database,
  CloudflareD1PreparedStatement,
  CloudflareHostedBindings,
} from './bindings.js';
import {
  beginPasskeyAuthentication,
  beginPasskeyRegistration,
  finishPasskeyAuthentication,
  finishPasskeyRegistration,
} from './passkeys.js';
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
    for (const migration of ['0002_hosted_identity_and_secrets.sql', '0009_passkeys.sql']) {
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

type TestCredential = {
  credentialId: string;
  credentialIdBytes: Uint8Array;
  cosePublicKey: Uint8Array;
  privateKey: CryptoKey;
};

function concat(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function counterBytes(counter: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, counter, false);
  return bytes;
}

function derInteger(bytes: Uint8Array): Uint8Array {
  let offset = 0;
  while (offset < bytes.length - 1 && bytes[offset] === 0) offset += 1;
  const value = bytes.slice(offset);
  return value[0] !== undefined && value[0] >= 0x80
    ? concat(new Uint8Array([0]), value)
    : value;
}

function rawEcdsaToDer(raw: Uint8Array): Uint8Array {
  const r = derInteger(raw.slice(0, raw.length / 2));
  const s = derInteger(raw.slice(raw.length / 2));
  return concat(
    new Uint8Array([0x30, 2 + r.length + 2 + s.length, 0x02, r.length]),
    r,
    new Uint8Array([0x02, s.length]),
    s,
  );
}

async function digest(value: string | Uint8Array): Promise<Uint8Array> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

async function testCredential(): Promise<TestCredential> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  ) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  if (!jwk.x || !jwk.y) throw new Error('Test key did not include EC coordinates.');
  const credentialIdBytes = crypto.getRandomValues(new Uint8Array(32));
  const cosePublicKey = isoCBOR.encode(new Map([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, isoBase64URL.toBuffer(jwk.x)],
    [-3, isoBase64URL.toBuffer(jwk.y)],
  ]));
  return {
    credentialId: isoBase64URL.fromBuffer(credentialIdBytes),
    credentialIdBytes,
    cosePublicKey,
    privateKey: keyPair.privateKey,
  };
}

async function registrationResponse(input: {
  credential: TestCredential;
  challenge: string;
  origin?: string;
  rpID?: string;
}): Promise<RegistrationResponseJSON> {
  const origin = input.origin ?? 'https://next.swarm.rati.chat';
  const rpID = input.rpID ?? 'next.swarm.rati.chat';
  const clientDataJSON = new TextEncoder().encode(JSON.stringify({
    type: 'webauthn.create',
    challenge: input.challenge,
    origin,
    crossOrigin: false,
  }));
  const credentialLength = new Uint8Array(2);
  new DataView(credentialLength.buffer).setUint16(0, input.credential.credentialIdBytes.length, false);
  const authenticatorData = concat(
    await digest(rpID),
    new Uint8Array([0x45]),
    counterBytes(0),
    new Uint8Array(16),
    credentialLength,
    input.credential.credentialIdBytes,
    input.credential.cosePublicKey,
  );
  const attestationObject = isoCBOR.encode(new Map([
    ['fmt', 'none'],
    ['attStmt', new Map()],
    ['authData', authenticatorData],
  ]));
  return {
    id: input.credential.credentialId,
    rawId: input.credential.credentialId,
    type: 'public-key',
    clientExtensionResults: {},
    authenticatorAttachment: 'platform',
    response: {
      clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
      attestationObject: isoBase64URL.fromBuffer(attestationObject),
      transports: ['internal'],
    },
  };
}

async function authenticationResponse(input: {
  credential: TestCredential;
  challenge: string;
  userHandle: string;
  counter?: number;
  origin?: string;
  rpID?: string;
  userVerified?: boolean;
  corruptSignature?: boolean;
}): Promise<AuthenticationResponseJSON> {
  const origin = input.origin ?? 'https://next.swarm.rati.chat';
  const rpID = input.rpID ?? 'next.swarm.rati.chat';
  const clientDataJSON = new TextEncoder().encode(JSON.stringify({
    type: 'webauthn.get',
    challenge: input.challenge,
    origin,
    crossOrigin: false,
  }));
  const authenticatorData = concat(
    await digest(rpID),
    new Uint8Array([input.userVerified === false ? 0x01 : 0x05]),
    counterBytes(input.counter ?? 1),
  );
  const signedData = concat(authenticatorData, await digest(clientDataJSON));
  const rawSignature = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    input.credential.privateKey,
    signedData,
  ));
  const signature = rawEcdsaToDer(rawSignature);
  if (input.corruptSignature) signature[signature.length - 1] ^= 0xff;
  return {
    id: input.credential.credentialId,
    rawId: input.credential.credentialId,
    type: 'public-key',
    clientExtensionResults: {},
    authenticatorAttachment: 'platform',
    response: {
      clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
      authenticatorData: isoBase64URL.fromBuffer(authenticatorData),
      signature: isoBase64URL.fromBuffer(signature),
      userHandle: input.userHandle,
    },
  };
}

const resources: SqliteD1[] = [];

function setup() {
  const state = new SqliteD1();
  resources.push(state);
  state.db.exec(`
    insert into swarm_accounts (account_id, created_at) values ('account-1', 1);
    insert into swarm_identities (provider, provider_id, account_id, created_at)
      values ('solana', 'wallet-1', 'account-1', 1);
  `);
  const env: CloudflareHostedBindings = {
    SWARM_STATE: state,
    SWARM_BLOBS: {
      get: async () => null,
      put: async () => undefined,
      delete: async () => undefined,
    },
    SWARM_HOSTED_ENABLED: '1',
    SWARM_PUBLIC_URL: 'https://next.swarm.rati.chat',
  };
  const request = new Request('https://next.swarm.rati.chat/api/auth/passkey', {
    method: 'POST',
    headers: { Origin: 'https://next.swarm.rati.chat', 'CF-Connecting-IP': '203.0.113.7' },
  });
  const session: HostedSession = {
    accountId: 'account-1',
    walletAddress: 'wallet-1',
    expiresAt: 9_999_999,
    sessionHash: 'wallet-session',
    authProvider: 'wallet',
  };
  return { state, env, request, session };
}

async function enrollPasskey(setupResult: ReturnType<typeof setup>, now = 1_000_000) {
  const credential = await testCredential();
  const start = await beginPasskeyRegistration(
    setupResult.env,
    setupResult.request,
    setupResult.session,
    now,
  );
  const response = await registrationResponse({ credential, challenge: start.options.challenge });
  const verified = await finishPasskeyRegistration(
    setupResult.env,
    setupResult.request,
    setupResult.session,
    { challengeId: start.challengeId, response },
    now + 1,
  );
  expect(verified).toBe(true);
  return credential;
}

afterEach(() => {
  while (resources.length) resources.pop()?.close();
});

describe('hosted passkeys', () => {
  it('enrolls a user-verified passkey and signs in to the same wallet-backed account', async () => {
    const test = setup();
    const credential = await enrollPasskey(test);
    const stored = test.state.db.query(
      'select webauthn_user_id from swarm_passkeys where credential_id = ?',
    ).get(credential.credentialId) as { webauthn_user_id: string };
    const authNow = Date.now();
    const start = await beginPasskeyAuthentication(test.env, test.request, authNow);
    expect(start.options.allowCredentials).toBeUndefined();
    expect(start.options.userVerification).toBe('required');
    const response = await authenticationResponse({
      credential,
      challenge: start.options.challenge,
      userHandle: stored.webauthn_user_id,
    });

    const session = await finishPasskeyAuthentication(
      test.env,
      test.request,
      { challengeId: start.challengeId, response },
      authNow + 1,
    );

    expect(session).toMatchObject({
      accountId: 'account-1',
      walletAddress: 'wallet-1',
      authProvider: 'passkey',
    });
    expect(test.state.db.query(
      'select counter from swarm_passkeys where credential_id = ?',
    ).get(credential.credentialId)).toEqual({ counter: 1 });
    expect(test.state.db.query(
      "select auth_provider from swarm_sessions where auth_provider = 'passkey'",
    ).get()).toEqual({ auth_provider: 'passkey' });
    if (!session) throw new Error('Expected a passkey session.');
    const meResponse = await worker.fetch(new Request('https://next.swarm.rati.chat/api/auth/me', {
      headers: { Cookie: hostedSessionCookie(session.sessionToken) },
    }), test.env);
    expect(meResponse.status).toBe(200);
    expect(await meResponse.json()).toMatchObject({
      authenticated: true,
      authProvider: 'passkey',
      accountId: 'account-1',
      walletAddress: 'wallet-1',
    });
    await expect(finishPasskeyAuthentication(
      test.env,
      test.request,
      { challengeId: start.challengeId, response },
      authNow + 2,
    )).resolves.toBeNull();
  });

  it('rejects an invalid origin and consumes the registration challenge once', async () => {
    const test = setup();
    const credential = await testCredential();
    const start = await beginPasskeyRegistration(test.env, test.request, test.session, 2_000_000);
    const hostileResponse = await registrationResponse({
      credential,
      challenge: start.options.challenge,
      origin: 'https://evil.example',
    });
    await expect(finishPasskeyRegistration(
      test.env,
      test.request,
      test.session,
      { challengeId: start.challengeId, response: hostileResponse },
      2_000_001,
    )).resolves.toBe(false);

    const correctResponse = await registrationResponse({ credential, challenge: start.options.challenge });
    await expect(finishPasskeyRegistration(
      test.env,
      test.request,
      test.session,
      { challengeId: start.challengeId, response: correctResponse },
      2_000_002,
    )).resolves.toBe(false);
  });

  it('rejects bad signatures and assertions without user verification', async () => {
    const test = setup();
    const credential = await enrollPasskey(test, 3_000_000);
    const stored = test.state.db.query(
      'select webauthn_user_id from swarm_passkeys where credential_id = ?',
    ).get(credential.credentialId) as { webauthn_user_id: string };

    const badSignatureStart = await beginPasskeyAuthentication(test.env, test.request, 3_000_100);
    const badSignature = await authenticationResponse({
      credential,
      challenge: badSignatureStart.options.challenge,
      userHandle: stored.webauthn_user_id,
      corruptSignature: true,
    });
    await expect(finishPasskeyAuthentication(
      test.env,
      test.request,
      { challengeId: badSignatureStart.challengeId, response: badSignature },
      3_000_101,
    )).resolves.toBeNull();

    const noVerificationStart = await beginPasskeyAuthentication(test.env, test.request, 3_000_200);
    const noVerification = await authenticationResponse({
      credential,
      challenge: noVerificationStart.options.challenge,
      userHandle: stored.webauthn_user_id,
      userVerified: false,
    });
    await expect(finishPasskeyAuthentication(
      test.env,
      test.request,
      { challengeId: noVerificationStart.challengeId, response: noVerification },
      3_000_201,
    )).resolves.toBeNull();
  });

  it('rate-limits unauthenticated challenge creation by source', async () => {
    const test = setup();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await beginPasskeyAuthentication(test.env, test.request, 4_000_000);
    }
    await expect(beginPasskeyAuthentication(test.env, test.request, 4_000_000)).rejects.toBeInstanceOf(
      HostedRateLimitError,
    );
  });

  it('requires an authenticated session before the registration route returns options', async () => {
    const test = setup();
    const response = await worker.fetch(new Request(
      'https://next.swarm.rati.chat/api/auth/passkey/register/options',
      { method: 'POST', headers: { Origin: 'https://next.swarm.rati.chat' } },
    ), test.env);
    expect(response.status).toBe(401);
  });

  it('rejects a configured RP ID outside the hosted domain hierarchy', async () => {
    const test = setup();
    test.env.SWARM_PASSKEY_RP_ID = 'unrelated.example';
    await expect(beginPasskeyAuthentication(test.env, test.request, 5_000_000)).rejects.toThrow(
      'SWARM_PASSKEY_RP_ID',
    );
  });
});
