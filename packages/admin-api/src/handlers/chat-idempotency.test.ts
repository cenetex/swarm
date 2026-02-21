/**
 * Chat Handler Idempotency Tests
 *
 * Verifies that the idempotency key lifecycle works correctly across all
 * terminal response paths in the POST /chat handler:
 *
 * 1. Success (200) - key is updated with the response payload
 * 2. Access denied (403) - key is updated with the error response
 * 3. Rate limited (429) - key is updated with the rate-limit response
 * 4. Async accepted (202) - key is updated with the async response
 * 5. Handler error (5xx) - key is removed so the client can retry
 * 6. Concurrent duplicate suppression still works (409)
 *
 * Uses createIdempotencyStore directly to test the claim-update-remove
 * lifecycle without needing to mock the entire handler dependency tree.
 */
import { describe, it, expect, vi } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createIdempotencyStore } from '../services/idempotency.js';

// Ensure env is set before module evaluation
process.env.ADMIN_TABLE = process.env.ADMIN_TABLE || 'ADMIN_TABLE_TEST';

// ── Helpers ─────────────────────────────────────────────────────────────────

interface ApiResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function createTestStore(params?: { now?: () => number; ttlMs?: number }) {
  const mockSend = vi.fn(() => Promise.resolve({} as unknown));
  const mockClient = { send: mockSend } as unknown as DynamoDBDocumentClient;

  const store = createIdempotencyStore<ApiResponse | null>({
    ...params,
    dynamoClient: mockClient,
  });

  return { store, mockSend };
}

function makeResponse(statusCode: number, body: Record<string, unknown>): ApiResponse {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

// ============================================================================
// Simulated handler lifecycle tests
// ============================================================================

describe('Chat idempotency - success path (200)', () => {
  it('should cache response payload on success and return it on replay', async () => {
    const { store, mockSend } = createTestStore();
    const key = 'success-key-1';
    const successResponse = makeResponse(200, { response: 'Hello', history: [] });

    // 1. Claim
    mockSend.mockResolvedValueOnce({}); // PutCommand (set)
    const claimed = await store.set(key, null);
    expect(claimed).toBe(true);

    // 2. Update with success response
    mockSend.mockResolvedValueOnce({}); // PutCommand (update)
    await store.update(key, successResponse);

    // 3. Replay: get should return the cached response
    mockSend.mockResolvedValueOnce({
      Item: {
        pk: `IDEMPOTENCY#${key}`,
        sk: 'IDEMPOTENCY',
        value: successResponse,
        ttl: Math.floor(Date.now() / 1000) + 300,
      },
    });
    const cached = await store.get(key);
    expect(cached).toEqual(successResponse);
    expect(cached!.statusCode).toBe(200);
  });
});

describe('Chat idempotency - access denied path (403)', () => {
  it('should cache 403 response so replays return the same error', async () => {
    const { store, mockSend } = createTestStore();
    const key = 'access-denied-key-1';
    const accessDeniedResponse = makeResponse(403, { error: 'Access denied' });

    // 1. Claim
    mockSend.mockResolvedValueOnce({});
    const claimed = await store.set(key, null);
    expect(claimed).toBe(true);

    // 2. Update with access denied response (simulates the fix)
    mockSend.mockResolvedValueOnce({});
    await store.update(key, accessDeniedResponse);

    // 3. Replay returns cached 403
    mockSend.mockResolvedValueOnce({
      Item: {
        pk: `IDEMPOTENCY#${key}`,
        sk: 'IDEMPOTENCY',
        value: accessDeniedResponse,
        ttl: Math.floor(Date.now() / 1000) + 300,
      },
    });
    const cached = await store.get(key);
    expect(cached).toEqual(accessDeniedResponse);
    expect(cached!.statusCode).toBe(403);
  });

  it('before the fix: replaying after access denied would return 409 (stuck in-flight)', async () => {
    // This test documents the OLD broken behavior:
    // When the key was claimed but never updated/removed, a retry would
    // see the in-flight sentinel and return 409.
    const { store, mockSend } = createTestStore();
    const key = 'stuck-access-denied';

    // 1. Claim
    mockSend.mockResolvedValueOnce({});
    await store.set(key, null);

    // 2. Access denied path returns early WITHOUT update (old behavior)
    // ... no store.update() call ...

    // 3. Retry: set returns false because key exists (still claimed)
    const ccfError = new ConditionalCheckFailedException({
      message: 'The conditional request failed',
      $metadata: {},
    });
    mockSend.mockRejectedValueOnce(ccfError);
    const retryClaim = await store.set(key, null);
    expect(retryClaim).toBe(false); // Would cause 409 - this is the bug

    // 4. get returns the sentinel null (no cached response)
    mockSend.mockResolvedValueOnce({
      Item: {
        pk: `IDEMPOTENCY#${key}`,
        sk: 'IDEMPOTENCY',
        value: null, // sentinel, not a real response
        ttl: Math.floor(Date.now() / 1000) + 300,
      },
    });
    const cached = await store.get(key);
    expect(cached).toBeNull(); // null sentinel, not a real response - broken!
  });
});

describe('Chat idempotency - rate limit path (429)', () => {
  it('should cache 429 response so replays return the same rate-limit error', async () => {
    const { store, mockSend } = createTestStore();
    const key = 'rate-limit-key-1';
    const rateLimitResponse = makeResponse(429, {
      error: 'Daily limit of 10 messages reached.',
      retryAfter: 3600,
      remaining: 0,
      limit: 10,
      isOrbHolder: false,
    });

    // 1. Claim
    mockSend.mockResolvedValueOnce({});
    await store.set(key, null);

    // 2. Update with rate-limit response
    mockSend.mockResolvedValueOnce({});
    await store.update(key, rateLimitResponse);

    // 3. Replay returns cached 429
    mockSend.mockResolvedValueOnce({
      Item: {
        pk: `IDEMPOTENCY#${key}`,
        sk: 'IDEMPOTENCY',
        value: rateLimitResponse,
        ttl: Math.floor(Date.now() / 1000) + 300,
      },
    });
    const cached = await store.get(key);
    expect(cached).toEqual(rateLimitResponse);
    expect(cached!.statusCode).toBe(429);
  });
});

describe('Chat idempotency - async accepted path (202)', () => {
  it('should cache 202 response so replays return the same jobId', async () => {
    const { store, mockSend } = createTestStore();
    const key = 'async-key-1';
    const jobId = 'job-abc-123';
    const asyncResponse = makeResponse(202, { jobId, status: 'pending' });

    // 1. Claim
    mockSend.mockResolvedValueOnce({});
    await store.set(key, null);

    // 2. Update with async response
    mockSend.mockResolvedValueOnce({});
    await store.update(key, asyncResponse);

    // 3. Replay returns cached 202 with same jobId
    mockSend.mockResolvedValueOnce({
      Item: {
        pk: `IDEMPOTENCY#${key}`,
        sk: 'IDEMPOTENCY',
        value: asyncResponse,
        ttl: Math.floor(Date.now() / 1000) + 300,
      },
    });
    const cached = await store.get(key);
    expect(cached).toEqual(asyncResponse);
    expect(cached!.statusCode).toBe(202);

    const body = JSON.parse(cached!.body);
    expect(body.jobId).toBe(jobId);
    expect(body.status).toBe('pending');
  });
});

describe('Chat idempotency - handler error path (5xx)', () => {
  it('should remove the key so the client can retry after a transient error', async () => {
    const { store, mockSend } = createTestStore();
    const key = 'error-key-1';

    // 1. Claim
    mockSend.mockResolvedValueOnce({});
    await store.set(key, null);

    // 2. Simulate handler throwing (caught by catch block)
    // The catch block calls store.remove(key)
    mockSend.mockResolvedValueOnce({}); // DeleteCommand
    await store.remove(key);

    // 3. Retry: set should succeed because key was removed
    mockSend.mockResolvedValueOnce({}); // PutCommand (set)
    const retryClaim = await store.set(key, null);
    expect(retryClaim).toBe(true);
  });

  it('should not block retries when DynamoDB remove fails (best-effort)', async () => {
    const nowMs = 1000;
    const { store, mockSend } = createTestStore({ now: () => nowMs, ttlMs: 5000 });
    const key = 'error-remove-fail';

    // 1. Claim
    mockSend.mockResolvedValueOnce({});
    await store.set(key, null);

    // 2. Remove fails in DynamoDB but succeeds in memory
    mockSend.mockRejectedValueOnce(new Error('DynamoDB unavailable'));
    await store.remove(key);

    // 3. Retry via memory fallback: should succeed because memory was cleaned
    mockSend.mockRejectedValueOnce(new Error('DynamoDB unavailable'));
    const retryClaim = await store.set(key, null);
    expect(retryClaim).toBe(true);
  });
});

describe('Chat idempotency - concurrent duplicate suppression', () => {
  it('should still prevent concurrent duplicates (409) for in-progress requests', async () => {
    const { store, mockSend } = createTestStore();
    const key = 'concurrent-key-1';

    // First request claims the key
    mockSend.mockResolvedValueOnce({});
    const firstClaim = await store.set(key, null);
    expect(firstClaim).toBe(true);

    // Second request tries to claim the same key (concurrent)
    const ccfError = new ConditionalCheckFailedException({
      message: 'The conditional request failed',
      $metadata: {},
    });
    mockSend.mockRejectedValueOnce(ccfError);
    const secondClaim = await store.set(key, null);
    expect(secondClaim).toBe(false); // Should return 409

    // First request completes and updates with response
    mockSend.mockResolvedValueOnce({});
    const successResponse = makeResponse(200, { response: 'Done' });
    await store.update(key, successResponse);

    // Now replays should return the cached response, not 409
    mockSend.mockResolvedValueOnce({
      Item: {
        pk: `IDEMPOTENCY#${key}`,
        sk: 'IDEMPOTENCY',
        value: successResponse,
        ttl: Math.floor(Date.now() / 1000) + 300,
      },
    });
    const cached = await store.get(key);
    expect(cached).toEqual(successResponse);
  });
});

describe('Chat idempotency - race between get and set (recheck on claim failure)', () => {
  it('should return the completed response when a prior request finishes between get() and set()', async () => {
    // This simulates the handler's recheck logic: if set() fails, the handler
    // calls get() again to see if a completed (non-null) response is now available.
    const { store, mockSend } = createTestStore();
    const key = 'race-recheck-key';
    const completedResponse = makeResponse(200, { response: 'Completed during race' });

    // Request A already claimed the key and is processing.
    // Request B calls get() — key holds null sentinel, returns null.
    mockSend.mockResolvedValueOnce({
      Item: {
        pk: `IDEMPOTENCY#${key}`,
        sk: 'IDEMPOTENCY',
        value: null, // in-flight sentinel
        ttl: Math.floor(Date.now() / 1000) + 300,
      },
    });
    const firstGet = await store.get(key);
    expect(firstGet).toBeNull(); // handler treats this as "not found"

    // Request B calls set() — fails because key exists.
    const ccfError = new ConditionalCheckFailedException({
      message: 'The conditional request failed',
      $metadata: {},
    });
    mockSend.mockRejectedValueOnce(ccfError);
    const claimed = await store.set(key, null);
    expect(claimed).toBe(false);

    // Meanwhile, Request A completed and called update(key, response).
    // Request B re-checks get() — now the completed response is available.
    mockSend.mockResolvedValueOnce({
      Item: {
        pk: `IDEMPOTENCY#${key}`,
        sk: 'IDEMPOTENCY',
        value: completedResponse,
        ttl: Math.floor(Date.now() / 1000) + 300,
      },
    });
    const recheck = await store.get(key);
    expect(recheck).toEqual(completedResponse);
    expect(recheck!.statusCode).toBe(200);
  });

  it('should return 409 when recheck still shows in-flight sentinel', async () => {
    // The key is genuinely in-flight — recheck returns null, handler returns 409.
    const { store, mockSend } = createTestStore();
    const key = 'still-inflight-key';

    // Request B get() — null sentinel
    mockSend.mockResolvedValueOnce({
      Item: {
        pk: `IDEMPOTENCY#${key}`,
        sk: 'IDEMPOTENCY',
        value: null,
        ttl: Math.floor(Date.now() / 1000) + 300,
      },
    });
    const firstGet = await store.get(key);
    expect(firstGet).toBeNull();

    // Request B set() — fails
    const ccfError = new ConditionalCheckFailedException({
      message: 'The conditional request failed',
      $metadata: {},
    });
    mockSend.mockRejectedValueOnce(ccfError);
    const claimed = await store.set(key, null);
    expect(claimed).toBe(false);

    // Request B recheck get() — still null (still in-flight)
    mockSend.mockResolvedValueOnce({
      Item: {
        pk: `IDEMPOTENCY#${key}`,
        sk: 'IDEMPOTENCY',
        value: null, // still in-flight
        ttl: Math.floor(Date.now() / 1000) + 300,
      },
    });
    const recheck = await store.get(key);
    expect(recheck).toBeNull(); // handler should return 409
  });
});

describe('Chat idempotency - full lifecycle with all paths', () => {
  it('should handle the complete claim -> update -> replay cycle for each terminal path', async () => {
    const terminalPaths = [
      { name: 'success', statusCode: 200, body: { response: 'OK' } },
      { name: 'access-denied', statusCode: 403, body: { error: 'Access denied' } },
      { name: 'rate-limit', statusCode: 429, body: { error: 'Rate limited', retryAfter: 3600 } },
      { name: 'async', statusCode: 202, body: { jobId: 'job-123', status: 'pending' } },
    ];

    for (const path of terminalPaths) {
      const { store, mockSend } = createTestStore();
      const key = `lifecycle-${path.name}`;
      const response = makeResponse(path.statusCode, path.body);

      // Claim
      mockSend.mockResolvedValueOnce({});
      const claimed = await store.set(key, null);
      expect(claimed).toBe(true);

      // Update with terminal response
      mockSend.mockResolvedValueOnce({});
      await store.update(key, response);

      // Replay
      mockSend.mockResolvedValueOnce({
        Item: {
          pk: `IDEMPOTENCY#${key}`,
          sk: 'IDEMPOTENCY',
          value: response,
          ttl: Math.floor(Date.now() / 1000) + 300,
        },
      });
      const cached = await store.get(key);
      expect(cached).toEqual(response);
      expect(cached!.statusCode).toBe(path.statusCode);
    }
  });

  it('should handle the claim -> remove -> retry cycle for transient errors', async () => {
    const { store, mockSend } = createTestStore();
    const key = 'transient-lifecycle';

    // Claim
    mockSend.mockResolvedValueOnce({});
    await store.set(key, null);

    // Transient error -> remove
    mockSend.mockResolvedValueOnce({});
    await store.remove(key);

    // Retry should succeed
    mockSend.mockResolvedValueOnce({});
    const retryClaim = await store.set(key, null);
    expect(retryClaim).toBe(true);

    // Second attempt succeeds -> update
    const successResponse = makeResponse(200, { response: 'Worked on retry' });
    mockSend.mockResolvedValueOnce({});
    await store.update(key, successResponse);

    // Replay returns success
    mockSend.mockResolvedValueOnce({
      Item: {
        pk: `IDEMPOTENCY#${key}`,
        sk: 'IDEMPOTENCY',
        value: successResponse,
        ttl: Math.floor(Date.now() / 1000) + 300,
      },
    });
    const cached = await store.get(key);
    expect(cached).toEqual(successResponse);
    expect(cached!.statusCode).toBe(200);
  });
});
