/**
 * Tests for DSAR (Data Subject Access Request) service.
 *
 * Uses the dependency-injection variants with an in-memory DynamoDB mock
 * to verify discovery, export, erasure, and dry-run behavior.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  discoverUserDataWith,
  exportUserDataWith,
  eraseUserDataWith,
  type DSARDeps,
} from './dsar.js';

// ── In-memory DynamoDB mock ─────────────────────────────────────────────────

type DynamoItem = Record<string, unknown>;

let storedItems: DynamoItem[] = [];
let deletedKeys: Array<{ pk: string; sk: string }> = [];

function makeMockDeps(): DSARDeps {
  const send = async (cmd: unknown) => {
    const command = cmd as { input?: Record<string, unknown>; constructor?: { name?: string } };
    const name = command?.constructor?.name;

    if (name === 'QueryCommand') {
      const input = command.input as {
        KeyConditionExpression?: string;
        ExpressionAttributeValues?: Record<string, string>;
      };

      const pk = input.ExpressionAttributeValues?.[':pk'] as string;

      // Filter items by pk
      let items = storedItems.filter((item) => item.pk === pk);

      // If there's a begins_with on sk, filter further
      const skPrefix = input.ExpressionAttributeValues?.[':prefix'] as string | undefined;
      const skPrefixAlt = input.ExpressionAttributeValues?.[':skPrefix'] as string | undefined;
      if (skPrefix) {
        items = items.filter((item) =>
          typeof item.sk === 'string' && item.sk.startsWith(skPrefix),
        );
      } else if (skPrefixAlt) {
        items = items.filter((item) =>
          typeof item.sk === 'string' && item.sk >= skPrefixAlt,
        );
      }

      return { Items: items };
    }

    if (name === 'ScanCommand') {
      const input = command.input as {
        FilterExpression?: string;
        ExpressionAttributeValues?: Record<string, string>;
      };

      const memPrefix = input.ExpressionAttributeValues?.[':memPrefix'] as string | undefined;
      const userId = input.ExpressionAttributeValues?.[':userId'] as string | undefined;
      const issuePrefix = input.ExpressionAttributeValues?.[':issuePrefix'] as string | undefined;
      const meta = input.ExpressionAttributeValues?.[':meta'] as string | undefined;

      let items = storedItems;

      if (memPrefix && userId) {
        items = items.filter(
          (item) =>
            typeof item.pk === 'string' &&
            item.pk.startsWith(memPrefix) &&
            item.userId === userId,
        );
      } else if (issuePrefix && meta) {
        items = items.filter(
          (item) =>
            typeof item.pk === 'string' &&
            item.pk.startsWith(issuePrefix) &&
            item.sk === meta &&
            item.avatarId === userId,
        );
      }

      return { Items: items };
    }

    if (name === 'DeleteCommand') {
      const input = command.input as { Key: { pk: string; sk: string } };
      deletedKeys.push(input.Key);
      // Remove from stored items
      storedItems = storedItems.filter(
        (item) => !(item.pk === input.Key.pk && item.sk === input.Key.sk),
      );
      return {};
    }

    if (name === 'PutCommand') {
      const item = (command.input as { Item: DynamoItem }).Item;
      storedItems.push(item);
      return {};
    }

    return {};
  };

  return {
    dynamoClient: { send } as unknown as DSARDeps['dynamoClient'],
    tableName: 'test-admin',
  };
}

// ── Test data ───────────────────────────────────────────────────────────────

function seedTestData(userId: string): void {
  // Chat history records
  storedItems.push({
    pk: `CHAT#${userId}`,
    sk: 'GLOBAL',
    messages: [{ role: 'user', content: 'hello' }],
    updatedAt: Date.now(),
  });
  storedItems.push({
    pk: `CHAT#${userId}`,
    sk: 'AVATAR#avatar-1',
    messages: [
      { role: 'user', content: 'hi avatar' },
      { role: 'assistant', content: 'hello!' },
    ],
    updatedAt: Date.now(),
  });

  // Identity links
  storedItems.push({
    pk: `USER#${userId}`,
    sk: 'IDENTITY_LINK#telegram#12345',
    userId,
    platform: 'telegram',
    platformUserId: '12345',
    linkedAt: '2026-01-01T00:00:00Z',
    consentGrantedAt: '2026-01-01T00:00:00Z',
    status: 'active',
  });

  // Memories
  storedItems.push({
    pk: 'MEMORY#avatar-1',
    sk: `immediate#${Date.now()}#mem-1`,
    id: 'mem-1',
    avatarId: 'avatar-1',
    userId,
    content: 'User likes cats',
    about: 'preferences',
    tier: 'immediate',
    createdAt: Date.now(),
  });

  // Issues
  storedItems.push({
    pk: 'ISSUE#issue-abc',
    sk: 'META',
    issueId: 'issue-abc',
    avatarId: userId,
    title: 'Test error',
    status: 'open',
    severity: 'low',
    firstSeenAt: Date.now(),
    lastSeenAt: Date.now(),
    occurrenceCount: 1,
  });

  // Audit events (keyed by AUDIT#{avatarId})
  storedItems.push({
    pk: `AUDIT#${userId}`,
    sk: `EVENT#${Date.now()}#audit-1`,
    id: 'audit-1',
    avatarId: userId,
    eventType: 'activated',
    actorId: userId,
    actorType: 'owner',
    details: {},
    timestamp: Date.now(),
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  storedItems = [];
  deletedKeys = [];
});

describe('discoverUserDataWith', () => {
  it('returns inventory of all data classes with counts', async () => {
    const deps = makeMockDeps();
    const userId = 'test-user-1';
    seedTestData(userId);

    const inventory = await discoverUserDataWith(deps, userId);

    expect(inventory.userId).toBe(userId);
    expect(inventory.generatedAt).toBeTruthy();
    expect(inventory.dataClasses).toHaveLength(5);

    const chat = inventory.dataClasses.find((dc) => dc.dataClass === 'chatHistory');
    expect(chat?.approximateCount).toBe(2);

    const links = inventory.dataClasses.find((dc) => dc.dataClass === 'identityLinks');
    expect(links?.approximateCount).toBe(1);

    const memories = inventory.dataClasses.find((dc) => dc.dataClass === 'memories');
    expect(memories?.approximateCount).toBe(1);

    const issues = inventory.dataClasses.find((dc) => dc.dataClass === 'issues');
    expect(issues?.approximateCount).toBe(1);

    const audit = inventory.dataClasses.find((dc) => dc.dataClass === 'auditLog');
    expect(audit?.approximateCount).toBe(1);

    expect(inventory.totalRecords).toBe(6);
  });

  it('returns zero counts for user with no data', async () => {
    const deps = makeMockDeps();
    const inventory = await discoverUserDataWith(deps, 'nonexistent-user');

    expect(inventory.totalRecords).toBe(0);
    for (const dc of inventory.dataClasses) {
      expect(dc.approximateCount).toBe(0);
    }
  });
});

describe('exportUserDataWith', () => {
  it('returns structured export with all data classes', async () => {
    const deps = makeMockDeps();
    const userId = 'test-user-2';
    seedTestData(userId);

    const exportData = await exportUserDataWith(deps, userId);

    expect(exportData.exportedAt).toBeTruthy();
    expect(exportData.userId).toBe(userId);
    expect(exportData.dataClasses.chatHistory).toHaveLength(2);
    expect(exportData.dataClasses.identityLinks).toHaveLength(1);
    expect(exportData.dataClasses.memories).toHaveLength(1);
    expect(exportData.dataClasses.issues).toHaveLength(1);
    expect(exportData.dataClasses.auditLog).toHaveLength(1);

    // Verify retention exceptions are documented
    expect(exportData.retentionExceptions).toHaveLength(1);
    expect(exportData.retentionExceptions[0].dataClass).toBe('auditLog');
  });

  it('returns empty export for user with no data', async () => {
    const deps = makeMockDeps();
    const exportData = await exportUserDataWith(deps, 'no-data-user');

    expect(exportData.dataClasses.chatHistory).toHaveLength(0);
    expect(exportData.dataClasses.identityLinks).toHaveLength(0);
    expect(exportData.dataClasses.memories).toHaveLength(0);
    expect(exportData.dataClasses.issues).toHaveLength(0);
    expect(exportData.dataClasses.auditLog).toHaveLength(0);
  });
});

describe('eraseUserDataWith', () => {
  it('deletes user data across all deletable stores', async () => {
    const deps = makeMockDeps();
    const userId = 'test-user-3';
    seedTestData(userId);

    const result = await eraseUserDataWith(deps, userId);

    expect(result.userId).toBe(userId);
    expect(result.dryRun).toBe(false);
    expect(result.erasedAt).toBeTruthy();

    // Should have deleted chat, links, memories, issues
    const chatDeleted = result.deleted.find((d) => d.dataClass === 'chatHistory');
    expect(chatDeleted?.count).toBe(2);

    const linksDeleted = result.deleted.find((d) => d.dataClass === 'identityLinks');
    expect(linksDeleted?.count).toBe(1);

    const memoriesDeleted = result.deleted.find((d) => d.dataClass === 'memories');
    expect(memoriesDeleted?.count).toBe(1);

    const issuesDeleted = result.deleted.find((d) => d.dataClass === 'issues');
    expect(issuesDeleted?.count).toBe(1);

    // Audit events should be retained
    const auditRetained = result.retained.find((r) => r.dataClass === 'auditLog');
    expect(auditRetained?.count).toBe(1);
    expect(auditRetained?.reason).toContain('compliance');

    expect(result.totalDeleted).toBe(5);
    expect(result.totalRetained).toBe(1);

    // Verify delete commands were issued (5 data items + 1 audit event put for recording erasure)
    expect(deletedKeys.length).toBe(5);
  });

  it('records the erasure as an audit event', async () => {
    const deps = makeMockDeps();
    const userId = 'test-user-4';
    seedTestData(userId);

    await eraseUserDataWith(deps, userId);

    // An audit event should have been recorded (PutCommand)
    const auditItems = storedItems.filter(
      (item) =>
        typeof item.pk === 'string' &&
        item.pk.startsWith('AUDIT#') &&
        typeof item.details === 'object' &&
        item.details !== null &&
        (item.details as Record<string, unknown>).action === 'dsar_erasure',
    );
    expect(auditItems.length).toBe(1);
  });

  it('dry-run mode does not delete any data', async () => {
    const deps = makeMockDeps();
    const userId = 'test-user-5';
    seedTestData(userId);

    const initialItemCount = storedItems.length;

    const result = await eraseUserDataWith(deps, userId, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.totalDeleted).toBe(5); // Reports what WOULD be deleted
    expect(deletedKeys.length).toBe(0); // But no actual deletes happened
    expect(storedItems.length).toBe(initialItemCount); // Items still there
  });

  it('handles user with no data gracefully', async () => {
    const deps = makeMockDeps();
    const result = await eraseUserDataWith(deps, 'empty-user');

    expect(result.totalDeleted).toBe(0);
    expect(result.totalRetained).toBe(0);
    expect(result.deleted).toHaveLength(0);
    expect(result.retained).toHaveLength(0);
    expect(deletedKeys.length).toBe(0);
  });
});
