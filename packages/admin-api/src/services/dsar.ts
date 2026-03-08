/**
 * DSAR (Data Subject Access Request) Service
 *
 * Implements data discovery, export, and erasure workflows for GDPR/privacy
 * compliance against the LIVE account schema. All personal data classes in
 * DynamoDB are covered:
 *
 *   Data class             | Partition key pattern           | How we find it
 *   -----------------------|---------------------------------|-----------------------------
 *   Account profile        | ACCOUNT#<accountId> / PROFILE   | Direct get by accountId
 *   Linked identities      | ACCOUNT#<accountId> / IDENTITY# | Query sk prefix on account
 *   Identity reverse-index | IDENTITY#<type>#<id> / ACCOUNT  | Get per identity from above
 *   Admin chat history     | CHAT#<email> / AVATAR#<id>|GLOBAL | Query by email (from account)
 *   Avatar memories        | MEMORY#<avatarId> / *           | Scan with userId filter
 *   Audit log              | AUDIT#<avatarId> / EVENT#       | Query (retained, not deleted)
 *   Auto-issues            | ISSUE#<issueId> / META          | Scan with avatarId filter
 *
 * Sessions (SESSION#<token> / DATA) cannot be efficiently queried by accountId
 * without a GSI. The service documents this limitation and skips session
 * enumeration. Sessions have a 24-hour TTL and self-expire.
 *
 * Retention exceptions (lawful basis):
 *   - Audit events: retained for compliance evidence (365-day TTL, immutable)
 *   - Consent records: retained to prove lawful processing basis
 *   - The erasure request itself: recorded as an audit event (immutable)
 */
import {
  type DynamoDBDocumentClient,
  GetCommand,
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
  identifierUsed: string;
}

export interface DSARInventory {
  accountId: string;
  generatedAt: string;
  dataClasses: DSARInventoryItem[];
  totalRecords: number;
}

export interface DSARExport {
  exportedAt: string;
  accountId: string;
  dataClasses: {
    accountProfile: Record<string, unknown> | null;
    linkedIdentities: Record<string, unknown>[];
    chatHistory: Record<string, unknown>[];
    auditLog: AuditEvent[];
    memories: Record<string, unknown>[];
    issues: Record<string, unknown>[];
  };
  retentionExceptions: Array<{ dataClass: string; reason: string }>;
}

export interface DSARErasureResult {
  accountId: string;
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
// Internal helpers — live schema key patterns
// ============================================================================

/**
 * Get the account profile record: pk=ACCOUNT#<accountId>, sk=PROFILE
 */
async function queryAccountProfile(
  deps: DSARDeps,
  accountId: string,
): Promise<Record<string, unknown> | null> {
  const result = await deps.dynamoClient.send(
    new GetCommand({
      TableName: deps.tableName,
      Key: { pk: `ACCOUNT#${accountId}`, sk: 'PROFILE' },
    }),
  );
  return (result.Item as Record<string, unknown>) ?? null;
}

/**
 * Get all identity records under an account: pk=ACCOUNT#<accountId>, sk begins_with IDENTITY#
 * Returns records like { pk, sk: IDENTITY#wallet#<addr>, identityType, providerId, createdAt }
 */
async function queryAccountIdentities(
  deps: DSARDeps,
  accountId: string,
): Promise<Record<string, unknown>[]> {
  const result = await deps.dynamoClient.send(
    new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': `ACCOUNT#${accountId}`,
        ':prefix': 'IDENTITY#',
      },
    }),
  );
  return (result.Items || []) as Record<string, unknown>[];
}

/**
 * Get the reverse identity-mapping record: pk=IDENTITY#<type>#<providerId>, sk=ACCOUNT
 */
async function queryIdentityMapping(
  deps: DSARDeps,
  identityType: string,
  providerId: string,
): Promise<Record<string, unknown> | null> {
  const result = await deps.dynamoClient.send(
    new GetCommand({
      TableName: deps.tableName,
      Key: { pk: `IDENTITY#${identityType}#${providerId}`, sk: 'ACCOUNT' },
    }),
  );
  return (result.Item as Record<string, unknown>) ?? null;
}

/**
 * Query all chat history records for a user by email.
 * Chat records use pk=CHAT#<email>, sk=AVATAR#<id>|GLOBAL
 */
async function queryChatHistory(
  deps: DSARDeps,
  email: string,
): Promise<Record<string, unknown>[]> {
  const result = await deps.dynamoClient.send(
    new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: {
        ':pk': `CHAT#${email}`,
      },
    }),
  );
  return (result.Items || []) as Record<string, unknown>[];
}

/**
 * Query avatar memories that reference this userId.
 * Memories are keyed by MEMORY#<avatarId>, so we scan with a filter.
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
 * Issues are keyed by ISSUE#<issueId>, so we scan with a filter.
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

/**
 * Derive the chat-history lookup key (email) from the account profile.
 * The admin chat history is keyed by CHAT#<email>, where email comes from
 * the account profile or falls back to a wallet address used as the email field.
 */
function deriveEmailFromProfile(profile: Record<string, unknown> | null, walletAddress?: string): string | null {
  if (profile?.email && typeof profile.email === 'string') {
    return profile.email;
  }
  if (walletAddress) {
    return walletAddress;
  }
  return null;
}

/**
 * Find the primary wallet address from identity records.
 */
function findWalletAddress(identities: Record<string, unknown>[]): string | undefined {
  const walletIdentity = identities.find(
    (id) => id.identityType === 'wallet' && typeof id.providerId === 'string',
  );
  return walletIdentity?.providerId as string | undefined;
}

// ============================================================================
// Core functions (accept explicit deps)
// ============================================================================

/**
 * Discover all personal data classes and approximate record counts for an account.
 */
export async function discoverUserDataWith(
  deps: DSARDeps,
  accountId: string,
): Promise<DSARInventory> {
  // Step 1: Get account profile and identities
  const [profile, identities] = await Promise.all([
    queryAccountProfile(deps, accountId),
    queryAccountIdentities(deps, accountId),
  ]);

  const walletAddress = findWalletAddress(identities);
  const email = deriveEmailFromProfile(profile, walletAddress);

  // Step 2: Get identity reverse-mapping records
  const identityMappings = await Promise.all(
    identities.map((id) =>
      queryIdentityMapping(
        deps,
        id.identityType as string,
        id.providerId as string,
      ),
    ),
  );
  const validMappings = identityMappings.filter(Boolean);

  // Step 3: Query data classes that need email or userId
  const auditDeps: AuditLogDeps = {
    dynamoClient: deps.dynamoClient as DynamoDBDocumentClient,
    tableName: deps.tableName,
  };

  // Use walletAddress as the userId for memories/issues (matches how authenticateRequest sets userId)
  const userId = walletAddress || accountId;

  const [chatRecords, memories, auditEvents, issues] = await Promise.all([
    email ? queryChatHistory(deps, email) : Promise.resolve([]),
    queryMemoriesForUser(deps, userId),
    listAuditEventsWith(auditDeps, userId, { limit: 500 }),
    queryIssuesForUser(deps, userId),
  ]);

  const dataClasses: DSARInventoryItem[] = [
    {
      dataClass: 'accountProfile',
      description: 'Account profile record (role, display name, last seen)',
      approximateCount: profile ? 1 : 0,
      retentionPolicy: 'Until account deletion',
      identifierUsed: `ACCOUNT#${accountId}`,
    },
    {
      dataClass: 'linkedIdentities',
      description: 'Linked authentication identities (wallet, privy) and their reverse-index records',
      approximateCount: identities.length + validMappings.length,
      retentionPolicy: 'Until revoked or account deletion',
      identifierUsed: `ACCOUNT#${accountId} / IDENTITY#*`,
    },
    {
      dataClass: 'chatHistory',
      description: 'Admin chat conversation history',
      approximateCount: chatRecords.length,
      retentionPolicy: '24 hours (TTL)',
      identifierUsed: email ? `CHAT#${email}` : 'N/A (no email on file)',
    },
    {
      dataClass: 'auditLog',
      description: 'Audit events for avatar state transitions',
      approximateCount: auditEvents.length,
      retentionPolicy: '365 days (compliance retention — lawful basis)',
      identifierUsed: `AUDIT#${userId}`,
    },
    {
      dataClass: 'memories',
      description: 'Avatar memories associated with user',
      approximateCount: memories.length,
      retentionPolicy: '30 days (default TTL)',
      identifierUsed: `userId=${userId} (scan filter)`,
    },
    {
      dataClass: 'issues',
      description: 'Error reports and auto-issues associated with user',
      approximateCount: issues.length,
      retentionPolicy: '30 days (TTL)',
      identifierUsed: `avatarId=${userId} (scan filter)`,
    },
  ];

  const totalRecords = dataClasses.reduce((sum, dc) => sum + dc.approximateCount, 0);

  return {
    accountId,
    generatedAt: new Date().toISOString(),
    dataClasses,
    totalRecords,
  };
}

/**
 * Export all personal data for an account in structured JSON format.
 */
export async function exportUserDataWith(
  deps: DSARDeps,
  accountId: string,
): Promise<DSARExport> {
  // Step 1: Get account profile and identities
  const [profile, identities] = await Promise.all([
    queryAccountProfile(deps, accountId),
    queryAccountIdentities(deps, accountId),
  ]);

  const walletAddress = findWalletAddress(identities);
  const email = deriveEmailFromProfile(profile, walletAddress);
  const userId = walletAddress || accountId;

  // Step 2: Get identity reverse-mapping records
  const identityMappings = await Promise.all(
    identities.map((id) =>
      queryIdentityMapping(
        deps,
        id.identityType as string,
        id.providerId as string,
      ),
    ),
  );

  // Step 3: Query remaining data classes
  const auditDeps: AuditLogDeps = {
    dynamoClient: deps.dynamoClient as DynamoDBDocumentClient,
    tableName: deps.tableName,
  };

  const [chatRecords, memories, auditEvents, issues] = await Promise.all([
    email ? queryChatHistory(deps, email) : Promise.resolve([]),
    queryMemoriesForUser(deps, userId),
    listAuditEventsWith(auditDeps, userId, { limit: 500 }),
    queryIssuesForUser(deps, userId),
  ]);

  // Combine identity records: account-side + reverse-mapping
  const allIdentityRecords = [
    ...identities,
    ...identityMappings.filter(Boolean) as Record<string, unknown>[],
  ];

  return {
    exportedAt: new Date().toISOString(),
    accountId,
    dataClasses: {
      accountProfile: profile,
      linkedIdentities: allIdentityRecords,
      chatHistory: chatRecords,
      auditLog: auditEvents,
      memories,
      issues,
    },
    retentionExceptions: [
      {
        dataClass: 'auditLog',
        reason:
          'Audit events are retained for compliance purposes (365-day TTL). ' +
          'They contain only metadata about state transitions (actorId, eventType), not message content.',
      },
      {
        dataClass: 'consentRecords',
        reason:
          'Consent records (if present within identity link metadata) are retained to ' +
          'prove the lawful basis for prior data processing per GDPR Art. 7(1).',
      },
    ],
  };
}

/**
 * Erase all personal data for an account across all stores.
 *
 * In dry-run mode, returns what would be deleted without performing deletions.
 */
export async function eraseUserDataWith(
  deps: DSARDeps,
  accountId: string,
  options: { dryRun?: boolean } = {},
): Promise<DSARErasureResult> {
  const dryRun = options.dryRun ?? false;

  // Step 1: Get account profile and identities
  const [profile, identities] = await Promise.all([
    queryAccountProfile(deps, accountId),
    queryAccountIdentities(deps, accountId),
  ]);

  const walletAddress = findWalletAddress(identities);
  const email = deriveEmailFromProfile(profile, walletAddress);
  const userId = walletAddress || accountId;

  // Step 2: Get identity reverse-mapping records
  const identityMappings = await Promise.all(
    identities.map((id) =>
      queryIdentityMapping(
        deps,
        id.identityType as string,
        id.providerId as string,
      ),
    ),
  );
  const validMappings = identityMappings.filter(Boolean) as Record<string, unknown>[];

  // Step 3: Query deletable data
  const auditDeps: AuditLogDeps = {
    dynamoClient: deps.dynamoClient as DynamoDBDocumentClient,
    tableName: deps.tableName,
  };

  const [chatRecords, memories, auditEvents, issues] = await Promise.all([
    email ? queryChatHistory(deps, email) : Promise.resolve([]),
    queryMemoriesForUser(deps, userId),
    listAuditEventsWith(auditDeps, userId, { limit: 500 }),
    queryIssuesForUser(deps, userId),
  ]);

  const deleted: Array<{ dataClass: string; count: number }> = [];
  const retained: Array<{ dataClass: string; count: number; reason: string }> = [];

  // 1. Delete account profile
  if (profile) {
    if (!dryRun) {
      await deps.dynamoClient.send(
        new DeleteCommand({
          TableName: deps.tableName,
          Key: { pk: profile.pk as string, sk: profile.sk as string },
        }),
      );
    }
    deleted.push({ dataClass: 'accountProfile', count: 1 });
  }

  // 2. Delete identity records (account-side)
  if (!dryRun) {
    for (const identity of identities) {
      await deps.dynamoClient.send(
        new DeleteCommand({
          TableName: deps.tableName,
          Key: { pk: identity.pk as string, sk: identity.sk as string },
        }),
      );
    }
  }

  // 3. Delete identity reverse-mapping records
  if (!dryRun) {
    for (const mapping of validMappings) {
      await deps.dynamoClient.send(
        new DeleteCommand({
          TableName: deps.tableName,
          Key: { pk: mapping.pk as string, sk: mapping.sk as string },
        }),
      );
    }
  }
  const totalIdentityRecords = identities.length + validMappings.length;
  if (totalIdentityRecords > 0) {
    deleted.push({ dataClass: 'linkedIdentities', count: totalIdentityRecords });
  }

  // 4. Delete chat history
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

  // 5. Delete memories
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

  // 6. Delete issues
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

  // 7. Audit events are RETAINED (compliance exception — lawful basis)
  if (auditEvents.length > 0) {
    retained.push({
      dataClass: 'auditLog',
      count: auditEvents.length,
      reason: 'Retained for compliance. Audit events contain only metadata (actorId, eventType), no message content.',
    });
  }

  // 8. Record the erasure request as an audit event (immutable)
  if (!dryRun) {
    await recordAuditEventWith(auditDeps, {
      avatarId: userId,
      eventType: 'avatar_deleted',
      actorId: accountId,
      actorType: 'owner',
      details: {
        action: 'dsar_erasure',
        accountId,
        accountProfileDeleted: profile ? 1 : 0,
        identityRecordsDeleted: totalIdentityRecords,
        chatHistoryDeleted: chatRecords.length,
        memoriesDeleted: memories.length,
        issuesDeleted: issues.length,
        auditEventsRetained: auditEvents.length,
      },
    });
  }

  const totalDeleted = deleted.reduce((sum, d) => sum + d.count, 0);
  const totalRetained = retained.reduce((sum, r) => sum + r.count, 0);

  return {
    accountId,
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

export async function discoverUserData(accountId: string): Promise<DSARInventory> {
  return discoverUserDataWith(getDefaultDeps(), accountId);
}

export async function exportUserData(accountId: string): Promise<DSARExport> {
  return exportUserDataWith(getDefaultDeps(), accountId);
}

export async function eraseUserData(
  accountId: string,
  options?: { dryRun?: boolean },
): Promise<DSARErasureResult> {
  return eraseUserDataWith(getDefaultDeps(), accountId, options);
}
