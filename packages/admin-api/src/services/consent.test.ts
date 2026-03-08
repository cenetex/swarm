/**
 * Tests for consent service.
 *
 * Uses the dependency-injection variants with an in-memory DynamoDB mock
 * to verify schema, consent lifecycle, version handling, account-bound
 * identity, notice hash artifacts, and legacy migration fallback.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  recordConsentWith,
  getConsentStatusWith,
  revokeConsentWith,
  listConsentRecordsWith,
  computeNoticeHash,
} from './consent.js';
import type { ConsentDeps } from './consent.js';

// ── In-memory DynamoDB mock (supports Get, Put, Query, Update) ──────────

type DbItem = Record<string, unknown>;

function makeInMemoryDynamo() {
  const store = new Map<string, DbItem>();
  const keyOf = (pk: string, sk: string) => `${pk}|${sk}`;

  const send = async (cmd: unknown): Promise<unknown> => {
    const command = cmd as {
      input?: Record<string, unknown>;
      constructor?: { name?: string };
    };
    const input = command?.input ?? {};
    const name = command?.constructor?.name ?? '';

    // PutCommand
    if (name === 'PutCommand') {
      const item = (input as { Item: DbItem }).Item;
      store.set(keyOf(item.pk as string, item.sk as string), { ...item });
      return {};
    }

    // GetCommand
    if (name === 'GetCommand') {
      const key = (input as { Key: { pk: string; sk: string } }).Key;
      const item = store.get(keyOf(key.pk, key.sk));
      return { Item: item ?? undefined };
    }

    // QueryCommand
    if (name === 'QueryCommand') {
      const eavs = (input as { ExpressionAttributeValues: Record<string, unknown> })
        .ExpressionAttributeValues;
      const pk = eavs[':pk'] as string;
      const items: DbItem[] = [];

      for (const [key, item] of store.entries()) {
        if (!key.startsWith(`${pk}|`)) continue;

        if (eavs[':sk'] !== undefined) {
          if (item.sk === eavs[':sk']) items.push(item);
          continue;
        }

        if (eavs[':skPrefix'] !== undefined) {
          if ((item.sk as string).startsWith(eavs[':skPrefix'] as string)) {
            items.push(item);
          }
          continue;
        }

        items.push(item);
      }

      return { Items: items };
    }

    // UpdateCommand
    if (name === 'UpdateCommand') {
      const key = (input as { Key: { pk: string; sk: string } }).Key;
      const existing = store.get(keyOf(key.pk, key.sk));

      if (!existing) {
        const err = new Error('ConditionalCheckFailedException');
        err.name = 'ConditionalCheckFailedException';
        throw err;
      }

      const eavs = (input as { ExpressionAttributeValues: Record<string, unknown> })
        .ExpressionAttributeValues;
      existing.status = eavs[':status'];
      existing.revokedAt = eavs[':revokedAt'];
      store.set(keyOf(key.pk, key.sk), existing);
      return {};
    }

    throw new Error(`Unhandled DynamoDB command: ${name}`);
  };

  return { send: send as ConsentDeps['dynamoClient']['send'], store };
}

const TABLE = 'test-admin';

function makeDeps() {
  const dynamo = makeInMemoryDynamo();
  return {
    dynamoClient: { send: dynamo.send },
    tableName: TABLE,
    store: dynamo.store,
  };
}

// =========================================================================
// computeNoticeHash
// =========================================================================

describe('computeNoticeHash', () => {
  it('returns a 64-char hex SHA-256 digest', () => {
    const hash = computeNoticeHash('Privacy Policy v1.2 content here');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns different hashes for different content', () => {
    const h1 = computeNoticeHash('version 1.0');
    const h2 = computeNoticeHash('version 1.1');
    expect(h1).not.toEqual(h2);
  });

  it('returns same hash for identical content', () => {
    const content = 'identical content';
    expect(computeNoticeHash(content)).toEqual(computeNoticeHash(content));
  });
});

// =========================================================================
// recordConsentWith
// =========================================================================

describe('recordConsentWith', () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    deps = makeDeps();
  });

  it('stores a consent record with correct legacy DynamoDB schema', async () => {
    const result = await recordConsentWith(deps, {
      userId: 'wallet-abc',
      policyVersion: '1.1',
    });

    expect(result.userId).toBe('wallet-abc');
    expect(result.policyVersion).toBe('1.1');
    expect(result.status).toBe('active');
    expect(result.acceptedAt).toBeGreaterThan(0);
    expect(result.revokedAt).toBeUndefined();

    const stored = deps.store.get('CONSENT#wallet-abc|v1.1');
    expect(stored).toBeDefined();
    expect(stored!.pk).toBe('CONSENT#wallet-abc');
    expect(stored!.sk).toBe('v1.1');
  });

  it('stores account-bound record keyed to ACCOUNT#<accountId>', async () => {
    const result = await recordConsentWith(deps, {
      userId: '0xWallet123',
      accountId: 'acct-001',
      policyVersion: '1.2',
      noticeHash: 'abc123hash',
    });

    expect(result.userId).toBe('0xWallet123');
    expect(result.accountId).toBe('acct-001');
    expect(result.noticeHash).toBe('abc123hash');
    expect(result.status).toBe('active');

    const stored = deps.store.get('CONSENT#ACCOUNT#acct-001|v1.2');
    expect(stored).toBeDefined();
    expect(stored!.pk).toBe('CONSENT#ACCOUNT#acct-001');
    expect(stored!.noticeHash).toBe('abc123hash');
  });

  it('does not set a TTL (consent records are long-lived)', async () => {
    await recordConsentWith(deps, {
      userId: 'wallet-abc',
      policyVersion: '1.0',
    });

    const stored = deps.store.get('CONSENT#wallet-abc|v1.0');
    expect(stored!.ttl).toBeUndefined();
  });

  it('is idempotent for the same user+version', async () => {
    await recordConsentWith(deps, {
      userId: 'wallet-abc',
      policyVersion: '1.0',
    });
    await recordConsentWith(deps, {
      userId: 'wallet-abc',
      policyVersion: '1.0',
    });

    // Both writes target the same pk/sk key — store should have exactly 1 entry
    let count = 0;
    for (const key of deps.store.keys()) {
      if (key.includes('wallet-abc')) count++;
    }
    expect(count).toBe(1);
  });
});

// =========================================================================
// getConsentStatusWith — dual lookup
// =========================================================================

describe('getConsentStatusWith', () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    deps = makeDeps();
  });

  it('returns consent record when it exists (legacy)', async () => {
    await recordConsentWith(deps, {
      userId: 'wallet-abc',
      policyVersion: '1.1',
    });

    const result = await getConsentStatusWith(deps, {
      userId: 'wallet-abc',
      policyVersion: '1.1',
    });

    expect(result).not.toBeNull();
    expect(result!.userId).toBe('wallet-abc');
    expect(result!.policyVersion).toBe('1.1');
    expect(result!.status).toBe('active');
  });

  it('returns account-scoped record when accountId is provided', async () => {
    await recordConsentWith(deps, {
      userId: '0xWallet',
      accountId: 'acct-001',
      policyVersion: '1.2',
      noticeHash: 'hash1',
    });

    const result = await getConsentStatusWith(deps, {
      userId: '0xWallet',
      accountId: 'acct-001',
      policyVersion: '1.2',
    });

    expect(result).not.toBeNull();
    expect(result!.accountId).toBe('acct-001');
    expect(result!.noticeHash).toBe('hash1');
  });

  it('falls back to legacy wallet-scoped record when no account record exists', async () => {
    // Legacy record (no accountId)
    await recordConsentWith(deps, {
      userId: '0xOldWallet',
      policyVersion: '1.0',
    });

    // Query with a new accountId — should fall back to legacy
    const result = await getConsentStatusWith(deps, {
      userId: '0xOldWallet',
      accountId: 'acct-new',
      policyVersion: '1.0',
    });

    expect(result).not.toBeNull();
    expect(result!.userId).toBe('0xOldWallet');
    expect(result!.accountId).toBeUndefined();
  });

  it('returns null when no consent record exists', async () => {
    const result = await getConsentStatusWith(deps, {
      userId: 'wallet-abc',
      policyVersion: '2.0',
    });

    expect(result).toBeNull();
  });

  it('returns null when no record exists under either key', async () => {
    const result = await getConsentStatusWith(deps, {
      userId: '0xNobody',
      accountId: 'acct-999',
      policyVersion: '1.2',
    });

    expect(result).toBeNull();
  });
});

// =========================================================================
// revokeConsentWith
// =========================================================================

describe('revokeConsentWith', () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    deps = makeDeps();
  });

  it('revokes a legacy consent record', async () => {
    await recordConsentWith(deps, {
      userId: 'wallet-abc',
      policyVersion: '1.0',
    });

    const revoked = await revokeConsentWith(deps, {
      userId: 'wallet-abc',
      policyVersion: '1.0',
    });

    expect(revoked).toBe(true);

    const record = await getConsentStatusWith(deps, {
      userId: 'wallet-abc',
      policyVersion: '1.0',
    });
    expect(record!.status).toBe('revoked');
    expect(record!.revokedAt).toBeGreaterThan(0);
  });

  it('revokes an account-scoped consent record', async () => {
    await recordConsentWith(deps, {
      userId: '0xWallet',
      accountId: 'acct-001',
      policyVersion: '1.2',
    });

    const revoked = await revokeConsentWith(deps, {
      userId: '0xWallet',
      accountId: 'acct-001',
      policyVersion: '1.2',
    });

    expect(revoked).toBe(true);

    const record = await getConsentStatusWith(deps, {
      userId: '0xWallet',
      accountId: 'acct-001',
      policyVersion: '1.2',
    });
    expect(record!.status).toBe('revoked');
  });

  it('falls back to revoking legacy record when account-scoped record does not exist', async () => {
    await recordConsentWith(deps, {
      userId: '0xLegacyWallet',
      policyVersion: '1.0',
    });

    const revoked = await revokeConsentWith(deps, {
      userId: '0xLegacyWallet',
      accountId: 'acct-new',
      policyVersion: '1.0',
    });

    expect(revoked).toBe(true);
  });

  it('returns false when the consent record does not exist', async () => {
    const revoked = await revokeConsentWith(deps, {
      userId: 'wallet-abc',
      policyVersion: '9.9',
    });

    expect(revoked).toBe(false);
  });
});

// =========================================================================
// listConsentRecordsWith
// =========================================================================

describe('listConsentRecordsWith', () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    deps = makeDeps();
  });

  it('returns all consent records for an account', async () => {
    await recordConsentWith(deps, {
      userId: '0xWallet',
      accountId: 'acct-001',
      policyVersion: '1.0',
      noticeHash: 'hash-v1',
    });
    await recordConsentWith(deps, {
      userId: '0xWallet',
      accountId: 'acct-001',
      policyVersion: '1.1',
      noticeHash: 'hash-v1.1',
    });

    const records = await listConsentRecordsWith(deps, '0xWallet', 'acct-001');
    expect(records.length).toBe(2);
    expect(records.map((r) => r.policyVersion).sort()).toEqual(['1.0', '1.1']);
  });

  it('queries legacy key when accountId is not provided', async () => {
    await recordConsentWith(deps, {
      userId: '0xLegacyWallet',
      policyVersion: '1.0',
    });

    const records = await listConsentRecordsWith(deps, '0xLegacyWallet');
    expect(records.length).toBe(1);
    expect(records[0].userId).toBe('0xLegacyWallet');
  });

  it('returns empty array when no records exist', async () => {
    const records = await listConsentRecordsWith(deps, 'wallet-nonexistent');
    expect(records).toEqual([]);
  });
});

// =========================================================================
// Re-acceptance after notice update
// =========================================================================

describe('re-acceptance after notice update', () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    deps = makeDeps();
  });

  it('stores different noticeHash when policy content changes', async () => {
    const hashV1 = computeNoticeHash('Privacy Policy version 1.0 content');
    const hashV2 = computeNoticeHash('Privacy Policy version 1.1 content — updated');

    await recordConsentWith(deps, {
      userId: '0xWallet',
      accountId: 'acct-001',
      policyVersion: '1.0',
      noticeHash: hashV1,
    });

    await recordConsentWith(deps, {
      userId: '0xWallet',
      accountId: 'acct-001',
      policyVersion: '1.1',
      noticeHash: hashV2,
    });

    const v1 = await getConsentStatusWith(deps, {
      userId: '0xWallet',
      accountId: 'acct-001',
      policyVersion: '1.0',
    });
    const v2 = await getConsentStatusWith(deps, {
      userId: '0xWallet',
      accountId: 'acct-001',
      policyVersion: '1.1',
    });

    expect(v1!.noticeHash).toBe(hashV1);
    expect(v2!.noticeHash).toBe(hashV2);
    expect(v1!.noticeHash).not.toBe(v2!.noticeHash);
  });

  it('idempotent re-accept overwrites with new noticeHash', async () => {
    await recordConsentWith(deps, {
      userId: '0xWallet',
      accountId: 'acct-001',
      policyVersion: '1.2',
      noticeHash: 'original-hash',
    });

    await recordConsentWith(deps, {
      userId: '0xWallet',
      accountId: 'acct-001',
      policyVersion: '1.2',
      noticeHash: 'corrected-hash',
    });

    const record = await getConsentStatusWith(deps, {
      userId: '0xWallet',
      accountId: 'acct-001',
      policyVersion: '1.2',
    });

    expect(record!.noticeHash).toBe('corrected-hash');
  });
});

// =========================================================================
// Linked identities lookup
// =========================================================================

describe('linked identities lookup', () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    deps = makeDeps();
  });

  it('user with multiple wallets linked to one account sees consent via accountId', async () => {
    // Consent recorded from walletA
    await recordConsentWith(deps, {
      userId: '0xWalletA',
      accountId: 'shared-acct',
      policyVersion: '1.2',
      noticeHash: 'hash-1.2',
    });

    // Query from walletB, same account
    const result = await getConsentStatusWith(deps, {
      userId: '0xWalletB',
      accountId: 'shared-acct',
      policyVersion: '1.2',
    });

    expect(result).not.toBeNull();
    expect(result!.accountId).toBe('shared-acct');
    expect(result!.status).toBe('active');
  });
});

// =========================================================================
// Consent version lifecycle
// =========================================================================

describe('consent version lifecycle', () => {
  let deps: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    deps = makeDeps();
  });

  it('supports accepting a new version after a previous one', async () => {
    const r1 = await recordConsentWith(deps, {
      userId: 'wallet-abc',
      policyVersion: '1.0',
    });
    expect(r1.policyVersion).toBe('1.0');
    expect(r1.status).toBe('active');

    const r2 = await recordConsentWith(deps, {
      userId: 'wallet-abc',
      policyVersion: '1.1',
    });
    expect(r2.policyVersion).toBe('1.1');
    expect(r2.status).toBe('active');

    // Both records exist
    expect(deps.store.size).toBe(2);
  });
});
