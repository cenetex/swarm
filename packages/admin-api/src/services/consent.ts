/**
 * Consent Service
 *
 * Records and retrieves privacy-policy consent records in DynamoDB.
 * Each record captures who accepted which policy version and when,
 * providing an evidence trail for compliance.
 *
 * Schema:
 *   pk: CONSENT#<userId>
 *   sk: v<policyVersion>
 *   userId, policyVersion, acceptedAt, status, revokedAt?
 *
 * Consent records are long-lived (no TTL) since they serve as evidence.
 */
import {
  type DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { getDynamoClient } from './dynamo-client.js';

// ============================================================================
// Types
// ============================================================================

export type ConsentStatus = 'active' | 'revoked';

export interface ConsentRecord {
  userId: string;
  policyVersion: string;
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
// Core functions (accept explicit deps)
// ============================================================================

/**
 * Record a consent acceptance for a user and policy version.
 * Overwrites any previous record for the same user+version (idempotent re-accept).
 */
export async function recordConsentWith(
  deps: ConsentDeps,
  params: {
    userId: string;
    policyVersion: string;
  },
): Promise<ConsentRecord> {
  const now = Date.now();

  const record: ConsentRecord = {
    userId: params.userId,
    policyVersion: params.policyVersion,
    acceptedAt: now,
    status: 'active',
  };

  await deps.dynamoClient.send(
    new PutCommand({
      TableName: deps.tableName,
      Item: {
        pk: `CONSENT#${params.userId}`,
        sk: `v${params.policyVersion}`,
        ...record,
      },
    }),
  );

  return record;
}

/**
 * Get the consent status for a user and specific policy version.
 * Returns null if no consent record exists.
 */
export async function getConsentStatusWith(
  deps: ConsentDeps,
  params: {
    userId: string;
    policyVersion: string;
  },
): Promise<ConsentRecord | null> {
  const result = await deps.dynamoClient.send(
    new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: 'pk = :pk AND sk = :sk',
      ExpressionAttributeValues: {
        ':pk': `CONSENT#${params.userId}`,
        ':sk': `v${params.policyVersion}`,
      },
      Limit: 1,
    }),
  );

  const items = result.Items || [];
  if (items.length === 0) return null;

  const item = items[0] as Record<string, unknown>;
  return {
    userId: item.userId as string,
    policyVersion: item.policyVersion as string,
    acceptedAt: item.acceptedAt as number,
    status: item.status as ConsentStatus,
    revokedAt: item.revokedAt as number | undefined,
  };
}

/**
 * List all consent records for a user (all versions), newest first.
 */
export async function listConsentRecordsWith(
  deps: ConsentDeps,
  userId: string,
): Promise<ConsentRecord[]> {
  const result = await deps.dynamoClient.send(
    new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :skPrefix)',
      ExpressionAttributeValues: {
        ':pk': `CONSENT#${userId}`,
        ':skPrefix': 'v',
      },
      ScanIndexForward: false,
    }),
  );

  return (result.Items || []).map((item) => {
    const i = item as Record<string, unknown>;
    return {
      userId: i.userId as string,
      policyVersion: i.policyVersion as string,
      acceptedAt: i.acceptedAt as number,
      status: i.status as ConsentStatus,
      revokedAt: i.revokedAt as number | undefined,
    };
  });
}

/**
 * Revoke consent for a user and specific policy version.
 * Sets status to 'revoked' and records the revocation timestamp.
 */
export async function revokeConsentWith(
  deps: ConsentDeps,
  params: {
    userId: string;
    policyVersion: string;
  },
): Promise<boolean> {
  const now = Date.now();

  try {
    await deps.dynamoClient.send(
      new UpdateCommand({
        TableName: deps.tableName,
        Key: {
          pk: `CONSENT#${params.userId}`,
          sk: `v${params.policyVersion}`,
        },
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
): Promise<ConsentRecord[]> {
  return listConsentRecordsWith(getDefaultDeps(), userId);
}

export async function revokeConsent(
  params: Parameters<typeof revokeConsentWith>[1],
): Promise<boolean> {
  return revokeConsentWith(getDefaultDeps(), params);
}
