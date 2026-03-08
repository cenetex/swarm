/**
 * DSAR (Data Subject Access Request) Service
 *
 * Implements data discovery, export, and erasure workflows for GDPR/privacy
 * compliance. Covers all personal data classes stored in DynamoDB:
 *   - Chat history (CHAT# partition)
 *   - Audit log entries (AUDIT# partition)
 *   - Identity links (USER# partition, IDENTITY_LINK# sort key prefix)
 *   - Avatar memories (MEMORY# partition, filtered by userId)
 *   - Auto-issues (ISSUE# partition, filtered by avatarId context)
 *
 * Retention exceptions:
 *   - Audit events: retained for compliance (90-day TTL, not deleted)
 *   - Erasure request itself: recorded as an audit event (immutable)
 */
import {
  type DynamoDBDocumentClient,
  QueryCommand,
  DeleteCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { getDynamoClient } from './dynamo-client.js';
import {
  recordAuditEventWith,
  listAuditEventsWith,
  type AuditEvent,
  type AuditLogDeps,
} from './audit-log.js';

// ============================================================================
// Types
// ============================================================================

export interface DSARInventoryItem {
  dataClass: string;
  description: string;
  approximateCount: number;
  retentionPolicy: string;
}

export interface DSARInventory {
  userId: string;
  generatedAt: string;
  dataClasses: DSARInventoryItem[];
  totalRecords: number;
}

export interface DSARExport {
  exportedAt: string;
  userId: string;
  dataClasses: {
    chatHistory: Record<string, unknown>[][];
    auditLog: AuditEvent[];
    identityLinks: Record<string, unknown>[];
    memories: Record<string, unknown>[];
    issues: Record<string, unknown>[];
  };
  retentionExceptions: Array<{ dataClass: string; reason: string }>;
}

export interface DSARErasureResult {
  userId: string;
  erasedAt: string;
  dryRun: boolean;
  deleted: Array<{ dataClass: string; count: number }>;
  retained: Array<{ dataClass: string; count: number; reason: string }>;
  totalDeleted: number;
  totalRetained: number;
}

export interface DSARDeps {
  dynamoClient: Pick<DynamoDBDocumentClient, 'send'>;
  tableName: string;
}

// ============================================================================
// Default production deps (lazy-initialized)
// ============================================================================

let _defaultDeps: DSARDeps | null = null;

function getDefaultDeps(): DSARDeps {
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

/**
 * Query all chat history records for a user (CHAT#{email} partition).
 */
async function queryChatHistory(
  deps: DSARDeps,
  userId: string,
): Promise<Record<string, unknown>[]> {
  const result = await deps.dynamoClient.send(
    new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': `CHAT#${userId}`,
      },
    }),
  );
  return (result.Items || []) as Record<string, unknown>[];
}

/**
 * Query all identity links for a user (USER#{userId} partition, IDENTITY_LINK# prefix).
 */
async function queryIdentityLinks(
  deps: DSARDeps,
  userId: string,
): Promise<Record<string, unknown>[]> {
  const result = await deps.dynamoClient.send(
    new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': `USER#${userId}`,
        ':prefix': 'IDENTITY_LINK#',
      },
    }),
  );
  return (result.Items || []) as Record<string, unknown>[];
}

/**
 * Query avatar memories that reference this userId.
 * Memories are keyed by MEMORY#{avatarId}, so we scan with a filter.
 * In production this would ideally use a GSI on userId.
 */
async function queryMemoriesForUser(
  deps: DSARDeps,
  userId: string,
): Promise<Record<string, unknown>[]> {
  const collected: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  let pagesScanned = 0;
  const maxPages = 10;

  while (pagesScanned < maxPages) {
    const result = await deps.dynamoClient.send(
      new ScanCommand({
        TableName: deps.tableName,
        FilterExpression: 'begins_with(pk, :memPrefix) AND userId = :userId',
        ExpressionAttributeValues: {
          ':memPrefix': 'MEMORY#',
          ':userId': userId,
        },
        Limit: 100,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    collected.push(...((result.Items || []) as Record<string, unknown>[]));
    pagesScanned += 1;
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (!exclusiveStartKey) break;
  }

  return collected;
}

/**
 * Query auto-issues that reference this userId in metadata.
 * Issues are keyed by ISSUE#{issueId}, so we scan with a filter.
 */
async function queryIssuesForUser(
  deps: DSARDeps,
  userId: string,
): Promise<Record<string, unknown>[]> {
  const collected: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  let pagesScanned = 0;
  const maxPages = 5;

  while (pagesScanned < maxPages) {
    const result = await deps.dynamoClient.send(
      new ScanCommand({
        TableName: deps.tableName,
        FilterExpression: 'begins_with(pk, :issuePrefix) AND sk = :meta AND avatarId = :userId',
        ExpressionAttributeValues: {
          ':issuePrefix': 'ISSUE#',
          ':meta': 'META',
          ':userId': userId,
        },
        Limit: 100,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    collected.push(...((result.Items || []) as Record<string, unknown>[]));
    pagesScanned += 1;
    exclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
    if (!exclusiveStartKey) break;
  }

  return collected;
}

// ============================================================================
// Core functions (accept explicit deps)
// ============================================================================

/**
 * Discover all personal data classes and approximate record counts for a user.
 */
export async function discoverUserDataWith(
  deps: DSARDeps,
  userId: string,
): Promise<DSARInventory> {
  const auditDeps: AuditLogDeps = {
    dynamoClient: deps.dynamoClient as DynamoDBDocumentClient,
    tableName: deps.tableName,
  };

  const [chatRecords, identityLinks, memories, auditEvents, issues] =
    await Promise.all([
      queryChatHistory(deps, userId),
      queryIdentityLinks(deps, userId),
      queryMemoriesForUser(deps, userId),
      listAuditEventsWith(auditDeps, userId, { limit: 500 }),
      queryIssuesForUser(deps, userId),
    ]);

  const dataClasses: DSARInventoryItem[] = [
    {
      dataClass: 'chatHistory',
      description: 'Chat conversation history with admin chatbot',
      approximateCount: chatRecords.length,
      retentionPolicy: '24 hours (TTL)',
    },
    {
      dataClass: 'auditLog',
      description: 'Audit events for avatar state transitions',
      approximateCount: auditEvents.length,
      retentionPolicy: '90 days (compliance retention)',
    },
    {
      dataClass: 'identityLinks',
      description: 'Linked platform identities (Discord, Telegram, Twitter)',
      approximateCount: identityLinks.length,
      retentionPolicy: 'Until revoked or deleted',
    },
    {
      dataClass: 'memories',
      description: 'Avatar memories associated with user',
      approximateCount: memories.length,
      retentionPolicy: '30 days (default TTL)',
    },
    {
      dataClass: 'issues',
      description: 'Error reports and auto-issues associated with user',
      approximateCount: issues.length,
      retentionPolicy: '30 days (TTL)',
    },
  ];

  const totalRecords = dataClasses.reduce((sum, dc) => sum + dc.approximateCount, 0);

  return {
    userId,
    generatedAt: new Date().toISOString(),
    dataClasses,
    totalRecords,
  };
}

/**
 * Export all personal data for a user in structured JSON format.
 */
export async function exportUserDataWith(
  deps: DSARDeps,
  userId: string,
): Promise<DSARExport> {
  const auditDeps: AuditLogDeps = {
    dynamoClient: deps.dynamoClient as DynamoDBDocumentClient,
    tableName: deps.tableName,
  };

  const [chatRecords, identityLinks, memories, auditEvents, issues] =
    await Promise.all([
      queryChatHistory(deps, userId),
      queryIdentityLinks(deps, userId),
      queryMemoriesForUser(deps, userId),
      listAuditEventsWith(auditDeps, userId, { limit: 500 }),
      queryIssuesForUser(deps, userId),
    ]);

  // Group chat records by avatar (each record has an sk like AVATAR#{id} or GLOBAL)
  const chatByAvatar: Record<string, unknown>[][] = chatRecords.map((record) => {
    const messages = (record.messages as Record<string, unknown>[]) || [];
    return messages;
  });

  return {
    exportedAt: new Date().toISOString(),
    userId,
    dataClasses: {
      chatHistory: chatByAvatar,
      auditLog: auditEvents,
      identityLinks,
      memories,
      issues,
    },
    retentionExceptions: [
      {
        dataClass: 'auditLog',
        reason:
          'Audit events are retained for compliance purposes (90-day TTL). ' +
          'They do not contain message content, only metadata about state transitions.',
      },
    ],
  };
}

/**
 * Erase all personal data for a user across all stores.
 *
 * In dry-run mode, returns what would be deleted without performing deletions.
 */
export async function eraseUserDataWith(
  deps: DSARDeps,
  userId: string,
  options: { dryRun?: boolean } = {},
): Promise<DSARErasureResult> {
  const dryRun = options.dryRun ?? false;

  // Discover all data first
  const [chatRecords, identityLinks, memories, issues] = await Promise.all([
    queryChatHistory(deps, userId),
    queryIdentityLinks(deps, userId),
    queryMemoriesForUser(deps, userId),
    queryIssuesForUser(deps, userId),
  ]);

  // Count audit events (retained, not deleted)
  const auditDeps: AuditLogDeps = {
    dynamoClient: deps.dynamoClient as DynamoDBDocumentClient,
    tableName: deps.tableName,
  };
  const auditEvents = await listAuditEventsWith(auditDeps, userId, { limit: 500 });

  const deleted: Array<{ dataClass: string; count: number }> = [];
  const retained: Array<{ dataClass: string; count: number; reason: string }> = [];

  // 1. Delete chat history
  if (!dryRun) {
    for (const record of chatRecords) {
      await deps.dynamoClient.send(
        new DeleteCommand({
          TableName: deps.tableName,
          Key: { pk: record.pk as string, sk: record.sk as string },
        }),
      );
    }
  }
  if (chatRecords.length > 0) {
    deleted.push({ dataClass: 'chatHistory', count: chatRecords.length });
  }

  // 2. Delete identity links
  if (!dryRun) {
    for (const link of identityLinks) {
      await deps.dynamoClient.send(
        new DeleteCommand({
          TableName: deps.tableName,
          Key: { pk: link.pk as string, sk: link.sk as string },
        }),
      );
    }
  }
  if (identityLinks.length > 0) {
    deleted.push({ dataClass: 'identityLinks', count: identityLinks.length });
  }

  // 3. Delete memories
  if (!dryRun) {
    for (const memory of memories) {
      await deps.dynamoClient.send(
        new DeleteCommand({
          TableName: deps.tableName,
          Key: { pk: memory.pk as string, sk: memory.sk as string },
        }),
      );
    }
  }
  if (memories.length > 0) {
    deleted.push({ dataClass: 'memories', count: memories.length });
  }

  // 4. Delete issues
  if (!dryRun) {
    for (const issue of issues) {
      await deps.dynamoClient.send(
        new DeleteCommand({
          TableName: deps.tableName,
          Key: { pk: issue.pk as string, sk: issue.sk as string },
        }),
      );
    }
  }
  if (issues.length > 0) {
    deleted.push({ dataClass: 'issues', count: issues.length });
  }

  // 5. Audit events are RETAINED (compliance exception)
  if (auditEvents.length > 0) {
    retained.push({
      dataClass: 'auditLog',
      count: auditEvents.length,
      reason: 'Retained for compliance. Audit events contain only metadata, no message content.',
    });
  }

  // 6. Record the erasure request as an audit event
  if (!dryRun) {
    await recordAuditEventWith(auditDeps, {
      avatarId: userId,
      eventType: 'avatar_deleted',
      actorId: userId,
      actorType: 'owner',
      details: {
        action: 'dsar_erasure',
        chatHistoryDeleted: chatRecords.length,
        identityLinksDeleted: identityLinks.length,
        memoriesDeleted: memories.length,
        issuesDeleted: issues.length,
        auditEventsRetained: auditEvents.length,
      },
    });
  }

  const totalDeleted = deleted.reduce((sum, d) => sum + d.count, 0);
  const totalRetained = retained.reduce((sum, r) => sum + r.count, 0);

  return {
    userId,
    erasedAt: new Date().toISOString(),
    dryRun,
    deleted,
    retained,
    totalDeleted,
    totalRetained,
  };
}

// ============================================================================
// Public API (uses default production deps)
// ============================================================================

export async function discoverUserData(userId: string): Promise<DSARInventory> {
  return discoverUserDataWith(getDefaultDeps(), userId);
}

export async function exportUserData(userId: string): Promise<DSARExport> {
  return exportUserDataWith(getDefaultDeps(), userId);
}

export async function eraseUserData(
  userId: string,
  options?: { dryRun?: boolean },
): Promise<DSARErasureResult> {
  return eraseUserDataWith(getDefaultDeps(), userId, options);
}
