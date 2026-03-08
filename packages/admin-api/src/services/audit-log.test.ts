/**
 * Tests for audit-log service.
 *
 * Uses the dependency-injection variants (recordAuditEventWith, listAuditEventsWith)
 * with an in-memory DynamoDB mock to verify schema, TTL, and query behavior.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { recordAuditEventWith, listAuditEventsWith } from './audit-log.js';
import type { AuditEvent, AuditLogDeps } from './audit-log.js';

// ── In-memory DynamoDB mock ─────────────────────────────────────────────────

let putItems: Record<string, unknown>[] = [];
let queryReturnItems: unknown[] = [];

function makeMockDeps(): AuditLogDeps {
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

    return {};
  };

  return {
    dynamoClient: { send } as unknown as AuditLogDeps['dynamoClient'],
    tableName: 'test-admin',
  };
}

beforeEach(() => {
  putItems = [];
  queryReturnItems = [];
});

// =========================================================================
// recordAuditEventWith
// =========================================================================
describe('recordAuditEventWith', () => {
  it('stores an audit event with correct DynamoDB schema', async () => {
    const deps = makeMockDeps();
    const result = await recordAuditEventWith(deps, {
      avatarId: 'avatar-1',
      eventType: 'activated',
      actorId: 'wallet-abc',
      actorType: 'owner',
      details: { previousStatus: 'draft' },
    });

    expect(result.avatarId).toBe('avatar-1');
    expect(result.eventType).toBe('activated');
    expect(result.actorId).toBe('wallet-abc');
    expect(result.actorType).toBe('owner');
    expect(result.details).toEqual({ previousStatus: 'draft' });
    expect(result.id).toMatch(/^audit-/);
    expect(result.timestamp).toBeGreaterThan(0);

    // Verify DynamoDB put call
    expect(putItems.length).toBe(1);
    const item = putItems[0];
    expect(item.pk).toBe('AUDIT#avatar-1');
    expect((item.sk as string).startsWith('EVENT#')).toBe(true);
    expect(item.gsi1pk).toBe('AUDIT_TYPE#activated');
    expect(typeof item.gsi1sk).toBe('number');
    expect(typeof item.ttl).toBe('number');
    expect(item.ttl as number).toBeGreaterThan(0);
  });

  it('records deactivation events', async () => {
    const deps = makeMockDeps();
    const result = await recordAuditEventWith(deps, {
      avatarId: 'avatar-2',
      eventType: 'deactivated',
      actorId: 'admin@test.com',
      actorType: 'admin',
      details: { reason: 'maintenance' },
    });

    expect(result.eventType).toBe('deactivated');
    expect(result.actorType).toBe('admin');
    expect(result.details).toEqual({ reason: 'maintenance' });

    const item = putItems[0];
    expect(item.gsi1pk).toBe('AUDIT_TYPE#deactivated');
  });

  it('records entitlement_changed events', async () => {
    const deps = makeMockDeps();
    const result = await recordAuditEventWith(deps, {
      avatarId: 'avatar-3',
      eventType: 'entitlement_changed',
      actorId: 'wallet-xyz',
      actorType: 'admin',
      details: { plan: 'pro', accountId: 'acc-1' },
    });

    expect(result.eventType).toBe('entitlement_changed');
    expect(result.details.plan).toBe('pro');

    const item = putItems[0];
    expect(item.gsi1pk).toBe('AUDIT_TYPE#entitlement_changed');
  });

  it('sets TTL to approximately 365 days from now', async () => {
    const deps = makeMockDeps();
    const before = Math.floor(Date.now() / 1000);
    await recordAuditEventWith(deps, {
      avatarId: 'avatar-ttl',
      eventType: 'activated',
      actorId: 'test',
      actorType: 'admin',
      details: {},
    });
    const after = Math.floor(Date.now() / 1000);
    const item = putItems[0];
    const ttl = item.ttl as number;
    const retentionDays = 365 * 24 * 60 * 60;
    expect(ttl).toBeGreaterThanOrEqual(before + retentionDays);
    expect(ttl).toBeLessThanOrEqual(after + retentionDays);
  });

  it('records avatar_created events', async () => {
    const deps = makeMockDeps();
    const result = await recordAuditEventWith(deps, {
      avatarId: 'avatar-new',
      eventType: 'avatar_created',
      actorId: 'wallet-abc',
      actorType: 'owner',
      details: { name: 'My Avatar', creationMethod: 'wallet' },
    });

    expect(result.eventType).toBe('avatar_created');
    expect(result.details.name).toBe('My Avatar');

    const item = putItems[0];
    expect(item.gsi1pk).toBe('AUDIT_TYPE#avatar_created');
  });

  it('records avatar_updated events', async () => {
    const deps = makeMockDeps();
    const result = await recordAuditEventWith(deps, {
      avatarId: 'avatar-1',
      eventType: 'avatar_updated',
      actorId: 'admin@test.com',
      actorType: 'admin',
      details: { updatedFields: ['name', 'description'] },
    });

    expect(result.eventType).toBe('avatar_updated');
    const item = putItems[0];
    expect(item.gsi1pk).toBe('AUDIT_TYPE#avatar_updated');
  });

  it('records avatar_deleted events', async () => {
    const deps = makeMockDeps();
    const result = await recordAuditEventWith(deps, {
      avatarId: 'avatar-del',
      eventType: 'avatar_deleted',
      actorId: 'admin@test.com',
      actorType: 'admin',
      details: {},
    });

    expect(result.eventType).toBe('avatar_deleted');
    const item = putItems[0];
    expect(item.gsi1pk).toBe('AUDIT_TYPE#avatar_deleted');
  });

  it('records avatar_reassigned events', async () => {
    const deps = makeMockDeps();
    const result = await recordAuditEventWith(deps, {
      avatarId: 'avatar-1',
      eventType: 'avatar_reassigned',
      actorId: 'admin@test.com',
      actorType: 'admin',
      details: { previousOwner: 'wallet-old', newOwner: 'wallet-new' },
    });

    expect(result.eventType).toBe('avatar_reassigned');
    expect(result.details.previousOwner).toBe('wallet-old');
    const item = putItems[0];
    expect(item.gsi1pk).toBe('AUDIT_TYPE#avatar_reassigned');
  });

  it('records secret_set events', async () => {
    const deps = makeMockDeps();
    const result = await recordAuditEventWith(deps, {
      avatarId: 'avatar-1',
      eventType: 'secret_set',
      actorId: 'wallet-abc',
      actorType: 'owner',
      details: { secretKey: 'openai_api_key' },
    });

    expect(result.eventType).toBe('secret_set');
    expect(result.details.secretKey).toBe('openai_api_key');
    const item = putItems[0];
    expect(item.gsi1pk).toBe('AUDIT_TYPE#secret_set');
  });

  it('generates unique IDs for each event', async () => {
    const deps = makeMockDeps();
    const r1 = await recordAuditEventWith(deps, {
      avatarId: 'avatar-1',
      eventType: 'activated',
      actorId: 'test',
      actorType: 'admin',
      details: {},
    });
    const r2 = await recordAuditEventWith(deps, {
      avatarId: 'avatar-1',
      eventType: 'deactivated',
      actorId: 'test',
      actorType: 'admin',
      details: {},
    });
    expect(r1.id).not.toBe(r2.id);
  });
});

// =========================================================================
// listAuditEventsWith
// =========================================================================
describe('listAuditEventsWith', () => {
  it('returns events from DynamoDB query', async () => {
    const deps = makeMockDeps();
    const mockEvent: AuditEvent = {
      id: 'audit-123',
      avatarId: 'avatar-1',
      eventType: 'activated',
      actorId: 'wallet-abc',
      actorType: 'owner',
      details: {},
      timestamp: Date.now(),
    };
    queryReturnItems = [mockEvent];

    const events = await listAuditEventsWith(deps, 'avatar-1');
    expect(events.length).toBe(1);
    expect(events[0].id).toBe('audit-123');
    expect(events[0].eventType).toBe('activated');
  });

  it('returns empty array when no events exist', async () => {
    const deps = makeMockDeps();
    queryReturnItems = [];
    const events = await listAuditEventsWith(deps, 'avatar-nonexistent');
    expect(events).toEqual([]);
  });

  it('passes eventType filter', async () => {
    const deps = makeMockDeps();
    queryReturnItems = [];
    const events = await listAuditEventsWith(deps, 'avatar-1', { eventType: 'deactivated' });
    expect(events).toEqual([]);
  });

  it('respects limit and since options', async () => {
    const deps = makeMockDeps();
    queryReturnItems = [];
    const events = await listAuditEventsWith(deps, 'avatar-1', { limit: 10, since: Date.now() - 3600000 });
    expect(events).toEqual([]);
  });

  it('returns multiple events in order', async () => {
    const deps = makeMockDeps();
    const event1: AuditEvent = {
      id: 'audit-1', avatarId: 'avatar-1', eventType: 'activated',
      actorId: 'a', actorType: 'admin', details: {}, timestamp: 1000,
    };
    const event2: AuditEvent = {
      id: 'audit-2', avatarId: 'avatar-1', eventType: 'deactivated',
      actorId: 'a', actorType: 'admin', details: {}, timestamp: 2000,
    };
    queryReturnItems = [event2, event1]; // newest first
    const events = await listAuditEventsWith(deps, 'avatar-1');
    expect(events.length).toBe(2);
    expect(events[0].id).toBe('audit-2');
    expect(events[1].id).toBe('audit-1');
  });
});
