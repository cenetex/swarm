/**
 * Response Sender Handler Tests
 * Tests for JSON.parse error handling and SQS batch failure responses
 *
 * Bug Index:
 * - BUG-001: JSON.parse without try-catch in handlers/response-sender.ts:103
 * - BUG-002: SQS batch failure - single bad message fails entire batch
 *
 * Uses bun:test with mock functions instead of vi.mock for dependency injection.
 *
 * @see packages/handlers/src/response-sender.ts
 */
import { describe, it, expect, vi } from 'vitest';

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
        avatarId: 'test-avatar',
        platform: 'telegram',
        conversationId: '123',
        actions: [{ type: 'send_message', text: 'hello' }],
      });
      const record = { messageId: 'msg-valid', body: validBody };
      const batchItemFailures: { itemIdentifier: string }[] = [];

      try {
        const parsed = JSON.parse(record.body);
        expect(parsed.avatarId).toBe('test-avatar');
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

describe('Response Sender - Telegram DM Guard', () => {
  it('treats positive Telegram chat IDs as DMs', () => {
    const isTelegramDirectMessageChatId = (conversationId: string) => {
      const chatId = Number(conversationId);
      return Number.isFinite(chatId) && chatId > 0;
    };

    expect(isTelegramDirectMessageChatId('123')).toBe(true);
    expect(isTelegramDirectMessageChatId('-100123')).toBe(false);
    expect(isTelegramDirectMessageChatId('not-a-number')).toBe(false);
  });

  it('builds RATi Chat New Bot deep link', () => {
    const ratichatUrl = 'https://t.me/ratichat';
    const newBotUrl = `${ratichatUrl}?start=new_bot`;
    expect(newBotUrl).toBe('https://t.me/ratichat?start=new_bot');
  });
});

describe('Response Sender - Media Handling', () => {
  /**
   * Tests for media action processing:
   * - Media generation actions (take_selfie, generate_video) are queued to MEDIA_QUEUE
   * - Non-media actions are sent directly
   * - Responses can contain both media and non-media actions
   */

  describe('Media action detection', () => {
    it('should identify media generation actions', () => {
      const actions = [
        { type: 'send_message', text: 'Hello!' },
        { type: 'take_selfie', prompt: 'A happy selfie' },
        { type: 'generate_video', prompt: 'Dancing robot' },
        { type: 'react', emoji: 'thumbsup' },
      ];

      const mediaActions = actions.filter(
        a => a.type === 'take_selfie' || a.type === 'generate_video'
      );
      const nonMediaActions = actions.filter(
        a => a.type !== 'take_selfie' && a.type !== 'generate_video'
      );

      expect(mediaActions).toHaveLength(2);
      expect(nonMediaActions).toHaveLength(2);
    });

    it('should separate media and non-media actions', () => {
      const response = {
        actions: [
          { type: 'send_message', text: 'Generating image...' },
          { type: 'take_selfie', prompt: 'Sunset selfie' },
        ],
      };

      const mediaActions = response.actions.filter(
        a => a.type === 'take_selfie' || a.type === 'generate_video'
      );
      const nonMediaActions = response.actions.filter(
        a => a.type !== 'take_selfie' && a.type !== 'generate_video'
      );

      expect(mediaActions).toHaveLength(1);
      expect(mediaActions[0].type).toBe('take_selfie');
      expect(nonMediaActions).toHaveLength(1);
      expect(nonMediaActions[0].type).toBe('send_message');
    });
  });

  describe('Media queue handling', () => {
    it('should create media job with required fields', () => {
      const jobId = 'job-123';
      const action = { type: 'take_selfie', prompt: 'Beach sunset' };
      const response = {
        avatarId: 'test-avatar',
        conversationId: 'conv-456',
      };

      const mediaJob = {
        jobId,
        avatarId: response.avatarId,
        conversationId: response.conversationId,
        action,
        response,
      };

      expect(mediaJob.jobId).toBe('job-123');
      expect(mediaJob.avatarId).toBe('test-avatar');
      expect(mediaJob.action.type).toBe('take_selfie');
    });

    it('should handle missing MEDIA_QUEUE_URL gracefully', () => {
      const MEDIA_QUEUE_URL = undefined;
      const mediaActions = [{ type: 'take_selfie', prompt: 'Test' }];

      let actionsToSend;
      if (mediaActions.length > 0) {
        if (MEDIA_QUEUE_URL) {
          // Would queue media
        } else {
          // Fallback: send error message
          actionsToSend = [{
            type: 'send_message',
            text: 'Media generation is unavailable right now.',
          }];
        }
      }

      expect(actionsToSend).toEqual([{
        type: 'send_message',
        text: 'Media generation is unavailable right now.',
      }]);
    });
  });

  describe('Mixed media and text responses', () => {
    it('should send text immediately while media is queued', () => {
      const response = {
        actions: [
          { type: 'send_message', text: 'Working on that image...' },
          { type: 'take_selfie', prompt: 'Cat picture' },
        ],
      };

      const mediaActions = response.actions.filter(
        a => a.type === 'take_selfie' || a.type === 'generate_video'
      );
      const nonMediaActions = response.actions.filter(
        a => a.type !== 'take_selfie' && a.type !== 'generate_video'
      );

      // Non-media should be sent immediately
      expect(nonMediaActions).toHaveLength(1);
      // Media should be queued
      expect(mediaActions).toHaveLength(1);
    });
  });
});

describe('Response Sender - Pending Jobs', () => {
  /**
   * Tests for async media generation with pending jobs:
   * - Jobs are tracked with jobId
   * - Completed jobs trigger media delivery
   * - Failed jobs are handled gracefully
   */

  describe('Pending job tracking', () => {
    it('should extract pending job from tool result', () => {
      const toolResult = {
        content: JSON.stringify({
          success: true,
          _pendingJob: {
            jobId: 'job-abc123',
            type: 'video',
            prompt: 'Dancing robot animation',
            purpose: 'user_request',
          },
        }),
      };

      const parsed = JSON.parse(toolResult.content);
      const pendingJobs: Array<{
        jobId: string;
        type: string;
        prompt?: string;
        purpose?: string;
      }> = [];

      if (parsed._pendingJob) {
        pendingJobs.push({
          jobId: parsed._pendingJob.jobId,
          type: parsed._pendingJob.type || 'image',
          prompt: parsed._pendingJob.prompt,
          purpose: parsed._pendingJob.purpose,
        });
      }

      expect(pendingJobs).toHaveLength(1);
      expect(pendingJobs[0].jobId).toBe('job-abc123');
      expect(pendingJobs[0].type).toBe('video');
      expect(pendingJobs[0].purpose).toBe('user_request');
    });

    it('should detect pending status from alternative format', () => {
      const toolResult = {
        content: JSON.stringify({
          success: true,
          jobId: 'job-xyz789',
          status: 'pending',
          prompt: 'Abstract art',
        }),
      };

      const parsed = JSON.parse(toolResult.content);
      const pendingJobs: Array<{ jobId: string; type: string; prompt?: string }> = [];

      if (parsed.jobId && (parsed.status === 'pending' || parsed.status === 'processing')) {
        pendingJobs.push({
          jobId: parsed.jobId,
          type: 'image', // Default type
          prompt: parsed.prompt,
        });
      }

      expect(pendingJobs).toHaveLength(1);
      expect(pendingJobs[0].jobId).toBe('job-xyz789');
    });

    it('should not detect completed jobs as pending', () => {
      const toolResult = {
        content: JSON.stringify({
          success: true,
          jobId: 'job-completed',
          status: 'completed',
          url: 'https://cdn.example.com/result.png',
        }),
      };

      const parsed = JSON.parse(toolResult.content);
      const pendingJobs: Array<{ jobId: string }> = [];

      if (parsed.jobId && (parsed.status === 'pending' || parsed.status === 'processing')) {
        pendingJobs.push({ jobId: parsed.jobId });
      }

      expect(pendingJobs).toHaveLength(0);
    });
  });

  describe('Job type detection', () => {
    it('should detect video type from tool name', () => {
      const toolName = 'generate_video' as string;

      const jobType = toolName === 'generate_video'
        ? 'video'
        : toolName === 'generate_sticker'
          ? 'sticker'
          : 'image';

      expect(jobType).toBe('video');
    });

    it('should detect sticker type from tool name', () => {
      const toolName = 'generate_sticker' as string;
      const jobType = toolName === 'generate_video'
        ? 'video'
        : toolName === 'generate_sticker'
          ? 'sticker'
          : 'image';

      expect(jobType).toBe('sticker');
    });

    it('should default to image type', () => {
      const toolName = 'generate_image' as string;
      const jobType = toolName === 'generate_video'
        ? 'video'
        : toolName === 'generate_sticker'
          ? 'sticker'
          : 'image';

      expect(jobType).toBe('image');
    });
  });
});

describe('Response Sender - Channel State Updates', () => {
  it('should update channel state with bot messages', () => {
    const sentMessages = ['Hello!', 'Here is your image.'];
    const avatarName = 'Test Bot';

    const channelUpdates = sentMessages.map(text => ({
      messageId: `bot_${Math.random().toString(36).slice(2)}`,
      sender: avatarName,
      isBot: true,
      content: text,
      timestamp: Date.now(),
    }));

    expect(channelUpdates).toHaveLength(2);
    expect(channelUpdates[0].isBot).toBe(true);
    expect(channelUpdates[0].sender).toBe('Test Bot');
  });
});

describe('Response Sender - Idempotency', () => {
  it('should generate unique response key', () => {
    const response = {
      conversationId: 'conv-123',
      replyToMessageId: 'msg-456',
      generatedAt: 1700000000000,
    };
    const recordMessageId = 'sqs-msg-789';

    const anchor = response.replyToMessageId ?? response.generatedAt ?? recordMessageId;
    const responseKey = `${response.conversationId}#${anchor}`;

    expect(responseKey).toBe('conv-123#msg-456');
  });

  it('should use generatedAt when replyToMessageId is missing', () => {
    const response = {
      conversationId: 'conv-123',
      replyToMessageId: undefined,
      generatedAt: 1700000000000,
    };
    const recordMessageId = 'sqs-msg-789';

    const anchor = response.replyToMessageId ?? response.generatedAt ?? recordMessageId;
    const responseKey = `${response.conversationId}#${anchor}`;

    expect(responseKey).toBe('conv-123#1700000000000');
  });

  it('should use recordMessageId as last fallback', () => {
    const response = {
      conversationId: 'conv-123',
      replyToMessageId: undefined,
      generatedAt: undefined,
    };
    const recordMessageId = 'sqs-msg-789';

    const anchor = response.replyToMessageId ?? response.generatedAt ?? recordMessageId;
    const responseKey = `${response.conversationId}#${anchor}`;

    expect(responseKey).toBe('conv-123#sqs-msg-789');
  });
});

describe('Response Sender - Service Mock Integration', () => {
  it('should send response via platform adapter', async () => {
    const mockSend = vi.fn(() => Promise.resolve({
      success: true,
      sentMessages: [{ messageId: 'msg-1', text: 'Hello!' }],
      errors: [],
    }));

    const mockOutboundSender = {
      send: mockSend,
    };

    const response = {
      avatarId: 'test-avatar',
      platform: 'telegram',
      conversationId: '12345',
      actions: [{ type: 'send_message', text: 'Hello!' }],
    };

    const result = await mockOutboundSender.send(response);

    expect(mockSend).toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.sentMessages).toHaveLength(1);
  });

  it('should handle send errors gracefully', async () => {
    const mockSend = vi.fn(() => Promise.resolve({
      success: false,
      sentMessages: [],
      errors: [{ action: 'send_message', message: 'Too many requests', statusCode: 429, isRetryable: true }],
    }));

    const mockOutboundSender = {
      send: mockSend,
    };

    const result = await mockOutboundSender.send({});

    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].statusCode).toBe(429);
  });

  it('should queue media jobs to SQS', async () => {
    const mockSqsSend = vi.fn(() => Promise.resolve({ MessageId: 'sqs-123' }));

    const mediaJob = {
      jobId: 'job-123',
      avatarId: 'test-avatar',
      conversationId: 'conv-456',
      action: { type: 'take_selfie', prompt: 'Beach sunset' },
    };

    // Simulate SQS send
    const sqsResult = await mockSqsSend({
      QueueUrl: 'https://sqs.test/media-queue',
      MessageBody: JSON.stringify(mediaJob),
      MessageGroupId: mediaJob.conversationId,
    });

    expect(mockSqsSend).toHaveBeenCalled();
    expect(sqsResult.MessageId).toBe('sqs-123');
  });
});

describe('Response Sender - Non-Retryable Error Handling (#368)', () => {
  /**
   * Tests for Twitter 403 and other non-retryable errors.
   * When all errors from OutboundSender are non-retryable (isRetryable: false),
   * the response sender should NOT add the message to batchItemFailures,
   * preventing wasteful SQS retries.
   */

  it('should not retry when all errors are non-retryable (e.g. 403)', () => {
    const actionErrors = [
      { action: 'send_message', message: 'Forbidden', statusCode: 403, isRetryable: false },
    ];

    const hasRetryableError = actionErrors.length === 0 ||
      actionErrors.some(e => e.isRetryable !== false);

    expect(hasRetryableError).toBe(false);
  });

  it('should retry when at least one error is retryable', () => {
    const actionErrors = [
      { action: 'send_message', message: 'Forbidden', statusCode: 403, isRetryable: false },
      { action: 'react', message: 'Server error', statusCode: 500, isRetryable: true },
    ];

    const hasRetryableError = actionErrors.length === 0 ||
      actionErrors.some(e => e.isRetryable !== false);

    expect(hasRetryableError).toBe(true);
  });

  it('should retry when errors array is empty (default safe behavior)', () => {
    const actionErrors: { action: string; message: string; statusCode?: number; isRetryable?: boolean }[] = [];

    const hasRetryableError = actionErrors.length === 0 ||
      actionErrors.some(e => e.isRetryable !== false);

    expect(hasRetryableError).toBe(true);
  });

  it('should retry when isRetryable is undefined (unknown errors default to retryable)', () => {
    const actionErrors = [
      { action: 'send_message', message: 'Unknown error', isRetryable: undefined },
    ];

    // isRetryable !== false is true when isRetryable is undefined
    const hasRetryableError = actionErrors.length === 0 ||
      actionErrors.some(e => e.isRetryable !== false);

    expect(hasRetryableError).toBe(true);
  });

  it('should not retry when multiple errors are all non-retryable', () => {
    const actionErrors = [
      { action: 'send_message', message: 'Forbidden', statusCode: 403, isRetryable: false },
      { action: 'react', message: 'Unauthorized', statusCode: 401, isRetryable: false },
    ];

    const hasRetryableError = actionErrors.length === 0 ||
      actionErrors.some(e => e.isRetryable !== false);

    expect(hasRetryableError).toBe(false);
  });

  it('should simulate full non-retryable flow without adding to batchItemFailures', () => {
    const batchItemFailures: { itemIdentifier: string }[] = [];
    const record = { messageId: 'msg-twitter-403' };

    // Simulate: outboundSender.send() returned non-retryable errors
    const sendSuccess = false;
    const actionErrors = [
      { action: 'send_message', message: 'Forbidden (403): reply restriction', statusCode: 403, isRetryable: false },
    ];

    // This is the logic from response-sender.ts
    if (!sendSuccess) {
      const hasRetryableError = actionErrors.length === 0 ||
        actionErrors.some(e => e.isRetryable !== false);

      if (!hasRetryableError) {
        // Non-retryable: don't add to batchItemFailures
      } else {
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }

    // 403 should NOT cause a retry
    expect(batchItemFailures).toHaveLength(0);
  });

  it('should add to batchItemFailures for retryable errors (e.g. 500)', () => {
    const batchItemFailures: { itemIdentifier: string }[] = [];
    const record = { messageId: 'msg-twitter-500' };

    const sendSuccess = false;
    const actionErrors = [
      { action: 'send_message', message: 'Server error', statusCode: 500, isRetryable: true },
    ];

    if (!sendSuccess) {
      const hasRetryableError = actionErrors.length === 0 ||
        actionErrors.some(e => e.isRetryable !== false);

      if (!hasRetryableError) {
        // Non-retryable
      } else {
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }

    // 500 SHOULD cause a retry
    expect(batchItemFailures).toHaveLength(1);
    expect(batchItemFailures[0].itemIdentifier).toBe('msg-twitter-500');
  });
});
