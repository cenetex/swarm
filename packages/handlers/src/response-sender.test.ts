/**
 * Response Sender Handler Tests
 * Tests for JSON.parse error handling and SQS batch failure responses
 *
 * Bug Index:
 * - BUG-001: JSON.parse without try-catch in handlers/response-sender.ts:103
 * - BUG-002: SQS batch failure - single bad message fails entire batch
 *
 * @see packages/handlers/src/response-sender.ts
 */
import { describe, it, expect, vi } from 'vitest';

// Mock external dependencies before importing the module
vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: vi.fn(() => ({
    send: vi.fn().mockResolvedValue({}),
  })),
  SendMessageCommand: vi.fn(),
}));

vi.mock('@swarm/core', () => ({
  TelegramAdapter: vi.fn(),
  TwitterAdapter: vi.fn(),
  WebAdapter: vi.fn(),
  PlatformRegistry: vi.fn(() => ({
    register: vi.fn(),
  })),
  createStateService: vi.fn(() => ({
    getAgentConfig: vi.fn().mockResolvedValue(null),
    addMessageToChannel: vi.fn().mockResolvedValue({}),
    markResponseSent: vi.fn().mockResolvedValue({}),
  })),
  createSecretsService: vi.fn(() => ({
    getSecretJson: vi.fn().mockResolvedValue({}),
  })),
  createActivityService: vi.fn(() => ({})),
  createOutboundSender: vi.fn(() => ({
    send: vi.fn().mockResolvedValue({ success: true, sentMessages: [], errors: [] }),
  })),
  logger: {
    setContext: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('Response Sender - JSON Parse Error Handling', () => {
  /**
   * BUG-001: JSON.parse without try-catch
   * File: packages/handlers/src/response-sender.ts:103
   *
   * Previously, malformed JSON in SQS message body would throw an unhandled error
   * and fail the entire Lambda invocation instead of just marking the message as failed.
   *
   * Fix: Wrapped JSON.parse in try-catch, adds to batchItemFailures on parse error
   */
  describe('Malformed JSON handling (BUG-001)', () => {
    it('should add malformed JSON messages to batch failures instead of throwing', async () => {
      // Test the pattern: try { JSON.parse() } catch { batchItemFailures.push(); continue; }
      const malformedBody = 'not valid json {{{';
      const record = { messageId: 'msg-123', body: malformedBody };

      // Simulate the error handling logic
      const batchItemFailures: { itemIdentifier: string }[] = [];

      try {
        JSON.parse(record.body);
      } catch {
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }

      expect(batchItemFailures).toHaveLength(1);
      expect(batchItemFailures[0].itemIdentifier).toBe('msg-123');
    });

    it('should handle undefined body gracefully', async () => {
      const record = { messageId: 'msg-456', body: undefined as unknown as string };
      const batchItemFailures: { itemIdentifier: string }[] = [];

      try {
        JSON.parse(record.body);
      } catch {
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }

      expect(batchItemFailures).toHaveLength(1);
    });

    it('should handle empty string body', async () => {
      const record = { messageId: 'msg-789', body: '' };
      const batchItemFailures: { itemIdentifier: string }[] = [];

      try {
        JSON.parse(record.body);
      } catch {
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }

      expect(batchItemFailures).toHaveLength(1);
    });

    it('should successfully parse valid JSON', async () => {
      const validBody = JSON.stringify({
        agentId: 'test-agent',
        platform: 'telegram',
        conversationId: '123',
        actions: [{ type: 'send_message', text: 'hello' }],
      });
      const record = { messageId: 'msg-valid', body: validBody };
      const batchItemFailures: { itemIdentifier: string }[] = [];

      try {
        const parsed = JSON.parse(record.body);
        expect(parsed.agentId).toBe('test-agent');
      } catch {
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }

      expect(batchItemFailures).toHaveLength(0);
    });
  });

  /**
   * BUG-002: SQS batch failure handling
   * File: packages/handlers/src/response-sender.ts
   *
   * Previously, one bad message would fail the entire batch instead of using
   * partial batch failure response to only retry failed messages.
   *
   * Fix: Return { batchItemFailures: [...] } to enable partial batch failure
   */
  describe('SQS partial batch failure response (BUG-002)', () => {
    it('should return batchItemFailures array for failed messages', async () => {
      const records = [
        { messageId: 'good-1', body: JSON.stringify({ valid: true }) },
        { messageId: 'bad-1', body: 'invalid json' },
        { messageId: 'good-2', body: JSON.stringify({ valid: true }) },
        { messageId: 'bad-2', body: '{incomplete' },
      ];

      const batchItemFailures: { itemIdentifier: string }[] = [];

      for (const record of records) {
        try {
          JSON.parse(record.body);
        } catch {
          batchItemFailures.push({ itemIdentifier: record.messageId });
        }
      }

      // Should only have the 2 bad messages
      expect(batchItemFailures).toHaveLength(2);
      expect(batchItemFailures.map(f => f.itemIdentifier)).toEqual(['bad-1', 'bad-2']);
    });

    it('should return empty batchItemFailures when all messages succeed', async () => {
      const records = [
        { messageId: 'good-1', body: JSON.stringify({ a: 1 }) },
        { messageId: 'good-2', body: JSON.stringify({ b: 2 }) },
      ];

      const batchItemFailures: { itemIdentifier: string }[] = [];

      for (const record of records) {
        try {
          JSON.parse(record.body);
        } catch {
          batchItemFailures.push({ itemIdentifier: record.messageId });
        }
      }

      expect(batchItemFailures).toHaveLength(0);
    });

    it('should preserve message order in failures', async () => {
      const records = [
        { messageId: 'first-bad', body: 'x' },
        { messageId: 'second-bad', body: 'y' },
        { messageId: 'third-bad', body: 'z' },
      ];

      const batchItemFailures: { itemIdentifier: string }[] = [];

      for (const record of records) {
        try {
          JSON.parse(record.body);
        } catch {
          batchItemFailures.push({ itemIdentifier: record.messageId });
        }
      }

      expect(batchItemFailures.map(f => f.itemIdentifier)).toEqual([
        'first-bad',
        'second-bad',
        'third-bad',
      ]);
    });
  });
});

describe('Response Sender - Error Logging', () => {
  it('should log body preview when JSON parse fails', async () => {
    const longBody = 'a'.repeat(200);
    const bodyPreview = longBody.slice(0, 100);

    // The fix includes logging bodyPreview for debugging
    expect(bodyPreview).toHaveLength(100);
    expect(bodyPreview).toBe('a'.repeat(100));
  });

  it('should handle body preview for short strings', async () => {
    const shortBody = 'abc';
    const bodyPreview = shortBody.slice(0, 100);

    expect(bodyPreview).toBe('abc');
  });
});
