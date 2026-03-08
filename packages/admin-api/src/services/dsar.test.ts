/**
 * Tests for DSAR (Data Subject Access Request) service.
 *
 * Uses the dependency-injection variants with an in-memory DynamoDB mock
 * to verify discovery, export, erasure, and dry-run behavior against the
 * LIVE account schema (ACCOUNT#, IDENTITY#, CHAT#, MEMORY#, GALLERY#, MEDIAJOB#, etc.).
 */
import { describe, it, expect, beforeEach } from 'bun:test';
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
let deletedS3Keys: Array<{ Bucket: string; Key: string }> = [];

function makeMockS3Client() {
  const send = async (cmd: unknown) => {
    const command = cmd as { input?: Record<string, unknown>; constructor?: { name?: string } };
    const name = command?.constructor?.name;

    if (name === 'DeleteObjectCommand') {
      const input = command.input as { Bucket: string; Key: string };
      deletedS3Keys.push({ Bucket: input.Bucket, Key: input.Key });
      return {};
    }

    return {};
  };

  return { send } as unknown as DSARDeps['s3Client'];
}

function makeMockDeps(): DSARDeps {
  const send = async (cmd: unknown) => {
    const command = cmd as { input?: Record<string, unknown>; constructor?: { name?: string } };
    const name = command?.constructor?.name;

    if (name === 'GetCommand') {
      const input = command.input as { Key: { pk: string; sk: string } };
      const item = storedItems.find(
        (i) => i.pk === input.Key.pk && i.sk === input.Key.sk,
      );
      return { Item: item || undefined };
    }

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
      const skKey = input.ExpressionAttributeValues?.[':sk'] as string | undefined;
      if (skPrefix) {
        items = items.filter((item) =>
          typeof item.sk === 'string' && item.sk.startsWith(skPrefix),
        );
      } else if (skKey) {
        // begins_with(sk, :sk) pattern used by gallery queries
        items = items.filter((item) =>
          typeof item.sk === 'string' && item.sk.startsWith(skKey),
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
      const jobPrefix = input.ExpressionAttributeValues?.[':jobPrefix'] as string | undefined;
      const statusSk = input.ExpressionAttributeValues?.[':status'] as string | undefined;
      const avatarIdVal = input.ExpressionAttributeValues?.[':avatarId'] as string | undefined;
      const inhabitantPrefix = input.ExpressionAttributeValues?.[':prefix'] as string | undefined;
      const walletVal = input.ExpressionAttributeValues?.[':wallet'] as string | undefined;

      let items = storedItems;

      if (memPrefix && userId) {
        // Memory scan
        items = items.filter(
          (item) =>
            typeof item.pk === 'string' &&
            item.pk.startsWith(memPrefix) &&
            item.userId === userId,
        );
      } else if (issuePrefix && meta) {
        // Issue scan
        items = items.filter(
          (item) =>
            typeof item.pk === 'string' &&
            item.pk.startsWith(issuePrefix) &&
            item.sk === meta &&
            item.avatarId === userId,
        );
      } else if (jobPrefix && statusSk && avatarIdVal) {
        // Media job scan
        items = items.filter(
          (item) =>
            typeof item.pk === 'string' &&
            item.pk.startsWith(jobPrefix) &&
            item.sk === statusSk &&
            item.avatarId === avatarIdVal,
        );
      } else if (inhabitantPrefix && walletVal) {
        // Inhabitant scan (for finding avatars by wallet)
        items = items.filter(
          (item) =>
            typeof item.sk === 'string' &&
            item.sk.startsWith(inhabitantPrefix) &&
            item.walletAddress === walletVal,
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
    s3Client: makeMockS3Client(),
    mediaBucket: 'test-media-bucket',
  };
}

// ── Test data (live schema) ─────────────────────────────────────────────────

const TEST_ACCOUNT_ID = 'acc-uuid-001';
const TEST_WALLET = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const TEST_AVATAR_ID = 'avatar-1';

function seedTestData(accountId: string, walletAddress: string): void {
  // Account profile: pk=ACCOUNT#<accountId>, sk=PROFILE
  storedItems.push({
    pk: `ACCOUNT#${accountId}`,
    sk: 'PROFILE',
    accountId,
    role: 'user',
    createdAt: Date.now(),
    sessionCount: 3,
    lastSeenAt: Date.now(),
  });

  // Linked identity (account-side): pk=ACCOUNT#<accountId>, sk=IDENTITY#wallet#<addr>
  storedItems.push({
    pk: `ACCOUNT#${accountId}`,
    sk: `IDENTITY#wallet#${walletAddress}`,
    identityType: 'wallet',
    providerId: walletAddress,
    createdAt: Date.now(),
  });

  // Linked identity (account-side): privy
  storedItems.push({
    pk: `ACCOUNT#${accountId}`,
    sk: 'IDENTITY#privy#did:privy:abc123',
    identityType: 'privy',
    providerId: 'did:privy:abc123',
    createdAt: Date.now(),
  });

  // Identity reverse-mapping: pk=IDENTITY#wallet#<addr>, sk=ACCOUNT
  storedItems.push({
    pk: `IDENTITY#wallet#${walletAddress}`,
    sk: 'ACCOUNT',
    identityType: 'wallet',
    providerId: walletAddress,
    accountId,
    createdAt: Date.now(),
  });

  // Identity reverse-mapping: privy
  storedItems.push({
    pk: 'IDENTITY#privy#did:privy:abc123',
    sk: 'ACCOUNT',
    identityType: 'privy',
    providerId: 'did:privy:abc123',
    accountId,
    createdAt: Date.now(),
  });

  // Chat history: pk=CHAT#<email>, sk=GLOBAL or AVATAR#<id>
  storedItems.push({
    pk: `CHAT#${walletAddress}`,
    sk: 'GLOBAL',
    messages: [{ role: 'user', content: 'hello' }],
    updatedAt: Date.now(),
  });
  storedItems.push({
    pk: `CHAT#${walletAddress}`,
    sk: `AVATAR#${TEST_AVATAR_ID}`,
    messages: [
      { role: 'user', content: 'hi avatar' },
      { role: 'assistant', content: 'hello!' },
    ],
    updatedAt: Date.now(),
  });

  // Memories: pk=MEMORY#<avatarId>, userId=<walletAddress>
  storedItems.push({
    pk: `MEMORY#${TEST_AVATAR_ID}`,
    sk: `immediate#${Date.now()}#mem-1`,
    id: 'mem-1',
    avatarId: TEST_AVATAR_ID,
    userId: walletAddress,
    content: 'User likes cats',
    about: 'preferences',
    tier: 'immediate',
    createdAt: Date.now(),
  });

  // Issues: pk=ISSUE#<issueId>, sk=META, avatarId=<walletAddress>
  storedItems.push({
    pk: 'ISSUE#issue-abc',
    sk: 'META',
    issueId: 'issue-abc',
    avatarId: walletAddress,
    title: 'Test error',
    status: 'open',
    severity: 'low',
    firstSeenAt: Date.now(),
    lastSeenAt: Date.now(),
    occurrenceCount: 1,
  });

  // Audit events: pk=AUDIT#<walletAddress>, sk=EVENT#<ts>#<uuid>
  storedItems.push({
    pk: `AUDIT#${walletAddress}`,
    sk: `EVENT#${Date.now()}#audit-1`,
    id: 'audit-1',
    avatarId: walletAddress,
    eventType: 'activated',
    actorId: walletAddress,
    actorType: 'owner',
    details: {},
    timestamp: Date.now(),
  });

  // Wallet mapping: pk=WALLET#<wallet>, sk=INHABITS
  storedItems.push({
    pk: `WALLET#${walletAddress}`,
    sk: 'INHABITS',
    walletAddress,
    avatarId: TEST_AVATAR_ID,
    inhabitedAt: Date.now(),
  });

  // Inhabitant mapping: pk=AVATAR#<avatarId>, sk=INHABITANT#<wallet>
  storedItems.push({
    pk: `AVATAR#${TEST_AVATAR_ID}`,
    sk: `INHABITANT#${walletAddress}`,
    avatarId: TEST_AVATAR_ID,
    walletAddress,
    inhabitedAt: Date.now(),
  });
}

function seedMediaData(avatarId: string): void {
  const now = Date.now();

  // Gallery item 1: image with S3 key
  storedItems.push({
    pk: `AVATAR#${avatarId}`,
    sk: `GALLERY#${now}#img-001`,
    id: 'img-001',
    avatarId,
    type: 'image',
    url: 'https://cdn.example.com/avatars/avatar-1/images/img-001.png',
    s3Key: `avatars/${avatarId}/images/img-001.png`,
    prompt: 'A catboy sitting on a cloud',
    model: 'replicate-image',
    platform: 'telegram',
    createdAt: now,
    postedToTwitter: false,
    convertedToSticker: false,
  });

  // Gallery item 2: video with S3 key
  storedItems.push({
    pk: `AVATAR#${avatarId}`,
    sk: `GALLERY#${now + 1}#vid-001`,
    id: 'vid-001',
    avatarId,
    type: 'video',
    url: 'https://cdn.example.com/avatars/avatar-1/videos/vid-001.mp4',
    s3Key: `avatars/${avatarId}/videos/vid-001.mp4`,
    prompt: 'Dancing catboy animation',
    model: 'replicate-video',
    platform: 'twitter',
    createdAt: now + 1,
    postedToTwitter: true,
    convertedToSticker: false,
  });

  // Media job: completed with result S3 key
  storedItems.push({
    pk: 'MEDIAJOB#job-001',
    sk: 'STATUS',
    jobId: 'job-001',
    avatarId,
    type: 'image',
    status: 'completed',
    prompt: 'Profile picture',
    resultUrl: 'https://cdn.example.com/avatars/avatar-1/images/job-001.png',
    resultS3Key: `avatars/${avatarId}/images/job-001.png`,
    createdAt: now,
    updatedAt: now,
    completedAt: now,
    ttl: Math.floor(now / 1000) + 86400,
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  storedItems = [];
  deletedKeys = [];
  deletedS3Keys = [];
});

describe('discoverUserDataWith', () => {
  it('returns inventory of all data classes with counts', async () => {
    const deps = makeMockDeps();
    seedTestData(TEST_ACCOUNT_ID, TEST_WALLET);

    const inventory = await discoverUserDataWith(deps, TEST_ACCOUNT_ID);

    expect(inventory.accountId).toBe(TEST_ACCOUNT_ID);
    expect(inventory.generatedAt).toBeTruthy();
    expect(inventory.dataClasses).toHaveLength(8);

    const profile = inventory.dataClasses.find((dc) => dc.dataClass === 'accountProfile');
    expect(profile?.approximateCount).toBe(1);
    expect(profile?.identifierUsed).toBe(`ACCOUNT#${TEST_ACCOUNT_ID}`);

    const identities = inventory.dataClasses.find((dc) => dc.dataClass === 'linkedIdentities');
    // 2 account-side + 2 reverse-mapping = 4
    expect(identities?.approximateCount).toBe(4);

    const chat = inventory.dataClasses.find((dc) => dc.dataClass === 'chatHistory');
    expect(chat?.approximateCount).toBe(2);
    expect(chat?.identifierUsed).toBe(`CHAT#${TEST_WALLET}`);

    const memories = inventory.dataClasses.find((dc) => dc.dataClass === 'memories');
    expect(memories?.approximateCount).toBe(1);

    const issues = inventory.dataClasses.find((dc) => dc.dataClass === 'issues');
    expect(issues?.approximateCount).toBe(1);

    const audit = inventory.dataClasses.find((dc) => dc.dataClass === 'auditLog');
    expect(audit?.approximateCount).toBe(1);

    const media = inventory.dataClasses.find((dc) => dc.dataClass === 'mediaAssets');
    expect(media?.approximateCount).toBe(0); // No gallery items seeded yet

    const mediaJobs = inventory.dataClasses.find((dc) => dc.dataClass === 'mediaJobs');
    expect(mediaJobs?.approximateCount).toBe(0);

    // 1 profile + 4 identities + 2 chat + 1 memory + 1 issue + 1 audit + 0 media + 0 jobs = 10
    expect(inventory.totalRecords).toBe(10);
  });

  it('includes media asset counts in inventory', async () => {
    const deps = makeMockDeps();
    seedTestData(TEST_ACCOUNT_ID, TEST_WALLET);
    seedMediaData(TEST_AVATAR_ID);

    const inventory = await discoverUserDataWith(deps, TEST_ACCOUNT_ID);

    const media = inventory.dataClasses.find((dc) => dc.dataClass === 'mediaAssets');
    expect(media?.approximateCount).toBe(2); // 2 gallery items
    expect(media?.identifierUsed).toContain(`AVATAR#${TEST_AVATAR_ID}`);

    const mediaJobs = inventory.dataClasses.find((dc) => dc.dataClass === 'mediaJobs');
    expect(mediaJobs?.approximateCount).toBe(1); // 1 media job

    // 1 profile + 4 identities + 2 chat + 1 memory + 1 issue + 1 audit + 2 media + 1 job = 13
    expect(inventory.totalRecords).toBe(13);
  });

  it('returns zero counts for account with no data', async () => {
    const deps = makeMockDeps();
    const inventory = await discoverUserDataWith(deps, 'nonexistent-account');

    expect(inventory.totalRecords).toBe(0);
    for (const dc of inventory.dataClasses) {
      expect(dc.approximateCount).toBe(0);
    }
  });
});

describe('exportUserDataWith', () => {
  it('returns structured export with all data classes', async () => {
    const deps = makeMockDeps();
    seedTestData(TEST_ACCOUNT_ID, TEST_WALLET);

    const exportData = await exportUserDataWith(deps, TEST_ACCOUNT_ID);

    expect(exportData.exportedAt).toBeTruthy();
    expect(exportData.accountId).toBe(TEST_ACCOUNT_ID);
    expect(exportData.dataClasses.accountProfile).toBeTruthy();
    expect((exportData.dataClasses.accountProfile as Record<string, unknown>).accountId).toBe(TEST_ACCOUNT_ID);
    // 2 account-side identities + 2 reverse mappings
    expect(exportData.dataClasses.linkedIdentities).toHaveLength(4);
    expect(exportData.dataClasses.chatHistory).toHaveLength(2);
    expect(exportData.dataClasses.memories).toHaveLength(1);
    expect(exportData.dataClasses.issues).toHaveLength(1);
    expect(exportData.dataClasses.auditLog).toHaveLength(1);
    expect(exportData.dataClasses.mediaAssets).toHaveLength(0);
    expect(exportData.dataClasses.mediaJobs).toHaveLength(0);

    // Verify retention exceptions are documented
    expect(exportData.retentionExceptions).toHaveLength(2);
    expect(exportData.retentionExceptions[0].dataClass).toBe('auditLog');
    expect(exportData.retentionExceptions[1].dataClass).toBe('consentRecords');
  });

  it('includes gallery metadata in export', async () => {
    const deps = makeMockDeps();
    seedTestData(TEST_ACCOUNT_ID, TEST_WALLET);
    seedMediaData(TEST_AVATAR_ID);

    const exportData = await exportUserDataWith(deps, TEST_ACCOUNT_ID);

    expect(exportData.dataClasses.mediaAssets).toHaveLength(2);

    const img = exportData.dataClasses.mediaAssets.find((a) => a.id === 'img-001');
    expect(img).toBeTruthy();
    expect(img?.type).toBe('image');
    expect(img?.s3Key).toBe(`avatars/${TEST_AVATAR_ID}/images/img-001.png`);
    expect(img?.prompt).toBe('A catboy sitting on a cloud');
    expect(img?.avatarId).toBe(TEST_AVATAR_ID);

    const vid = exportData.dataClasses.mediaAssets.find((a) => a.id === 'vid-001');
    expect(vid).toBeTruthy();
    expect(vid?.type).toBe('video');

    expect(exportData.dataClasses.mediaJobs).toHaveLength(1);
    const job = exportData.dataClasses.mediaJobs[0];
    expect(job.jobId).toBe('job-001');
    expect(job.avatarId).toBe(TEST_AVATAR_ID);
    expect(job.resultS3Key).toBe(`avatars/${TEST_AVATAR_ID}/images/job-001.png`);
  });

  it('returns empty export for account with no data', async () => {
    const deps = makeMockDeps();
    const exportData = await exportUserDataWith(deps, 'no-data-account');

    expect(exportData.dataClasses.accountProfile).toBeNull();
    expect(exportData.dataClasses.linkedIdentities).toHaveLength(0);
    expect(exportData.dataClasses.chatHistory).toHaveLength(0);
    expect(exportData.dataClasses.memories).toHaveLength(0);
    expect(exportData.dataClasses.issues).toHaveLength(0);
    expect(exportData.dataClasses.auditLog).toHaveLength(0);
    expect(exportData.dataClasses.mediaAssets).toHaveLength(0);
    expect(exportData.dataClasses.mediaJobs).toHaveLength(0);
  });
});

describe('eraseUserDataWith', () => {
  it('deletes user data across all deletable stores', async () => {
    const deps = makeMockDeps();
    seedTestData(TEST_ACCOUNT_ID, TEST_WALLET);

    const result = await eraseUserDataWith(deps, TEST_ACCOUNT_ID);

    expect(result.accountId).toBe(TEST_ACCOUNT_ID);
    expect(result.dryRun).toBe(false);
    expect(result.erasedAt).toBeTruthy();

    // Should have deleted account profile
    const profileDeleted = result.deleted.find((d) => d.dataClass === 'accountProfile');
    expect(profileDeleted?.count).toBe(1);

    // Should have deleted identity records (2 account-side + 2 reverse-mapping = 4)
    const identitiesDeleted = result.deleted.find((d) => d.dataClass === 'linkedIdentities');
    expect(identitiesDeleted?.count).toBe(4);

    // Should have deleted chat history
    const chatDeleted = result.deleted.find((d) => d.dataClass === 'chatHistory');
    expect(chatDeleted?.count).toBe(2);

    const memoriesDeleted = result.deleted.find((d) => d.dataClass === 'memories');
    expect(memoriesDeleted?.count).toBe(1);

    const issuesDeleted = result.deleted.find((d) => d.dataClass === 'issues');
    expect(issuesDeleted?.count).toBe(1);

    // Audit events should be retained
    const auditRetained = result.retained.find((r) => r.dataClass === 'auditLog');
    expect(auditRetained?.count).toBe(1);
    expect(auditRetained?.reason).toContain('compliance');

    // 1 profile + 4 identities + 2 chat + 1 memory + 1 issue = 9
    expect(result.totalDeleted).toBe(9);
    expect(result.totalRetained).toBe(1);

    // Verify delete commands were issued for all deletable records
    expect(deletedKeys.length).toBe(9);
  });

  it('deletes gallery items and S3 objects during erasure', async () => {
    const deps = makeMockDeps();
    seedTestData(TEST_ACCOUNT_ID, TEST_WALLET);
    seedMediaData(TEST_AVATAR_ID);

    const result = await eraseUserDataWith(deps, TEST_ACCOUNT_ID);

    // Should have deleted media assets
    const mediaDeleted = result.deleted.find((d) => d.dataClass === 'mediaAssets');
    expect(mediaDeleted?.count).toBe(2); // 2 gallery items

    // Should have deleted media jobs
    const jobsDeleted = result.deleted.find((d) => d.dataClass === 'mediaJobs');
    expect(jobsDeleted?.count).toBe(1);

    // Verify S3 delete commands were issued
    // 2 gallery S3 keys + 1 media job resultS3Key = 3 S3 deletes
    expect(deletedS3Keys.length).toBe(3);
    expect(deletedS3Keys.some((k) => k.Key === `avatars/${TEST_AVATAR_ID}/images/img-001.png`)).toBe(true);
    expect(deletedS3Keys.some((k) => k.Key === `avatars/${TEST_AVATAR_ID}/videos/vid-001.mp4`)).toBe(true);
    expect(deletedS3Keys.some((k) => k.Key === `avatars/${TEST_AVATAR_ID}/images/job-001.png`)).toBe(true);
    expect(deletedS3Keys.every((k) => k.Bucket === 'test-media-bucket')).toBe(true);

    // Total: 9 original + 2 gallery + 1 media job = 12
    expect(result.totalDeleted).toBe(12);

    // DynamoDB deletes: 9 original + 2 gallery records + 1 media job record = 12
    expect(deletedKeys.length).toBe(12);
  });

  it('records the erasure as an audit event', async () => {
    const deps = makeMockDeps();
    seedTestData(TEST_ACCOUNT_ID, TEST_WALLET);

    await eraseUserDataWith(deps, TEST_ACCOUNT_ID);

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

    // Verify the audit event references accountId
    const auditDetail = auditItems[0].details as Record<string, unknown>;
    expect(auditDetail.accountId).toBe(TEST_ACCOUNT_ID);
  });

  it('records media deletion counts in audit event', async () => {
    const deps = makeMockDeps();
    seedTestData(TEST_ACCOUNT_ID, TEST_WALLET);
    seedMediaData(TEST_AVATAR_ID);

    await eraseUserDataWith(deps, TEST_ACCOUNT_ID);

    const auditItems = storedItems.filter(
      (item) =>
        typeof item.pk === 'string' &&
        item.pk.startsWith('AUDIT#') &&
        typeof item.details === 'object' &&
        item.details !== null &&
        (item.details as Record<string, unknown>).action === 'dsar_erasure',
    );
    expect(auditItems.length).toBe(1);

    const details = auditItems[0].details as Record<string, unknown>;
    expect(details.mediaAssetsDeleted).toBe(2);
    expect(details.mediaJobsDeleted).toBe(1);
    expect(details.s3ObjectsDeleted).toBe(3);
  });

  it('dry-run mode does not delete any data', async () => {
    const deps = makeMockDeps();
    seedTestData(TEST_ACCOUNT_ID, TEST_WALLET);
    seedMediaData(TEST_AVATAR_ID);

    const initialItemCount = storedItems.length;

    const result = await eraseUserDataWith(deps, TEST_ACCOUNT_ID, { dryRun: true });

    expect(result.dryRun).toBe(true);
    // 9 original + 2 gallery + 1 media job = 12
    expect(result.totalDeleted).toBe(12);
    expect(deletedKeys.length).toBe(0); // But no actual DynamoDB deletes happened
    expect(deletedS3Keys.length).toBe(0); // And no S3 deletes happened
    expect(storedItems.length).toBe(initialItemCount); // Items still there
  });

  it('handles account with no data gracefully', async () => {
    const deps = makeMockDeps();
    const result = await eraseUserDataWith(deps, 'empty-account');

    expect(result.totalDeleted).toBe(0);
    expect(result.totalRetained).toBe(0);
    expect(result.deleted).toHaveLength(0);
    expect(result.retained).toHaveLength(0);
    expect(deletedKeys.length).toBe(0);
    expect(deletedS3Keys.length).toBe(0);
  });
});
