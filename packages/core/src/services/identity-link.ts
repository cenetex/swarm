/**
 * Identity Link Service
 *
 * DynamoDB-backed implementation of IdentityLinkService.
 * Follows the DI pattern used by usage.ts / state/index.ts:
 *   - accepts an optional DynamoDBDocumentClient in the constructor so
 *     tests can inject an in-memory mock without hitting AWS.
 *
 * DynamoDB key schema
 * -------------------
 * Partition key : USER#<userId>
 * Sort key      : IDENTITY_LINK#<platform>#<platformUserId>
 *
 * Audit events
 * ------------
 * Partition key : AUDIT
 * Sort key      : IDENTITY_LINK#<occurredAt>#<userId>#<action>
 * TTL           : 365 days (audit trail retained for 1 year)
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { Platform } from '../types/platform.js';
import type {
  IdentityLink,
  IdentityLinkAuditEvent,
  IdentityLinkService,
} from '../types/identity-link.js';

// ---------------------------------------------------------------------------
// DI injection hook (mirrors _setDynamoClient used in canonical-memory.ts)
// ---------------------------------------------------------------------------

let _injectedClient: DynamoDBDocumentClient | null = null;

/**
 * Override the DynamoDB client used by IdentityLinkServiceImpl.
 * Call with `null` to restore the default behaviour.
 * Intended for tests only.
 */
export function _setIdentityLinkDynamoClient(client: DynamoDBDocumentClient | null): void {
  _injectedClient = client;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDocClient(region = 'us-east-1'): DynamoDBDocumentClient {
  if (_injectedClient) return _injectedClient;
  const raw = new DynamoDBClient({ region });
  return DynamoDBDocumentClient.from(raw, {
    marshallOptions: { removeUndefinedValues: true },
  });
}

function linkPk(userId: string): string {
  return `USER#${userId}`;
}

function linkSk(platform: Platform, platformUserId: string): string {
  return `IDENTITY_LINK#${platform}#${platformUserId}`;
}

function auditSk(occurredAt: string, userId: string, action: string): string {
  return `IDENTITY_LINK#${occurredAt}#${userId}#${action}`;
}

function ttlSeconds(days: number): number {
  return Math.floor(Date.now() / 1000) + days * 24 * 60 * 60;
}

// ---------------------------------------------------------------------------
// Service implementation
// ---------------------------------------------------------------------------

export class IdentityLinkServiceImpl implements IdentityLinkService {
  private readonly docClient: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(tableName: string, docClient?: DynamoDBDocumentClient) {
    this.tableName = tableName;
    this.docClient = docClient ?? makeDocClient();
  }

  // -------------------------------------------------------------------------
  // linkIdentity
  // -------------------------------------------------------------------------

  async linkIdentity(
    userId: string,
    platform: Platform,
    platformUserId: string,
  ): Promise<IdentityLink> {
    const now = new Date().toISOString();

    // Read existing link (may be active or revoked).
    const existing = await this._getLink(userId, platform, platformUserId);

    if (existing?.status === 'active') {
      // Already linked — idempotent, return as-is.
      await this.auditLog({
        action: 'consent_checked',
        userId,
        platform,
        platformUserId,
        occurredAt: now,
        reason: 'link_already_active',
      });
      return existing;
    }

    const link: IdentityLink = {
      userId,
      platform,
      platformUserId,
      linkedAt: existing?.linkedAt ?? now,
      consentGrantedAt: now,
      consentRevokedAt: undefined,
      status: 'active',
    };

    await this.docClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: linkPk(userId),
          sk: linkSk(platform, platformUserId),
          ...link,
          updatedAt: now,
        },
      }),
    );

    await this.auditLog({
      action: 'link_created',
      userId,
      platform,
      platformUserId,
      occurredAt: now,
    });

    return link;
  }

  // -------------------------------------------------------------------------
  // revokeLink
  // -------------------------------------------------------------------------

  async revokeLink(
    userId: string,
    platform: Platform,
    platformUserId: string,
  ): Promise<IdentityLink | null> {
    const existing = await this._getLink(userId, platform, platformUserId);
    if (!existing) return null;

    const now = new Date().toISOString();

    await this.docClient.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: {
          pk: linkPk(userId),
          sk: linkSk(platform, platformUserId),
        },
        UpdateExpression:
          'SET #status = :revoked, consentRevokedAt = :now, updatedAt = :now',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: {
          ':revoked': 'revoked',
          ':now': now,
        },
      }),
    );

    const updated: IdentityLink = {
      ...existing,
      status: 'revoked',
      consentRevokedAt: now,
    };

    await this.auditLog({
      action: 'link_revoked',
      userId,
      platform,
      platformUserId,
      occurredAt: now,
    });

    return updated;
  }

  // -------------------------------------------------------------------------
  // getLinkedIdentities
  // -------------------------------------------------------------------------

  async getLinkedIdentities(userId: string): Promise<IdentityLink[]> {
    const result = await this.docClient.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: {
          ':pk': linkPk(userId),
          ':prefix': 'IDENTITY_LINK#',
        },
      }),
    );

    return (result.Items ?? []).map((item) => ({
      userId: item.userId as string,
      platform: item.platform as Platform,
      platformUserId: item.platformUserId as string,
      linkedAt: item.linkedAt as string,
      consentGrantedAt: item.consentGrantedAt as string,
      consentRevokedAt: item.consentRevokedAt as string | undefined,
      status: item.status as 'active' | 'revoked',
    }));
  }

  // -------------------------------------------------------------------------
  // hasConsent
  // -------------------------------------------------------------------------

  async hasConsent(
    userId: string,
    platform: Platform,
    platformUserId: string,
  ): Promise<boolean> {
    const link = await this._getLink(userId, platform, platformUserId);
    const allowed = link?.status === 'active';

    // Only audit denied checks — active consent is already recorded by the
    // link_created event. This avoids excessive DynamoDB writes in hot paths.
    if (!allowed) {
      const now = new Date().toISOString();
      await this.auditLog({
        action: 'consent_checked',
        userId,
        platform,
        platformUserId,
        occurredAt: now,
        reason: 'no_active_link',
      });
    }

    return allowed;
  }

  // -------------------------------------------------------------------------
  // auditLog
  // -------------------------------------------------------------------------

  async auditLog(event: IdentityLinkAuditEvent): Promise<void> {
    // Structured event — no PII included (only IDs and decisions).
    await this.docClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: 'AUDIT',
          sk: auditSk(event.occurredAt, event.userId, event.action),
          action: event.action,
          userId: event.userId,
          ...(event.platform !== undefined ? { platform: event.platform } : {}),
          ...(event.platformUserId !== undefined
            ? { platformUserId: event.platformUserId }
            : {}),
          occurredAt: event.occurredAt,
          ...(event.reason !== undefined ? { reason: event.reason } : {}),
          // Retain audit events for 365 days
          ttl: ttlSeconds(365),
        },
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async _getLink(
    userId: string,
    platform: Platform,
    platformUserId: string,
  ): Promise<IdentityLink | null> {
    const result = await this.docClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          pk: linkPk(userId),
          sk: linkSk(platform, platformUserId),
        },
      }),
    );

    if (!result.Item) return null;

    return {
      userId: result.Item.userId as string,
      platform: result.Item.platform as Platform,
      platformUserId: result.Item.platformUserId as string,
      linkedAt: result.Item.linkedAt as string,
      consentGrantedAt: result.Item.consentGrantedAt as string,
      consentRevokedAt: result.Item.consentRevokedAt as string | undefined,
      status: result.Item.status as 'active' | 'revoked',
    };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an IdentityLinkService backed by DynamoDB.
 *
 * @param tableName - DynamoDB table (same table used by the rest of the platform)
 * @param docClient - Optional pre-built document client (useful for testing)
 */
export function createIdentityLinkService(
  tableName: string,
  docClient?: DynamoDBDocumentClient,
): IdentityLinkService {
  return new IdentityLinkServiceImpl(tableName, docClient);
}
