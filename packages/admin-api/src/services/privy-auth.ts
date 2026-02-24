/**
 * Privy Authentication Service
 * Handles authentication for users signing in via Privy (email/social)
 */
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { randomBytes } from 'crypto';
import { logger } from '@swarm/core';
import { PrivyClient, type User as PrivyUser } from '@privy-io/node';

import { checkNFTGate, type NFTGateResult } from './nft-gate.js';
import type { UserRecord, SessionRecord } from './wallet-auth.js';
import { recordAccountSession } from './accounts.js';
import {
  resolveOnboardingAuthAccount,
  type OnboardingAuthFailureResult,
  type OnboardingAuthOutcome,
} from './accounts/onboarding-auth-resolver.js';
import { upsertActiveUserSlotOnLogin } from './active-user-limit.js';
import { getDynamoClient } from './dynamo-client.js';
import { emitAuthEvent } from './funnel-emitter.js';

const dynamoClient = getDynamoClient();

const secretsClient = new SecretsManagerClient({});

const ADMIN_TABLE = process.env.ADMIN_TABLE!;

const PRIVY_APP_ID = process.env.PRIVY_APP_ID;
const PRIVY_APP_SECRET_ARN = process.env.PRIVY_APP_SECRET_ARN;
let privyAppSecret: string | null = process.env.PRIVY_APP_SECRET || null;
let privyAppSecretFetched = false;

const PRIVY_JWT_VERIFICATION_KEY_ARN = process.env.PRIVY_JWT_VERIFICATION_KEY_ARN;
let privyJwtVerificationKey: string | null = process.env.PRIVY_JWT_VERIFICATION_KEY || null;
let privyJwtVerificationKeyFetched = false;

const SESSION_TTL_HOURS = 24;

// ============================================================================
// Types
// ============================================================================

export interface PrivyVerifyRequest {
  accessToken: string;
  userId?: string;
  email?: string;
  walletAddress?: string;
}

export interface PrivyAuthResult {
  success: boolean;
  session?: SessionRecord;
  user?: UserRecord & { email?: string };
  nftGate?: NFTGateResult;
  error?: string;
  code?: OnboardingAuthFailureResult['code'];
  outcome?: OnboardingAuthOutcome;
  switchAccountId?: string;
  requiredIntent?: OnboardingAuthFailureResult['requiredIntent'];
  conflict?: { type: 'wallet' | 'privy'; providerId: string; existingAccountId: string };
}

// ============================================================================
// Config + Client
// ============================================================================

async function getSecretValue(secretArn: string): Promise<string | null> {
  try {
    const response = await secretsClient.send(
      new GetSecretValueCommand({
        SecretId: secretArn,
      })
    );
    return response.SecretString || null;
  } catch (error) {
    logger.error('[PrivyAuth] Failed to fetch secret from Secrets Manager', error);
    return null;
  }
}

async function getPrivyAppSecret(): Promise<string | null> {
  if (privyAppSecret) return privyAppSecret;
  if (privyAppSecretFetched) return null;
  privyAppSecretFetched = true;

  if (!PRIVY_APP_SECRET_ARN) return null;
  privyAppSecret = await getSecretValue(PRIVY_APP_SECRET_ARN);
  return privyAppSecret;
}

async function getPrivyJwtVerificationKey(): Promise<string | null> {
  if (privyJwtVerificationKey) return privyJwtVerificationKey;
  if (privyJwtVerificationKeyFetched) return null;
  privyJwtVerificationKeyFetched = true;

  if (!PRIVY_JWT_VERIFICATION_KEY_ARN) return null;
  privyJwtVerificationKey = await getSecretValue(PRIVY_JWT_VERIFICATION_KEY_ARN);
  return privyJwtVerificationKey;
}

let privyClient: PrivyClient | null = null;

async function getPrivyClient(): Promise<PrivyClient> {
  if (privyClient) return privyClient;

  const appId = PRIVY_APP_ID;
  const appSecret = await getPrivyAppSecret();
  const jwtVerificationKey = await getPrivyJwtVerificationKey();

  if (!appId) throw new Error('Missing PRIVY_APP_ID');
  if (!appSecret) throw new Error('Missing PRIVY_APP_SECRET or PRIVY_APP_SECRET_ARN');
  if (!jwtVerificationKey) {
    throw new Error('Missing PRIVY_JWT_VERIFICATION_KEY or PRIVY_JWT_VERIFICATION_KEY_ARN');
  }

  privyClient = new PrivyClient({
    appId,
    appSecret,
    jwtVerificationKey,
  });

  return privyClient;
}

// ============================================================================
// Helpers
// ============================================================================

function generateSessionToken(): string {
  return randomBytes(48).toString('base64url');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

type SolanaWalletLinkedAccount = {
  type: 'wallet';
  chain_type: 'solana';
  address: string;
  wallet_client?: string;
};

function isSolanaWalletLinkedAccount(value: unknown): value is SolanaWalletLinkedAccount {
  if (!isRecord(value)) return false;
  return (
    value.type === 'wallet' &&
    value.chain_type === 'solana' &&
    typeof value.address === 'string' &&
    (value.wallet_client === undefined || typeof value.wallet_client === 'string')
  );
}

type EmailLinkedAccount = {
  type: 'email';
  address: string;
};

function isEmailLinkedAccount(value: unknown): value is EmailLinkedAccount {
  if (!isRecord(value)) return false;
  return value.type === 'email' && typeof value.address === 'string';
}

function pickSolanaWalletAddressFromPrivyUser(user: PrivyUser): string | null {
  const linkedAccounts = (user.linked_accounts ?? []) as unknown[];
  const solanaWallets = linkedAccounts.filter(isSolanaWalletLinkedAccount);

  if (solanaWallets.length === 0) return null;

  const embedded = solanaWallets.find((w) => w.wallet_client === 'privy');
  return (embedded ?? solanaWallets[0])?.address ?? null;
}

function pickEmailFromPrivyUser(user: PrivyUser): string | undefined {
  const linkedAccounts = (user.linked_accounts ?? []) as unknown[];
  const email = linkedAccounts.find(isEmailLinkedAccount);
  return email?.address;
}

// ============================================================================
// Session Management
// ============================================================================

async function createSession(
  walletAddress: string,
  privyUserId: string,
  accountId: string,
  isOrbHolder: boolean,
  userAgent?: string,
  ipAddress?: string
): Promise<SessionRecord> {
  const sessionToken = generateSessionToken();
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_HOURS * 60 * 60 * 1000;

  const record: SessionRecord = {
    pk: `SESSION#${sessionToken}`,
    sk: 'DATA',
    sessionToken,
    walletAddress,
    accountId,
    createdAt: now,
    expiresAt,
    lastActiveAt: now,
    userAgent,
    ipAddress,
    isOrbHolder,
    ttl: Math.floor(expiresAt / 1000),
  };

  await dynamoClient.send(
    new PutCommand({
      TableName: ADMIN_TABLE,
      Item: {
        ...record,
        authProvider: 'privy',
        privyUserId,
      },
    })
  );

  logger.info('[PrivyAuth] Created session', { privyUserId, wallet: walletAddress.slice(0, 8) });

  return record;
}

// ============================================================================
// User Management
// ============================================================================

async function getOrCreateUser(
  walletAddress: string,
  email?: string,
  privyUserId?: string
): Promise<UserRecord & { email?: string }> {
  const pk = `USER#${walletAddress}`;

  const result = await dynamoClient.send(
    new GetCommand({
      TableName: ADMIN_TABLE,
      Key: { pk, sk: 'PROFILE' },
    })
  );

  const now = Date.now();

  if (result.Item) {
    const user = result.Item as UserRecord & { email?: string };
    const updateExpr = email
      ? 'SET lastSeenAt = :now, sessionCount = sessionCount + :one, email = :email, authProvider = :ap, privyUserId = :puid'
      : 'SET lastSeenAt = :now, sessionCount = sessionCount + :one, authProvider = :ap, privyUserId = :puid';

    const exprValues: Record<string, unknown> = {
      ':now': now,
      ':one': 1,
      ':ap': 'privy',
      ':puid': privyUserId ?? null,
    };

    if (email) {
      exprValues[':email'] = email;
    }

    await dynamoClient.send(
      new UpdateCommand({
        TableName: ADMIN_TABLE,
        Key: { pk, sk: 'PROFILE' },
        UpdateExpression: updateExpr,
        ExpressionAttributeValues: exprValues,
      })
    );

    return { ...user, lastSeenAt: now, sessionCount: user.sessionCount + 1, email: email || user.email };
  }

  const newUser: UserRecord & { email?: string; authProvider: string; privyUserId?: string } = {
    pk,
    sk: 'PROFILE',
    walletAddress,
    email,
    authProvider: 'privy',
    privyUserId,
    createdAt: now,
    lastSeenAt: now,
    sessionCount: 1,
  };

  if (email) {
    newUser.displayName = email.split('@')[0];
  }

  await dynamoClient.send(
    new PutCommand({
      TableName: ADMIN_TABLE,
      Item: newUser,
    })
  );

  logger.info('[PrivyAuth] Created new user', { privyUserId, wallet: walletAddress.slice(0, 8) });

  return newUser;
}

// ============================================================================
// Main Auth Flow
// ============================================================================

export async function verifyPrivyAuth(
  request: PrivyVerifyRequest,
  userAgent?: string,
  ipAddress?: string
): Promise<PrivyAuthResult> {
  const { accessToken, userId: claimedUserId } = request;

  if (!accessToken) {
    return { success: false, error: 'Missing access token' };
  }

  try {
    const client = await getPrivyClient();

    // 1) Verify the access token signature + claims.
    const payload = await client.utils().auth().verifyAccessToken(accessToken);
    const privyUserId = payload.user_id;

    if (!privyUserId) {
      return { success: false, error: 'Invalid access token' };
    }

    if (claimedUserId && claimedUserId !== privyUserId) {
      return { success: false, error: 'Token user mismatch' };
    }

    // 2) Fetch the user so we can trust-linked wallet/email (don’t trust client-provided walletAddress).
    const user = await client.users()._get(privyUserId);

    const walletAddress = pickSolanaWalletAddressFromPrivyUser(user);
    if (!walletAddress) {
      return { success: false, error: 'No Solana wallet found for Privy user' };
    }

    const email = pickEmailFromPrivyUser(user) ?? request.email;

    logger.info('[PrivyAuth] Verifying user', { privyUserId, wallet: walletAddress.slice(0, 8) });

    // 3) Check NFT gate.
    const nftGate = await checkNFTGate(walletAddress);

    // 4) Get/create user record (keyed by wallet).
    const appUser = await getOrCreateUser(walletAddress, email, privyUserId);

    // 5) Resolve/create account via canonical resolver.
    const accountResolution = await resolveOnboardingAuthAccount({
      mode: 'identity',
      primaryIdentity: { type: 'privy', providerId: privyUserId },
      additionalIdentities: [{ type: 'wallet', providerId: walletAddress }],
      createIfNotFound: true,
    });

    if (!accountResolution.success) {
      const conflictIdentity = accountResolution.identity;
      const conflictType = conflictIdentity?.type === 'wallet' ? 'wallet' : 'privy';
      const conflictProviderId = conflictIdentity?.providerId ?? privyUserId;

      return {
        success: false,
        error: accountResolution.error,
        code: accountResolution.code,
        outcome: accountResolution.outcome,
        switchAccountId: accountResolution.switchAccountId,
        requiredIntent: accountResolution.requiredIntent,
        conflict: accountResolution.switchAccountId
          ? {
              type: conflictType,
              providerId: conflictProviderId,
              existingAccountId: accountResolution.switchAccountId,
            }
          : undefined,
      };
    }

    // Track unified account activity + refresh active-user slot (if enabled)
    await recordAccountSession(accountResolution.accountId);
    const isOrbHolder = (nftGate.ownedCount ?? 0) > 0;
    await upsertActiveUserSlotOnLogin({ accountId: accountResolution.accountId, walletAddress, isOrbHolder });

    // 6) Create session.
    const session = await createSession(walletAddress, privyUserId, accountResolution.accountId, isOrbHolder, userAgent, ipAddress);

    // GTM funnel: F1 — authenticated account
    emitAuthEvent(accountResolution.accountId, {
      authProvider: 'privy',
      privyUserId,
      isOrbHolder,
    });

    return {
      success: true,
      session,
      user: appUser,
      nftGate,
      outcome: accountResolution.outcome,
    };
  } catch (error) {
    logger.error('[PrivyAuth] Verify error', error);
    return { success: false, error: 'Authentication failed' };
  }
}

export async function verifyPrivyAccessTokenForLink(accessToken: string): Promise<{ ok: true; privyUserId: string; walletAddress: string | null; email?: string } | { ok: false; error: string }> {
  try {
    const client = await getPrivyClient();
    const payload = await client.utils().auth().verifyAccessToken(accessToken);
    const privyUserId = payload.user_id;
    if (!privyUserId) return { ok: false, error: 'Invalid access token' };

    const user = await client.users()._get(privyUserId);
    const walletAddress = pickSolanaWalletAddressFromPrivyUser(user);
    const email = pickEmailFromPrivyUser(user);

    return { ok: true, privyUserId, walletAddress, email };
  } catch (error) {
    logger.error('[PrivyAuth] Link verify error', error);
    return { ok: false, error: 'Invalid authentication token' };
  }
}
