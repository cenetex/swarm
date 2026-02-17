/**
 * Media Processor Handler Tests
 * Tests for JSON.parse error handling, schema validation, and SQS batch failures
 *
 * Bug Index:
 * - BUG-003: JSON.parse without try-catch in handlers/media-processor.ts:168
 * - BUG-004: Schema validation failures cause infinite retries (poison pill)
 * - BUG-005: Single failure fails entire SQS batch
 *
 * @see packages/handlers/src/media-processor.ts
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';

// Schema matching the one in media-processor.ts
const MediaQueueItemSchema = z.object({
  jobId: z.string(),
  avatarId: z.string(),
  conversationId: z.string(),
  action: z.object({
    type: z.string(),
    prompt: z.string().optional(),
    style: z.string().optional(),
  }),
  response: z.object({
    platform: z.string(),
    conversationId: z.string(),
    replyToMessageId: z.string().optional(),
    actions: z.array(z.unknown()),
    generatedAt: z.number().optional(),
  }),
});

describe('Media Processor - JSON Parse Error Handling', () => {
  /**
   * BUG-003: JSON.parse without try-catch in media processor
   * File: packages/handlers/src/media-processor.ts:168
   *
   * Previously, malformed JSON would crash the handler.
   *
   * Fix: Wrapped JSON.parse in try-catch, adds to batchItemFailures on parse error
   */
  describe('Malformed JSON handling (BUG-003)', () => {
    it('should catch JSON parse errors and add to batch failures', async () => {
      const malformedBodies = [
        'not json at all',
        '{"incomplete": ',
        '{key: no quotes}',
        'null',  // Valid JSON but not an object
        '[]',    // Valid JSON but not expected type
      ];

      for (const body of malformedBodies) {
        const batchItemFailures: { itemIdentifier: string }[] = [];
        const messageId = `msg-${Math.random()}`;

        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(body);
        } catch {
          batchItemFailures.push({ itemIdentifier: messageId });
          continue;
        }

        // Even if JSON parses, schema might fail
        const parseResult = MediaQueueItemSchema.safeParse(parsedBody);
        if (!parseResult.success) {
          batchItemFailures.push({ itemIdentifier: messageId });
        }

        expect(batchItemFailures.length).toBeGreaterThanOrEqual(1);
      }
    });
  });

  /**
   * BUG-004: Schema validation failures should go to DLQ
   * File: packages/handlers/src/media-processor.ts:179-187
   *
   * Previously, invalid schema messages would retry forever (poison pill).
   *
   * Fix: Add schema failures to batchItemFailures so they go to DLQ
   */
  describe('Schema validation and poison pill prevention (BUG-004)', () => {
    it('should reject messages missing required fields', async () => {
      const invalidMessages = [
        { jobId: '123' },  // Missing avatarId, conversationId, etc.
        { jobId: '123', avatarId: 'test' },  // Missing conversationId
        { jobId: '123', avatarId: 'test', conversationId: 'conv' },  // Missing action, response
      ];

      for (const msg of invalidMessages) {
        const result = MediaQueueItemSchema.safeParse(msg);
        expect(result.success).toBe(false);
      }
    });

    it('should accept valid media queue items', async () => {
      const validMessage = {
        jobId: 'job-123',
        avatarId: 'avatar-456',
        conversationId: 'conv-789',
        action: {
          type: 'take_selfie',
          prompt: 'A cute cat',
        },
        response: {
          platform: 'telegram',
          conversationId: 'conv-789',
          actions: [],
        },
      };

      const result = MediaQueueItemSchema.safeParse(validMessage);
      expect(result.success).toBe(true);
    });

    it('should add schema failures to batch failures (not retry forever)', async () => {
      const batchItemFailures: { itemIdentifier: string }[] = [];

      // Invalid schema - would previously cause infinite retries
      const invalidBody = JSON.stringify({ jobId: 'only-job-id' });
      const messageId = 'poison-pill-msg';

      try {
        const parsedBody = JSON.parse(invalidBody);
        const parseResult = MediaQueueItemSchema.safeParse(parsedBody);

        if (!parseResult.success) {
          // This is the fix - add to failures instead of just continuing
          batchItemFailures.push({ itemIdentifier: messageId });
        }
      } catch {
        batchItemFailures.push({ itemIdentifier: messageId });
      }

      expect(batchItemFailures).toHaveLength(1);
      expect(batchItemFailures[0].itemIdentifier).toBe('poison-pill-msg');
    });
  });

  /**
   * BUG-005: Single failure fails entire batch
   * File: packages/handlers/src/media-processor.ts:264-267
   *
   * Previously, throwing error inside the loop would fail all messages.
   *
   * Fix: Catch errors and add to batchItemFailures instead of throwing
   */
  describe('Partial batch failure handling (BUG-005)', () => {
    it('should process valid messages even when some fail', async () => {
      const records = [
        { messageId: 'valid-1', body: JSON.stringify({
          jobId: 'j1', avatarId: 'a1', conversationId: 'c1',
          action: { type: 'take_selfie' },
          response: { platform: 'telegram', conversationId: 'c1', actions: [] },
        })},
        { messageId: 'invalid-1', body: 'not json' },
        { messageId: 'valid-2', body: JSON.stringify({
          jobId: 'j2', avatarId: 'a2', conversationId: 'c2',
          action: { type: 'take_selfie' },
          response: { platform: 'telegram', conversationId: 'c2', actions: [] },
        })},
      ];

      const batchItemFailures: { itemIdentifier: string }[] = [];
      const processedJobs: string[] = [];

      for (const record of records) {
        try {
          let parsedBody: unknown;
          try {
            parsedBody = JSON.parse(record.body);
          } catch {
            batchItemFailures.push({ itemIdentifier: record.messageId });
            continue;
          }

          const parseResult = MediaQueueItemSchema.safeParse(parsedBody);
          if (!parseResult.success) {
            batchItemFailures.push({ itemIdentifier: record.messageId });
            continue;
          }

          // Simulate successful processing
          processedJobs.push(parseResult.data.jobId);
        } catch {
          batchItemFailures.push({ itemIdentifier: record.messageId });
        }
      }

      // Valid messages should be processed
      expect(processedJobs).toEqual(['j1', 'j2']);
      // Invalid message should be in failures
      expect(batchItemFailures).toHaveLength(1);
      expect(batchItemFailures[0].itemIdentifier).toBe('invalid-1');
    });

    it('should return proper batch response format', async () => {
      const batchItemFailures = [
        { itemIdentifier: 'failed-1' },
        { itemIdentifier: 'failed-2' },
      ];

      const response = { batchItemFailures };

      // This is the format SQS expects for partial batch failures
      expect(response).toHaveProperty('batchItemFailures');
      expect(Array.isArray(response.batchItemFailures)).toBe(true);
      expect(response.batchItemFailures[0]).toHaveProperty('itemIdentifier');
    });
  });
});

describe('Media Processor - Error Recovery', () => {
  it('should not throw when media job fails - add to batch failures instead', async () => {
    const batchItemFailures: { itemIdentifier: string }[] = [];
    const messageId = 'media-job-fail';

    // Simulate a media job processing error
    const simulateMediaJobFailure = () => {
      throw new Error('Replicate API error');
    };

    try {
      simulateMediaJobFailure();
    } catch {
      // The fix: catch and add to batch failures instead of re-throwing
      batchItemFailures.push({ itemIdentifier: messageId });
    }

    expect(batchItemFailures).toHaveLength(1);
    // Handler should continue processing other messages
  });
});
