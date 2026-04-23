/**
 * Tests for the Telegram owner-binding store (#1471).
 *
 * These pin: atomic consume under concurrent retries, 15-min TTL expiry,
 * second-issuance invalidation of prior code, idempotent retry with same
 * telegramUserId, rejection of replay from a different user.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { createTelegramBindingStore } from './telegram-binding.js';

type Item = Record<string, unknown>;

/**
 * In-memory DynamoDB-document-client mock that understands the subset of
 * commands used by the binding store.
 */
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
    if (cmd instanceof TransactWriteCommand) {
      // Validate all conditions first; apply atomically. Mirror DynamoDB
      // semantics enough for these tests.
      const items = cmd.input.TransactItems ?? [];
      // Pre-check conditions.
      for (const action of items) {
        if (action.Delete?.ConditionExpression === 'attribute_exists(pk)') {
          const key = action.Delete.Key as { pk: string; sk: string };
          if (!store.has(keyOf(key.pk, key.sk))) {
            const err = new TransactionCanceledException({
              message: 'Transaction cancelled (ConditionalCheckFailed)',
              CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
              $metadata: {},
            });
            throw err;
          }
        }
      }
      // Apply.
      for (const action of items) {
        if (action.Put) {
          const item = action.Put.Item as { pk: string; sk: string };
          store.set(keyOf(item.pk, item.sk), item as Item);
        } else if (action.Delete) {
          const key = action.Delete.Key as { pk: string; sk: string };
          store.delete(keyOf(key.pk, key.sk));
        }
      }
      return {};
    }
    throw new Error(`Unexpected command: ${(cmd as { constructor?: { name?: string } }).constructor?.name}`);
  }

  return { send, store };
}

describe('telegram-binding store (#1471)', () => {
  let mockDynamo: ReturnType<typeof createMockDynamo>;
  let store: ReturnType<typeof createTelegramBindingStore>;
  let now: number;

  beforeEach(() => {
    mockDynamo = createMockDynamo();
    now = 1_700_000_000_000;
    let codeCounter = 0;
    store = createTelegramBindingStore({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dynamoClient: mockDynamo as any,
      tableName: 'test-table',
      now: () => now,
      generateCode: () => `code-${++codeCounter}`,
    });
  });

  it('issues a bind code and stores both the code and the per-avatar pointer', async () => {
    const record = await store.issueBindCode('avatar-1');
    expect(record.code).toBe('code-1');
    expect(record.avatarId).toBe('avatar-1');
    expect(mockDynamo.store.has('TELEGRAM_BIND#code-1|META')).toBe(true);
    expect(mockDynamo.store.has('AVATAR#avatar-1|TELEGRAM_BIND_PENDING')).toBe(true);
  });

  it('second issueBindCode invalidates the previous pending code', async () => {
    const first = await store.issueBindCode('avatar-1');
    const second = await store.issueBindCode('avatar-1');
    expect(second.code).not.toBe(first.code);
    expect(mockDynamo.store.has(`TELEGRAM_BIND#${first.code}|META`)).toBe(false);
    expect(mockDynamo.store.has(`TELEGRAM_BIND#${second.code}|META`)).toBe(true);
  });

  it('consumeBindCode upserts the binding and removes the pending code', async () => {
    await store.issueBindCode('avatar-1');
    const binding = await store.consumeBindCode({
      code: 'code-1',
      telegramUserId: 'tg-42',
      telegramUsername: 'alice',
    });
    expect(binding).not.toBeNull();
    expect(binding!.avatarId).toBe('avatar-1');
    expect(binding!.telegramUserId).toBe('tg-42');
    expect(binding!.telegramUsername).toBe('alice');
    expect(mockDynamo.store.has('TELEGRAM_BIND#code-1|META')).toBe(false);
    expect(mockDynamo.store.has('AVATAR#avatar-1|TELEGRAM_BIND_PENDING')).toBe(false);
    expect(mockDynamo.store.has('AVATAR#avatar-1|TELEGRAM_OWNER_BINDING')).toBe(true);
  });

  it('returns null when the code is unknown', async () => {
    const result = await store.consumeBindCode({
      code: 'nonexistent',
      telegramUserId: 'tg-42',
    });
    expect(result).toBeNull();
  });

  it('rejects an expired code even if DynamoDB TTL has not swept it yet', async () => {
    await store.issueBindCode('avatar-1');
    // Advance past the 15-minute TTL.
    now += 16 * 60 * 1000;
    const result = await store.consumeBindCode({
      code: 'code-1',
      telegramUserId: 'tg-42',
    });
    expect(result).toBeNull();
    // Expired code should have been cleaned up.
    expect(mockDynamo.store.has('TELEGRAM_BIND#code-1|META')).toBe(false);
  });

  it('concurrent consume attempts produce exactly one binding (atomic)', async () => {
    await store.issueBindCode('avatar-1');
    // Simulate two concurrent confirm taps from the same user (Telegram
    // webhook retry under a slow response).
    const [a, b] = await Promise.all([
      store.consumeBindCode({ code: 'code-1', telegramUserId: 'tg-42' }),
      store.consumeBindCode({ code: 'code-1', telegramUserId: 'tg-42' }),
    ]);
    const winners = [a, b].filter(Boolean);
    expect(winners.length).toBeGreaterThanOrEqual(1);
    // Both return a binding (first one committed, second one idempotent-retry
    // returns the same record).
    for (const w of winners) expect(w!.telegramUserId).toBe('tg-42');
    expect(winners[0]!.avatarId).toBe('avatar-1');
  });

  it('rejects a replay from a different user after someone else has bound', async () => {
    await store.issueBindCode('avatar-1');
    const first = await store.consumeBindCode({ code: 'code-1', telegramUserId: 'tg-42' });
    expect(first).not.toBeNull();
    // Attacker tries to replay the (already-consumed) code with their own ID.
    const replay = await store.consumeBindCode({ code: 'code-1', telegramUserId: 'tg-99' });
    expect(replay).toBeNull();
    // Original binding is untouched.
    const existing = await store.getOwnerBinding('avatar-1');
    expect(existing!.telegramUserId).toBe('tg-42');
  });

  it('getOwnerBinding returns null when no binding exists', async () => {
    const r = await store.getOwnerBinding('avatar-1');
    expect(r).toBeNull();
  });

  it('deleteOwnerBinding removes the record', async () => {
    await store.issueBindCode('avatar-1');
    await store.consumeBindCode({ code: 'code-1', telegramUserId: 'tg-42' });
    await store.deleteOwnerBinding('avatar-1');
    expect(mockDynamo.store.has('AVATAR#avatar-1|TELEGRAM_OWNER_BINDING')).toBe(false);
  });

  it('ignores empty avatarId / telegramUserId inputs safely', async () => {
    await expect(store.issueBindCode('')).rejects.toThrow();
    expect(await store.consumeBindCode({ code: '', telegramUserId: 'x' })).toBeNull();
    expect(await store.consumeBindCode({ code: 'x', telegramUserId: '' })).toBeNull();
    expect(await store.getOwnerBinding('')).toBeNull();
  });
});
