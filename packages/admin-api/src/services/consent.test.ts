/**
 * Tests for consent service.
 *
 * Uses the dependency-injection variants with an in-memory DynamoDB mock
 * to verify schema, consent lifecycle, and version handling.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordConsentWith,
  getConsentStatusWith,
  revokeConsentWith,
  listConsentRecordsWith,
} from './consent.js';
import type { ConsentDeps } from './consent.js';

// ── In-memory DynamoDB mock ─────────────────────────────────────────────────

let putItems: Record<string, unknown>[] = [];
let updateCalls: Record<string, unknown>[] = [];
let queryReturnItems: unknown[] = [];

function makeMockDeps(): ConsentDeps {
  const send = async (cmd: unknown) => {
    const command = cmd as { input?: Record<string, unknown>; constructor?: { name?: string } };
    const name = command?.constructor?.name;

    if (name === 'PutCommand') {
      const item = (command.input as { Item: Record<string, unknown> }).Item;
      putItems.push(item);
      return {};
    }

    if (name === 'QueryCommand') {
      return { Items: queryReturnItems };
    }

    if (name === 'UpdateCommand') {
      updateCalls.push(command.input as Record<string, unknown>);
      return {};
    }

    return {};
  };

  return {
    dynamoClient: { send } as unknown as ConsentDeps['dynamoClient'],
    tableName: 'test-admin',
  };
}

beforeEach(() => {
  putItems = [];
  updateCalls = [];
  queryReturnItems = [];
});

// =========================================================================
// recordConsentWith
// =========================================================================
describe('recordConsentWith', () => {
  it('stores a consent record with correct DynamoDB schema', async () => {
    const deps = makeMockDeps();
    const result = await recordConsentWith(deps, {
      userId: 'wallet-abc',
      policyVersion: '1.1',
    });

    expect(result.userId).toBe('wallet-abc');
    expect(result.policyVersion).toBe('1.1');
    expect(result.status).toBe('active');
    expect(result.acceptedAt).toBeGreaterThan(0);
    expect(result.revokedAt).toBeUndefined();

    // Verify DynamoDB put call
    expect(putItems.length).toBe(1);
    const item = putItems[0];
    expect(item.pk).toBe('CONSENT#wallet-abc');
    expect(item.sk).toBe('v1.1');
    expect(item.userId).toBe('wallet-abc');
    expect(item.policyVersion).toBe('1.1');
    expect(item.status).toBe('active');
  });

  it('does not set a TTL (consent records are long-lived)', async () => {
    const deps = makeMockDeps();
    await recordConsentWith(deps, {
      userId: 'wallet-abc',
      policyVersion: '1.0',
    });

    const item = putItems[0];
    expect(item.ttl).toBeUndefined();
  });

  it('is idempotent for the same user+version', async () => {
    const deps = makeMockDeps();
    const r1 = await recordConsentWith(deps, {
      userId: 'wallet-abc',
      policyVersion: '1.0',
    });
    const r2 = await recordConsentWith(deps, {
      userId: 'wallet-abc',
      policyVersion: '1.0',
    });

    expect(putItems.length).toBe(2);
    // Both writes target the same pk/sk (overwrite)
    expect(putItems[0].pk).toBe(putItems[1].pk);
    expect(putItems[0].sk).toBe(putItems[1].sk);
    expect(r1.userId).toBe(r2.userId);
    expect(r1.policyVersion).toBe(r2.policyVersion);
  });
});

// =========================================================================
// getConsentStatusWith
// =========================================================================
describe('getConsentStatusWith', () => {
  it('returns consent record when it exists', async () => {
    const deps = makeMockDeps();
    queryReturnItems = [{
      userId: 'wallet-abc',
      policyVersion: '1.1',
      acceptedAt: 1700000000000,
      status: 'active',
    }];

    const result = await getConsentStatusWith(deps, {
      userId: 'wallet-abc',
      policyVersion: '1.1',
    });

    expect(result).not.toBeNull();
    expect(result!.userId).toBe('wallet-abc');
    expect(result!.policyVersion).toBe('1.1');
    expect(result!.status).toBe('active');
  });

  it('returns null when no consent record exists', async () => {
    const deps = makeMockDeps();
    queryReturnItems = [];

    const result = await getConsentStatusWith(deps, {
      userId: 'wallet-abc',
      policyVersion: '2.0',
    });

    expect(result).toBeNull();
  });

  it('returns revoked status when consent was revoked', async () => {
    const deps = makeMockDeps();
    queryReturnItems = [{
      userId: 'wallet-abc',
      policyVersion: '1.0',
      acceptedAt: 1700000000000,
      status: 'revoked',
      revokedAt: 1700001000000,
    }];

    const result = await getConsentStatusWith(deps, {
      userId: 'wallet-abc',
      policyVersion: '1.0',
    });

    expect(result).not.toBeNull();
    expect(result!.status).toBe('revoked');
    expect(result!.revokedAt).toBe(1700001000000);
  });
});

// =========================================================================
// revokeConsentWith
// =========================================================================
describe('revokeConsentWith', () => {
  it('sends an update command with revoked status', async () => {
    const deps = makeMockDeps();

    const revoked = await revokeConsentWith(deps, {
      userId: 'wallet-abc',
      policyVersion: '1.0',
    });

    expect(revoked).toBe(true);
    expect(updateCalls.length).toBe(1);
    const call = updateCalls[0];
    expect(call.Key).toEqual({
      pk: 'CONSENT#wallet-abc',
      sk: 'v1.0',
    });
    expect(call.ConditionExpression).toBe('attribute_exists(pk) AND attribute_exists(sk)');
    expect(call.ExpressionAttributeValues).toMatchObject({
      ':status': 'revoked',
    });
    expect((call.ExpressionAttributeValues as Record<string, unknown>)[':revokedAt']).toBeGreaterThan(0);
  });

  it('returns false when the consent record does not exist', async () => {
    const send = async (cmd: unknown) => {
      const command = cmd as { constructor?: { name?: string } };
      if (command?.constructor?.name === 'UpdateCommand') {
        const error = new Error('missing');
        error.name = 'ConditionalCheckFailedException';
        throw error;
      }
      return {};
    };

    const deps: ConsentDeps = {
      dynamoClient: { send } as unknown as ConsentDeps['dynamoClient'],
      tableName: 'test-admin',
    };

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
  it('returns all consent records for a user', async () => {
    const deps = makeMockDeps();
    queryReturnItems = [
      {
        userId: 'wallet-abc',
        policyVersion: '1.1',
        acceptedAt: 1700001000000,
        status: 'active',
      },
      {
        userId: 'wallet-abc',
        policyVersion: '1.0',
        acceptedAt: 1700000000000,
        status: 'revoked',
        revokedAt: 1700001000000,
      },
    ];

    const records = await listConsentRecordsWith(deps, 'wallet-abc');

    expect(records.length).toBe(2);
    expect(records[0].policyVersion).toBe('1.1');
    expect(records[0].status).toBe('active');
    expect(records[1].policyVersion).toBe('1.0');
    expect(records[1].status).toBe('revoked');
  });

  it('returns empty array when no records exist', async () => {
    const deps = makeMockDeps();
    queryReturnItems = [];

    const records = await listConsentRecordsWith(deps, 'wallet-nonexistent');
    expect(records).toEqual([]);
  });
});

// =========================================================================
// Re-acceptance after version bump
// =========================================================================
describe('consent version lifecycle', () => {
  it('supports accepting a new version after a previous one', async () => {
    const deps = makeMockDeps();

    // Accept v1.0
    const r1 = await recordConsentWith(deps, {
      userId: 'wallet-abc',
      policyVersion: '1.0',
    });
    expect(r1.policyVersion).toBe('1.0');
    expect(r1.status).toBe('active');

    // Accept v1.1 (different sk, so separate record)
    const r2 = await recordConsentWith(deps, {
      userId: 'wallet-abc',
      policyVersion: '1.1',
    });
    expect(r2.policyVersion).toBe('1.1');
    expect(r2.status).toBe('active');

    // Both writes happened
    expect(putItems.length).toBe(2);
    expect(putItems[0].sk).toBe('v1.0');
    expect(putItems[1].sk).toBe('v1.1');
  });
});
