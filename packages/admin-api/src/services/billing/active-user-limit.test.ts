import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  checkActiveUserAccess,
  upsertActiveUserSlotOnLogin,
  type ActiveUserSlotsRecord,
  type ActiveUserLimitDeps,
} from './active-user-limit.js';

function conditionalCheckFailed(): Error {
  const err = new Error('ConditionalCheckFailedException');
  (err as Error & { name: string }).name = 'ConditionalCheckFailedException';
  return err;
}

describe('active-user-limit', () => {
  const prevLimit = process.env.SWARM_ACTIVE_USER_LIMIT;

  beforeEach(() => {
    delete process.env.SWARM_ACTIVE_USER_LIMIT;
  });

  afterEach(() => {
    if (prevLimit === undefined) {
      delete process.env.SWARM_ACTIVE_USER_LIMIT;
    } else {
      process.env.SWARM_ACTIVE_USER_LIMIT = prevLimit;
    }
  });

  it('fails open when SWARM_ACTIVE_USER_LIMIT is unset', async () => {
    const send = vi.fn(async () => ({}));

    const deps: ActiveUserLimitDeps = {
      dynamoClient: { send: send as any },
      tableName: 'T',
      now: () => 123,
      maxRetries: 2,
    };

    const access = await checkActiveUserAccess({ accountId: 'a1', isAdmin: false }, deps);
    expect(access.allowed).toBe(true);

    const upsert = await upsertActiveUserSlotOnLogin({ accountId: 'a1', walletAddress: 'w1' }, deps);
    expect(upsert.allowed).toBe(true);

    expect(send).not.toHaveBeenCalled();
  });

  it('bypasses the limit for Orb holders', async () => {
    process.env.SWARM_ACTIVE_USER_LIMIT = '2';

    const send = vi.fn(async () => {
      throw new Error('Should not touch Dynamo for Orb holder');
    });

    const deps: ActiveUserLimitDeps = {
      dynamoClient: { send: send as any },
      tableName: 'T',
      now: () => 123,
      maxRetries: 2,
    };

    const access = await checkActiveUserAccess({ accountId: 'a-orb', isAdmin: false, isOrbHolder: true }, deps);
    expect(access.allowed).toBe(true);
    expect(access.limit).toBe(2);

    const upsert = await upsertActiveUserSlotOnLogin(
      { accountId: 'a-orb', walletAddress: 'w-orb', isOrbHolder: true },
      deps
    );
    expect(upsert.allowed).toBe(true);
    expect(upsert.limit).toBe(2);

    expect(send).not.toHaveBeenCalled();
  });

  it('enforces membership once slots are full', async () => {
    process.env.SWARM_ACTIVE_USER_LIMIT = '2';

    const store = new Map<string, ActiveUserSlotsRecord>();

    const send = vi.fn(async (cmd: any) => {
      const input = cmd?.input as any;

      // Put (create)
      if (input?.Item?.pk === 'ACTIVE_USERS' && input?.Item?.sk === 'SLOTS') {
        const key = `${input.Item.pk}#${input.Item.sk}`;
        if (input.ConditionExpression && store.has(key)) {
          throw conditionalCheckFailed();
        }
        store.set(key, input.Item as ActiveUserSlotsRecord);
        return {};
      }

      // Update (optimistic lock)
      if (input?.UpdateExpression && input?.Key?.pk === 'ACTIVE_USERS' && input?.Key?.sk === 'SLOTS') {
        const key = `${input.Key.pk}#${input.Key.sk}`;
        const existing = store.get(key);
        const expected = input.ExpressionAttributeValues?.[':expected'];

        if (input.ConditionExpression?.includes('#version')) {
          const existingVersion = existing?.version;
          const ok = existingVersion === undefined || existingVersion === expected;
          if (!ok) throw conditionalCheckFailed();
        }

        const next: ActiveUserSlotsRecord = {
          pk: 'ACTIVE_USERS',
          sk: 'SLOTS',
          version: input.ExpressionAttributeValues?.[':v'],
          updatedAt: input.ExpressionAttributeValues?.[':now'],
          slots: input.ExpressionAttributeValues?.[':slots'],
        };
        store.set(key, next);
        return {};
      }

      // Get
      if (input?.Key?.pk === 'ACTIVE_USERS' && input?.Key?.sk === 'SLOTS' && input.TableName) {
        const key = `${input.Key.pk}#${input.Key.sk}`;
        return { Item: store.get(key) };
      }

      throw new Error('Unexpected command');
    });

    const deps: ActiveUserLimitDeps = {
      dynamoClient: { send: send as any },
      tableName: 'T',
      now: () => Date.now(),
      maxRetries: 2,
    };

    // Login 1
    await upsertActiveUserSlotOnLogin({ accountId: 'a1', walletAddress: 'w1' }, { ...deps, now: () => 1000 });
    // Login 2
    await upsertActiveUserSlotOnLogin({ accountId: 'a2', walletAddress: 'w2' }, { ...deps, now: () => 2000 });

    // Slots now full; a3 should be denied
    const access3 = await checkActiveUserAccess({ accountId: 'a3', isAdmin: false }, deps);
    expect(access3.allowed).toBe(false);
    expect(access3.limit).toBe(2);

    // a1 and a2 are allowed
    const access1 = await checkActiveUserAccess({ accountId: 'a1', isAdmin: false }, deps);
    const access2 = await checkActiveUserAccess({ accountId: 'a2', isAdmin: false }, deps);
    expect(access1.allowed).toBe(true);
    expect(access2.allowed).toBe(true);

    // If a3 logs in, it should bump the least-recent (a1)
    await upsertActiveUserSlotOnLogin({ accountId: 'a3', walletAddress: 'w3' }, { ...deps, now: () => 3000 });

    const access3b = await checkActiveUserAccess({ accountId: 'a3', isAdmin: false }, deps);
    expect(access3b.allowed).toBe(true);

    const access1b = await checkActiveUserAccess({ accountId: 'a1', isAdmin: false }, deps);
    expect(access1b.allowed).toBe(false);
  });
});
