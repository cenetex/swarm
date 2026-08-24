import bs58 from 'bs58';
import nacl from 'tweetnacl';
import type { CloudflareHostedBindings } from './bindings.js';

const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CHALLENGE_RATE_WINDOW_MS = 60 * 1000;
const CHALLENGE_RATE_LIMIT = 5;
export const HOSTED_SESSION_COOKIE = 'swarm_hosted_session';

export class HostedRateLimitError extends Error {
  readonly retryAfter: number;

  constructor(retryAfter: number) {
    super('Too many wallet challenges. Try again shortly.');
    this.name = 'HostedRateLimitError';
    this.retryAfter = retryAfter;
  }
}

export class HostedOriginError extends Error {
  constructor() {
    super('Cross-origin hosted request rejected.');
    this.name = 'HostedOriginError';
  }
}

type ChallengeRow = {
  wallet_address: string;
  message: string;
  expires_at: number;
};

type IdentityRow = {
  account_id: string;
};

type SessionRow = {
  account_id: string;
  wallet_address: string;
  expires_at: number;
};

export type HostedSession = {
  accountId: string;
  walletAddress: string;
  expiresAt: number;
  sessionHash: string;
};

export type VerifiedWalletSession = HostedSession & {
  sessionToken: string;
};

export type VerifiedWalletIdentity = {
  accountId: string;
  walletAddress: string;
};

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

export function randomToken(size: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(size)));
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(new TextEncoder().encode(value)));
  return base64Url(new Uint8Array(digest));
}

export function hostedPublicOrigin(env: CloudflareHostedBindings, request: Request): string {
  const configured = env.SWARM_PUBLIC_URL?.trim();
  if (configured) {
    const url = new URL(configured);
    if (env.SWARM_ENV === 'production' && url.protocol !== 'https:') {
      throw new Error('SWARM_PUBLIC_URL must use HTTPS in production.');
    }
    return url.origin;
  }
  if (env.SWARM_ENV === 'production') {
    throw new Error('SWARM_PUBLIC_URL is required in production.');
  }
  return new URL(request.url).origin;
}

function validateWalletAddress(walletAddress: string): Uint8Array {
  let publicKey: Uint8Array;
  try {
    publicKey = bs58.decode(walletAddress);
  } catch {
    throw new Error('Wallet address is not valid base58.');
  }
  if (publicKey.byteLength !== 32) throw new Error('Wallet address must decode to 32 bytes.');
  return publicKey;
}

export function createWalletSignInMessage(input: {
  origin: string;
  walletAddress: string;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
  chainId: string;
  statement?: string;
}): string {
  const domain = new URL(input.origin).host;
  const statement = input.statement ?? 'Sign in to Swarm Hosted.';
  return `${domain} wants you to sign in with your Solana account:\n${input.walletAddress}\n\n${statement}\n\nURI: ${input.origin}\nVersion: 1\nChain ID: ${input.chainId}\nNonce: ${input.nonce}\nIssued At: ${input.issuedAt.toISOString()}\nExpiration Time: ${input.expiresAt.toISOString()}`;
}

async function enforceChallengeRateLimit(
  env: CloudflareHostedBindings,
  request: Request,
  walletAddress: string,
  now: number,
): Promise<void> {
  const sourceIp = (request.headers.get('CF-Connecting-IP') ?? 'unknown').slice(0, 128);
  const rateKey = await sha256(`wallet-challenge|${sourceIp}|${walletAddress}`);
  const windowStart = Math.floor(now / CHALLENGE_RATE_WINDOW_MS) * CHALLENGE_RATE_WINDOW_MS;
  const expiresAt = windowStart + CHALLENGE_RATE_WINDOW_MS * 2;
  const row = await env.SWARM_STATE.prepare(
    `insert into swarm_auth_rate_limits (rate_key, window_start, count, expires_at)
     values (?, ?, 1, ?)
     on conflict(rate_key) do update set
       count = case
         when swarm_auth_rate_limits.window_start = excluded.window_start
           then swarm_auth_rate_limits.count + 1
         else 1
       end,
       window_start = excluded.window_start,
       expires_at = excluded.expires_at
     returning count`,
  )
    .bind(rateKey, windowStart, expiresAt)
    .first<{ count: number }>();
  if (!row) throw new Error('Unable to enforce wallet challenge rate limit.');
  if (row.count > CHALLENGE_RATE_LIMIT) {
    throw new HostedRateLimitError(Math.max(1, Math.ceil((windowStart + CHALLENGE_RATE_WINDOW_MS - now) / 1000)));
  }
}

export async function createWalletChallenge(
  env: CloudflareHostedBindings,
  request: Request,
  walletAddress: string,
  now = Date.now(),
  statement = 'Sign in to Swarm Hosted.',
): Promise<{ nonce: string; message: string; expiresAt: number }> {
  validateWalletAddress(walletAddress);
  await enforceChallengeRateLimit(env, request, walletAddress, now);
  const origin = hostedPublicOrigin(env, request);
  const nonce = randomToken(24);
  const expiresAt = now + CHALLENGE_TTL_MS;
  const message = createWalletSignInMessage({
    origin,
    walletAddress,
    nonce,
    issuedAt: new Date(now),
    expiresAt: new Date(expiresAt),
    chainId: env.SWARM_SOLANA_CHAIN_ID?.trim() || 'solana:mainnet',
    statement,
  });
  const result = await env.SWARM_STATE.prepare(
    `insert into swarm_auth_challenges (nonce_hash, wallet_address, message, created_at, expires_at)
     values (?, ?, ?, ?, ?)`,
  )
    .bind(await sha256(nonce), walletAddress, message, now, expiresAt)
    .run();
  if (!result.success) throw new Error(result.error ?? 'Unable to store wallet challenge.');
  return { nonce, message, expiresAt };
}

async function getOrCreateAccount(env: CloudflareHostedBindings, walletAddress: string, now: number): Promise<string> {
  const existing = await env.SWARM_STATE.prepare(
    `select account_id from swarm_identities where provider = 'solana' and provider_id = ?`,
  )
    .bind(walletAddress)
    .first<IdentityRow>();
  if (existing) return existing.account_id;

  const candidateAccountId = `acct_${randomToken(18)}`;
  const accountResult = await env.SWARM_STATE.prepare(
    'insert into swarm_accounts (account_id, created_at) values (?, ?)',
  )
    .bind(candidateAccountId, now)
    .run();
  if (!accountResult.success) throw new Error(accountResult.error ?? 'Unable to create hosted account.');

  const identityResult = await env.SWARM_STATE.prepare(
    `insert into swarm_identities (provider, provider_id, account_id, created_at)
     values ('solana', ?, ?, ?)
     on conflict(provider, provider_id) do nothing`,
  )
    .bind(walletAddress, candidateAccountId, now)
    .run();
  if (!identityResult.success) throw new Error(identityResult.error ?? 'Unable to link hosted identity.');

  const resolved = await env.SWARM_STATE.prepare(
    `select account_id from swarm_identities where provider = 'solana' and provider_id = ?`,
  )
    .bind(walletAddress)
    .first<IdentityRow>();
  if (!resolved) throw new Error('Unable to resolve hosted account after wallet sign-in.');
  return resolved.account_id;
}

export async function verifyWalletIdentity(
  env: CloudflareHostedBindings,
  input: { walletAddress: string; nonce: string; signature: string },
  now = Date.now(),
  expectedStatement?: string,
): Promise<VerifiedWalletIdentity | null> {
  const publicKey = validateWalletAddress(input.walletAddress);
  if (!input.nonce || input.nonce.length > 256 || !input.signature || input.signature.length > 256) return null;
  const challenge = await env.SWARM_STATE.prepare(
    `delete from swarm_auth_challenges
     where nonce_hash = ? and wallet_address = ? and expires_at > ?
     returning wallet_address, message, expires_at`,
  )
    .bind(await sha256(input.nonce), input.walletAddress, now)
    .first<ChallengeRow>();
  if (!challenge) return null;
  if (expectedStatement && !challenge.message.includes(`\n\n${expectedStatement}\n\n`)) return null;

  let signature: Uint8Array;
  try {
    signature = bs58.decode(input.signature);
  } catch {
    return null;
  }
  if (
    signature.byteLength !== nacl.sign.signatureLength ||
    !nacl.sign.detached.verify(new TextEncoder().encode(challenge.message), signature, publicKey)
  )
    return null;

  const accountId = await getOrCreateAccount(env, input.walletAddress, now);
  return { accountId, walletAddress: input.walletAddress };
}

export async function createHostedSession(
  env: CloudflareHostedBindings,
  identity: VerifiedWalletIdentity,
  now = Date.now(),
): Promise<VerifiedWalletSession> {
  const sessionToken = randomToken(48);
  const sessionHash = await sha256(sessionToken);
  const expiresAt = now + SESSION_TTL_MS;
  const result = await env.SWARM_STATE.prepare(
    `insert into swarm_sessions (session_hash, account_id, wallet_address, created_at, expires_at)
     values (?, ?, ?, ?, ?)`,
  )
    .bind(sessionHash, identity.accountId, identity.walletAddress, now, expiresAt)
    .run();
  if (!result.success) throw new Error(result.error ?? 'Unable to create hosted session.');
  return { ...identity, expiresAt, sessionHash, sessionToken };
}

export async function verifyWalletChallenge(
  env: CloudflareHostedBindings,
  input: { walletAddress: string; nonce: string; signature: string },
  now = Date.now(),
): Promise<VerifiedWalletSession | null> {
  const identity = await verifyWalletIdentity(env, input, now);
  if (!identity) return null;
  return createHostedSession(env, identity, now);
}

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get('Cookie');
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return null;
}

export async function getHostedSession(
  env: CloudflareHostedBindings,
  request: Request,
  now = Date.now(),
): Promise<HostedSession | null> {
  const sessionToken = cookieValue(request, HOSTED_SESSION_COOKIE);
  if (!sessionToken) return null;
  const sessionHash = await sha256(sessionToken);
  const row = await env.SWARM_STATE.prepare(
    `select account_id, wallet_address, expires_at from swarm_sessions
     where session_hash = ? and expires_at > ?`,
  )
    .bind(sessionHash, now)
    .first<SessionRow>();
  if (!row) return null;
  return {
    accountId: row.account_id,
    walletAddress: row.wallet_address,
    expiresAt: row.expires_at,
    sessionHash,
  };
}

export async function deleteHostedSession(env: CloudflareHostedBindings, request: Request): Promise<void> {
  const token = cookieValue(request, HOSTED_SESSION_COOKIE);
  if (!token) return;
  const result = await env.SWARM_STATE.prepare('delete from swarm_sessions where session_hash = ?')
    .bind(await sha256(token))
    .run();
  if (!result.success) throw new Error(result.error ?? 'Unable to delete hosted session.');
}

export function hostedSessionCookie(token: string, maxAgeSeconds = SESSION_TTL_MS / 1000): string {
  return `${HOSTED_SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clearHostedSessionCookie(): string {
  return `${HOSTED_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function assertSameOrigin(env: CloudflareHostedBindings, request: Request): void {
  const origin = request.headers.get('Origin');
  if (!origin) return;
  if (origin !== hostedPublicOrigin(env, request)) throw new HostedOriginError();
}

export async function cleanupExpiredHostedAuth(env: CloudflareHostedBindings, now = Date.now()): Promise<void> {
  const tables = [
    'swarm_auth_challenges',
    'swarm_auth_rate_limits',
    'swarm_sessions',
    'swarm_oauth_transactions',
    'swarm_mobile_auth_pairings',
  ];
  for (const table of tables) {
    const result = await env.SWARM_STATE.prepare(`delete from ${table} where expires_at <= ?`).bind(now).run();
    if (!result.success) throw new Error(result.error ?? `Unable to clean expired rows from ${table}.`);
  }
}
