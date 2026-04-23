/**
 * Regression test for #1466.
 *
 * `getKnownTelegramUsers` used to run an unbounded `ScanCommand` against the
 * entire ADMIN_TABLE with only a post-scan `FilterExpression`. Each admin-UI
 * poll paid per-scanned-item on data that had nothing to do with Telegram.
 *
 * These tests pin: (a) pagination follows LastEvaluatedKey up to the cap,
 * (b) early-exit kicks in once we have enough results, (c) the return shape
 * is unchanged for small tenants.
 */
import { describe, it, expect } from 'bun:test';

process.env.ADMIN_TABLE = process.env.ADMIN_TABLE || 'ADMIN_TABLE_TEST';

import type { ChannelStateRecord } from '../types.js';
import { getKnownTelegramUsers, type KnownTelegramUsersDeps } from './channel-state.js';

function makeState(overrides: Partial<ChannelStateRecord> = {}): ChannelStateRecord {
  const now = Date.now();
  return {
    pk: 'CHANNEL#a1#1001',
    sk: 'STATE',
    avatarId: 'a1',
    chatId: 1001,
    chatType: 'group',
    chatTitle: 'Test Group',
    state: 'IDLE',
    stateChangedAt: now,
    messageBuffer: [
      { messageId: 1, userId: 42, userName: 'Alice', username: 'alice', text: 'hi', timestamp: now, isMention: false },
    ],
    bufferSize: 1,
    lastActivityAt: now,
    ttl: Math.floor(now / 1000) + 3600,
    updatedAt: now,
    ...overrides,
  };
}

describe('getKnownTelegramUsers (#1466)', () => {
  it('returns a single page when there is no LastEvaluatedKey', async () => {
    let calls = 0;
    const deps: KnownTelegramUsersDeps = {
      scan: async () => {
        calls++;
        return { items: [makeState()] };
      },
    };
    const users = await getKnownTelegramUsers('a1', deps);
    expect(users).toHaveLength(1);
    expect(users[0].userId).toBe(42);
    expect(calls).toBe(1);
  });

  it('follows LastEvaluatedKey across pages', async () => {
    const pages = [
      {
        items: [makeState({ pk: 'CHANNEL#a1#1', chatId: 1, messageBuffer: [{ messageId: 1, userId: 1, userName: 'U1', timestamp: Date.now(), isMention: false }] })],
        lastEvaluatedKey: { pk: 'CHANNEL#a1#1', sk: 'STATE' },
      },
      {
        items: [makeState({ pk: 'CHANNEL#a1#2', chatId: 2, messageBuffer: [{ messageId: 2, userId: 2, userName: 'U2', timestamp: Date.now(), isMention: false }] })],
        lastEvaluatedKey: undefined,
      },
    ];

    let callIndex = 0;
    const deps: KnownTelegramUsersDeps = {
      scan: async () => pages[callIndex++],
    };

    const users = await getKnownTelegramUsers('a1', deps);
    expect(users.map(u => u.userId).sort()).toEqual([1, 2]);
    expect(callIndex).toBe(2);
  });

  it('stops at the max-pages cap even if more pages exist', async () => {
    let calls = 0;
    const deps: KnownTelegramUsersDeps = {
      scan: async () => {
        calls++;
        return {
          items: [makeState({
            pk: `CHANNEL#a1#${calls}`,
            chatId: calls,
            messageBuffer: [{ messageId: calls, userId: calls, userName: `U${calls}`, timestamp: Date.now(), isMention: false }],
          })],
          lastEvaluatedKey: { pk: `CHANNEL#a1#${calls}`, sk: 'STATE' },
        };
      },
    };

    await getKnownTelegramUsers('a1', deps);
    expect(calls).toBe(5);
  });

  it('early-exits once the result cap is reached', async () => {
    // 250 users in one page — more than the 200 cap. Should stop after page 1.
    const messageBuffer = Array.from({ length: 250 }, (_, i) => ({
      messageId: i,
      userId: i,
      userName: `U${i}`,
      timestamp: Date.now() + i,
      isMention: false,
    }));
    let calls = 0;
    const deps: KnownTelegramUsersDeps = {
      scan: async () => {
        calls++;
        return {
          items: [makeState({ messageBuffer, bufferSize: messageBuffer.length })],
          lastEvaluatedKey: { pk: 'next', sk: 'STATE' },
        };
      },
    };

    const users = await getKnownTelegramUsers('a1', deps);
    expect(users).toHaveLength(200);
    expect(calls).toBe(1);
  });

  it('skips expired channel states', async () => {
    const expiredState = makeState({
      ttl: Math.floor(Date.now() / 1000) - 10,
      messageBuffer: [{ messageId: 99, userId: 99, userName: 'Expired', timestamp: Date.now(), isMention: false }],
    });
    const deps: KnownTelegramUsersDeps = {
      scan: async () => ({ items: [expiredState] }),
    };
    const users = await getKnownTelegramUsers('a1', deps);
    expect(users).toEqual([]);
  });

  it('sorts by lastSeen descending', async () => {
    const now = Date.now();
    const deps: KnownTelegramUsersDeps = {
      scan: async () => ({
        items: [
          makeState({ messageBuffer: [
            { messageId: 1, userId: 1, userName: 'Old', timestamp: now - 10_000, isMention: false },
            { messageId: 2, userId: 2, userName: 'New', timestamp: now, isMention: false },
          ] }),
        ],
      }),
    };
    const users = await getKnownTelegramUsers('a1', deps);
    expect(users.map(u => u.userId)).toEqual([2, 1]);
  });

  it('returns empty when the scan throws', async () => {
    const deps: KnownTelegramUsersDeps = {
      scan: async () => { throw new Error('DynamoDB exploded'); },
    };
    const users = await getKnownTelegramUsers('a1', deps);
    expect(users).toEqual([]);
  });
});
