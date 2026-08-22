import { describe, expect, it } from 'vitest';
import type { DynamoDBDocumentClient } from '@swarm/core';
import { checkApiKeyRateLimit } from './openai-compat.js';

function makeRateLimitDeps(nowMs: number) {
  const store = new Map<string, { count: number; resetAt: number; ttl: number }>();
  const keyOf = (pk: string, sk: string) => `${pk}|${sk}`;

  const send: DynamoDBDocumentClient['send'] = async (cmd: unknown) => {
    const command = cmd as { input?: Record<string, unknown>; constructor?: { name?: string } };
    const input = command?.input ?? {};

    if (command?.constructor?.name !== 'UpdateCommand') {
      throw new Error(`Unexpected command: ${command?.constructor?.name}`);
    }

    const key = input.Key as { pk: string; sk: string };
    const itemKey = keyOf(key.pk, key.sk);
    const existing = store.get(itemKey);
    const values = input.ExpressionAttributeValues as Record<string, number>;

    const limit = values[':limit'];
    const current = existing?.count ?? 0;
    if (current >= limit) {
      const err = new Error('Conditional check failed');
      (err as Error & { name: string }).name = 'ConditionalCheckFailedException';
      throw err;
    }

    store.set(itemKey, {
      count: current + 1,
      resetAt: values[':resetAt'],
      ttl: values[':ttl'],
    });

    return {};
  };

  return {
    deps: {
      docClient: { send },
      tableName: 'test-admin-table',
      now: () => nowMs,
    },
    store,
  };
}

describe('checkApiKeyRateLimit', () => {
  it('allows requests when no rate limits are configured', async () => {
    const { deps } = makeRateLimitDeps(1_700_000_000_000);

    const result = await checkApiKeyRateLimit('key-hash', undefined, deps);
    expect(result).toEqual({ allowed: true });
  });

  it('enforces per-minute limits', async () => {
    const { deps } = makeRateLimitDeps(1_700_000_000_000);
    const limits = { requestsPerMinute: 1, requestsPerDay: 100 };

    const first = await checkApiKeyRateLimit('key-hash', limits, deps);
    expect(first.allowed).toBe(true);

    const second = await checkApiKeyRateLimit('key-hash', limits, deps);
    expect(second.allowed).toBe(false);
    expect(typeof second.retryAfterSeconds).toBe('number');
    expect(second.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('enforces per-day limits', async () => {
    const { deps } = makeRateLimitDeps(1_700_000_000_000);
    const limits = { requestsPerMinute: 100, requestsPerDay: 1 };

    const first = await checkApiKeyRateLimit('key-hash', limits, deps);
    expect(first.allowed).toBe(true);

    const second = await checkApiKeyRateLimit('key-hash', limits, deps);
    expect(second.allowed).toBe(false);
    expect(typeof second.retryAfterSeconds).toBe('number');
    expect(second.retryAfterSeconds).toBeGreaterThan(0);
  });
});
