/**
 * Consent Service
 *
 * Records and retrieves privacy-policy consent records in DynamoDB.
 * Each record captures who accepted which policy version and when,
 * providing an evidence trail for compliance.
 *
 * Schema (v2 — account-bound):
 *   pk: CONSENT#ACCOUNT#<accountId>
 *   sk: v<policyVersion>
 *   userId (wallet address), accountId, policyVersion, noticeHash,
 *   acceptedAt, status, revokedAt?
 *
 * Legacy schema (v1 — wallet-scoped, read-only for migration):
 *   pk: CONSENT#<walletAddress>
 *   sk: v<policyVersion>
 *
 * The noticeHash is a SHA-256 hex digest of the privacy policy text at the
 * time of acceptance, proving which version of the notice was shown.
 *
 * Consent records are long-lived (no TTL) since they serve as evidence.
 */
import {
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@swarm/core';
import { createHash } from 'crypto';
import { getDynamoClient } from './dynamo-client.js';

// ============================================================================
// Types
// ============================================================================

export type ConsentStatus = 'active' | 'revoked';

export interface ConsentRecord {
  userId: string;
  accountId?: string;
  policyVersion: string;
  noticeHash?: string;
  acceptedAt: number;
  status: ConsentStatus;
  revokedAt?: number;
}

/** Dependencies that can be injected for testing. */
export interface ConsentDeps {
  dynamoClient: Pick<DynamoDBDocumentClient, 'send'>;
  tableName: string;
}

// ============================================================================
// Notice hashing
// ============================================================================

/**
 * Compute a SHA-256 hex digest of privacy-notice content.
 * Callers pass the canonical text of the notice that was displayed.
 */
export function computeNoticeHash(noticeContent: string): string {
  return createHash('sha256').update(noticeContent, 'utf8').digest('hex');
}

// ============================================================================
// Key helpers
// ============================================================================

/**
 * Build the partition key for a consent record.
 * New records use ACCOUNT#<accountId>; legacy records used the raw userId (wallet).
 */
function consentPk(params: { userId: string; accountId?: string }): string {
  if (params.accountId) {
    return `CONSENT#ACCOUNT#${params.accountId}`;
  }
  return `CONSENT#${params.userId}`;
}

function legacyConsentPk(userId: string): string {
  return `CONSENT#${userId}`;
}

// ============================================================================
// Default production deps (lazy-initialized)
// ============================================================================

let _defaultDeps: ConsentDeps | null = null;

function getDefaultDeps(): ConsentDeps {
  if (!_defaultDeps) {
    _defaultDeps = {
      dynamoClient: getDynamoClient(),
      tableName: process.env.ADMIN_TABLE || 'swarm-admin',
    };
  }
  return _defaultDeps;
}

// ============================================================================
// Internal helpers
// ============================================================================

function itemToRecord(item: Record<string, unknown>): ConsentRecord {
  return {
    userId: item.userId as string,
    accountId: item.accountId as string | undefined,
    policyVersion: item.policyVersion as string,
    noticeHash: item.noticeHash as string | undefined,
    acceptedAt: item.acceptedAt as number,
    status: item.status as ConsentStatus,
    revokedAt: item.revokedAt as number | undefined,
  };
}

// ============================================================================
// Core functions (accept explicit deps)
// ============================================================================

/**
 * Record a consent acceptance for a user and policy version.
 * Overwrites any previous record for the same user+version (idempotent re-accept).
 *
 * When accountId is provided the record is keyed to the stable account identity.
 * The noticeHash field captures a SHA-256 digest of the notice content shown.
 */
export async function recordConsentWith(
  deps: ConsentDeps,
  params: {
    userId: string;
    accountId?: string;
    policyVersion: string;
    noticeHash?: string;
  },
): Promise<ConsentRecord> {
  const now = Date.now();

  const record: ConsentRecord = {
    userId: params.userId,
    accountId: params.accountId,
    policyVersion: params.policyVersion,
    noticeHash: params.noticeHash,
    acceptedAt: now,
    status: 'active',
  };

  const pk = consentPk(params);

  await deps.dynamoClient.send(
    new PutCommand({
      TableName: deps.tableName,
      Item: {
        pk,
        sk: `v${params.policyVersion}`,
        ...record,
      },
    }),
  );

  return record;
}

/**
 * Get the consent status for a user and specific policy version.
 * Performs dual-lookup: first by accountId (new schema), then by legacy userId.
 * Returns null if no consent record exists under either key.
 */
export async function getConsentStatusWith(
  deps: ConsentDeps,
  params: {
    userId: string;
    accountId?: string;
    policyVersion: string;
  },
): Promise<ConsentRecord | null> {
  const sk = `v${params.policyVersion}`;

  // Try account-scoped lookup first
  if (params.accountId) {
    const result = await deps.dynamoClient.send(
      new GetCommand({
        TableName: deps.tableName,
        Key: {
          pk: `CONSENT#ACCOUNT#${params.accountId}`,
          sk,
        },
      }),
    );

    if (result.Item) {
      return itemToRecord(result.Item as Record<string, unknown>);
    }
  }

  // Fall back to legacy wallet-scoped lookup
  const result = await deps.dynamoClient.send(
    new GetCommand({
      TableName: deps.tableName,
      Key: {
        pk: legacyConsentPk(params.userId),
        sk,
      },
    }),
  );

  if (!result.Item) return null;
  return itemToRecord(result.Item as Record<string, unknown>);
}

/**
 * List all consent records for a user (all versions), newest first.
 * Queries by accountId when available, falls back to legacy userId.
 */
export async function listConsentRecordsWith(
  deps: ConsentDeps,
  userId: string,
  accountId?: string,
): Promise<ConsentRecord[]> {
  const pk = accountId ? `CONSENT#ACCOUNT#${accountId}` : legacyConsentPk(userId);

  const result = await deps.dynamoClient.send(
    new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': pk,
        ':skPrefix': 'v',
      },
      ScanIndexForward: false,
    }),
  );

  return (result.Items || []).map((item) =>
    itemToRecord(item as Record<string, unknown>),
  );
}

/**
 * Revoke consent for a user and specific policy version.
 * Sets status to 'revoked' and records the revocation timestamp.
 * Tries account-scoped key first, then falls back to legacy key.
 */
export async function revokeConsentWith(
  deps: ConsentDeps,
  params: {
    userId: string;
    accountId?: string;
    policyVersion: string;
  },
): Promise<boolean> {
  const now = Date.now();
  const sk = `v${params.policyVersion}`;

  const tryRevoke = async (pk: string): Promise<boolean> => {
    try {
      await deps.dynamoClient.send(
        new UpdateCommand({
          TableName: deps.tableName,
          Key: { pk, sk },
          UpdateExpression: 'SET #status = :status, revokedAt = :revokedAt',
          ConditionExpression: 'attribute_exists(pk) AND attribute_exists(sk)',
          ExpressionAttributeNames: {
            '#status': 'status',
          },
          ExpressionAttributeValues: {
            ':status': 'revoked',
            ':revokedAt': now,
          },
        }),
      );
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === 'ConditionalCheckFailedException') {
        return false;
      }
      throw error;
    }
  };

  // Try account-scoped key first
  if (params.accountId) {
    const revoked = await tryRevoke(`CONSENT#ACCOUNT#${params.accountId}`);
    if (revoked) return true;
  }

  // Fall back to legacy wallet-scoped key
  return tryRevoke(legacyConsentPk(params.userId));
}

// ============================================================================
// Public API (uses default production deps)
// ============================================================================

export async function recordConsent(
  params: Parameters<typeof recordConsentWith>[1],
): Promise<ConsentRecord> {
  return recordConsentWith(getDefaultDeps(), params);
}

export async function getConsentStatus(
  params: Parameters<typeof getConsentStatusWith>[1],
): Promise<ConsentRecord | null> {
  return getConsentStatusWith(getDefaultDeps(), params);
}

export async function listConsentRecords(
  userId: string,
  accountId?: string,
): Promise<ConsentRecord[]> {
  return listConsentRecordsWith(getDefaultDeps(), userId, accountId);
}

export async function revokeConsent(
  params: Parameters<typeof revokeConsentWith>[1],
): Promise<boolean> {
  return revokeConsentWith(getDefaultDeps(), params);
}
