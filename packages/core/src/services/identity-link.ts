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
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { Platform } from '../types/platform.js';
import type {
  ConsentRevocationResult,
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

    // Determine whether this is a fresh link or a re-grant after revocation.
    // Re-grants start fresh — previously purged data is NOT recovered.
    const isRegrant = existing?.status === 'revoked';

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
      action: isRegrant ? 'link_regrant' : 'link_created',
      userId,
      platform,
      platformUserId,
      occurredAt: now,
      reason: isRegrant
        ? 'consent_regranted_after_revocation — fresh_start — previously_purged_data_not_recovered'
        : undefined,
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
  // revokeAndPurge
  // -------------------------------------------------------------------------

  async revokeAndPurge(
    userId: string,
    platform: Platform,
    platformUserId: string,
  ): Promise<ConsentRevocationResult> {
    const now = new Date().toISOString();

    // Step 1: Revoke the identity link (forward block)
    const revokedLink = await this.revokeLink(userId, platform, platformUserId);

    // Step 2: Log purge initiation
    await this.auditLog({
      action: 'purge_started',
      userId,
      platform,
      platformUserId,
      occurredAt: now,
    });

    // Step 3: Find and purge cross-platform memories tagged with source platform.
    // Memories are stored under MEMORY#<avatarId> with a `sourcePlatform` attribute
    // when created via cross-platform merge. We scan for memories belonging to this
    // user that were sourced from the revoked platform.
    const memoriesPurged = await this._purgeCrossPlatformMemories(
      userId,
      platform,
    );

    // Step 4: Document retention exceptions for stores where retroactive purge
    // is not technically feasible.
    const retentionExceptions = [
      {
        store: 'audit_log',
        reason:
          'Audit events are append-only and immutable. They contain only metadata ' +
          '(actorId, eventType, timestamps) — no message content or user PII.',
        lawfulBasis: 'GDPR Art. 17(3)(e) — establishment, exercise, or defence of legal claims',
      },
      {
        store: 'channel_state_buffers',
        reason:
          'Channel state buffers contain truncated message snippets (max 200 chars) ' +
          'used for response evaluation. These have a 90-day TTL and self-expire. ' +
          'Messages are not individually attributable to cross-platform sources.',
        lawfulBasis: 'GDPR Art. 17(3)(e) — legitimate interest in service operation; self-expiring with TTL',
      },
      {
        store: 'cloudwatch_logs',
        reason:
          'Structured log events may reference userId/platform combinations. ' +
          'CloudWatch Logs are retained per log-group retention policy and cannot ' +
          'be selectively purged by user.',
        lawfulBasis: 'GDPR Art. 17(3)(e) — security and incident investigation; time-limited retention',
      },
    ];

    // Log each retention exception
    for (const exception of retentionExceptions) {
      await this.auditLog({
        action: 'purge_limitation_documented',
        userId,
        platform,
        platformUserId,
        occurredAt: now,
        reason: `${exception.store}: ${exception.reason} (${exception.lawfulBasis})`,
      });
    }

    // Step 5: Log purge completion
    await this.auditLog({
      action: 'purge_completed',
      userId,
      platform,
      platformUserId,
      occurredAt: now,
      reason: `memories_purged=${memoriesPurged}`,
    });

    return {
      revokedLink,
      memoriesPurged,
      retentionExceptions,
      revokedAt: now,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Find and delete memories that were created via cross-platform merging
   * from the specified platform. Memories created through cross-platform
   * merge are tagged with `sourcePlatform` to enable selective purge.
   *
   * Memories without a `sourcePlatform` tag are presumed to be
   * single-platform and are not purged.
   */
  private async _purgeCrossPlatformMemories(
    userId: string,
    sourcePlatform: Platform,
  ): Promise<number> {
    let purged = 0;
    let exclusiveStartKey: Record<string, unknown> | undefined;
    let pagesScanned = 0;
    const maxPages = 20;

    while (pagesScanned < maxPages) {
      const result = await this.docClient.send(
        new ScanCommand({
          TableName: this.tableName,
          FilterExpression:
            'begins_with(pk, :memPrefix) AND userId = :userId AND sourcePlatform = :sourcePlatform',
          ExpressionAttributeValues: {
            ':memPrefix': 'MEMORY#',
            ':userId': userId,
            ':sourcePlatform': sourcePlatform,
          },
          Limit: 100,
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );

      const items = result.Items ?? [];
      for (const item of items) {
        await this.docClient.send(
          new DeleteCommand({
            TableName: this.tableName,
            Key: { pk: item.pk as string, sk: item.sk as string },
          }),
        );
        purged++;
      }

      pagesScanned++;
      exclusiveStartKey = result.LastEvaluatedKey as
        | Record<string, unknown>
        | undefined;
      if (!exclusiveStartKey) break;
    }

    return purged;
  }

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
