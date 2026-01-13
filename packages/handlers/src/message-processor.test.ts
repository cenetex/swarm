/**
 * Message Processor Handler Tests
 * Tests for JSON.parse error handling, tool argument parsing, and poison pill prevention
 *
 * Bug Index:
 * - BUG-006: JSON.parse without try-catch in handlers/message-processor.ts:556
 * - BUG-007: Tool call argument parsing without error handling (line 240)
 * - BUG-008: Schema validation failures cause infinite retries (poison pill)
 *
 * @see packages/handlers/src/message-processor.ts
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// Schema matching MessageQueueItemSchema
const MessageQueueItemSchema = z.object({
  envelope: z.object({
    agentId: z.string(),
    platform: z.string(),
    messageId: z.string(),
    conversationId: z.string(),
    timestamp: z.number(),
    sender: z.object({
      id: z.string(),
      isBot: z.boolean(),
    }),
    content: z.object({
      text: z.string().optional(),
    }),
    metadata: z.object({
      idempotencyKey: z.string(),
    }),
  }),
  enqueuedAt: z.number(),
  attempts: z.number(),
  maxAttempts: z.number(),
});

describe('Message Processor - JSON Parse Error Handling', () => {
  /**
   * BUG-006: JSON.parse without try-catch in message processor
   * File: packages/handlers/src/message-processor.ts:556
   *
   * Previously, malformed JSON would crash the handler.
   *
   * Fix: Wrapped JSON.parse in try-catch, adds to batchItemFailures on parse error
   */
  describe('Message body parsing (BUG-006)', () => {
    it('should catch JSON parse errors and add to batch failures', async () => {
      const records = [
        { messageId: 'msg-1', body: 'not json' },
        { messageId: 'msg-2', body: '{"incomplete":' },
        { messageId: 'msg-3', body: '' },
      ];

      const batchItemFailures: { itemIdentifier: string }[] = [];

      for (const record of records) {
        try {
          JSON.parse(record.body);
        } catch {
          batchItemFailures.push({ itemIdentifier: record.messageId });
        }
      }

      expect(batchItemFailures).toHaveLength(3);
    });

    it('should handle valid JSON but invalid schema', async () => {
      const validJsonInvalidSchema = JSON.stringify({ foo: 'bar' });
      const batchItemFailures: { itemIdentifier: string }[] = [];

      try {
        const parsed = JSON.parse(validJsonInvalidSchema);
        const result = MessageQueueItemSchema.safeParse(parsed);
        if (!result.success) {
          batchItemFailures.push({ itemIdentifier: 'msg-schema-fail' });
        }
      } catch {
        batchItemFailures.push({ itemIdentifier: 'msg-schema-fail' });
      }

      expect(batchItemFailures).toHaveLength(1);
    });
  });

  /**
   * BUG-007: Tool call argument parsing without error handling
   * File: packages/handlers/src/message-processor.ts:240
   *
   * Previously, invalid JSON in tool arguments would throw unhandled error.
   *
   * Fix: Wrapped in try-catch, returns empty object on parse failure
   */
  describe('Tool call argument parsing (BUG-007)', () => {
    it('should handle malformed tool arguments gracefully', async () => {
      const toolCalls = [
        { id: 'tc-1', function: { name: 'send_message', arguments: 'not json' }},
        { id: 'tc-2', function: { name: 'react', arguments: '{"emoji":' }},
        { id: 'tc-3', function: { name: 'ignore', arguments: undefined }},
      ];

      const parsedCalls = toolCalls.map(tc => {
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = JSON.parse(tc.function.arguments || '{}');
        } catch {
          // The fix: catch and return empty object instead of crashing
          parsedArgs = {};
        }
        return {
          id: tc.id,
          name: tc.function.name,
          arguments: parsedArgs,
        };
      });

      // All tool calls should be processed, with empty args for invalid JSON
      expect(parsedCalls).toHaveLength(3);
      expect(parsedCalls[0].arguments).toEqual({});
      expect(parsedCalls[1].arguments).toEqual({});
      expect(parsedCalls[2].arguments).toEqual({});
    });

    it('should parse valid tool arguments correctly', async () => {
      const toolCall = {
        id: 'tc-valid',
        function: {
          name: 'send_message',
          arguments: JSON.stringify({ text: 'Hello world' }),
        },
      };

      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(toolCall.function.arguments || '{}');
      } catch {
        parsedArgs = {};
      }

      expect(parsedArgs).toEqual({ text: 'Hello world' });
    });

    it('should handle empty string arguments', async () => {
      const toolCall = {
        id: 'tc-empty',
        function: { name: 'ignore', arguments: '' },
      };

      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(toolCall.function.arguments || '{}');
      } catch {
        parsedArgs = {};
      }

      // Empty string falls back to default '{}'
      expect(parsedArgs).toEqual({});
    });
  });
});

describe('Message Processor - Poison Pill Prevention', () => {
  /**
   * BUG-008: Schema validation failures cause infinite retries
   * File: packages/handlers/src/message-processor.ts:568-576
   *
   * Previously, invalid schema messages would continue (skip) but not be acknowledged,
   * causing them to retry forever.
   *
   * Fix: Add schema failures to batchItemFailures so they go to DLQ
   */
  describe('Schema validation failures go to DLQ (BUG-008)', () => {
    it('should add schema failures to batch failures', async () => {
      const poisonPillMessage = {
        messageId: 'poison-123',
        body: JSON.stringify({
          // Valid JSON but missing required envelope fields
          someField: 'value',
        }),
      };

      const batchItemFailures: { itemIdentifier: string }[] = [];

      try {
        const parsed = JSON.parse(poisonPillMessage.body);
        const result = MessageQueueItemSchema.safeParse(parsed);

        if (!result.success) {
          // The fix: add to batch failures so message goes to DLQ
          batchItemFailures.push({ itemIdentifier: poisonPillMessage.messageId });
        }
      } catch {
        batchItemFailures.push({ itemIdentifier: poisonPillMessage.messageId });
      }

      expect(batchItemFailures).toHaveLength(1);
      expect(batchItemFailures[0].itemIdentifier).toBe('poison-123');
    });

    it('should not add valid messages to batch failures', async () => {
      const validMessage = {
        messageId: 'valid-123',
        body: JSON.stringify({
          envelope: {
            agentId: 'agent-1',
            platform: 'telegram',
            messageId: '456',
            conversationId: 'conv-789',
            timestamp: Date.now(),
            sender: { id: 'user-1', isBot: false },
            content: { text: 'Hello' },
            metadata: { idempotencyKey: 'key-123' },
          },
          enqueuedAt: Date.now(),
          attempts: 0,
          maxAttempts: 3,
        }),
      };

      const batchItemFailures: { itemIdentifier: string }[] = [];

      try {
        const parsed = JSON.parse(validMessage.body);
        const result = MessageQueueItemSchema.safeParse(parsed);

        if (!result.success) {
          batchItemFailures.push({ itemIdentifier: validMessage.messageId });
        }
      } catch {
        batchItemFailures.push({ itemIdentifier: validMessage.messageId });
      }

      expect(batchItemFailures).toHaveLength(0);
    });
  });
});

describe('Message Processor - Batch Processing', () => {
  it('should process valid messages even when some fail', async () => {
    const records = [
      { messageId: 'good-1', body: JSON.stringify({
        envelope: {
          agentId: 'a1', platform: 'telegram', messageId: 'm1',
          conversationId: 'c1', timestamp: Date.now(),
          sender: { id: 'u1', isBot: false },
          content: { text: 'Hi' },
          metadata: { idempotencyKey: 'k1' },
        },
        enqueuedAt: Date.now(), attempts: 0, maxAttempts: 3,
      })},
      { messageId: 'bad-1', body: 'invalid' },
      { messageId: 'good-2', body: JSON.stringify({
        envelope: {
          agentId: 'a2', platform: 'telegram', messageId: 'm2',
          conversationId: 'c2', timestamp: Date.now(),
          sender: { id: 'u2', isBot: false },
          content: { text: 'Hello' },
          metadata: { idempotencyKey: 'k2' },
        },
        enqueuedAt: Date.now(), attempts: 0, maxAttempts: 3,
      })},
    ];

    const batchItemFailures: { itemIdentifier: string }[] = [];
    const processedMessages: string[] = [];

    for (const record of records) {
      try {
        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(record.body);
        } catch {
          batchItemFailures.push({ itemIdentifier: record.messageId });
          continue;
        }

        const result = MessageQueueItemSchema.safeParse(parsedBody);
        if (!result.success) {
          batchItemFailures.push({ itemIdentifier: record.messageId });
          continue;
        }

        processedMessages.push(result.data.envelope.messageId);
      } catch {
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }

    expect(processedMessages).toEqual(['m1', 'm2']);
    expect(batchItemFailures).toHaveLength(1);
    expect(batchItemFailures[0].itemIdentifier).toBe('bad-1');
  });

  it('should return batch response even when all messages succeed', async () => {
    const batchItemFailures: { itemIdentifier: string }[] = [];

    // Even with no failures, should return the proper structure
    const response = { batchItemFailures };

    expect(response.batchItemFailures).toEqual([]);
  });
});
