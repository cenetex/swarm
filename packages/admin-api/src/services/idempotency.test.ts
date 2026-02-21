/**
 * Idempotency Store Tests
 *
 * Tests for the DynamoDB-backed idempotency store covering:
 * 1. DynamoDB-backed deduplication (get/set via DynamoDB)
 * 2. Atomic check-and-set (ConditionalCheckFailedException)
 * 3. Concurrent/race condition scenarios
 * 4. Fallback to in-memory when DynamoDB fails
 * 5. TTL / expiration behavior
 * 6. Cold start resilience (DynamoDB persists across instances)
 */

import { describe, it, expect, vi } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createIdempotencyStore } from './idempotency.js';

// Ensure env is set before module evaluation
process.env.ADMIN_TABLE = process.env.ADMIN_TABLE || 'ADMIN_TABLE_TEST';

// ── Test-local DynamoDB client helper ───────────────────────────────────────
function createTestStore<T>(params?: {
  now?: () => number;
  ttlMs?: number;
}) {
  const mockSend = vi.fn(() => Promise.resolve({} as unknown));
  const mockClient = {
    send: mockSend,
  } as unknown as DynamoDBDocumentClient;

  const store = createIdempotencyStore<T>({
    ...params,
    dynamoClient: mockClient,
  });

  return { store, mockSend };
}

// ============================================================================
// DynamoDB-backed deduplication
// ============================================================================
describe('DynamoDB-backed idempotency store', () => {
  it('should set a value in DynamoDB and return true on first write', async () => {
    const { store, mockSend } = createTestStore<string>();
    mockSend.mockResolvedValueOnce({}); // PutCommand succeeds
    const result = await store.set('key-1', 'value-1');

    expect(result).toBe(true);
    expect(mockSend).toHaveBeenCalledTimes(1);

    // Verify the PutCommand was called with correct parameters
    const putCall = mockSend.mock.calls[0][0];
    expect(putCall.input.Item.pk).toBe('IDEMPOTENCY#key-1');
    expect(putCall.input.Item.sk).toBe('IDEMPOTENCY');
    expect(putCall.input.Item.value).toBe('value-1');
    expect(putCall.input.ConditionExpression).toContain('attribute_not_exists(pk)');
  });

  it('should retrieve a value from DynamoDB', async () => {
    const nowMs = 1000000;
    const { store, mockSend } = createTestStore<string>({ now: () => nowMs });

    mockSend.mockResolvedValueOnce({
      Item: {
        pk: 'IDEMPOTENCY#key-1',
        sk: 'IDEMPOTENCY',
        value: 'cached-value',
        ttl: Math.floor(nowMs / 1000) + 300, // 5 minutes in the future
      },
    });

    const result = await store.get('key-1');
    expect(result).toBe('cached-value');
  });

  it('should return null when key does not exist in DynamoDB', async () => {
    const { store, mockSend } = createTestStore<string>();
    mockSend.mockResolvedValueOnce({ Item: undefined });
    const result = await store.get('nonexistent');

    expect(result).toBeNull();
  });

  it('should store complex objects as values', async () => {
    const { store, mockSend } = createTestStore<{ statusCode: number; body: string }>();
    mockSend.mockResolvedValueOnce({}); // PutCommand
    const value = { statusCode: 200, body: '{"ok": true}' };

    const result = await store.set('request-abc', value);
    expect(result).toBe(true);

    const putCall = mockSend.mock.calls[0][0];
    expect(putCall.input.Item.value).toEqual(value);
  });
});

// ============================================================================
// Atomic check-and-set (race conditions)
// ============================================================================
describe('atomic check-and-set', () => {
  it('should return false when ConditionalCheckFailedException is thrown (duplicate key)', async () => {
    const { store, mockSend } = createTestStore<string>();
    const error = new ConditionalCheckFailedException({
      message: 'The conditional request failed',
      $metadata: {},
    });
    mockSend.mockRejectedValueOnce(error);
    const result = await store.set('dup-key', 'value');

    expect(result).toBe(false);
  });

  it('should return false for error with name ConditionalCheckFailedException', async () => {
    const { store, mockSend } = createTestStore<string>();
    // Some SDK versions may throw a plain Error with the name set
    const error = new Error('The conditional request failed');
    error.name = 'ConditionalCheckFailedException';
    mockSend.mockRejectedValueOnce(error);
    const result = await store.set('dup-key', 'value');

    expect(result).toBe(false);
  });

  it('should handle concurrent set calls - first wins, second detects duplicate', async () => {
    const { store, mockSend } = createTestStore<string>();
    // First call succeeds
    mockSend.mockResolvedValueOnce({});
    // Second call gets ConditionalCheckFailedException
    const error = new ConditionalCheckFailedException({
      message: 'The conditional request failed',
      $metadata: {},
    });
    mockSend.mockRejectedValueOnce(error);

    const [result1, result2] = await Promise.all([
      store.set('race-key', 'first'),
      store.set('race-key', 'second'),
    ]);

    // One should succeed, one should fail
    expect(result1).toBe(true);
    expect(result2).toBe(false);
  });
});

// ============================================================================
// Fallback to in-memory when DynamoDB fails
// ============================================================================
describe('fallback to in-memory store', () => {
  it('should fall back to in-memory on DynamoDB get failure', async () => {
    const nowMs = 1000;
    const { store, mockSend } = createTestStore<string>({ now: () => nowMs, ttlMs: 5000 });

    // First set succeeds in DynamoDB (also populates memory store)
    mockSend.mockResolvedValueOnce({});
    await store.set('fallback-key', 'hello');

    // Get fails in DynamoDB -- should return from in-memory fallback
    mockSend.mockRejectedValueOnce(new Error('DynamoDB unavailable'));
    const result = await store.get('fallback-key');

    expect(result).toBe('hello');
  });

  it('should fall back to in-memory on DynamoDB set failure (non-conditional)', async () => {
    const { store, mockSend } = createTestStore<string>();

    // DynamoDB set fails with a non-conditional error
    mockSend.mockRejectedValueOnce(new Error('Service unavailable'));
    const result = await store.set('fallback-set-key', 'value');

    // Should succeed via in-memory fallback
    expect(result).toBe(true);
  });

  it('should detect duplicates in memory fallback when DynamoDB is unavailable', async () => {
    const nowMs = 1000;
    const { store, mockSend } = createTestStore<string>({ now: () => nowMs, ttlMs: 5000 });

    // First set: DynamoDB fails, falls back to memory
    mockSend.mockRejectedValueOnce(new Error('Service unavailable'));
    const first = await store.set('mem-dup-key', 'value-1');
    expect(first).toBe(true);

    // Second set: DynamoDB also fails, memory detects duplicate
    mockSend.mockRejectedValueOnce(new Error('Service unavailable'));
    const second = await store.set('mem-dup-key', 'value-2');
    expect(second).toBe(false);
  });

  it('should treat null sentinel claims as duplicates in memory fallback', async () => {
    const nowMs = 1000;
    const { store, mockSend } = createTestStore<string | null>({ now: () => nowMs, ttlMs: 5000 });

    // First claim uses null sentinel (same as chat handler in-flight claim)
    mockSend.mockRejectedValueOnce(new Error('Service unavailable'));
    const first = await store.set('mem-null-sentinel-key', null);
    expect(first).toBe(true);

    // Second claim for same key must still be rejected
    mockSend.mockRejectedValueOnce(new Error('Service unavailable'));
    const second = await store.set('mem-null-sentinel-key', null);
    expect(second).toBe(false);
  });

  it('should allow re-claiming a null sentinel after fallback TTL expires', async () => {
    let nowMs = 1000;
    const { store, mockSend } = createTestStore<string | null>({ now: () => nowMs, ttlMs: 100 });

    // First claim via memory fallback
    mockSend.mockRejectedValueOnce(new Error('Service unavailable'));
    const first = await store.set('mem-null-expire-key', null);
    expect(first).toBe(true);

    // Advance beyond fallback TTL
    nowMs += 200;

    // Expired sentinel should no longer block a new claim
    mockSend.mockRejectedValueOnce(new Error('Service unavailable'));
    const second = await store.set('mem-null-expire-key', null);
    expect(second).toBe(true);
  });

  it('should return null from memory fallback when key not found anywhere', async () => {
    const { store, mockSend } = createTestStore<string>();

    // DynamoDB get fails
    mockSend.mockRejectedValueOnce(new Error('DynamoDB unavailable'));
    const result = await store.get('unknown-key');

    expect(result).toBeNull();
  });
});

// ============================================================================
// TTL / expiration behavior
// ============================================================================
describe('TTL behavior', () => {
  it('should set DynamoDB TTL attribute in epoch seconds', async () => {
    const nowMs = 1000000; // 1000 seconds in epoch ms
    const { store, mockSend } = createTestStore<string>({
      now: () => nowMs,
      ttlMs: 60_000, // 60 seconds
    });
    mockSend.mockResolvedValueOnce({});

    await store.set('ttl-key', 'value');

    const putCall = mockSend.mock.calls[0][0];
    // TTL should be now (in seconds) + ttlMs/1000
    expect(putCall.input.Item.ttl).toBe(Math.floor(nowMs / 1000) + 60);
  });

  it('should return null for expired records from DynamoDB', async () => {
    const nowMs = 2000000;
    const { store, mockSend } = createTestStore<string>({ now: () => nowMs });

    // Return a record that has already expired
    mockSend.mockResolvedValueOnce({
      Item: {
        pk: 'IDEMPOTENCY#expired-key',
        sk: 'IDEMPOTENCY',
        value: 'old-value',
        ttl: Math.floor(nowMs / 1000) - 1, // 1 second in the past
      },
    });

    const result = await store.get('expired-key');
    expect(result).toBeNull();
  });

  it('should return value for non-expired records from DynamoDB', async () => {
    const nowMs = 2000000;
    const { store, mockSend } = createTestStore<string>({ now: () => nowMs });

    mockSend.mockResolvedValueOnce({
      Item: {
        pk: 'IDEMPOTENCY#valid-key',
        sk: 'IDEMPOTENCY',
        value: 'fresh-value',
        ttl: Math.floor(nowMs / 1000) + 300, // 5 minutes in the future
      },
    });

    const result = await store.get('valid-key');
    expect(result).toBe('fresh-value');
  });

  it('should expire entries in the in-memory fallback', async () => {
    let nowMs = 1000;
    const { store, mockSend } = createTestStore<string>({ now: () => nowMs, ttlMs: 100 });

    // Set via memory fallback (DynamoDB fails)
    mockSend.mockRejectedValueOnce(new Error('DynamoDB unavailable'));
    await store.set('expiring-key', 'value');

    // Advance time past TTL
    nowMs += 200;

    // Get via memory fallback (DynamoDB also fails)
    mockSend.mockRejectedValueOnce(new Error('DynamoDB unavailable'));
    const result = await store.get('expiring-key');

    expect(result).toBeNull();
  });

  it('should allow overwrite of expired keys via condition expression', async () => {
    const { store, mockSend } = createTestStore<string>();
    // The condition expression includes `OR #ttl <= :now` to allow
    // overwriting expired records. Test that the set succeeds even
    // when the key existed but has expired.
    mockSend.mockResolvedValueOnce({}); // PutCommand succeeds (expired key overwritten)
    const result = await store.set('expired-overwrite', 'new-value');

    expect(result).toBe(true);
  });
});

// ============================================================================
// Cold start / cross-instance scenarios
// ============================================================================
describe('cold start resilience', () => {
  it('should retrieve value from DynamoDB even with empty in-memory store (simulates cold start)', async () => {
    const nowMs = 1000000;
    const { store, mockSend } = createTestStore<string>({ now: () => nowMs });

    // Create a "fresh" store (simulating cold start - empty memory)
    // DynamoDB has the record from a previous Lambda instance
    mockSend.mockResolvedValueOnce({
      Item: {
        pk: 'IDEMPOTENCY#cold-start-key',
        sk: 'IDEMPOTENCY',
        value: 'persisted-value',
        ttl: Math.floor(nowMs / 1000) + 300,
      },
    });

    const result = await store.get('cold-start-key');
    expect(result).toBe('persisted-value');
  });

  it('should prevent duplicate set across cold starts via DynamoDB', async () => {
    const nowMs = 1000000;
    const mockSend = vi.fn(() => Promise.resolve({} as unknown));
    const mockClient = {
      send: mockSend,
    } as unknown as DynamoDBDocumentClient;

    const store1 = createIdempotencyStore<string>({
      now: () => nowMs,
      dynamoClient: mockClient,
    });

    // First Lambda instance sets the key
    mockSend.mockResolvedValueOnce({}); // PutCommand succeeds
    const result1 = await store1.set('cross-instance-key', 'first');
    expect(result1).toBe(true);

    // Second Lambda instance (cold start) tries to set the same key
    const store2 = createIdempotencyStore<string>({
      now: () => nowMs,
      dynamoClient: mockClient,
    });
    const error = new ConditionalCheckFailedException({
      message: 'The conditional request failed',
      $metadata: {},
    });
    mockSend.mockRejectedValueOnce(error);
    const result2 = await store2.set('cross-instance-key', 'second');
    expect(result2).toBe(false);
  });
});

// ============================================================================
// clear() behavior
// ============================================================================
describe('clear', () => {
  it('should clear the in-memory fallback store', async () => {
    const nowMs = 1000;
    const { store, mockSend } = createTestStore<string>({ now: () => nowMs, ttlMs: 5000 });

    // Set via memory fallback
    mockSend.mockRejectedValueOnce(new Error('DynamoDB unavailable'));
    await store.set('clear-key', 'value');

    store.clear();

    // After clear, memory fallback should not have the key
    mockSend.mockRejectedValueOnce(new Error('DynamoDB unavailable'));
    const result = await store.get('clear-key');
    expect(result).toBeNull();
  });
});

// ============================================================================
// remove() behavior
// ============================================================================
describe('remove', () => {
  it('should send a DeleteCommand to DynamoDB', async () => {
    const { store, mockSend } = createTestStore<string>();

    // Set the key first
    mockSend.mockResolvedValueOnce({}); // PutCommand
    await store.set('remove-key', 'value');

    // Remove the key
    mockSend.mockResolvedValueOnce({}); // DeleteCommand
    await store.remove('remove-key');

    expect(mockSend).toHaveBeenCalledTimes(2);
    const deleteCall = mockSend.mock.calls[1][0];
    expect(deleteCall.input.Key.pk).toBe('IDEMPOTENCY#remove-key');
    expect(deleteCall.input.Key.sk).toBe('IDEMPOTENCY');
  });

  it('should remove the key from memory fallback', async () => {
    const nowMs = 1000;
    const { store, mockSend } = createTestStore<string>({ now: () => nowMs, ttlMs: 5000 });

    // Set via DynamoDB + memory
    mockSend.mockResolvedValueOnce({}); // PutCommand
    await store.set('mem-remove-key', 'value');

    // Remove succeeds in DynamoDB + memory
    mockSend.mockResolvedValueOnce({}); // DeleteCommand
    await store.remove('mem-remove-key');

    // Get falls back to memory -- key should be gone
    mockSend.mockRejectedValueOnce(new Error('DynamoDB unavailable'));
    const result = await store.get('mem-remove-key');
    expect(result).toBeNull();
  });

  it('should remove from memory even when DynamoDB delete fails', async () => {
    const nowMs = 1000;
    const { store, mockSend } = createTestStore<string>({ now: () => nowMs, ttlMs: 5000 });

    // Set via DynamoDB + memory
    mockSend.mockResolvedValueOnce({});
    await store.set('fail-remove-key', 'value');

    // Remove fails in DynamoDB
    mockSend.mockRejectedValueOnce(new Error('DynamoDB unavailable'));
    await store.remove('fail-remove-key');

    // Memory fallback should not have the key
    mockSend.mockRejectedValueOnce(new Error('DynamoDB unavailable'));
    const result = await store.get('fail-remove-key');
    expect(result).toBeNull();
  });

  it('should allow re-claiming a removed key', async () => {
    const { store, mockSend } = createTestStore<string>();

    // Set, remove, then set again
    mockSend.mockResolvedValueOnce({}); // first set
    await store.set('reclaim-key', 'first');

    mockSend.mockResolvedValueOnce({}); // remove
    await store.remove('reclaim-key');

    mockSend.mockResolvedValueOnce({}); // second set succeeds (key was removed)
    const result = await store.set('reclaim-key', 'second');
    expect(result).toBe(true);
  });
});

// ============================================================================
// Condition expression correctness
// ============================================================================
describe('condition expression', () => {
  it('should use attribute_not_exists(pk) with ttl expiry check', async () => {
    const nowMs = 1000000;
    const { store, mockSend } = createTestStore<string>({ now: () => nowMs });
    mockSend.mockResolvedValueOnce({});
    await store.set('cond-key', 'value');

    const putCall = mockSend.mock.calls[0][0];
    expect(putCall.input.ConditionExpression).toBe('attribute_not_exists(pk) OR #ttl <= :now');
    expect(putCall.input.ExpressionAttributeNames).toEqual({ '#ttl': 'ttl' });
    expect(putCall.input.ExpressionAttributeValues[':now']).toBe(Math.floor(nowMs / 1000));
  });
});
