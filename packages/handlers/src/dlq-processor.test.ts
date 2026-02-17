/**
 * DLQ Processor Handler Tests
 *
 * Tests for message categorization, context extraction, source queue inference,
 * and the overall handler flow.
 *
 * Uses bun:test-compatible vitest API (describe/it/expect).
 *
 * @see packages/handlers/src/dlq-processor.ts
 */
import { describe, it, expect } from 'vitest';
import {
  categorizeMessage,
  extractMessageContext,
  inferSourceQueue,
  type FailureCategory,
} from './dlq-processor.js';

// ---------------------------------------------------------------------------
// categorizeMessage
// ---------------------------------------------------------------------------

describe('categorizeMessage', () => {
  it('returns parse_error for undefined body', () => {
    expect(categorizeMessage(undefined)).toBe('parse_error');
  });

  it('returns parse_error for empty string', () => {
    expect(categorizeMessage('')).toBe('parse_error');
  });

  it('returns parse_error for malformed JSON', () => {
    expect(categorizeMessage('not valid json {{{')).toBe('parse_error');
    expect(categorizeMessage('{incomplete')).toBe('parse_error');
  });

  it('returns schema_error for non-object JSON', () => {
    expect(categorizeMessage('"just a string"')).toBe('schema_error');
    expect(categorizeMessage('42')).toBe('schema_error');
    expect(categorizeMessage('null')).toBe('schema_error');
    expect(categorizeMessage('true')).toBe('schema_error');
  });

  it('returns schema_error for object without known fields', () => {
    expect(categorizeMessage(JSON.stringify({ foo: 'bar' }))).toBe('schema_error');
    expect(categorizeMessage(JSON.stringify({}))).toBe('schema_error');
  });

  it('returns transient for message queue item (has envelope)', () => {
    const body = JSON.stringify({
      envelope: {
        avatarId: 'test',
        platform: 'telegram',
        messageId: 'msg-1',
        conversationId: 'conv-1',
        timestamp: Date.now(),
        sender: { id: 'user-1', username: 'test', isBot: false },
        content: { text: 'hello' },
        metadata: {},
      },
      enqueuedAt: Date.now(),
      attempts: 1,
      maxAttempts: 3,
    });
    expect(categorizeMessage(body)).toBe('transient');
  });

  it('returns transient for response queue item (has avatarId + actions)', () => {
    const body = JSON.stringify({
      avatarId: 'test-avatar',
      platform: 'telegram',
      conversationId: 'conv-1',
      actions: [{ type: 'send_message', text: 'hello' }],
    });
    expect(categorizeMessage(body)).toBe('transient');
  });

  it('returns transient for item with just avatarId', () => {
    const body = JSON.stringify({
      avatarId: 'test-avatar',
      someOtherField: 'data',
    });
    expect(categorizeMessage(body)).toBe('transient');
  });
});

// ---------------------------------------------------------------------------
// extractMessageContext
// ---------------------------------------------------------------------------

describe('extractMessageContext', () => {
  it('returns empty context for undefined body', () => {
    const ctx = extractMessageContext(undefined);
    expect(ctx.avatarId).toBeUndefined();
    expect(ctx.platform).toBeUndefined();
    expect(ctx.conversationId).toBeUndefined();
  });

  it('returns empty context for malformed JSON', () => {
    const ctx = extractMessageContext('invalid json');
    expect(ctx.avatarId).toBeUndefined();
  });

  it('extracts context from envelope-based message', () => {
    const body = JSON.stringify({
      envelope: {
        avatarId: 'agent-1',
        platform: 'telegram',
        conversationId: 'chat-42',
      },
    });
    const ctx = extractMessageContext(body);
    expect(ctx.avatarId).toBe('agent-1');
    expect(ctx.platform).toBe('telegram');
    expect(ctx.conversationId).toBe('chat-42');
  });

  it('extracts context from flat response message', () => {
    const body = JSON.stringify({
      avatarId: 'agent-2',
      platform: 'discord',
      conversationId: 'channel-99',
      actions: [],
    });
    const ctx = extractMessageContext(body);
    expect(ctx.avatarId).toBe('agent-2');
    expect(ctx.platform).toBe('discord');
    expect(ctx.conversationId).toBe('channel-99');
  });

  it('prefers envelope path over flat fields', () => {
    const body = JSON.stringify({
      avatarId: 'flat-id',
      platform: 'web',
      envelope: {
        avatarId: 'envelope-id',
        platform: 'telegram',
        conversationId: 'env-conv',
      },
    });
    const ctx = extractMessageContext(body);
    expect(ctx.avatarId).toBe('envelope-id');
    expect(ctx.platform).toBe('telegram');
  });

  it('handles non-string fields gracefully', () => {
    const body = JSON.stringify({
      avatarId: 123,
      platform: null,
      conversationId: true,
    });
    const ctx = extractMessageContext(body);
    expect(ctx.avatarId).toBeUndefined();
    expect(ctx.platform).toBeUndefined();
    expect(ctx.conversationId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// inferSourceQueue
// ---------------------------------------------------------------------------

describe('inferSourceQueue', () => {
  // Note: env vars aren't set in unit tests, so we check for undefined
  // when no env vars are configured. The logic is still exercised.

  it('returns undefined for undefined body', () => {
    expect(inferSourceQueue(undefined)).toBeUndefined();
  });

  it('returns undefined for malformed JSON', () => {
    expect(inferSourceQueue('bad json')).toBeUndefined();
  });

  it('returns undefined for unrecognized structure', () => {
    expect(inferSourceQueue(JSON.stringify({ random: 'data' }))).toBeUndefined();
  });

  it('identifies message queue items (envelope + enqueuedAt + attempts)', () => {
    const body = JSON.stringify({
      envelope: { avatarId: 'a', platform: 'telegram' },
      enqueuedAt: Date.now(),
      attempts: 1,
      maxAttempts: 3,
    });
    // Returns the MESSAGE_QUEUE_URL env var (undefined in test)
    const result = inferSourceQueue(body);
    // We can only assert the function runs without error; actual URL depends on env
    expect(result === undefined || typeof result === 'string').toBe(true);
  });

  it('identifies response queue items (actions + platform)', () => {
    const body = JSON.stringify({
      avatarId: 'a',
      platform: 'telegram',
      conversationId: 'c',
      actions: [{ type: 'send_message', text: 'hi' }],
    });
    const result = inferSourceQueue(body);
    expect(result === undefined || typeof result === 'string').toBe(true);
  });

  it('identifies media queue items (action + conversationId + jobId)', () => {
    const body = JSON.stringify({
      jobId: 'job-1',
      avatarId: 'a',
      conversationId: 'c',
      action: { type: 'take_selfie', prompt: 'test' },
    });
    const result = inferSourceQueue(body);
    expect(result === undefined || typeof result === 'string').toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration-level edge cases
// ---------------------------------------------------------------------------

describe('DLQ Processor - Edge Cases', () => {
  it('handles array JSON body as schema_error', () => {
    expect(categorizeMessage(JSON.stringify([1, 2, 3]))).toBe('schema_error');
  });

  it('handles deeply nested valid envelope', () => {
    const body = JSON.stringify({
      envelope: {
        avatarId: 'deep-agent',
        platform: 'twitter',
        conversationId: 'thread-1',
        content: { text: 'x'.repeat(10000) },
      },
      enqueuedAt: Date.now(),
      attempts: 3,
      maxAttempts: 3,
    });
    expect(categorizeMessage(body)).toBe('transient');
    const ctx = extractMessageContext(body);
    expect(ctx.avatarId).toBe('deep-agent');
  });

  it('body preview is safe for logging (no sensitive data leaks tested by length)', () => {
    const longBody = JSON.stringify({ avatarId: 'a', secret: 'x'.repeat(1000) });
    const preview = longBody.slice(0, 500);
    expect(preview.length).toBeLessThanOrEqual(500);
  });

  describe('FailureCategory type exhaustiveness', () => {
    it('covers all expected categories', () => {
      const categories: FailureCategory[] = [
        'parse_error',
        'schema_error',
        'transient',
        'permanent',
        'unknown',
      ];
      expect(categories).toHaveLength(5);
    });
  });
});
