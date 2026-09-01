import { describe, expect, it } from 'bun:test';
import { MessageQueueItemSchema, type MediaGeneratedContinuation } from '@swarm/core';
import { _setDynamoClient } from '../services/dynamo-client.js';
import { _setSecretsClient } from '../services/aws-clients.js';

const unusedClient = { send: async () => ({}) };
_setDynamoClient(unusedClient);
_setSecretsClient(unusedClient);
const { buildContinuationEnvelope } = await import('./continuation-processor.js');

describe('buildContinuationEnvelope', () => {
  it('builds a schema-valid direct follow-up for a group media continuation', () => {
    const continuation: MediaGeneratedContinuation = {
      type: 'media_generated',
      avatarId: 'avatar-1',
      platform: 'telegram',
      conversationId: '-1001234567890',
      replyToMessageId: '55',
      jobId: 'job-1',
      timestamp: 1700000000000,
      data: {
        mediaType: 'image',
        mediaUrl: 'https://cdn.example.com/image.png',
        prompt: 'group portrait',
        deliveryIntent: {
          platform: 'telegram',
          conversationId: '-1001234567890',
          replyToMessageId: '55',
          expectedAction: 'send_media',
        },
      },
    };

    const envelope = buildContinuationEnvelope(continuation, 'completed', 'trace-1');
    const parsed = MessageQueueItemSchema.safeParse({
      envelope,
      enqueuedAt: Date.now(),
      attempts: 0,
      maxAttempts: 1,
    });

    expect(parsed.success).toBe(true);
    expect(envelope.conversationId).toBe('-1001234567890');
    expect(envelope.replyTo).toBe('55');
    expect(envelope.metadata).toMatchObject({
      isContinuation: true,
      continuationType: 'media_generated',
      originalJobId: 'job-1',
      isReplyToBot: true,
      shouldRespond: true,
    });
  });

  it('routes a fallback envelope to an explicit supported cross-platform target', () => {
    const continuation: MediaGeneratedContinuation = {
      type: 'media_generated',
      avatarId: 'avatar-1',
      platform: 'admin-ui',
      conversationId: 'admin-session-1',
      jobId: 'job-2',
      timestamp: 1700000000000,
      data: {
        mediaType: 'video',
        mediaUrl: 'https://cdn.example.com/video.mp4',
        prompt: 'launch clip',
        deliveryIntent: {
          platform: 'discord',
          conversationId: 'discord-channel-42',
          replyToMessageId: 'discord-message-7',
          expectedAction: 'discord_send_media_to_channel',
        },
      },
    };

    const envelope = buildContinuationEnvelope(continuation, 'completed', 'trace-2');

    expect(envelope.platform).toBe('discord');
    expect(envelope.conversationId).toBe('discord-channel-42');
    expect(envelope.replyTo).toBe('discord-message-7');
  });
});
