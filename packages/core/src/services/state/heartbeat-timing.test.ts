import { describe, it, expect, beforeEach } from 'vitest';
import { getLastHeartbeat, setLastHeartbeat } from './heartbeat-timing.js';

// ---------------------------------------------------------------------------
// In-memory DynamoDB mock
// ---------------------------------------------------------------------------
const store = new Map<string, Record<string, unknown>>();

function makeKey(pk: string, sk: string): string {
  return `${pk}|${sk}`;
}

const mockDocClient = {
  send: async (command: unknown) => {
    const cmd = command as { input: Record<string, unknown>; constructor: { name: string } };
    const name = cmd.constructor.name;

    if (name === 'GetCommand') {
      const input = cmd.input as { Key: { pk: string; sk: string } };
      const key = makeKey(input.Key.pk, input.Key.sk);
      const item = store.get(key);
      return { Item: item ?? undefined };
    }

    if (name === 'PutCommand') {
      const input = cmd.input as { Item: Record<string, unknown> & { pk: string; sk: string } };
      const key = makeKey(input.Item.pk, input.Item.sk);
      store.set(key, { ...input.Item });
      return {};
    }

    throw new Error(`Unexpected command: ${name}`);
  },
} as never;

const TABLE = 'test-state-table';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('heartbeat-timing', () => {
  beforeEach(() => {
    store.clear();
  });

  describe('getLastHeartbeat', () => {
    it('returns 0 when no record exists', async () => {
      const result = await getLastHeartbeat(mockDocClient, TABLE, 'avatar-1', 'twitter');
      expect(result).toBe(0);
    });

    it('returns the stored timestamp for a specific platform', async () => {
      const key = makeKey('AVATAR#avatar-1', 'HEARTBEAT#twitter');
      store.set(key, { pk: 'AVATAR#avatar-1', sk: 'HEARTBEAT#twitter', timestamp: 1700000000000 });

      const result = await getLastHeartbeat(mockDocClient, TABLE, 'avatar-1', 'twitter');
      expect(result).toBe(1700000000000);
    });

    it('returns different timestamps for different platforms', async () => {
      store.set(makeKey('AVATAR#avatar-1', 'HEARTBEAT#twitter'), {
        pk: 'AVATAR#avatar-1', sk: 'HEARTBEAT#twitter', timestamp: 1000,
      });
      store.set(makeKey('AVATAR#avatar-1', 'HEARTBEAT#discord'), {
        pk: 'AVATAR#avatar-1', sk: 'HEARTBEAT#discord', timestamp: 2000,
      });

      expect(await getLastHeartbeat(mockDocClient, TABLE, 'avatar-1', 'twitter')).toBe(1000);
      expect(await getLastHeartbeat(mockDocClient, TABLE, 'avatar-1', 'discord')).toBe(2000);
    });

    it('returns different timestamps for different avatars', async () => {
      store.set(makeKey('AVATAR#avatar-1', 'HEARTBEAT#twitter'), {
        pk: 'AVATAR#avatar-1', sk: 'HEARTBEAT#twitter', timestamp: 1000,
      });
      store.set(makeKey('AVATAR#avatar-2', 'HEARTBEAT#twitter'), {
        pk: 'AVATAR#avatar-2', sk: 'HEARTBEAT#twitter', timestamp: 3000,
      });

      expect(await getLastHeartbeat(mockDocClient, TABLE, 'avatar-1', 'twitter')).toBe(1000);
      expect(await getLastHeartbeat(mockDocClient, TABLE, 'avatar-2', 'twitter')).toBe(3000);
    });
  });

  describe('setLastHeartbeat', () => {
    it('writes correct DynamoDB item with platform in sort key', async () => {
      await setLastHeartbeat(mockDocClient, TABLE, 'avatar-1', 'twitter', 1700000000000);

      const key = makeKey('AVATAR#avatar-1', 'HEARTBEAT#twitter');
      const item = store.get(key);

      expect(item).toBeDefined();
      expect(item!.pk).toBe('AVATAR#avatar-1');
      expect(item!.sk).toBe('HEARTBEAT#twitter');
      expect(item!.platform).toBe('twitter');
      expect(item!.timestamp).toBe(1700000000000);
      expect(item!.updatedAt).toBeTypeOf('number');
    });

    it('overwrites existing heartbeat for same avatar and platform', async () => {
      await setLastHeartbeat(mockDocClient, TABLE, 'avatar-1', 'twitter', 1000);
      await setLastHeartbeat(mockDocClient, TABLE, 'avatar-1', 'twitter', 2000);

      const result = await getLastHeartbeat(mockDocClient, TABLE, 'avatar-1', 'twitter');
      expect(result).toBe(2000);
    });

    it('creates separate records for different platforms', async () => {
      await setLastHeartbeat(mockDocClient, TABLE, 'avatar-1', 'twitter', 1000);
      await setLastHeartbeat(mockDocClient, TABLE, 'avatar-1', 'discord', 2000);

      expect(store.size).toBe(2);
      expect(await getLastHeartbeat(mockDocClient, TABLE, 'avatar-1', 'twitter')).toBe(1000);
      expect(await getLastHeartbeat(mockDocClient, TABLE, 'avatar-1', 'discord')).toBe(2000);
    });
  });
});
