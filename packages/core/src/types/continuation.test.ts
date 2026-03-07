import { describe, it, expect } from 'bun:test';
import { formatContinuationAsSystemMessage } from './continuation.js';
import type { MediaFailedContinuation } from './continuation.js';

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
});
