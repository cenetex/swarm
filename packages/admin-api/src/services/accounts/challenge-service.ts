/**
 * Challenge Service
 *
 * Provides retry-safe challenge creation and consumption for identity linking.
 * Challenges are marked as consumed rather than deleted, allowing for idempotent
 * retries and debugging of race conditions.
 */
import {
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@swarm/core';
import { randomBytes } from 'crypto';
import { getDynamoClient } from '../dynamo-client.js';

const dynamoClient = getDynamoClient();

const ADMIN_TABLE = process.env.ADMIN_TABLE!;
const CHALLENGE_TTL_MINUTES = 5;
const DOMAIN = process.env.AUTH_DOMAIN || 'swarm.rati.chat';

// ============================================================================
// Types
// ============================================================================

export type ChallengeType = 'auth' | 'link';

export interface ChallengeRecord {
  pk: string; // CHALLENGE#<nonce> for auth, LINKCHALLENGE#<nonce> for link
  sk: 'DATA';
  challengeType: ChallengeType;
  nonce: string;
  message: string;
  // For auth challenges
  walletAddress?: string;
  // For link challenges
  accountId?: string;
  identityType?: string;
  providerId?: string;
  // Idempotency support
  idempotencyKey?: string;
  consumedAt?: number;
  consumedBy?: string; // Session token or request ID that consumed it
  // Timestamps
  createdAt: number;
  expiresAt: number;
  ttl: number;
}

export interface ChallengeServiceDeps {
  dynamoClient: Pick<DynamoDBDocumentClient, 'send'>;
  tableName: string;
  domain: string;
  now: () => number;
  generateNonce: () => string;
}

function getDefaultDeps(): ChallengeServiceDeps {
  return {
    dynamoClient,
    tableName: ADMIN_TABLE,
    domain: DOMAIN,
    now: () => Date.now(),
    generateNonce: () => randomBytes(32).toString('hex'),
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Generate the partition key for a challenge.
 * Uses legacy key format for backwards compatibility:
 * - Auth challenges: CHALLENGE#<nonce> (matches wallet-auth.ts)
 * - Link challenges: LINKCHALLENGE#<nonce> (matches wallet-link.ts)
 */
function challengePk(type: ChallengeType, nonce: string): string {
  if (type === 'auth') {
    return `CHALLENGE#${nonce}`;
  }
  return `LINKCHALLENGE#${nonce}`;
}

// ============================================================================
// Auth Challenge (for initial sign-in)
// ============================================================================

export interface CreateAuthChallengeParams {
  walletAddress: string;
  idempotencyKey?: string;
}

export interface CreateAuthChallengeResult {
  nonce: string;
  message: string;
  expiresAt: number;
}

/**
 * Create an auth challenge for wallet sign-in.
 */
export async function createAuthChallenge(
  params: CreateAuthChallengeParams,
  deps: ChallengeServiceDeps = getDefaultDeps()
): Promise<CreateAuthChallengeResult> {
  const { walletAddress, idempotencyKey } = params;
  const nonce = deps.generateNonce();
  const now = deps.now();
  const expiresAt = now + CHALLENGE_TTL_MINUTES * 60 * 1000;

  const nowDate = new Date(now);
  const expirationDate = new Date(expiresAt);

  const message = `Sign this message to authenticate with Swarm Admin.

Domain: ${deps.domain}
Wallet: ${walletAddress}
Nonce: ${nonce}
Issued At: ${nowDate.toISOString()}
Expiration: ${expirationDate.toISOString()}

This signature will not trigger any blockchain transaction or cost any fees.`;

  const record: ChallengeRecord = {
    pk: challengePk('auth', nonce),
    sk: 'DATA',
    challengeType: 'auth',
    nonce,
    message,
    walletAddress,
    idempotencyKey,
    createdAt: now,
    expiresAt,
    ttl: Math.floor(expiresAt / 1000),
  };

  await deps.dynamoClient.send(
    new PutCommand({
      TableName: deps.tableName,
      Item: record,
    })
  );

  return { nonce, message, expiresAt };
}

// ============================================================================
// Link Challenge (for linking additional identities)
// ============================================================================

export interface CreateLinkChallengeParams {
  accountId: string;
  walletAddress: string;
  idempotencyKey?: string;
}

export interface CreateLinkChallengeResult {
  nonce: string;
  message: string;
  expiresAt: number;
}

/**
 * Create a challenge for linking a wallet to an existing account.
 */
export async function createLinkChallenge(
  params: CreateLinkChallengeParams,
  deps: ChallengeServiceDeps = getDefaultDeps()
): Promise<CreateLinkChallengeResult> {
  const { accountId, walletAddress, idempotencyKey } = params;
  const nonce = deps.generateNonce();
  const now = deps.now();
  const expiresAt = now + CHALLENGE_TTL_MINUTES * 60 * 1000;

  const nowDate = new Date(now);
  const expirationDate = new Date(expiresAt);

  const message = `Sign this message to link a Solana wallet to your Swarm account.

Domain: ${deps.domain}
Account: ${accountId}
Wallet: ${walletAddress}
Nonce: ${nonce}
Issued At: ${nowDate.toISOString()}
Expiration: ${expirationDate.toISOString()}

This signature will not trigger any blockchain transaction or cost any fees.`;

  const record: ChallengeRecord = {
    pk: challengePk('link', nonce),
    sk: 'DATA',
    challengeType: 'link',
    nonce,
    message,
    accountId,
    walletAddress,
    identityType: 'wallet',
    providerId: walletAddress,
    idempotencyKey,
    createdAt: now,
    expiresAt,
    ttl: Math.floor(expiresAt / 1000),
  };

  await deps.dynamoClient.send(
    new PutCommand({
      TableName: deps.tableName,
      Item: record,
    })
  );

  return { nonce, message, expiresAt };
}

// ============================================================================
// Challenge Consumption
// ============================================================================

export type ConsumeResult =
  | { success: true; challenge: ChallengeRecord }
  | { success: false; error: string; alreadyConsumed?: boolean };

/**
 * Consume a challenge. Returns the challenge data if valid.
 *
 * This is idempotent - if the same consumerId attempts to consume the same
 * challenge twice, it will succeed and return the challenge data.
 *
 * @param type - The challenge type ('auth' or 'link')
 * @param nonce - The challenge nonce
 * @param consumerId - Unique identifier for this consumption attempt (e.g., request ID)
 */
export async function consumeChallenge(
  type: ChallengeType,
  nonce: string,
  consumerId: string,
  deps: ChallengeServiceDeps = getDefaultDeps()
): Promise<ConsumeResult> {
  const pk = challengePk(type, nonce);

  // First, try to get the challenge
  const getResult = await deps.dynamoClient.send(
    new GetCommand({
      TableName: deps.tableName,
      Key: { pk, sk: 'DATA' },
    })
  );

  if (!getResult.Item) {
    return { success: false, error: 'Challenge not found' };
  }

  const challenge = getResult.Item as ChallengeRecord;
  const now = deps.now();

  // Check expiration
  if (now > challenge.expiresAt) {
    return { success: false, error: 'Challenge expired' };
  }

  // Check if already consumed
  if (challenge.consumedAt) {
    // If consumed by the same consumer, allow idempotent retry
    if (challenge.consumedBy === consumerId) {
      return { success: true, challenge };
    }
    return {
      success: false,
      error: 'Challenge already consumed',
      alreadyConsumed: true,
    };
  }

  // Mark as consumed (atomically)
  try {
    await deps.dynamoClient.send(
      new UpdateCommand({
        TableName: deps.tableName,
        Key: { pk, sk: 'DATA' },
        UpdateExpression: 'SET consumedAt = :now, consumedBy = :consumerId',
        ConditionExpression: 'attribute_not_exists(consumedAt)',
        ExpressionAttributeValues: {
          ':now': now,
          ':consumerId': consumerId,
        },
      })
    );

    return {
      success: true,
      challenge: { ...challenge, consumedAt: now, consumedBy: consumerId },
    };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'ConditionalCheckFailedException') {
      // Race condition - someone else consumed it
      // Re-fetch to check if it was us (idempotent retry)
      const refetch = await deps.dynamoClient.send(
        new GetCommand({
          TableName: deps.tableName,
          Key: { pk, sk: 'DATA' },
        })
      );

      const updated = refetch.Item as ChallengeRecord | undefined;
      if (updated?.consumedBy === consumerId) {
        return { success: true, challenge: updated };
      }

      return {
        success: false,
        error: 'Challenge already consumed',
        alreadyConsumed: true,
      };
    }
    throw err;
  }
}

/**
 * Get a challenge without consuming it.
 */
export async function getChallenge(
  type: ChallengeType,
  nonce: string,
  deps: ChallengeServiceDeps = getDefaultDeps()
): Promise<ChallengeRecord | null> {
  const result = await deps.dynamoClient.send(
    new GetCommand({
      TableName: deps.tableName,
      Key: { pk: challengePk(type, nonce), sk: 'DATA' },
    })
  );

  return (result.Item as ChallengeRecord) ?? null;
}
