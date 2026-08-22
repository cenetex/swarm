/**
 * Tests for the Telegram DM approval store (#1473).
 *
 * These pin:
 *   - Pending DM create/get/delete round-trip
 *   - 24h TTL is honored client-side even when DynamoDB's sweep lags
 *   - First-message preview is truncated to MAX_FIRST_MESSAGE_CHARS
 *   - Blocklist is persistent (no TTL), add/check/remove round-trip
 *   - listPending returns only live (non-expired) records
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@swarm/core';
import {
  createTelegramDmApprovalStore,
  MAX_FIRST_MESSAGE_CHARS,
} from './telegram-dm-approval.js';

type Item = Record<string, unknown>;

function createMockDynamo() {
  const store = new Map<string, Item>();
  const keyOf = (pk: string, sk: string) => `${pk}|${sk}`;

  async function send(cmd: unknown): Promise<unknown> {
    if (cmd instanceof PutCommand) {
      const item = cmd.input.Item as { pk: string; sk: string };
      store.set(keyOf(item.pk, item.sk), item as Item);
      return {};
    }
    if (cmd instanceof GetCommand) {
      const key = cmd.input.Key as { pk: string; sk: string };
      return { Item: store.get(keyOf(key.pk, key.sk)) };
    }
    if (cmd instanceof DeleteCommand) {
      const key = cmd.input.Key as { pk: string; sk: string };
      store.delete(keyOf(key.pk, key.sk));
      return {};
    }
    if (cmd instanceof QueryCommand) {
      const values = cmd.input.ExpressionAttributeValues as { ':pk': string; ':sk': string };
      const items = Array.from(store.values()).filter((item) => {
        const entry = item as { pk?: string; sk?: string };
        return entry.pk === values[':pk'] && entry.sk?.startsWith(values[':sk']);
      });
      const limit = cmd.input.Limit;
      return { Items: typeof limit === 'number' ? items.slice(0, limit) : items };
    }
    throw new Error(`Unexpected command: ${(cmd as { constructor?: { name?: string } }).constructor?.name}`);
  }

  return { send, store };
}

describe('telegram-dm-approval (#1473)', () => {
  let mockDynamo: ReturnType<typeof createMockDynamo>;
  let store: ReturnType<typeof createTelegramDmApprovalStore>;
  let now: number;

  beforeEach(() => {
    mockDynamo = createMockDynamo();
    now = 1_700_000_000_000;
    store = createTelegramDmApprovalStore({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dynamoClient: mockDynamo as any,
      tableName: 'test-table',
      now: () => now,
    });
  });

  describe('pending', () => {
    it('creates and retrieves a pending DM record', async () => {
      const record = await store.createPendingDm({
        avatarId: 'a1',
        requesterId: 'r42',
        requesterUsername: 'stranger',
        holdingMessageId: 111,
        ownerMessageId: 222,
        firstMessage: 'hello?',
      });
      expect(record.requesterId).toBe('r42');
      expect(record.holdingMessageId).toBe(111);
      expect(record.ownerMessageId).toBe(222);
      expect(mockDynamo.store.has('AVATAR#a1|TELEGRAM_DM_PENDING#r42')).toBe(true);

      const fetched = await store.getPendingDm('a1', 'r42');
      expect(fetched?.requesterId).toBe('r42');
      expect(fetched?.firstMessage).toBe('hello?');
    });

    it('truncates oversize first-message previews', async () => {
      const huge = 'x'.repeat(MAX_FIRST_MESSAGE_CHARS + 500);
      const record = await store.createPendingDm({
        avatarId: 'a1',
        requesterId: 'r42',
        holdingMessageId: 1,
        ownerMessageId: 2,
        firstMessage: huge,
      });
      expect(record.firstMessage.length).toBe(MAX_FIRST_MESSAGE_CHARS);
    });

    it('rejects expired pending records even if sweep has lagged', async () => {
      await store.createPendingDm({
        avatarId: 'a1',
        requesterId: 'r42',
        holdingMessageId: 1,
        ownerMessageId: 2,
        firstMessage: 'hi',
      });
      now += 25 * 60 * 60 * 1000; // 25h later
      const fetched = await store.getPendingDm('a1', 'r42');
      expect(fetched).toBeNull();
    });

    it('deletes a pending record', async () => {
      await store.createPendingDm({
        avatarId: 'a1',
        requesterId: 'r42',
        holdingMessageId: 1,
        ownerMessageId: 2,
        firstMessage: 'hi',
      });
      await store.deletePendingDm('a1', 'r42');
      expect(mockDynamo.store.has('AVATAR#a1|TELEGRAM_DM_PENDING#r42')).toBe(false);
    });

    it('listPending returns only live records across multiple requesters', async () => {
      await store.createPendingDm({
        avatarId: 'a1', requesterId: 'r1',
        holdingMessageId: 1, ownerMessageId: 10, firstMessage: 'hi 1',
      });
      await store.createPendingDm({
        avatarId: 'a1', requesterId: 'r2',
        holdingMessageId: 2, ownerMessageId: 20, firstMessage: 'hi 2',
      });
      await store.createPendingDm({
        avatarId: 'a1', requesterId: 'r3',
        holdingMessageId: 3, ownerMessageId: 30, firstMessage: 'hi 3',
      });
      const pending = await store.listPending('a1');
      expect(pending).toHaveLength(3);
      expect(pending.map(p => p.requesterId).sort()).toEqual(['r1', 'r2', 'r3']);
    });

    it('listPending filters out expired records', async () => {
      await store.createPendingDm({
        avatarId: 'a1', requesterId: 'r1',
        holdingMessageId: 1, ownerMessageId: 10, firstMessage: 'hi',
      });
      now += 25 * 60 * 60 * 1000;
      await store.createPendingDm({
        avatarId: 'a1', requesterId: 'r2',
        holdingMessageId: 2, ownerMessageId: 20, firstMessage: 'hi',
      });
      const pending = await store.listPending('a1');
      expect(pending.map(p => p.requesterId)).toEqual(['r2']);
    });
  });

  describe('blocklist', () => {
    it('add/check/remove a blocked user', async () => {
      expect(await store.isBlocked('a1', 'r99')).toBe(false);
      await store.addBlocked({ avatarId: 'a1', requesterId: 'r99', requesterUsername: 'spammer' });
      expect(await store.isBlocked('a1', 'r99')).toBe(true);
      expect(mockDynamo.store.has('AVATAR#a1|TELEGRAM_BLOCKED#r99')).toBe(true);

      await store.removeBlocked('a1', 'r99');
      expect(await store.isBlocked('a1', 'r99')).toBe(false);
    });

    it('blocklist has no TTL and survives "time passing"', async () => {
      await store.addBlocked({ avatarId: 'a1', requesterId: 'r99' });
      now += 365 * 24 * 60 * 60 * 1000; // a year later
      expect(await store.isBlocked('a1', 'r99')).toBe(true);
    });
  });

  it('safely ignores empty inputs', async () => {
    expect(await store.getPendingDm('', 'r1')).toBeNull();
    expect(await store.getPendingDm('a1', '')).toBeNull();
    expect(await store.isBlocked('', 'r1')).toBe(false);
    await store.deletePendingDm('', '');
    await store.removeBlocked('', '');
    expect(mockDynamo.store.size).toBe(0);
  });
});
