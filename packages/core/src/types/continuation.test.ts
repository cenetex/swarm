import { describe, it, expect } from 'bun:test';
import {
  buildMediaDeliveryResponse,
  createMediaDeliveryIntent,
  formatContinuationAsSystemMessage,
} from './continuation.js';
import type { MediaFailedContinuation, MediaGeneratedContinuation, ResumeContext } from './continuation.js';

const BASE = {
  avatarId: 'avatar-1',
  platform: 'telegram' as const,
  conversationId: 'conv-1',
  timestamp: 1700000000000,
};

function makeMediaFailed(error: string): MediaFailedContinuation {
  return {
    ...BASE,
    type: 'media_failed',
    data: {
      mediaType: 'image',
      error,
      prompt: 'a beautiful sunset',
    },
  };
}

function makeMediaGenerated(): MediaGeneratedContinuation {
  return {
    ...BASE,
    type: 'media_generated',
    jobId: 'job-123',
    data: {
      mediaType: 'image',
      mediaUrl: 'https://example.com/image.png',
      prompt: 'a beautiful sunset',
    },
  };
}

describe('formatContinuationAsSystemMessage', () => {
  describe('media_failed — E006 / prompt rejection', () => {
    it('detects E006 in the error string and returns user-friendly guidance', () => {
      const msg = makeMediaFailed('E006: Prediction rejected due to content policy');
      const result = formatContinuationAsSystemMessage(msg);

      expect(result).toContain('content filter');
      expect(result).toContain('rephrase');
      // Must NOT echo raw error codes or prediction IDs
      expect(result).not.toContain('E006');
      expect(result).not.toContain('Prediction rejected');
    });

    it('detects "Prompt was rejected" in the error string and returns user-friendly guidance', () => {
      const msg = makeMediaFailed('Prompt was rejected by safety checker (prediction: abc123)');
      const result = formatContinuationAsSystemMessage(msg);

      expect(result).toContain('content filter');
      expect(result).toContain('rephrase');
      expect(result).not.toContain('abc123');
      expect(result).not.toContain('Prompt was rejected');
    });

    it('includes the original prompt in E006 guidance', () => {
      const msg = makeMediaFailed('E006: rejected');
      const result = formatContinuationAsSystemMessage(msg);
      expect(result).toContain('a beautiful sunset');
    });
  });

  describe('media_failed — non-E006 failures', () => {
    it('includes the raw error for non-E006 failures', () => {
      const msg = makeMediaFailed('Connection timeout after 30s');
      const result = formatContinuationAsSystemMessage(msg);

      expect(result).toContain('Connection timeout after 30s');
      expect(result).toContain('inform the user about this failure');
    });

    it('includes original prompt for non-E006 failures', () => {
      const msg = makeMediaFailed('Internal server error');
      const result = formatContinuationAsSystemMessage(msg);
      expect(result).toContain('a beautiful sunset');
    });

    it('does NOT trigger E006 path for unrelated errors', () => {
      const msg = makeMediaFailed('Rate limit exceeded');
      const result = formatContinuationAsSystemMessage(msg);
      // Should have the generic retry message, not the content filter message
      expect(result).toContain('offer to retry');
      expect(result).not.toContain('content filter');
    });
  });

  describe('Resume prefix for loop-triggering continuations', () => {
    it('includes resume prefix when resumeContext is provided', () => {
      const msg = makeMediaGenerated();
      const resumeContext: ResumeContext = {
        triggeringMessageId: 'msg-456',
        triggeringMessagePreview: 'can you generate a sunset image?',
        elapsedSeconds: 45,
        jobType: 'image_generation',
        resultStatus: 'success',
      };

      const result = formatContinuationAsSystemMessage(msg, resumeContext);

      expect(result).toContain('[Resuming agent loop]');
      expect(result).toContain('msg-456');
      expect(result).toContain('can you generate a sunset image?');
      expect(result).toContain('45s');
      expect(result).toContain('image_generation');
      expect(result).toContain('success');
    });

    it('handles missing triggering message by saying "[trigger no longer in buffer]"', () => {
      const msg = makeMediaGenerated();
      const resumeContext: ResumeContext = {
        // We have the message ID but preview was rolled out
        triggeringMessageId: 'msg-old-123',
        triggeringMessagePreview: undefined,
        elapsedSeconds: 300,
        jobType: 'image_generation',
        resultStatus: 'success',
      };

      const result = formatContinuationAsSystemMessage(msg, resumeContext);

      expect(result).toContain('[Resuming agent loop]');
      expect(result).toContain('msg-old-123');
      expect(result).toContain('[trigger no longer in buffer]');
      expect(result).toContain('300s');
    });

    it('does not include trigger line when no triggering message ID', () => {
      const msg = makeMediaGenerated();
      const resumeContext: ResumeContext = {
        elapsedSeconds: 45,
        jobType: 'image_generation',
        resultStatus: 'success',
      };

      const result = formatContinuationAsSystemMessage(msg, resumeContext);

      expect(result).toContain('[Resuming agent loop]');
      expect(result).toContain('45s');
      // Without a triggering message ID, we don't include the trigger line
      expect(result).not.toContain('Trigger:');
    });

    it('includes failure class for failed continuations', () => {
      const msg = makeMediaFailed('Connection timeout');
      const resumeContext: ResumeContext = {
        triggeringMessageId: 'msg-789',
        triggeringMessagePreview: 'generate an image',
        elapsedSeconds: 60,
        jobType: 'image_generation',
        resultStatus: 'failure',
        failureClass: 'timeout',
      };

      const result = formatContinuationAsSystemMessage(msg, resumeContext);

      expect(result).toContain('[Resuming agent loop]');
      expect(result).toContain('failure');
      expect(result).toContain('timeout');
    });

    it('does not include resume prefix when resumeContext is not provided', () => {
      const msg = makeMediaGenerated();
      const result = formatContinuationAsSystemMessage(msg);

      expect(result).not.toContain('[Resuming agent loop]');
      expect(result).toContain('[ASYNC RESULT @');
    });
  });

  it('includes the exact delivery target and expected action', () => {
    const msg = makeMediaGenerated();
    msg.data.deliveryIntent = {
      platform: 'telegram',
      conversationId: '-1001234567890',
      replyToMessageId: '456',
      expectedAction: 'telegram_send_media_to_chat',
    };

    const result = formatContinuationAsSystemMessage(msg);

    expect(result).toContain('telegram:-1001234567890');
    expect(result).toContain('telegram_send_media_to_chat');
    expect(result).toContain('Reply to: 456');
  });
});

describe('media delivery intent', () => {
  it('builds direct delivery back to the same Telegram group and reply target', () => {
    const msg = makeMediaGenerated();
    msg.conversationId = '-1001234567890';
    msg.replyToMessageId = '456';
    msg.data.deliveryIntent = createMediaDeliveryIntent({
      platform: msg.platform,
      conversationId: msg.conversationId,
      replyToMessageId: msg.replyToMessageId,
    });

    expect(buildMediaDeliveryResponse(msg)).toEqual({
      avatarId: 'avatar-1',
      platform: 'telegram',
      conversationId: '-1001234567890',
      replyToMessageId: '456',
      actions: [{
        type: 'send_media',
        mediaType: 'image',
        url: 'https://example.com/image.png',
        caption: 'a beautiful sunset',
        replyToMessageId: '456',
      }],
      generatedAt: 1700000000000,
      llmModel: 'continuation-direct-delivery',
      tokensUsed: 0,
    });
  });

  it('uses an explicit supported cross-platform destination without changing the origin', () => {
    const msg: MediaGeneratedContinuation = {
      ...makeMediaGenerated(),
      platform: 'admin-ui',
      conversationId: 'admin-session-1',
      data: {
        ...makeMediaGenerated().data,
        mediaType: 'sticker',
        deliveryIntent: {
          platform: 'discord',
          conversationId: 'discord-channel-42',
          replyToMessageId: 'discord-message-7',
          expectedAction: 'discord_send_media_to_channel',
        },
      },
    };

    const response = buildMediaDeliveryResponse(msg);

    expect(response?.platform).toBe('discord');
    expect(response?.conversationId).toBe('discord-channel-42');
    expect(response?.replyToMessageId).toBe('discord-message-7');
    // The outbound pipeline sends generated stickers as an image attachment.
    expect(response?.actions[0]).toMatchObject({
      type: 'send_media',
      mediaType: 'image',
      url: 'https://example.com/image.png',
    });
    expect(msg.platform).toBe('admin-ui');
    expect(msg.conversationId).toBe('admin-session-1');
  });

  it('does not create push intent for polling-only or invalid destinations', () => {
    expect(createMediaDeliveryIntent({
      platform: 'admin-ui',
      conversationId: 'session-1',
    })).toBeUndefined();
    expect(createMediaDeliveryIntent({
      platform: 'telegram',
      conversationId: '-1001',
      expectedAction: 'discord_send_media_to_channel',
    })).toBeUndefined();
  });
});
