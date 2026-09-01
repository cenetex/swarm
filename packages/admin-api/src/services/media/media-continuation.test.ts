import { afterEach, describe, expect, it } from 'vitest';
import type { MediaJob } from '../../types.js';
import { _setSQSClient } from '../aws-clients.js';
import {
  buildMediaFailedContinuation,
  buildMediaGeneratedContinuation,
  publishMediaGeneratedContinuation,
} from './media-continuation.js';

function makeJob(overrides: Partial<MediaJob> = {}): MediaJob {
  return {
    pk: 'MEDIAJOB#job-1',
    sk: 'STATUS',
    jobId: 'job-1',
    avatarId: 'avatar-1',
    type: 'image',
    status: 'processing',
    prompt: 'a team portrait',
    conversationId: '-100123',
    platform: 'telegram',
    replyToMessageId: 'message-9',
    provider: 'replicate',
    purpose: 'send_to_chat',
    createdAt: 1,
    updatedAt: 1,
    ttl: 100,
    ...overrides,
  };
}

afterEach(() => {
  delete process.env.RESPONSE_QUEUE_URL;
  _setSQSClient(null);
});

describe('media continuation publishing', () => {
  it('keeps a same-conversation Telegram group and reply target', () => {
    expect(buildMediaGeneratedContinuation(makeJob(), 'https://cdn.test/image.png', 10)).toEqual({
      type: 'media_generated',
      avatarId: 'avatar-1',
      platform: 'telegram',
      conversationId: '-100123',
      replyToMessageId: 'message-9',
      jobId: 'job-1',
      timestamp: 10,
      data: {
        mediaType: 'image',
        mediaUrl: 'https://cdn.test/image.png',
        prompt: 'a team portrait',
        purpose: 'send_to_chat',
        deliveryIntent: {
          platform: 'telegram',
          conversationId: '-100123',
          replyToMessageId: 'message-9',
          expectedAction: 'send_media',
        },
      },
    });
  });

  it('keeps an explicit supported cross-platform destination', () => {
    const continuation = buildMediaFailedContinuation(makeJob({
      platform: 'admin-ui',
      conversationId: 'admin-session',
      replyToMessageId: undefined,
      deliveryIntent: {
        platform: 'discord',
        conversationId: 'channel-42',
        replyToMessageId: 'discord-message-7',
        expectedAction: 'discord_send_media_to_channel',
      },
    }), 'provider failed', 20);

    expect(continuation?.platform).toBe('admin-ui');
    expect(continuation?.data.deliveryIntent).toEqual({
      platform: 'discord',
      conversationId: 'channel-42',
      replyToMessageId: 'discord-message-7',
      expectedAction: 'discord_send_media_to_channel',
    });
  });

  it('publishes the stored target to the response queue', async () => {
    const sent: Array<Record<string, unknown>> = [];
    _setSQSClient({
      async send(command) {
        sent.push(command.input);
        return {};
      },
    });
    process.env.RESPONSE_QUEUE_URL = 'https://sqs.test/responses';

    await expect(publishMediaGeneratedContinuation(
      makeJob(),
      'https://cdn.test/image.png',
    )).resolves.toBe(true);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.QueueUrl).toBe('https://sqs.test/responses');
    expect(JSON.parse(String(sent[0]?.MessageBody)).data.deliveryIntent.conversationId).toBe('-100123');
  });

  it('does not publish polling-only admin gallery jobs', async () => {
    process.env.RESPONSE_QUEUE_URL = 'https://sqs.test/responses';

    await expect(publishMediaGeneratedContinuation(makeJob({
      platform: 'admin-ui',
      conversationId: 'admin-session',
      purpose: 'gallery',
      deliveryIntent: undefined,
    }), 'https://cdn.test/image.png')).resolves.toBe(false);
  });
});
