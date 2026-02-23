/**
 * Session Service
 *
 * Manages user sessions with support for multiple auth providers.
 * Extracted from wallet-auth.ts to provide a unified session interface.
 */
import {
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { randomBytes } from 'crypto';
import { logger } from '@swarm/core';
import { getDynamoClient } from '../dynamo-client.js';

const dynamoClient = getDynamoClient();

const ADMIN_TABLE = process.env.ADMIN_TABLE!;
const SESSION_TTL_HOURS = 24;

// ============================================================================
// Types
// ============================================================================

export type AuthProvider = 'wallet' | 'privy';

export interface SessionRecord {
  pk: string; // SESSION#<token>
  sk: 'DATA';
  sessionToken: string;
  walletAddress: string; // Primary wallet for this session
  // These fields are always set by the new session service, but may be
  // undefined when reading legacy sessions created by wallet-auth.ts
  accountId?: string;
  authProvider?: AuthProvider;
  authProviderId?: string; // Provider-specific ID used to authenticate
  createdAt: number;
  expiresAt: number;
  lastActiveAt: number;
  userAgent?: string;
  ipAddress?: string;
  ttl: number;
}

export interface SessionServiceDeps {
  dynamoClient: Pick<DynamoDBDocumentClient, 'send'>;
  tableName: string;
  now: () => number;
  generateToken: () => string;
}

function getDefaultDeps(): SessionServiceDeps {
  return {
    dynamoClient,
    tableName: ADMIN_TABLE,
    now: () => Date.now(),
    generateToken: () => randomBytes(48).toString('base64url'),
  };
}

// ============================================================================
// Helpers
// ============================================================================

function sessionPk(token: string): string {
  return `SESSION#${token}`;
}

// ============================================================================
// Session CRUD
// ============================================================================

export interface CreateSessionParams {
  accountId: string;
  walletAddress: string;
  authProvider: AuthProvider;
  authProviderId: string;
  userAgent?: string;
  ipAddress?: string;
}

/**
 * Create a new session.
 */
export async function createSession(
  params: CreateSessionParams,
  deps: SessionServiceDeps = getDefaultDeps()
): Promise<SessionRecord> {
  const {
    accountId,
    walletAddress,
    authProvider,
    authProviderId,
    userAgent,
    ipAddress,
  } = params;

  const sessionToken = deps.generateToken();
  const now = deps.now();
  const expiresAt = now + SESSION_TTL_HOURS * 60 * 60 * 1000;

  const record: SessionRecord = {
    pk: sessionPk(sessionToken),
    sk: 'DATA',
    sessionToken,
    accountId,
    walletAddress,
    authProvider,
    authProviderId,
    createdAt: now,
    expiresAt,
    lastActiveAt: now,
    userAgent,
    ipAddress,
    ttl: Math.floor(expiresAt / 1000),
  };

  await deps.dynamoClient.send(
    new PutCommand({
      TableName: deps.tableName,
      Item: record,
    })
  );

  logger.info('[SessionService] Created session', { accountId, authProvider });

  return record;
}

/**
 * Get a session by token. Returns null if not found or expired.
 */
export async function getSession(
  sessionToken: string,
  deps: SessionServiceDeps = getDefaultDeps()
): Promise<SessionRecord | null> {
  const result = await deps.dynamoClient.send(
    new GetCommand({
      TableName: deps.tableName,
      Key: { pk: sessionPk(sessionToken), sk: 'DATA' },
    })
  );

  if (!result.Item) {
    return null;
  }

  const session = result.Item as SessionRecord;
  const now = deps.now();

  // Check expiration
  if (now > session.expiresAt) {
    // Clean up expired session
    await deleteSession(sessionToken, deps);
    return null;
  }

  return session;
}

/**
 * Touch a session to extend its TTL (sliding window).
 */
export async function touchSession(
  sessionToken: string,
  deps: SessionServiceDeps = getDefaultDeps()
): Promise<void> {
  const now = deps.now();
  const newExpiresAt = now + SESSION_TTL_HOURS * 60 * 60 * 1000;

  try {
    await deps.dynamoClient.send(
      new UpdateCommand({
        TableName: deps.tableName,
        Key: { pk: sessionPk(sessionToken), sk: 'DATA' },
        UpdateExpression: 'SET lastActiveAt = :now, expiresAt = :exp, #ttl = :ttl',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':now': now,
          ':exp': newExpiresAt,
          ':ttl': Math.floor(newExpiresAt / 1000),
        },
        ConditionExpression: 'attribute_exists(pk)',
      })
    );
  } catch (err: unknown) {
    // Session may have been deleted - ignore
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
      return;
    }
    throw err;
  }
}

/**
 * Delete a session (logout).
 */
export async function deleteSession(
  sessionToken: string,
  deps: SessionServiceDeps = getDefaultDeps()
): Promise<void> {
  await deps.dynamoClient.send(
    new DeleteCommand({
      TableName: deps.tableName,
      Key: { pk: sessionPk(sessionToken), sk: 'DATA' },
    })
  );

  logger.info('[SessionService] Session deleted');
}

/**
 * Get a session and touch it to extend TTL.
 * This is the common pattern for authenticated endpoints.
 */
export async function getAndTouchSession(
  sessionToken: string,
  deps: SessionServiceDeps = getDefaultDeps()
): Promise<SessionRecord | null> {
  const session = await getSession(sessionToken, deps);
  if (!session) {
    return null;
  }

  // Touch session in the background (don't wait)
  touchSession(sessionToken, deps).catch((err) => {
    logger.error('[SessionService] Failed to touch session', err);
  });

  return session;
}

// ============================================================================
// Session Validation Helpers
// ============================================================================

export interface ValidatedSession {
  session: SessionRecord;
  accountId: string;
  walletAddress: string;
}

/**
 * Validate a session token and return session info.
 * This is a convenience wrapper that ensures the session is valid.
 *
 * Returns null if:
 * - Session doesn't exist
 * - Session is expired
 * - Session doesn't have an accountId (legacy sessions)
 */
export async function validateSession(
  sessionToken: string,
  deps: SessionServiceDeps = getDefaultDeps()
): Promise<ValidatedSession | null> {
  const session = await getAndTouchSession(sessionToken, deps);
  if (!session) {
    return null;
  }

  // Legacy sessions may not have accountId - treat as invalid for new system
  if (!session.accountId) {
    logger.warn('[SessionService] Session missing accountId, treating as invalid');
    return null;
  }

  return {
    session,
    accountId: session.accountId,
    walletAddress: session.walletAddress,
  };
}
