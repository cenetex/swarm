import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import {
  createHostedSession,
  hostedPublicOrigin,
  HostedRateLimitError,
  randomToken,
  sha256,
  type HostedSession,
  type VerifiedWalletSession,
} from './auth.js';
import type { CloudflareHostedBindings } from './bindings.js';

const PASSKEY_CHALLENGE_TTL_MS = 10 * 60 * 1000;
const PASSKEY_RATE_WINDOW_MS = 60 * 1000;
const PASSKEY_RATE_LIMIT = 10;
const PASSKEY_TIMEOUT_MS = 5 * 60 * 1000;

type PasskeyRow = {
  credential_id: string;
  account_id: string;
  webauthn_user_id: string;
  public_key: string;
  counter: number;
  device_type: 'singleDevice' | 'multiDevice';
  backed_up: number;
  transports: string;
};

type ChallengeRow = {
  account_id: string | null;
  challenge: string;
  webauthn_user_id: string | null;
};

type WalletIdentityRow = {
  provider_id: string;
};

export type PasskeyRegistrationStart = {
  challengeId: string;
  options: PublicKeyCredentialCreationOptionsJSON;
  expiresAt: number;
};

export type PasskeyAuthenticationStart = {
  challengeId: string;
  options: PublicKeyCredentialRequestOptionsJSON;
  expiresAt: number;
};

function passkeyRelyingParty(env: CloudflareHostedBindings, request: Request): {
  origin: string;
  rpID: string;
} {
  const origin = hostedPublicOrigin(env, request);
  const hostname = new URL(origin).hostname;
  const configuredRpID = env.SWARM_PASSKEY_RP_ID?.trim().toLowerCase();
  const rpID = configuredRpID || hostname;
  if (!rpID || (hostname !== rpID && !hostname.endsWith(`.${rpID}`))) {
    throw new Error('SWARM_PASSKEY_RP_ID must match the hosted domain or one of its parent domains.');
  }
  return { origin, rpID };
}
function parseTransports(value: string): AuthenticatorTransportFuture[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((transport): transport is AuthenticatorTransportFuture =>
      typeof transport === 'string'
      && ['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'].includes(transport),
    );
  } catch {
    return [];
  }
}

async function enforceAuthenticationRateLimit(
  env: CloudflareHostedBindings,
  request: Request,
  now: number,
): Promise<void> {
  const sourceIp = (request.headers.get('CF-Connecting-IP') ?? 'unknown').slice(0, 128);
  const rateKey = await sha256(`passkey-authentication|${sourceIp}`);
  const windowStart = Math.floor(now / PASSKEY_RATE_WINDOW_MS) * PASSKEY_RATE_WINDOW_MS;
  const expiresAt = windowStart + PASSKEY_RATE_WINDOW_MS * 2;
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
  if (!row) throw new Error('Unable to enforce passkey authentication rate limit.');
  if (row.count > PASSKEY_RATE_LIMIT) {
    const retryAfter = Math.max(1, Math.ceil((windowStart + PASSKEY_RATE_WINDOW_MS - now) / 1000));
    throw new HostedRateLimitError(retryAfter, 'Too many passkey attempts. Try again shortly.');
  }
}

async function storeChallenge(
  env: CloudflareHostedBindings,
  input: {
    purpose: 'registration' | 'authentication';
    accountId?: string;
    challenge: string;
    webauthnUserID?: string;
    now: number;
  },
): Promise<{ challengeId: string; expiresAt: number }> {
  const challengeId = randomToken(32);
  const expiresAt = input.now + PASSKEY_CHALLENGE_TTL_MS;
  const result = await env.SWARM_STATE.prepare(
    `insert into swarm_passkey_challenges
       (handle_hash, purpose, account_id, challenge, webauthn_user_id, created_at, expires_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      await sha256(challengeId),
      input.purpose,
      input.accountId ?? null,
      input.challenge,
      input.webauthnUserID ?? null,
      input.now,
      expiresAt,
    )
    .run();
  if (!result.success) throw new Error(result.error ?? 'Unable to store passkey challenge.');
  return { challengeId, expiresAt };
}

async function consumeChallenge(
  env: CloudflareHostedBindings,
  input: {
    challengeId: string;
    purpose: 'registration' | 'authentication';
    accountId?: string;
    now: number;
  },
): Promise<ChallengeRow | null> {
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(input.challengeId)) return null;
  const accountClause = input.accountId ? 'and account_id = ?' : 'and account_id is null';
  const statement = env.SWARM_STATE.prepare(
    `delete from swarm_passkey_challenges
     where handle_hash = ? and purpose = ? ${accountClause} and expires_at > ?
     returning account_id, challenge, webauthn_user_id`,
  );
  return input.accountId
    ? statement.bind(await sha256(input.challengeId), input.purpose, input.accountId, input.now).first<ChallengeRow>()
    : statement.bind(await sha256(input.challengeId), input.purpose, input.now).first<ChallengeRow>();
}

async function accountPasskeys(env: CloudflareHostedBindings, accountId: string): Promise<PasskeyRow[]> {
  const result = await env.SWARM_STATE.prepare(
    `select credential_id, account_id, webauthn_user_id, public_key, counter,
            device_type, backed_up, transports
     from swarm_passkeys where account_id = ? order by created_at`,
  )
    .bind(accountId)
    .all<PasskeyRow>();
  if (!result.success) throw new Error(result.error ?? 'Unable to list account passkeys.');
  return result.results ?? [];
}

export async function beginPasskeyRegistration(
  env: CloudflareHostedBindings,
  request: Request,
  session: HostedSession,
  now = Date.now(),
): Promise<PasskeyRegistrationStart> {
  const { rpID } = passkeyRelyingParty(env, request);
  const existingPasskeys = await accountPasskeys(env, session.accountId);
  const webauthnUserID = await sha256(`swarm-passkey-user|${session.accountId}`);
  const options = await generateRegistrationOptions({
    rpName: 'Swarm Hosted',
    rpID,
    userID: isoBase64URL.toBuffer(webauthnUserID),
    userName: `Swarm account ${session.accountId.slice(-6)}`,
    userDisplayName: 'Swarm Hosted',
    attestationType: 'none',
    timeout: PASSKEY_TIMEOUT_MS,
    excludeCredentials: existingPasskeys.map((passkey) => ({
      id: passkey.credential_id,
      transports: parseTransports(passkey.transports),
    })),
    authenticatorSelection: {
      residentKey: 'required',
      userVerification: 'required',
    },
  });
  const challenge = await storeChallenge(env, {
    purpose: 'registration',
    accountId: session.accountId,
    challenge: options.challenge,
    webauthnUserID,
    now,
  });
  return { ...challenge, options };
}

export async function finishPasskeyRegistration(
  env: CloudflareHostedBindings,
  request: Request,
  session: HostedSession,
  input: { challengeId: string; response: RegistrationResponseJSON },
  now = Date.now(),
): Promise<boolean> {
  const challenge = await consumeChallenge(env, {
    challengeId: input.challengeId,
    purpose: 'registration',
    accountId: session.accountId,
    now,
  });
  if (!challenge?.webauthn_user_id) return false;
  const { origin, rpID } = passkeyRelyingParty(env, request);
  try {
    const verification = await verifyRegistrationResponse({
      response: input.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserPresence: true,
      requireUserVerification: true,
    });
    if (!verification.verified || !verification.registrationInfo.userVerified) return false;
    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    const inserted = await env.SWARM_STATE.prepare(
      `insert into swarm_passkeys
         (credential_id, account_id, webauthn_user_id, public_key, counter,
          device_type, backed_up, transports, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(credential_id) do nothing
       returning credential_id`,
    )
      .bind(
        credential.id,
        session.accountId,
        challenge.webauthn_user_id,
        isoBase64URL.fromBuffer(credential.publicKey),
        credential.counter,
        credentialDeviceType,
        credentialBackedUp ? 1 : 0,
        JSON.stringify(credential.transports ?? []),
        now,
      )
      .first<{ credential_id: string }>();
    return inserted?.credential_id === credential.id;
  } catch {
    return false;
  }
}

export async function beginPasskeyAuthentication(
  env: CloudflareHostedBindings,
  request: Request,
  now = Date.now(),
): Promise<PasskeyAuthenticationStart> {
  await enforceAuthenticationRateLimit(env, request, now);
  const { rpID } = passkeyRelyingParty(env, request);
  const options = await generateAuthenticationOptions({
    rpID,
    timeout: PASSKEY_TIMEOUT_MS,
    userVerification: 'required',
  });
  const challenge = await storeChallenge(env, {
    purpose: 'authentication',
    challenge: options.challenge,
    now,
  });
  return { ...challenge, options };
}

export async function finishPasskeyAuthentication(
  env: CloudflareHostedBindings,
  request: Request,
  input: { challengeId: string; response: AuthenticationResponseJSON },
  now = Date.now(),
): Promise<VerifiedWalletSession | null> {
  const challenge = await consumeChallenge(env, {
    challengeId: input.challengeId,
    purpose: 'authentication',
    now,
  });
  if (!challenge || input.response.response.userHandle === undefined) return null;
  const passkey = await env.SWARM_STATE.prepare(
    `select credential_id, account_id, webauthn_user_id, public_key, counter,
            device_type, backed_up, transports
     from swarm_passkeys where credential_id = ?`,
  )
    .bind(input.response.id)
    .first<PasskeyRow>();
  if (!passkey || input.response.response.userHandle !== passkey.webauthn_user_id) return null;
  const { origin, rpID } = passkeyRelyingParty(env, request);
  try {
    const verification = await verifyAuthenticationResponse({
      response: input.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: passkey.credential_id,
        publicKey: isoBase64URL.toBuffer(passkey.public_key),
        counter: passkey.counter,
        transports: parseTransports(passkey.transports),
      },
      requireUserVerification: true,
    });
    if (!verification.verified || !verification.authenticationInfo.userVerified) return null;
    const updated = await env.SWARM_STATE.prepare(
      `update swarm_passkeys set counter = ?, last_used_at = ?
       where credential_id = ? and counter = ?
       returning credential_id`,
    )
      .bind(verification.authenticationInfo.newCounter, now, passkey.credential_id, passkey.counter)
      .first<{ credential_id: string }>();
    if (!updated) return null;
    const wallet = await env.SWARM_STATE.prepare(
      `select provider_id from swarm_identities
       where account_id = ? and provider = 'solana'
       order by created_at limit 1`,
    )
      .bind(passkey.account_id)
      .first<WalletIdentityRow>();
    if (!wallet) return null;
    return createHostedSession(env, {
      accountId: passkey.account_id,
      walletAddress: wallet.provider_id,
      authProvider: 'passkey',
    }, now);
  } catch {
    return null;
  }
}
