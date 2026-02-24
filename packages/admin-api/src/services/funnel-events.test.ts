/**
 * Tests for funnel-events service.
 *
 * Uses the dependency-injection variants (recordFunnelEventWith,
 * listFunnelEventsForUserWith, listFunnelEventsByStageWith) with
 * an in-memory DynamoDB mock to verify schema, TTL, and query behavior.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordFunnelEventWith,
  listFunnelEventsForUserWith,
  listFunnelEventsByStageWith,
  FUNNEL_STAGE_LABELS,
} from './funnel-events.js';
import type { FunnelEvent, FunnelEventsDeps, FunnelStage } from './funnel-events.js';

// ── In-memory DynamoDB mock ─────────────────────────────────────────────────

let putItems: Record<string, unknown>[] = [];
let queryReturnItems: unknown[] = [];

function makeMockDeps(): FunnelEventsDeps {
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
    dynamoClient: { send } as unknown as FunnelEventsDeps['dynamoClient'],
    tableName: 'test-admin',
  };
}

beforeEach(() => {
  putItems = [];
  queryReturnItems = [];
});

// =========================================================================
// recordFunnelEventWith
// =========================================================================
describe('recordFunnelEventWith', () => {
  it('stores a funnel event with correct DynamoDB schema', async () => {
    const deps = makeMockDeps();
    const result = await recordFunnelEventWith(deps, {
      stage: 'F1',
      userId: 'user-1',
      metadata: { authProvider: 'wallet' },
    });

    expect(result.stage).toBe('F1');
    expect(result.userId).toBe('user-1');
    expect(result.metadata).toEqual({ authProvider: 'wallet' });
    expect(result.id).toMatch(/^funnel-/);
    expect(result.timestamp).toBeGreaterThan(0);
    expect(result.failureReason).toBeUndefined();

    // Verify DynamoDB put call
    expect(putItems.length).toBe(1);
    const item = putItems[0];
    expect(item.pk).toBe('FUNNEL#user-1');
    expect((item.sk as string).startsWith('STAGE#F1#')).toBe(true);
    expect(item.gsi1pk).toBe('FUNNEL_STAGE#F1');
    expect(typeof item.gsi1sk).toBe('number');
    expect(typeof item.ttl).toBe('number');
    expect(item.ttl as number).toBeGreaterThan(0);
  });

  it('records avatar creation events (F2) with avatarId', async () => {
    const deps = makeMockDeps();
    const result = await recordFunnelEventWith(deps, {
      stage: 'F2',
      userId: 'user-2',
      avatarId: 'avatar-1',
      metadata: { creationMethod: 'wallet' },
    });

    expect(result.stage).toBe('F2');
    expect(result.avatarId).toBe('avatar-1');
    expect(result.metadata.creationMethod).toBe('wallet');

    const item = putItems[0];
    expect(item.gsi1pk).toBe('FUNNEL_STAGE#F2');
    expect(item.avatarId).toBe('avatar-1');
  });

  it('records failure events with failureReason', async () => {
    const deps = makeMockDeps();
    const result = await recordFunnelEventWith(deps, {
      stage: 'F3',
      userId: 'user-3',
      avatarId: 'avatar-2',
      failureReason: 'llm_timeout',
      metadata: { platform: 'telegram' },
    });

    expect(result.stage).toBe('F3');
    expect(result.failureReason).toBe('llm_timeout');

    const item = putItems[0];
    expect(item.failureReason).toBe('llm_timeout');
  });

  it('sets TTL to approximately 365 days from now', async () => {
    const deps = makeMockDeps();
    const before = Math.floor(Date.now() / 1000);
    await recordFunnelEventWith(deps, {
      stage: 'F1',
      userId: 'user-ttl',
    });
    const after = Math.floor(Date.now() / 1000);
    const item = putItems[0];
    const ttl = item.ttl as number;
    const oneYear = 365 * 24 * 60 * 60;
    expect(ttl).toBeGreaterThanOrEqual(before + oneYear);
    expect(ttl).toBeLessThanOrEqual(after + oneYear);
  });

  it('generates unique IDs for each event', async () => {
    const deps = makeMockDeps();
    const r1 = await recordFunnelEventWith(deps, {
      stage: 'F1',
      userId: 'user-1',
    });
    const r2 = await recordFunnelEventWith(deps, {
      stage: 'F1',
      userId: 'user-1',
    });
    expect(r1.id).not.toBe(r2.id);
  });

  it('defaults metadata to empty object when not provided', async () => {
    const deps = makeMockDeps();
    const result = await recordFunnelEventWith(deps, {
      stage: 'F5',
      userId: 'user-5',
    });

    expect(result.metadata).toEqual({});
  });

  it('records all funnel stages (F0-F6)', async () => {
    const deps = makeMockDeps();
    const stages: FunnelStage[] = ['F0', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6'];

    for (const stage of stages) {
      await recordFunnelEventWith(deps, { stage, userId: `user-${stage}` });
    }

    expect(putItems.length).toBe(7);

    for (let i = 0; i < stages.length; i++) {
      expect(putItems[i].gsi1pk).toBe(`FUNNEL_STAGE#${stages[i]}`);
    }
  });
});

// =========================================================================
// FUNNEL_STAGE_LABELS
// =========================================================================
describe('FUNNEL_STAGE_LABELS', () => {
  it('has labels for all stages F0-F6', () => {
    const stages: FunnelStage[] = ['F0', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6'];
    for (const stage of stages) {
      expect(typeof FUNNEL_STAGE_LABELS[stage]).toBe('string');
      expect(FUNNEL_STAGE_LABELS[stage].length).toBeGreaterThan(0);
    }
  });
});

// =========================================================================
// listFunnelEventsForUserWith
// =========================================================================
describe('listFunnelEventsForUserWith', () => {
  it('returns events from DynamoDB query', async () => {
    const deps = makeMockDeps();
    const mockEvent: FunnelEvent = {
      id: 'funnel-123',
      stage: 'F1',
      timestamp: Date.now(),
      userId: 'user-1',
      metadata: {},
    };
    queryReturnItems = [mockEvent];

    const events = await listFunnelEventsForUserWith(deps, 'user-1');
    expect(events.length).toBe(1);
    expect(events[0].id).toBe('funnel-123');
    expect(events[0].stage).toBe('F1');
  });

  it('returns empty array when no events exist', async () => {
    const deps = makeMockDeps();
    queryReturnItems = [];
    const events = await listFunnelEventsForUserWith(deps, 'user-nonexistent');
    expect(events).toEqual([]);
  });

  it('passes stage filter', async () => {
    const deps = makeMockDeps();
    queryReturnItems = [];
    const events = await listFunnelEventsForUserWith(deps, 'user-1', { stage: 'F2' });
    expect(events).toEqual([]);
  });

  it('respects limit and since options', async () => {
    const deps = makeMockDeps();
    queryReturnItems = [];
    const events = await listFunnelEventsForUserWith(deps, 'user-1', {
      limit: 10,
      since: Date.now() - 3600000,
    });
    expect(events).toEqual([]);
  });

  it('returns multiple events in order', async () => {
    const deps = makeMockDeps();
    const event1: FunnelEvent = {
      id: 'funnel-1', stage: 'F1', timestamp: 1000,
      userId: 'user-1', metadata: {},
    };
    const event2: FunnelEvent = {
      id: 'funnel-2', stage: 'F2', timestamp: 2000,
      userId: 'user-1', metadata: {},
    };
    queryReturnItems = [event2, event1]; // newest first
    const events = await listFunnelEventsForUserWith(deps, 'user-1');
    expect(events.length).toBe(2);
    expect(events[0].id).toBe('funnel-2');
    expect(events[1].id).toBe('funnel-1');
  });
});

// =========================================================================
// listFunnelEventsByStageWith
// =========================================================================
describe('listFunnelEventsByStageWith', () => {
  it('returns events for a stage via GSI query', async () => {
    const deps = makeMockDeps();
    const mockEvent: FunnelEvent = {
      id: 'funnel-456',
      stage: 'F2',
      timestamp: Date.now(),
      userId: 'user-2',
      avatarId: 'avatar-1',
      metadata: {},
    };
    queryReturnItems = [mockEvent];

    const events = await listFunnelEventsByStageWith(deps, 'F2');
    expect(events.length).toBe(1);
    expect(events[0].id).toBe('funnel-456');
    expect(events[0].stage).toBe('F2');
  });

  it('returns empty array when no events for stage', async () => {
    const deps = makeMockDeps();
    queryReturnItems = [];
    const events = await listFunnelEventsByStageWith(deps, 'F6');
    expect(events).toEqual([]);
  });

  it('respects since and limit options', async () => {
    const deps = makeMockDeps();
    queryReturnItems = [];
    const events = await listFunnelEventsByStageWith(deps, 'F1', {
      since: Date.now() - 86400000,
      limit: 100,
    });
    expect(events).toEqual([]);
  });
});
