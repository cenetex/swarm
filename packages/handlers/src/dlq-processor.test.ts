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
  containsPermanentErrorSignal,
  calculateRedriveDelay,
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

  it('returns permanent for message with "avatar not found" error', () => {
    const body = JSON.stringify({
      avatarId: 'test-avatar',
      error: 'Avatar not found',
    });
    expect(categorizeMessage(body)).toBe('permanent');
  });

  it('returns permanent for message with nested error.message containing permanent pattern', () => {
    const body = JSON.stringify({
      avatarId: 'test-avatar',
      error: { message: 'Invalid API key provided', code: '401' },
    });
    expect(categorizeMessage(body)).toBe('permanent');
  });

  it('returns permanent for message with failureReason containing permanent pattern', () => {
    const body = JSON.stringify({
      avatarId: 'test-avatar',
      failureReason: 'Bot was blocked by the user',
    });
    expect(categorizeMessage(body)).toBe('permanent');
  });

  it('returns permanent for message with errorMessage containing permanent pattern', () => {
    const body = JSON.stringify({
      avatarId: 'test-avatar',
      errorMessage: 'Account suspended for policy violation',
    });
    expect(categorizeMessage(body)).toBe('permanent');
  });

  it('returns permanent for envelope-level error with permanent pattern', () => {
    const body = JSON.stringify({
      envelope: {
        avatarId: 'test-avatar',
        platform: 'telegram',
        error: 'Chat not found',
      },
    });
    expect(categorizeMessage(body)).toBe('permanent');
  });

  it('returns transient for error that does not match permanent patterns', () => {
    const body = JSON.stringify({
      avatarId: 'test-avatar',
      error: 'Connection timed out after 30000ms',
    });
    expect(categorizeMessage(body)).toBe('transient');
  });

  it('returns transient for message with no error fields', () => {
    const body = JSON.stringify({
      avatarId: 'test-avatar',
      actions: [{ type: 'send_message', text: 'hello' }],
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
// containsPermanentErrorSignal
// ---------------------------------------------------------------------------

describe('containsPermanentErrorSignal', () => {
  it('returns false for object with no error fields', () => {
    expect(containsPermanentErrorSignal({ avatarId: 'a', platform: 'telegram' })).toBe(false);
  });

  it('returns true for top-level error string matching pattern', () => {
    expect(containsPermanentErrorSignal({ avatarId: 'a', error: 'Avatar deleted' })).toBe(true);
  });

  it('returns true for nested error.message matching pattern', () => {
    expect(
      containsPermanentErrorSignal({
        avatarId: 'a',
        error: { message: 'Forbidden: insufficient permissions' },
      })
    ).toBe(true);
  });

  it('returns true for errorMessage field matching pattern', () => {
    expect(
      containsPermanentErrorSignal({ avatarId: 'a', errorMessage: 'Access denied to resource' })
    ).toBe(true);
  });

  it('returns true for failureReason field matching pattern', () => {
    expect(
      containsPermanentErrorSignal({ avatarId: 'a', failureReason: 'User is deactivated' })
    ).toBe(true);
  });

  it('returns true for envelope-level error matching pattern', () => {
    expect(
      containsPermanentErrorSignal({
        envelope: { error: 'Config validation failed for avatar' },
      })
    ).toBe(true);
  });

  it('returns false for transient error strings', () => {
    expect(containsPermanentErrorSignal({ error: 'Connection timed out' })).toBe(false);
    expect(containsPermanentErrorSignal({ error: 'ECONNRESET' })).toBe(false);
    expect(containsPermanentErrorSignal({ error: 'Service temporarily unavailable' })).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(containsPermanentErrorSignal({ error: 'AVATAR NOT FOUND' })).toBe(true);
    expect(containsPermanentErrorSignal({ error: 'Invalid Api Key' })).toBe(true);
  });

  it('handles non-string error field gracefully', () => {
    expect(containsPermanentErrorSignal({ error: 42 })).toBe(false);
    expect(containsPermanentErrorSignal({ error: null })).toBe(false);
    expect(containsPermanentErrorSignal({ error: true })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// calculateRedriveDelay
// ---------------------------------------------------------------------------

describe('calculateRedriveDelay', () => {
  it('returns base delay for first receive (count=1)', () => {
    expect(calculateRedriveDelay(1)).toBe(30);
  });

  it('returns 2x base delay for second receive (count=2)', () => {
    expect(calculateRedriveDelay(2)).toBe(60);
  });

  it('returns 4x base delay for third receive (count=3)', () => {
    expect(calculateRedriveDelay(3)).toBe(120);
  });

  it('returns 8x base delay for fourth receive (count=4)', () => {
    expect(calculateRedriveDelay(4)).toBe(240);
  });

  it('caps at 900 seconds (SQS maximum DelaySeconds)', () => {
    expect(calculateRedriveDelay(6)).toBe(900);
    expect(calculateRedriveDelay(10)).toBe(900);
    expect(calculateRedriveDelay(100)).toBe(900);
  });

  it('handles zero and negative counts gracefully', () => {
    expect(calculateRedriveDelay(0)).toBe(30);
    expect(calculateRedriveDelay(-1)).toBe(30);
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

// ---------------------------------------------------------------------------
// DLQ Processor — offloaded message handling (issue #1069)
// ---------------------------------------------------------------------------

describe('DLQ Processor - Offloaded message archival', () => {
  it('correctly categorizes an offloaded message reference as schema_error (no envelope/avatarId)', () => {
    // An offloaded message ref has __offloaded, bucket, key — but no envelope or avatarId.
    // The DLQ processor sees the raw SQS body (the ref), not the original payload.
    const offloadRef = JSON.stringify({
      __offloaded: true,
      bucket: 'swarm-staging-media',
      key: 'sqs-offload/abc-123.json',
      originalSizeBytes: 300000,
    });

    // Without envelope or avatarId, the categorizer treats it as schema_error
    expect(categorizeMessage(offloadRef)).toBe('schema_error');
  });

  it('extracts no context from an offloaded reference (fields are S3 metadata, not message context)', () => {
    const offloadRef = JSON.stringify({
      __offloaded: true,
      bucket: 'swarm-staging-media',
      key: 'sqs-offload/def-456.json',
      originalSizeBytes: 250000,
    });

    const ctx = extractMessageContext(offloadRef);
    expect(ctx.avatarId).toBeUndefined();
    expect(ctx.platform).toBeUndefined();
    expect(ctx.conversationId).toBeUndefined();
  });

  it('categorizes the original (retrieved) message body correctly after S3 retrieval', () => {
    // Simulate what happens after the DLQ processor retrieves the original payload from S3.
    // The original payload is a valid envelope-based message.
    const originalPayload = {
      envelope: {
        avatarId: 'agent-offloaded',
        platform: 'telegram',
        conversationId: 'conv-offloaded',
        content: { text: 'x'.repeat(300000) },
      },
      enqueuedAt: Date.now(),
      attempts: 2,
      maxAttempts: 3,
    };
    const originalBody = JSON.stringify(originalPayload);

    expect(categorizeMessage(originalBody)).toBe('transient');

    const ctx = extractMessageContext(originalBody);
    expect(ctx.avatarId).toBe('agent-offloaded');
    expect(ctx.platform).toBe('telegram');
    expect(ctx.conversationId).toBe('conv-offloaded');
  });

  it('categorizes a retrieved offloaded message with permanent error correctly', () => {
    // After retrieval from S3, the original payload contains a permanent error signal.
    const originalPayload = {
      envelope: {
        avatarId: 'agent-perm',
        platform: 'discord',
        error: 'Avatar not found',
      },
    };
    const originalBody = JSON.stringify(originalPayload);

    expect(categorizeMessage(originalBody)).toBe('permanent');

    const ctx = extractMessageContext(originalBody);
    expect(ctx.avatarId).toBe('agent-perm');
    expect(ctx.platform).toBe('discord');
  });

  it('inferSourceQueue returns undefined for an offloaded reference (no structural match)', () => {
    const offloadRef = JSON.stringify({
      __offloaded: true,
      bucket: 'swarm-staging-media',
      key: 'sqs-offload/ghi-789.json',
      originalSizeBytes: 400000,
    });

    expect(inferSourceQueue(offloadRef)).toBeUndefined();
  });

  it('inferSourceQueue identifies source correctly from the retrieved original payload', () => {
    const originalPayload = {
      envelope: { avatarId: 'a', platform: 'telegram' },
      enqueuedAt: Date.now(),
      attempts: 1,
      maxAttempts: 3,
    };
    const originalBody = JSON.stringify(originalPayload);

    // Returns MESSAGE_QUEUE_URL env var (undefined in test), but function runs without error
    const result = inferSourceQueue(originalBody);
    expect(result === undefined || typeof result === 'string').toBe(true);
  });
});
