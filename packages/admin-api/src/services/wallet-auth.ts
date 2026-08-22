/**
 * Wallet Authentication Service
 * Handles Solana wallet sign-in (SIWS - Sign In With Solana)
 */
import {
  PutCommand,
  GetCommand,
  DeleteCommand,
  UpdateCommand,
} from '@swarm/core';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { randomBytes } from 'crypto';
import { logger } from '@swarm/core';
import { checkNFTGate, type NFTGateResult } from './web3/nft-gate.js';
import { getOrCreateAccountForWallet, recordAccountSession } from './accounts.js';
import { upsertActiveUserSlotOnLogin } from './billing/active-user-limit.js';
import { getDynamoClient } from './dynamo-client.js';
import { emitAuthEvent } from './funnel-emitter.js';

const dynamoClient = getDynamoClient();
const ADMIN_TABLE = process.env.ADMIN_TABLE!;

// Session configuration
const SESSION_TTL_HOURS = 24;
const CHALLENGE_TTL_MINUTES = 5;
const DOMAIN = process.env.AUTH_DOMAIN || 'swarm.rati.chat';

// Rate limiting configuration
const CHALLENGE_RATE_LIMIT_PER_MINUTE = 10;
const CHALLENGE_RATE_WINDOW_MS = 60 * 1000; // 1 minute

// ============================================================================
// Types
// ============================================================================

export interface UserRecord {
  pk: string; // USER#<walletAddress>
  sk: 'PROFILE';
  walletAddress: string;
  displayName?: string;
  avatarUrl?: string;
  inhabitedAvatarId?: string;
  inhabitedAt?: number;
  createdAt: number;
  lastSeenAt: number;
  sessionCount: number;
}

export type AuthProvider = 'wallet' | 'privy';

export interface SessionRecord {
  pk: string; // SESSION#<token>
  sk: 'DATA';
  sessionToken: string;
  walletAddress: string;
  accountId?: string;
  // New fields for unified auth model
  authProvider?: AuthProvider;
  authProviderId?: string; // The provider-specific ID used to authenticate
  createdAt: number;
  expiresAt: number;
  lastActiveAt: number;
  userAgent?: string;
  ipAddress?: string;
  // Cached at login time to avoid repeated NFT lookups on every request.
  // Used for bypassing the active-user cap.
  isOrbHolder?: boolean;
  ttl: number;
}

export interface ChallengeRecord {
  pk: string; // CHALLENGE#<nonce>
  sk: 'DATA';
  nonce: string;
  walletAddress: string;
  message: string;
  createdAt: number;
  expiresAt: number;
  ttl: number;
}

export interface WalletSession {
  walletAddress: string;
  sessionToken: string;
  accountId?: string;
  user: UserRecord;
  isOrbHolder?: boolean;
}

// ============================================================================
// Challenge Management
// ============================================================================

/**
 * Generate a random nonce for challenges
 */
function generateNonce(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Generate a session token
 */
function generateSessionToken(): string {
  return randomBytes(48).toString('base64url');
}

/**
 * Create a challenge message for the user to sign
 */
export function createChallengeMessage(walletAddress: string, nonce: string): string {
  const now = new Date();
  const expiration = new Date(now.getTime() + CHALLENGE_TTL_MINUTES * 60 * 1000);

  return `Sign this message to authenticate with Swarm Admin.

Domain: ${DOMAIN}
Wallet: ${walletAddress}
Nonce: ${nonce}
Issued At: ${now.toISOString()}
Expiration: ${expiration.toISOString()}

This signature will not trigger any blockchain transaction or cost any fees.`;
}

// ============================================================================
// Rate Limiting
// ============================================================================

interface RateLimitRecord {
  pk: string; // RATELIMIT#<type>#<key>
  sk: 'DATA';
  count: number;
  windowStart: number;
  ttl: number;
}

/**
 * Check and update rate limit for a given key
 * Returns true if within limit, false if exceeded
 */
async function checkRateLimit(
  type: string,
  key: string,
  maxPerWindow: number,
  windowMs: number
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const pk = `RATELIMIT#${type}#${key}`;
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const resetAt = windowStart + windowMs;
  const ttl = Math.floor(resetAt / 1000) + 60; // TTL slightly after window ends

  try {
    // Try to increment counter with conditional check
    const result = await dynamoClient.send(new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: { pk, sk: 'DATA' },
      UpdateExpression: 'SET #count = if_not_exists(#count, :zero) + :one, windowStart = :ws, #ttl = :ttl',
      ConditionExpression: 'attribute_not_exists(windowStart) OR windowStart = :ws',
      ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ':zero': 0,
        ':one': 1,
        ':ws': windowStart,
        ':ttl': ttl,
      },
      ReturnValues: 'ALL_NEW',
    }));

    const count = (result.Attributes?.count as number) || 1;
    const allowed = count <= maxPerWindow;
    return { allowed, remaining: Math.max(0, maxPerWindow - count), resetAt };
  } catch (err: unknown) {
    // Window changed, start fresh counter
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
      await dynamoClient.send(new PutCommand({
        TableName: ADMIN_TABLE,
        Item: { pk, sk: 'DATA', count: 1, windowStart, ttl } as RateLimitRecord,
      }));
      return { allowed: true, remaining: maxPerWindow - 1, resetAt };
    }
    // On error, allow the request (fail open)
    logger.error('[WalletAuth] Rate limit check failed', err);
    return { allowed: true, remaining: maxPerWindow, resetAt: now + windowMs };
  }
}

/**
 * Create and store a new challenge
 */
export async function createChallenge(
  walletAddress: string,
  ipAddress?: string
): Promise<{
  nonce: string;
  message: string;
  expiresAt: number;
} | { error: string; retryAfter: number }> {
  // Rate limit by IP address (or wallet if no IP)
  const rateLimitKey = ipAddress || walletAddress;
  const rateCheck = await checkRateLimit(
    'challenge',
    rateLimitKey,
    CHALLENGE_RATE_LIMIT_PER_MINUTE,
    CHALLENGE_RATE_WINDOW_MS
  );

  if (!rateCheck.allowed) {
    logger.info('[WalletAuth] Rate limited challenge', { rateLimitKey: rateLimitKey.slice(0, 8) });
    return {
      error: 'Too many requests. Please wait before trying again.',
      retryAfter: Math.ceil((rateCheck.resetAt - Date.now()) / 1000),
    };
  }

  const nonce = generateNonce();
  const message = createChallengeMessage(walletAddress, nonce);
  const now = Date.now();
  const expiresAt = now + CHALLENGE_TTL_MINUTES * 60 * 1000;

  const record: ChallengeRecord = {
    pk: `CHALLENGE#${nonce}`,
    sk: 'DATA',
    nonce,
    walletAddress,
    message,
    createdAt: now,
    expiresAt,
    ttl: Math.floor(expiresAt / 1000), // DynamoDB TTL in seconds
  };

  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: record,
  }));

  logger.info('[WalletAuth] Created challenge', { wallet: walletAddress.slice(0, 8) });

  return { nonce, message, expiresAt };
}

/**
 * Get and validate a challenge (one-time use)
 */
async function consumeChallenge(nonce: string, walletAddress: string): Promise<ChallengeRecord | null> {
  const now = Date.now();
  try {
    const result = await dynamoClient.send(new DeleteCommand({
      TableName: ADMIN_TABLE,
      Key: { pk: `CHALLENGE#${nonce}`, sk: 'DATA' },
      ConditionExpression: '#expiresAt > :now AND (#walletAddress = :walletAddress OR attribute_not_exists(#walletAddress))',
      ExpressionAttributeNames: {
        '#expiresAt': 'expiresAt',
        '#walletAddress': 'walletAddress',
      },
      ExpressionAttributeValues: {
        ':now': now,
        ':walletAddress': walletAddress,
      },
      ReturnValues: 'ALL_OLD',
    }));

    const challenge = result.Attributes as ChallengeRecord | undefined;
    if (!challenge) {
      logger.info('[WalletAuth] Challenge not found', { nonce: nonce.slice(0, 16) });
      return null;
    }
    return challenge;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
      logger.info('[WalletAuth] Challenge invalid/expired/mismatched wallet', { nonce: nonce.slice(0, 16) });
      return null;
    }
    throw err;
  }
}

// ============================================================================
// Signature Verification
// ============================================================================

/**
 * Verify a Solana signature
 */
export function verifySignature(
  message: string,
  signatureBase58: string,
  publicKeyBase58: string
): boolean {
  try {
    const messageBytes = new TextEncoder().encode(message);
    const signatureBytes = bs58.decode(signatureBase58);
    const publicKeyBytes = bs58.decode(publicKeyBase58);

    logger.debug('[WalletAuth] Verifying signature', {
      messageLength: message.length,
      signatureLength: signatureBytes.length,
      publicKeyLength: publicKeyBytes.length,
      publicKey: publicKeyBase58.substring(0, 8),
    });

    // Solana public keys are 32 bytes
    if (publicKeyBytes.length !== 32) {
      logger.warn('[WalletAuth] Invalid public key length', { length: publicKeyBytes.length });
      return false;
    }

    // Solana signatures are 64 bytes
    if (signatureBytes.length !== 64) {
      logger.warn('[WalletAuth] Invalid signature length', { length: signatureBytes.length });
      return false;
    }

    const isValid = nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes);
    logger.debug('[WalletAuth] Signature verification result', { isValid });

    return isValid;
  } catch (error) {
    logger.error('[WalletAuth] Signature verification error', error);
    return false;
  }
}

// ============================================================================
// Session Management
// ============================================================================

/**
 * Create a new session for a wallet
 */
async function createSession(
  walletAddress: string,
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

  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: record,
  }));

  logger.info('[WalletAuth] Created session', { wallet: walletAddress.slice(0, 8) });

  return record;
}

/**
 * Get a session by token
 */
export async function getSession(sessionToken: string): Promise<SessionRecord | null> {
  const result = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: { pk: `SESSION#${sessionToken}`, sk: 'DATA' },
  }));

  if (!result.Item) {
    return null;
  }

  const session = result.Item as SessionRecord;

  // Check expiration
  if (Date.now() > session.expiresAt) {
    // Clean up expired session
    await dynamoClient.send(new DeleteCommand({
      TableName: ADMIN_TABLE,
      Key: { pk: `SESSION#${sessionToken}`, sk: 'DATA' },
    }));
    return null;
  }

  return session;
}

/**
 * Update session last active time (sliding window)
 */
export async function touchSession(sessionToken: string): Promise<void> {
  const now = Date.now();
  const newExpiresAt = now + SESSION_TTL_HOURS * 60 * 60 * 1000;

  await dynamoClient.send(new UpdateCommand({
    TableName: ADMIN_TABLE,
    Key: { pk: `SESSION#${sessionToken}`, sk: 'DATA' },
    UpdateExpression: 'SET lastActiveAt = :now, expiresAt = :exp, #ttl = :ttl',
    ExpressionAttributeNames: { '#ttl': 'ttl' },
    ExpressionAttributeValues: {
      ':now': now,
      ':exp': newExpiresAt,
      ':ttl': Math.floor(newExpiresAt / 1000),
    },
  }));
}

/**
 * Delete a session (logout)
 */
export async function deleteSession(sessionToken: string): Promise<void> {
  await dynamoClient.send(new DeleteCommand({
    TableName: ADMIN_TABLE,
    Key: { pk: `SESSION#${sessionToken}`, sk: 'DATA' },
  }));
  logger.info('[WalletAuth] Session deleted');
}

// ============================================================================
// User Management
// ============================================================================

/**
 * Get or create a user record
 */
async function getOrCreateUser(walletAddress: string): Promise<UserRecord> {
  const pk = `USER#${walletAddress}`;

  // Try to get existing user
  const result = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: { pk, sk: 'PROFILE' },
  }));

  const now = Date.now();

  if (result.Item) {
    // Update last seen and session count
    const user = result.Item as UserRecord;
    await dynamoClient.send(new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: { pk, sk: 'PROFILE' },
      UpdateExpression: 'SET lastSeenAt = :now, sessionCount = sessionCount + :one',
      ExpressionAttributeValues: {
        ':now': now,
        ':one': 1,
      },
    }));

    return { ...user, lastSeenAt: now, sessionCount: user.sessionCount + 1 };
  }

  // Create new user
  const newUser: UserRecord = {
    pk,
    sk: 'PROFILE',
    walletAddress,
    createdAt: now,
    lastSeenAt: now,
    sessionCount: 1,
  };

  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: newUser,
  }));

  logger.info('[WalletAuth] Created new user', { wallet: walletAddress.slice(0, 8) });

  return newUser;
}

/**
 * Get user by wallet address
 */
export async function getUser(walletAddress: string): Promise<UserRecord | null> {
  const result = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: { pk: `USER#${walletAddress}`, sk: 'PROFILE' },
  }));

  return result.Item as UserRecord | null;
}

/**
 * Update user profile
 */
export async function updateUser(
  walletAddress: string,
  updates: { displayName?: string; avatarUrl?: string }
): Promise<UserRecord | null> {
  const expressions: string[] = [];
  const values: Record<string, unknown> = {};

  if (updates.displayName !== undefined) {
    expressions.push('displayName = :dn');
    values[':dn'] = updates.displayName;
  }

  if (updates.avatarUrl !== undefined) {
    expressions.push('avatarUrl = :av');
    values[':av'] = updates.avatarUrl;
  }

  if (expressions.length === 0) {
    return getUser(walletAddress);
  }

  const result = await dynamoClient.send(new UpdateCommand({
    TableName: ADMIN_TABLE,
    Key: { pk: `USER#${walletAddress}`, sk: 'PROFILE' },
    UpdateExpression: `SET ${expressions.join(', ')}`,
    ExpressionAttributeValues: values,
    ReturnValues: 'ALL_NEW',
  }));

  return result.Attributes as UserRecord | null;
}

// ============================================================================
// Main Auth Flow
// ============================================================================

/**
 * Verify a signature and create a session
 */
export async function verifyAndCreateSession(
  signatureBase58: string,
  publicKeyBase58: string,
  nonce: string,
  userAgent?: string,
  ipAddress?: string
): Promise<{
  success: boolean;
  session?: SessionRecord;
  user?: UserRecord;
  nftGate?: NFTGateResult;
  error?: string;
}> {
  // 1. Get and consume the challenge
  const challenge = await consumeChallenge(nonce, publicKeyBase58);
  if (!challenge) {
    return { success: false, error: 'Invalid or expired challenge' };
  }

  // 2. Verify the signature
  const isValid = verifySignature(challenge.message, signatureBase58, publicKeyBase58);
  if (!isValid) {
    logger.warn('[WalletAuth] Invalid signature', { wallet: publicKeyBase58.slice(0, 8) });
    return { success: false, error: 'Invalid signature' };
  }

  // 3. Check NFT gate - but don't block authentication
  // Users without Orbs can still authenticate with limited access
  const nftGate = await checkNFTGate(publicKeyBase58);
  const isOrbHolder = (nftGate.ownedCount ?? 0) > 0;
  
  // Log gate status but proceed regardless
  if (!nftGate.allowed) {
    logger.info('[WalletAuth] No Orb NFT (limited access)', { wallet: publicKeyBase58.slice(0, 8) });
  }

  // 4. Get or create user
  const user = await getOrCreateUser(publicKeyBase58);

  // 4b. Get or create account for this wallet
  const accountId = await getOrCreateAccountForWallet(publicKeyBase58);

  // Track unified account activity + refresh active-user slot (if enabled)
  await recordAccountSession(accountId);
  await upsertActiveUserSlotOnLogin({ accountId, walletAddress: publicKeyBase58, isOrbHolder });

  // 5. Create session
  const session = await createSession(publicKeyBase58, accountId, isOrbHolder, userAgent, ipAddress);

  logger.info('[WalletAuth] Auth successful', { wallet: publicKeyBase58.slice(0, 8) });

  // GTM funnel: F1 — authenticated account
  emitAuthEvent(accountId, {
    authProvider: 'wallet',
    walletAddress: publicKeyBase58,
    isOrbHolder,
  });

  return { success: true, session, user, nftGate };
}

/**
 * Get current session and user from session token
 */
export async function getSessionWithUser(sessionToken: string): Promise<WalletSession | null> {
  const session = await getSession(sessionToken);
  if (!session) {
    return null;
  }

  const user = await getUser(session.walletAddress);
  if (!user) {
    return null;
  }

  // Touch session to extend TTL
  await touchSession(sessionToken);

  return {
    walletAddress: session.walletAddress,
    sessionToken: session.sessionToken,
    accountId: session.accountId,
    user,
    isOrbHolder: session.isOrbHolder,
  };
}
