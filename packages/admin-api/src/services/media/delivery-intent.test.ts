import { describe, expect, it } from 'bun:test';
import type { MediaJob } from '../../types.js';
import { resolveJobDeliveryIntent } from './delivery-intent.js';

function makeJob(overrides: Partial<MediaJob> = {}): MediaJob {
  return {
    pk: 'MEDIAJOB#job-1',
    sk: 'STATUS',
    jobId: 'job-1',
    avatarId: 'avatar-1',
    type: 'image',
    status: 'processing',
    prompt: 'group portrait',
    conversationId: '-1001234567890',
    platform: 'telegram',
    replyToMessageId: '55',
    provider: 'replicate',
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ttl: 1700003600,
    ...overrides,
  };
}

describe('resolveJobDeliveryIntent', () => {
  it('keeps a same-conversation Telegram group target for legacy jobs', () => {
    expect(resolveJobDeliveryIntent(makeJob())).toEqual({
      platform: 'telegram',
      conversationId: '-1001234567890',
      replyToMessageId: '55',
      expectedAction: 'send_media',
    });
  });

  it('keeps an explicit supported cross-platform target', () => {
    expect(resolveJobDeliveryIntent(makeJob({
      platform: 'admin-ui',
      conversationId: 'admin-session-1',
      deliveryIntent: {
        platform: 'discord',
        conversationId: 'discord-channel-42',
        replyToMessageId: 'discord-message-7',
        expectedAction: 'discord_send_media_to_channel',
      },
    }))).toEqual({
      platform: 'discord',
      conversationId: 'discord-channel-42',
      replyToMessageId: 'discord-message-7',
      expectedAction: 'discord_send_media_to_channel',
    });
  });

  it('does not push polling-only or separate-workflow jobs', () => {
    expect(resolveJobDeliveryIntent(makeJob({
      platform: 'admin-ui',
      conversationId: 'admin-session-1',
    }))).toBeUndefined();
    expect(resolveJobDeliveryIntent(makeJob({ purpose: 'profile' }))).toBeUndefined();
    expect(resolveJobDeliveryIntent(makeJob({ purpose: 'post_to_twitter' }))).toBeUndefined();
  });
});
