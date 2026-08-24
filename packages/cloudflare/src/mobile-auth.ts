import type { CloudflareHostedBindings } from './bindings.js';
import {
  createHostedSession,
  createWalletChallenge,
  HostedRateLimitError,
  hostedPublicOrigin,
  randomToken,
  sha256,
  verifyWalletIdentity,
  type VerifiedWalletSession,
} from './auth.js';

const PAIRING_TTL_MS = 5 * 60 * 1000;
const PAIRING_RATE_WINDOW_MS = 60 * 1000;
const PAIRING_RATE_LIMIT = 10;

type PairingRow = {
  status: 'pending' | 'approved' | 'consumed';
  account_id: string | null;
  wallet_address: string | null;
  expires_at: number;
};

export type MobileWalletPairing = {
  pairingId: string;
  pollToken: string;
  mobileUrl: string;
  verificationCode: string;
  expiresAt: number;
};

export type MobileWalletPairingResult =
  | { status: 'pending'; expiresAt: number }
  | { status: 'expired' }
  | { status: 'not-found' }
  | { status: 'authenticated'; session: VerifiedWalletSession };

function validToken(value: string, minLength: number, maxLength: number): boolean {
  return value.length >= minLength && value.length <= maxLength && /^[A-Za-z0-9_-]+$/u.test(value);
}

export function mobilePairingVerificationCode(pairingId: string): string {
  return pairingId.slice(0, 6).toUpperCase();
}

function mobilePairingStatement(pairingId: string): string {
  return `Approve sign-in on another device. Pairing code: ${mobilePairingVerificationCode(pairingId)}.`;
}

async function enforcePairingRateLimit(
  env: CloudflareHostedBindings,
  request: Request,
  now: number,
): Promise<void> {
  const sourceIp = (request.headers.get('CF-Connecting-IP') ?? 'unknown').slice(0, 128);
  const rateKey = await sha256(`mobile-wallet-pairing|${sourceIp}`);
  const windowStart = Math.floor(now / PAIRING_RATE_WINDOW_MS) * PAIRING_RATE_WINDOW_MS;
  const expiresAt = windowStart + PAIRING_RATE_WINDOW_MS * 2;
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
  if (!row) throw new Error('Unable to enforce mobile wallet pairing rate limit.');
  if (row.count > PAIRING_RATE_LIMIT) {
    throw new HostedRateLimitError(
      Math.max(1, Math.ceil((windowStart + PAIRING_RATE_WINDOW_MS - now) / 1000)),
    );
  }
}

async function loadPairing(
  env: CloudflareHostedBindings,
  pairingId: string,
  now: number,
): Promise<PairingRow | null> {
  if (!validToken(pairingId, 24, 64)) return null;
  return env.SWARM_STATE.prepare(
    `select status, account_id, wallet_address, expires_at
     from swarm_mobile_auth_pairings
     where pairing_hash = ? and expires_at > ?`,
  )
    .bind(await sha256(pairingId), now)
    .first<PairingRow>();
}

export async function createMobileWalletPairing(
  env: CloudflareHostedBindings,
  request: Request,
  now = Date.now(),
): Promise<MobileWalletPairing> {
  await enforcePairingRateLimit(env, request, now);
  const pairingId = randomToken(24);
  const pollToken = randomToken(32);
  const expiresAt = now + PAIRING_TTL_MS;
  const result = await env.SWARM_STATE.prepare(
    `insert into swarm_mobile_auth_pairings
       (pairing_hash, poll_token_hash, status, created_at, expires_at)
     values (?, ?, 'pending', ?, ?)`,
  )
    .bind(await sha256(pairingId), await sha256(pollToken), now, expiresAt)
    .run();
  if (!result.success) throw new Error(result.error ?? 'Unable to create mobile wallet pairing.');
  const mobileUrl = new URL('/mobile-sign-in', hostedPublicOrigin(env, request));
  mobileUrl.searchParams.set('pairing', pairingId);
  return {
    pairingId,
    pollToken,
    mobileUrl: mobileUrl.toString(),
    verificationCode: mobilePairingVerificationCode(pairingId),
    expiresAt,
  };
}

export async function createMobileWalletChallenge(
  env: CloudflareHostedBindings,
  request: Request,
  pairingId: string,
  walletAddress: string,
  now = Date.now(),
): ReturnType<typeof createWalletChallenge> {
  const pairing = await loadPairing(env, pairingId, now);
  if (!pairing || pairing.status !== 'pending') {
    throw new Error('Mobile wallet pairing is invalid or expired.');
  }
  return createWalletChallenge(
    env,
    request,
    walletAddress,
    now,
    mobilePairingStatement(pairingId),
  );
}

export async function approveMobileWalletPairing(
  env: CloudflareHostedBindings,
  pairingId: string,
  input: { walletAddress: string; nonce: string; signature: string },
  now = Date.now(),
): Promise<boolean> {
  const pairing = await loadPairing(env, pairingId, now);
  if (!pairing || pairing.status !== 'pending') return false;
  const identity = await verifyWalletIdentity(env, input, now, mobilePairingStatement(pairingId));
  if (!identity) return false;
  const approved = await env.SWARM_STATE.prepare(
    `update swarm_mobile_auth_pairings
     set status = 'approved', account_id = ?, wallet_address = ?, approved_at = ?
     where pairing_hash = ? and status = 'pending' and expires_at > ?
     returning status`,
  )
    .bind(identity.accountId, identity.walletAddress, now, await sha256(pairingId), now)
    .first<{ status: 'approved' }>();
  return !!approved;
}

export async function consumeMobileWalletPairing(
  env: CloudflareHostedBindings,
  pairingId: string,
  pollToken: string,
  now = Date.now(),
): Promise<MobileWalletPairingResult> {
  if (!validToken(pairingId, 24, 64) || !validToken(pollToken, 32, 96)) {
    return { status: 'not-found' };
  }
  const pairingHash = await sha256(pairingId);
  const pollTokenHash = await sha256(pollToken);
  const pairing = await env.SWARM_STATE.prepare(
    `select status, account_id, wallet_address, expires_at
     from swarm_mobile_auth_pairings
     where pairing_hash = ? and poll_token_hash = ?`,
  )
    .bind(pairingHash, pollTokenHash)
    .first<PairingRow>();
  if (!pairing) return { status: 'not-found' };
  if (pairing.expires_at <= now || pairing.status === 'consumed') return { status: 'expired' };
  if (pairing.status === 'pending') return { status: 'pending', expiresAt: pairing.expires_at };
  if (!pairing.account_id || !pairing.wallet_address) return { status: 'expired' };

  const consumed = await env.SWARM_STATE.prepare(
    `update swarm_mobile_auth_pairings
     set status = 'consumed', consumed_at = ?
     where pairing_hash = ? and poll_token_hash = ? and status = 'approved' and expires_at > ?
     returning account_id, wallet_address`,
  )
    .bind(now, pairingHash, pollTokenHash, now)
    .first<{ account_id: string; wallet_address: string }>();
  if (!consumed) return { status: 'expired' };
  const session = await createHostedSession(
    env,
    { accountId: consumed.account_id, walletAddress: consumed.wallet_address },
    now,
  );
  return { status: 'authenticated', session };
}
