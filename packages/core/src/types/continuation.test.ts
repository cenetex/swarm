import { describe, it, expect } from 'bun:test';
import { formatContinuationAsSystemMessage } from './continuation.js';
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
});
