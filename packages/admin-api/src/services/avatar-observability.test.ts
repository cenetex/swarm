/**
 * Tests for avatar-observability recordLogBatch chunking and retry behavior.
 *
 * Uses the dependency-injection variant (recordLogBatchWith) with an
 * in-memory DynamoDB mock to verify:
 *   - Input is chunked (not truncated) for batches > 25
 *   - UnprocessedItems are retried with exponential backoff
 *   - Residual failures after retries are surfaced in the result
 */
import { describe, it, expect, vi } from 'vitest';
import {
  recordLogBatchWith,
  type RecordLogBatchDeps,
} from './avatar-observability.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build N minimal log entries for a given avatar */
function makeEntries(count: number, avatarId = 'avatar-1') {
  return Array.from({ length: count }, (_, i) => ({
    avatarId,
    level: 'INFO' as const,
    subsystem: 'test',
    event: `event-${i}`,
    message: `message ${i}`,
  }));
}

const TABLE = 'test-admin';

/** A no-op delay that resolves immediately (avoids real timers in tests) */
const instantDelay = () => Promise.resolve();

/** Create deps with a configurable send mock */
function makeDeps(
  sendFn: (cmd: unknown) => Promise<unknown>,
): RecordLogBatchDeps {
  return {
    dynamoClient: { send: sendFn },
    tableName: TABLE,
    delay: instantDelay,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('recordLogBatchWith', () => {
  // --------------------------------------------------------------------------
  // Basic behavior
  // --------------------------------------------------------------------------

  it('returns zeros for empty input', async () => {
    const send = vi.fn(async () => ({}));
    const result = await recordLogBatchWith(makeDeps(send), []);
    expect(result).toEqual({ totalEntries: 0, writtenCount: 0, droppedCount: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it('writes a small batch (< 25) in a single BatchWriteCommand', async () => {
    const send = vi.fn(async () => ({ UnprocessedItems: {} }));
    const entries = makeEntries(10);

    const result = await recordLogBatchWith(makeDeps(send), entries);

    expect(result).toEqual({ totalEntries: 10, writtenCount: 10, droppedCount: 0 });
    expect(send).toHaveBeenCalledTimes(1);

    // Verify the command contains 10 items for the correct table
    const cmd = send.mock.calls[0][0] as { input: { RequestItems: Record<string, unknown[]> } };
    expect(cmd.input.RequestItems[TABLE]).toHaveLength(10);
  });

  it('writes exactly 25 entries in a single BatchWriteCommand', async () => {
    const send = vi.fn(async () => ({ UnprocessedItems: {} }));
    const entries = makeEntries(25);

    const result = await recordLogBatchWith(makeDeps(send), entries);

    expect(result).toEqual({ totalEntries: 25, writtenCount: 25, droppedCount: 0 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  // --------------------------------------------------------------------------
  // Chunking (no truncation)
  // --------------------------------------------------------------------------

  it('chunks 30 entries into two BatchWriteCommand calls (25 + 5)', async () => {
    const send = vi.fn(async () => ({ UnprocessedItems: {} }));
    const entries = makeEntries(30);

    const result = await recordLogBatchWith(makeDeps(send), entries);

    expect(result).toEqual({ totalEntries: 30, writtenCount: 30, droppedCount: 0 });
    expect(send).toHaveBeenCalledTimes(2);

    const firstBatch = (send.mock.calls[0][0] as { input: { RequestItems: Record<string, unknown[]> } })
      .input.RequestItems[TABLE];
    const secondBatch = (send.mock.calls[1][0] as { input: { RequestItems: Record<string, unknown[]> } })
      .input.RequestItems[TABLE];
    expect(firstBatch).toHaveLength(25);
    expect(secondBatch).toHaveLength(5);
  });

  it('chunks 75 entries into three BatchWriteCommand calls (25 + 25 + 25)', async () => {
    const send = vi.fn(async () => ({ UnprocessedItems: {} }));
    const entries = makeEntries(75);

    const result = await recordLogBatchWith(makeDeps(send), entries);

    expect(result).toEqual({ totalEntries: 75, writtenCount: 75, droppedCount: 0 });
    expect(send).toHaveBeenCalledTimes(3);
  });

  // --------------------------------------------------------------------------
  // UnprocessedItems retry
  // --------------------------------------------------------------------------

  it('retries UnprocessedItems and succeeds on second attempt', async () => {
    const unprocessedItem = {
      PutRequest: {
        Item: {
          pk: 'AVATAR#avatar-1',
          sk: 'LOG#123#abc',
          id: 'log-retry',
        },
      },
    };

    let callCount = 0;
    const send = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        // First call: 1 item unprocessed
        return {
          UnprocessedItems: {
            [TABLE]: [unprocessedItem],
          },
        };
      }
      // Second call: all processed
      return { UnprocessedItems: {} };
    });

    const entries = makeEntries(5);
    const result = await recordLogBatchWith(makeDeps(send), entries);

    expect(result).toEqual({ totalEntries: 5, writtenCount: 5, droppedCount: 0 });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('retries up to 3 times and reports dropped items when retries exhausted', async () => {
    const unprocessedItems = [
      {
        PutRequest: {
          Item: {
            pk: 'AVATAR#avatar-1',
            sk: 'LOG#123#abc',
            id: 'log-stuck',
          },
        },
      },
      {
        PutRequest: {
          Item: {
            pk: 'AVATAR#avatar-1',
            sk: 'LOG#124#def',
            id: 'log-stuck-2',
          },
        },
      },
    ];

    // Always return the same 2 items as unprocessed
    const send = vi.fn(async () => ({
      UnprocessedItems: {
        [TABLE]: unprocessedItems,
      },
    }));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const entries = makeEntries(5);
    const result = await recordLogBatchWith(makeDeps(send), entries);

    // 1 initial attempt + 3 retries = 4 calls
    expect(send).toHaveBeenCalledTimes(4);
    expect(result.totalEntries).toBe(5);
    expect(result.droppedCount).toBe(2);
    expect(result.writtenCount).toBe(3);

    // Verify warning was emitted
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('2 items dropped after 3 retries')
    );

    warnSpy.mockRestore();
  });

  it('calls delay with exponential backoff on retries', async () => {
    const delayMock = vi.fn(async () => {});

    const unprocessedItem = {
      PutRequest: {
        Item: { pk: 'AVATAR#a', sk: 'LOG#1#x', id: 'log-x' },
      },
    };

    let callCount = 0;
    const send = vi.fn(async () => {
      callCount++;
      if (callCount <= 3) {
        return { UnprocessedItems: { [TABLE]: [unprocessedItem] } };
      }
      return { UnprocessedItems: {} };
    });

    const deps: RecordLogBatchDeps = {
      dynamoClient: { send },
      tableName: TABLE,
      delay: delayMock,
    };

    await recordLogBatchWith(deps, makeEntries(3));

    // 3 retries = 3 delay calls (attempt 1, 2, 3)
    expect(delayMock).toHaveBeenCalledTimes(3);
    expect(delayMock).toHaveBeenNthCalledWith(1, 100);  // 100 * 2^0
    expect(delayMock).toHaveBeenNthCalledWith(2, 200);  // 100 * 2^1
    expect(delayMock).toHaveBeenNthCalledWith(3, 400);  // 100 * 2^2
  });

  // --------------------------------------------------------------------------
  // Chunking + retry combined
  // --------------------------------------------------------------------------

  it('retries UnprocessedItems independently per chunk', async () => {
    let callCount = 0;
    const send = vi.fn(async (cmd: unknown) => {
      callCount++;
      const batchCmd = cmd as { input: { RequestItems: Record<string, unknown[]> } };
      const items = batchCmd.input.RequestItems[TABLE];

      // First chunk (25 items): first call returns 2 unprocessed, retry succeeds
      if (callCount === 1) {
        return {
          UnprocessedItems: {
            [TABLE]: items.slice(0, 2),
          },
        };
      }
      // All other calls succeed fully
      return { UnprocessedItems: {} };
    });

    const entries = makeEntries(30);
    const result = await recordLogBatchWith(makeDeps(send), entries);

    expect(result).toEqual({ totalEntries: 30, writtenCount: 30, droppedCount: 0 });
    // Chunk 1: initial call (25) + retry (2) = 2 calls
    // Chunk 2: initial call (5) = 1 call
    expect(send).toHaveBeenCalledTimes(3);
  });

  // --------------------------------------------------------------------------
  // Item structure verification
  // --------------------------------------------------------------------------

  it('produces correct DynamoDB item structure with pk, sk, gsi1pk, gsi1sk, ttl', async () => {
    const send = vi.fn(async () => ({ UnprocessedItems: {} }));
    const entries = [
      {
        avatarId: 'avatar-42',
        level: 'ERROR' as const,
        subsystem: 'llm',
        event: 'rate_limited',
        message: 'API returned 429',
        data: { code: 429 },
        requestId: 'req-abc',
        platform: 'telegram',
      },
    ];

    await recordLogBatchWith(makeDeps(send), entries);

    const cmd = send.mock.calls[0][0] as { input: { RequestItems: Record<string, unknown[]> } };
    const items = cmd.input.RequestItems[TABLE];
    expect(items).toHaveLength(1);

    const item = (items[0] as { PutRequest: { Item: Record<string, unknown> } }).PutRequest.Item;
    expect(item.pk).toBe('AVATAR#avatar-42');
    expect((item.sk as string).startsWith('LOG#')).toBe(true);
    expect(item.gsi1pk).toBe('LOGS#ERROR');
    expect(typeof item.gsi1sk).toBe('number');
    expect(typeof item.ttl).toBe('number');
    expect(item.avatarId).toBe('avatar-42');
    expect(item.level).toBe('ERROR');
    expect(item.subsystem).toBe('llm');
    expect(item.event).toBe('rate_limited');
    expect(item.message).toBe('API returned 429');
    expect(item.data).toEqual({ code: 429 });
    expect(item.requestId).toBe('req-abc');
    expect(item.platform).toBe('telegram');
  });
});
