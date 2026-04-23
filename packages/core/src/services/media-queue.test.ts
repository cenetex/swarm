/**
 * Tests for enqueueMediaJob — verifies the jobType parameter
 * produces the correct action.type in the SQS message payload.
 *
 * Covers the contract that platform-mcp-adapter relies on to route
 * generate_video jobs through MEDIA_QUEUE (see #1493).
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';

const sendMock = mock(async () => ({ MessageId: 'stub' }));

mock.module('@aws-sdk/client-sqs', () => ({
  SQSClient: class {
    send = sendMock;
  },
  SendMessageCommand: class {
    public input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

// Import after mock so enqueueMediaJob picks up the stubbed client.
const { enqueueMediaJob } = await import('./media-queue.js');

describe('enqueueMediaJob', () => {
  beforeEach(() => {
    sendMock.mockClear();
  });

  it('defaults action.type to generate_image when jobType is omitted', async () => {
    await enqueueMediaJob('queue-url', {
      avatarId: 'a1',
      conversationId: 'c1',
      platform: 'telegram',
      prompt: 'a cat',
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
    const cmd = sendMock.mock.calls[0][0] as { input: { MessageBody: string } };
    const body = JSON.parse(cmd.input.MessageBody);
    expect(body.action.type).toBe('generate_image');
  });

  it('sets action.type to generate_video when jobType=generate_video', async () => {
    await enqueueMediaJob('queue-url', {
      avatarId: 'a1',
      conversationId: 'c1',
      platform: 'telegram',
      prompt: 'a dancing cat',
      jobType: 'generate_video',
    });

    const cmd = sendMock.mock.calls[0][0] as { input: { MessageBody: string } };
    const body = JSON.parse(cmd.input.MessageBody);
    expect(body.action.type).toBe('generate_video');
    expect(body.action.prompt).toBe('a dancing cat');
  });

  it('propagates usageAccounted, traceId, and replyToMessageId', async () => {
    await enqueueMediaJob('queue-url', {
      avatarId: 'a1',
      conversationId: 'c1',
      platform: 'telegram',
      prompt: 'a cat',
      usageAccounted: true,
      traceId: 'trace-xyz',
      replyToMessageId: 'msg-42',
      jobType: 'generate_video',
    });

    const cmd = sendMock.mock.calls[0][0] as {
      input: { MessageBody: string; MessageAttributes?: Record<string, { StringValue: string }> };
    };
    const body = JSON.parse(cmd.input.MessageBody);
    expect(body.usageAccounted).toBe(true);
    expect(body.response.replyToMessageId).toBe('msg-42');
    expect(cmd.input.MessageAttributes?.traceId?.StringValue).toBe('trace-xyz');
  });
});
