/**
 * Tests for token-accounting service.
 *
 * Uses in-memory DynamoDB mocks to verify:
 * - Token resolution (provider vs estimated)
 * - Per-request log recording
 * - Daily rollup aggregation
 * - Query rollups with gap filling
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  resolveTokenUsage,
  estimateTokens,
  recordTokenUsage,
  getKeyUsageRollups,
  getAvatarUsageRollups,
} from './token-accounting.js';
import type { TokenAccountingDeps, TokenUsage } from './token-accounting.js';

// ── In-memory DynamoDB mock ─────────────────────────────────────────────────

interface StoredItem {
  pk: string;
  sk: string;
  [key: string]: unknown;
}

let store: Map<string, StoredItem>;

function makeKey(pk: string, sk: string): string {
  return `${pk}|${sk}`;
}

/**
 * Apply a DynamoDB UpdateExpression to an in-memory item.
 *
 * Supports two patterns used by token-accounting:
 * 1. Simple SET: `fieldOrAlias = :value`
 * 2. Atomic increment: `fieldOrAlias = if_not_exists(fieldOrAlias, :zero) + :value`
 *
 * Handles ExpressionAttributeNames (#alias -> realName) and multi-line expressions.
 */
function applyUpdateExpression(
  existing: StoredItem,
  rawExpr: string,
  values: Record<string, unknown>,
  names: Record<string, string>,
): void {
  // Normalize whitespace: collapse newlines + multiple spaces into single space
  const expr = rawExpr.replace(/\s+/g, ' ').trim();

  // Extract the SET clause body
  const setBody = expr.replace(/^SET\s+/i, '');
  if (!setBody) return;

  // Split on comma, but be careful about commas inside function calls
  // Simple approach: split on `, ` preceded by a value ref or field name
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of setBody) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());

  for (const part of parts) {
    // Resolve field name (may be #alias or bare name)
    const eqIdx = part.indexOf('=');
    if (eqIdx < 0) continue;

    const lhs = part.slice(0, eqIdx).trim();
    const rhs = part.slice(eqIdx + 1).trim();

    // Resolve field name from alias
    const fieldName = lhs.startsWith('#') ? (names[lhs] || lhs.slice(1)) : lhs;

    // Check for if_not_exists pattern: if_not_exists(x, :zero) + :val
    const ifneMatch = rhs.match(/if_not_exists\([^,]+,\s*:(\w+)\)\s*\+\s*:(\w+)/);
    if (ifneMatch) {
      const zeroVal = values[`:${ifneMatch[1]}`] as number;
      const addVal = values[`:${ifneMatch[2]}`] as number;
      const current = (existing[fieldName] as number | undefined) ?? zeroVal;
      existing[fieldName] = current + addVal;
      continue;
    }

    // Simple assignment: field = :value
    const simpleMatch = rhs.match(/^:(\w+)$/);
    if (simpleMatch) {
      existing[fieldName] = values[`:${simpleMatch[1]}`];
    }
  }
}

function makeMockDeps(nowMs: number = Date.now()): TokenAccountingDeps {
  const send = async (cmd: unknown) => {
    // The @aws-sdk Command classes store params in `.input`
    const cmdObj = cmd as { input?: Record<string, unknown> };
    const input = cmdObj.input || {};

    // Detect command type by shape of input
    const isUpdate = !!input.Key && !!input.UpdateExpression;
    const isQuery = !!input.KeyConditionExpression;

    if (isUpdate) {
      const key = input.Key as { pk: string; sk: string };
      const itemKey = makeKey(key.pk, key.sk);
      const existing = store.get(itemKey) || { pk: key.pk, sk: key.sk };

      applyUpdateExpression(
        existing,
        input.UpdateExpression as string,
        (input.ExpressionAttributeValues || {}) as Record<string, unknown>,
        (input.ExpressionAttributeNames || {}) as Record<string, string>,
      );

      store.set(itemKey, existing);
      return {};
    }

    if (isQuery) {
      const exprValues = (input.ExpressionAttributeValues || {}) as Record<string, string>;
      const pk = exprValues[':pk'];
      const startSk = exprValues[':start'];
      const endSk = exprValues[':end'];

      const items: StoredItem[] = [];
      for (const [, item] of store) {
        if (item.pk === pk && item.sk >= startSk && item.sk <= endSk) {
          items.push(item);
        }
      }
      items.sort((a, b) => a.sk.localeCompare(b.sk));
      return { Items: items };
    }

    return {};
  };

  return {
    dynamoClient: { send } as unknown as TokenAccountingDeps['dynamoClient'],
    tableName: 'test-admin',
    now: () => nowMs,
  };
}

beforeEach(() => {
  store = new Map();
});

// =========================================================================
// resolveTokenUsage
// =========================================================================
describe('resolveTokenUsage', () => {
  it('prefers provider-reported usage when available', () => {
    const result = resolveTokenUsage(
      { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      'Hello world',
      'Hi there',
      'anthropic/claude-3-5-sonnet-latest',
    );

    expect(result.usageSource).toBe('provider');
    expect(result.promptTokens).toBe(100);
    expect(result.completionTokens).toBe(50);
    expect(result.totalTokens).toBe(150);
  });

  it('falls back to estimation when provider usage is undefined', () => {
    const result = resolveTokenUsage(
      undefined,
      'Hello world',
      'Hi there',
      'anthropic/claude-3-5-sonnet-latest',
    );

    expect(result.usageSource).toBe('estimated');
    expect(result.promptTokens).toBeGreaterThan(0);
    expect(result.completionTokens).toBeGreaterThan(0);
    expect(result.totalTokens).toBe(result.promptTokens + result.completionTokens);
  });

  it('falls back to estimation when provider usage has zero prompt tokens', () => {
    const result = resolveTokenUsage(
      { promptTokens: 0, completionTokens: 50 },
      'Hello world',
      'Hi there',
      'openai/gpt-4o',
    );

    expect(result.usageSource).toBe('estimated');
  });

  it('falls back to estimation when provider usage is partial', () => {
    const result = resolveTokenUsage(
      { promptTokens: 100 } as { promptTokens: number; completionTokens?: number },
      'Hello world',
      'Hi there',
      'openai/gpt-4o',
    );

    expect(result.usageSource).toBe('estimated');
  });

  it('computes totalTokens from prompt+completion when provider omits it', () => {
    const result = resolveTokenUsage(
      { promptTokens: 100, completionTokens: 50, totalTokens: undefined as unknown as number },
      'ignored',
      'ignored',
      'openai/gpt-4o',
    );

    expect(result.usageSource).toBe('provider');
    expect(result.totalTokens).toBe(150);
  });
});

// =========================================================================
// estimateTokens
// =========================================================================
describe('estimateTokens', () => {
  it('uses model-aware character ratio for Anthropic models', () => {
    const text = 'A'.repeat(350);
    const tokens = estimateTokens(text, 'anthropic/claude-3-5-sonnet-latest');
    expect(tokens).toBe(100);
  });

  it('uses model-aware character ratio for OpenAI models', () => {
    const text = 'A'.repeat(400);
    const tokens = estimateTokens(text, 'openai/gpt-4o');
    expect(tokens).toBe(100);
  });

  it('uses default ratio for unknown models', () => {
    const text = 'A'.repeat(400);
    const tokens = estimateTokens(text, 'unknown/model');
    expect(tokens).toBe(100);
  });

  it('rounds up fractional tokens', () => {
    const text = 'A'.repeat(3);
    const tokens = estimateTokens(text, 'anthropic/claude-3-5-sonnet-latest');
    expect(tokens).toBe(1);
  });
});

// =========================================================================
// recordTokenUsage
// =========================================================================
describe('recordTokenUsage', () => {
  it('writes per-request log, key rollup, and avatar rollup', async () => {
    const nowMs = new Date('2026-02-23T12:00:00Z').getTime();
    const deps = makeMockDeps(nowMs);

    const usage: TokenUsage = {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      usageSource: 'provider',
    };

    await recordTokenUsage(
      {
        requestId: 'req-001',
        keyHash: 'abc123hash',
        avatarId: 'my-bot',
        model: 'anthropic/claude-3-5-sonnet-latest',
        usage,
      },
      deps,
    );

    // Check per-request log was written
    const logKey = makeKey('TOKEN_LOG#abc123hash', 'REQ#2026-02-23#req-001');
    const logItem = store.get(logKey);
    expect(logItem).toBeDefined();
    expect(logItem!.promptTokens).toBe(100);
    expect(logItem!.completionTokens).toBe(50);
    expect(logItem!.totalTokens).toBe(150);
    expect(logItem!.usageSource).toBe('provider');
    expect(logItem!.model).toBe('anthropic/claude-3-5-sonnet-latest');
    expect(logItem!.avatarId).toBe('my-bot');
    expect(logItem!.totalCostMicroUsd).toBeGreaterThan(0);
    expect(logItem!.pricingVersion).toBeGreaterThan(0);

    // Check key rollup
    const keyRollupKey = makeKey('TOKEN_ROLLUP#KEY#abc123hash', 'DAY#2026-02-23');
    const keyRollup = store.get(keyRollupKey);
    expect(keyRollup).toBeDefined();
    expect(keyRollup!.requestCount).toBe(1);
    expect(keyRollup!.totalPromptTokens).toBe(100);
    expect(keyRollup!.totalCompletionTokens).toBe(50);
    expect(keyRollup!.totalTokens).toBe(150);
    expect(keyRollup!.providerReportedCount).toBe(1);
    expect(keyRollup!.estimatedCount).toBe(0);

    // Check avatar rollup
    const avatarRollupKey = makeKey('TOKEN_ROLLUP#AVATAR#my-bot', 'DAY#2026-02-23');
    const avatarRollup = store.get(avatarRollupKey);
    expect(avatarRollup).toBeDefined();
    expect(avatarRollup!.requestCount).toBe(1);
    expect(avatarRollup!.totalTokens).toBe(150);
  });

  it('aggregates multiple requests into the same daily rollup', async () => {
    const nowMs = new Date('2026-02-23T12:00:00Z').getTime();
    const deps = makeMockDeps(nowMs);

    const usage1: TokenUsage = {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      usageSource: 'provider',
    };
    const usage2: TokenUsage = {
      promptTokens: 200,
      completionTokens: 100,
      totalTokens: 300,
      usageSource: 'estimated',
    };

    await recordTokenUsage(
      { requestId: 'req-001', keyHash: 'key1', avatarId: 'bot-a', model: 'openai/gpt-4o', usage: usage1 },
      deps,
    );
    await recordTokenUsage(
      { requestId: 'req-002', keyHash: 'key1', avatarId: 'bot-a', model: 'openai/gpt-4o', usage: usage2 },
      deps,
    );

    const keyRollupKey = makeKey('TOKEN_ROLLUP#KEY#key1', 'DAY#2026-02-23');
    const keyRollup = store.get(keyRollupKey);
    expect(keyRollup!.requestCount).toBe(2);
    expect(keyRollup!.totalPromptTokens).toBe(300);
    expect(keyRollup!.totalCompletionTokens).toBe(150);
    expect(keyRollup!.totalTokens).toBe(450);
    expect(keyRollup!.providerReportedCount).toBe(1);
    expect(keyRollup!.estimatedCount).toBe(1);
  });

  it('records estimated usage source correctly in rollups', async () => {
    const nowMs = new Date('2026-02-23T12:00:00Z').getTime();
    const deps = makeMockDeps(nowMs);

    await recordTokenUsage(
      {
        requestId: 'req-001',
        keyHash: 'key2',
        avatarId: 'bot-b',
        model: 'deepseek/deepseek-r1',
        usage: { promptTokens: 50, completionTokens: 25, totalTokens: 75, usageSource: 'estimated' },
      },
      deps,
    );

    const rollupKey = makeKey('TOKEN_ROLLUP#KEY#key2', 'DAY#2026-02-23');
    const rollup = store.get(rollupKey);
    expect(rollup!.providerReportedCount).toBe(0);
    expect(rollup!.estimatedCount).toBe(1);
  });
});

// =========================================================================
// getKeyUsageRollups / getAvatarUsageRollups
// =========================================================================
describe('getKeyUsageRollups', () => {
  it('returns rollups with gap-filling for days without data', async () => {
    const nowMs = new Date('2026-02-25T12:00:00Z').getTime();
    const deps = makeMockDeps(nowMs);

    // Insert rollup for 2026-02-24 only
    store.set(makeKey('TOKEN_ROLLUP#KEY#keyA', 'DAY#2026-02-24'), {
      pk: 'TOKEN_ROLLUP#KEY#keyA',
      sk: 'DAY#2026-02-24',
      date: '2026-02-24',
      requestCount: 5,
      totalPromptTokens: 500,
      totalCompletionTokens: 250,
      totalTokens: 750,
      totalCostMicroUsd: 5000,
      providerReportedCount: 3,
      estimatedCount: 2,
    });

    const rollups = await getKeyUsageRollups('keyA', 3, deps);

    expect(rollups).toHaveLength(3);

    expect(rollups[0].date).toBe('2026-02-23');
    expect(rollups[0].requestCount).toBe(0);
    expect(rollups[0].totalTokens).toBe(0);

    expect(rollups[1].date).toBe('2026-02-24');
    expect(rollups[1].requestCount).toBe(5);
    expect(rollups[1].totalTokens).toBe(750);
    expect(rollups[1].totalCostMicroUsd).toBe(5000);

    expect(rollups[2].date).toBe('2026-02-25');
    expect(rollups[2].requestCount).toBe(0);
  });
});

describe('getAvatarUsageRollups', () => {
  it('returns rollups for avatar partition key', async () => {
    const nowMs = new Date('2026-02-23T12:00:00Z').getTime();
    const deps = makeMockDeps(nowMs);

    store.set(makeKey('TOKEN_ROLLUP#AVATAR#bot-x', 'DAY#2026-02-23'), {
      pk: 'TOKEN_ROLLUP#AVATAR#bot-x',
      sk: 'DAY#2026-02-23',
      date: '2026-02-23',
      requestCount: 10,
      totalPromptTokens: 1000,
      totalCompletionTokens: 500,
      totalTokens: 1500,
      totalCostMicroUsd: 10000,
      providerReportedCount: 8,
      estimatedCount: 2,
    });

    const rollups = await getAvatarUsageRollups('bot-x', 1, deps);

    expect(rollups).toHaveLength(1);
    expect(rollups[0].requestCount).toBe(10);
    expect(rollups[0].totalTokens).toBe(1500);
    expect(rollups[0].providerReportedCount).toBe(8);
    expect(rollups[0].estimatedCount).toBe(2);
  });
});
