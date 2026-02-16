/**
 * Tests for Telegram type guard utilities
 */
import { describe, it, expect } from 'bun:test';
import type { Update, Message } from 'grammy/types';
import {
  getMessageFromUpdate,
  getErrorMessage,
  isRateLimitError,
  isErrorWithMessage,
  isErrorWithCode,
  isErrorWithStatus,
  isErrorWithStatusCode,
  isTwitterRawTweet,
} from './telegram-type-guards.js';

describe('telegram-type-guards', () => {
  describe('getMessageFromUpdate', () => {
    it('should extract message from update.message', () => {
      const update: Update = {
        update_id: 123,
        message: {
          message_id: 1,
          date: Date.now(),
          chat: { id: 123, type: 'private' },
        } as Message,
      };
      const result = getMessageFromUpdate(update);
      expect(result).toBeDefined();
      expect(result?.message_id).toBe(1);
    });

    it('should extract message from update.edited_message', () => {
      const update: Update = {
        update_id: 123,
        edited_message: {
          message_id: 2,
          date: Date.now(),
          chat: { id: 123, type: 'private' },
        } as Message,
      };
      const result = getMessageFromUpdate(update);
      expect(result).toBeDefined();
      expect(result?.message_id).toBe(2);
    });

    it('should extract message from update.channel_post', () => {
      const update: Update = {
        update_id: 123,
        channel_post: {
          message_id: 3,
          date: Date.now(),
          chat: { id: 123, type: 'channel' },
        } as Message,
      };
      const result = getMessageFromUpdate(update);
      expect(result).toBeDefined();
      expect(result?.message_id).toBe(3);
    });

    it('should return undefined when no message is present', () => {
      const update: Update = {
        update_id: 123,
      };
      const result = getMessageFromUpdate(update);
      expect(result).toBeUndefined();
    });
  });

  describe('error type guards', () => {
    it('isErrorWithMessage should identify errors with message property', () => {
      expect(isErrorWithMessage(new Error('test'))).toBe(true);
      expect(isErrorWithMessage({ message: 'test' })).toBe(true);
      expect(isErrorWithMessage({ code: 123 })).toBe(false);
      expect(isErrorWithMessage('string')).toBe(false);
      expect(isErrorWithMessage(null)).toBe(false);
    });

    it('isErrorWithCode should identify errors with code property', () => {
      expect(isErrorWithCode({ code: 429 })).toBe(true);
      expect(isErrorWithCode({ code: 'ERR_TEST' })).toBe(true);
      expect(isErrorWithCode({ message: 'test' })).toBe(false);
      expect(isErrorWithCode(null)).toBe(false);
    });

    it('isErrorWithStatus should identify errors with status property', () => {
      expect(isErrorWithStatus({ status: 429 })).toBe(true);
      expect(isErrorWithStatus({ status: '429' })).toBe(false); // must be number
      expect(isErrorWithStatus({ code: 429 })).toBe(false);
    });

    it('isErrorWithStatusCode should identify errors with statusCode property', () => {
      expect(isErrorWithStatusCode({ statusCode: 429 })).toBe(true);
      expect(isErrorWithStatusCode({ statusCode: '429' })).toBe(false); // must be number
      expect(isErrorWithStatusCode({ status: 429 })).toBe(false);
    });
  });

  describe('getErrorMessage', () => {
    it('should extract message from Error objects', () => {
      const error = new Error('Test error message');
      expect(getErrorMessage(error)).toBe('Test error message');
    });

    it('should extract message from objects with message property', () => {
      expect(getErrorMessage({ message: 'Custom error' })).toBe('Custom error');
    });

    it('should convert non-error values to string', () => {
      expect(getErrorMessage('string error')).toBe('string error');
      expect(getErrorMessage(123)).toBe('123');
      expect(getErrorMessage(null)).toBe('null');
    });
  });

  describe('isRateLimitError', () => {
    it('should identify 429 code errors', () => {
      expect(isRateLimitError({ code: 429 })).toBe(true);
      expect(isRateLimitError({ code: '429' })).toBe(false); // string code doesn't match
    });

    it('should identify 429 status errors', () => {
      expect(isRateLimitError({ status: 429 })).toBe(true);
      expect(isRateLimitError({ status: 200 })).toBe(false);
    });

    it('should identify 429 statusCode errors', () => {
      expect(isRateLimitError({ statusCode: 429 })).toBe(true);
      expect(isRateLimitError({ statusCode: 500 })).toBe(false);
    });

    it('should return false for non-rate-limit errors', () => {
      expect(isRateLimitError({ code: 500 })).toBe(false);
      expect(isRateLimitError({ message: '429' })).toBe(false);
      expect(isRateLimitError(new Error('429'))).toBe(false);
    });
  });

  describe('isTwitterRawTweet', () => {
    it('should accept objects with referenced_tweets array', () => {
      const tweet = {
        referenced_tweets: [{ type: 'replied_to', id: '123' }],
      };
      expect(isTwitterRawTweet(tweet)).toBe(true);
    });

    it('should accept objects without referenced_tweets', () => {
      const tweet = { id: '123', text: 'hello' };
      expect(isTwitterRawTweet(tweet)).toBe(true);
    });

    it('should reject non-objects', () => {
      expect(isTwitterRawTweet(null)).toBe(false);
      expect(isTwitterRawTweet(undefined)).toBe(false);
      expect(isTwitterRawTweet('string')).toBe(false);
      expect(isTwitterRawTweet(123)).toBe(false);
    });

    it('should reject objects with invalid referenced_tweets', () => {
      const tweet = { referenced_tweets: 'not-an-array' };
      expect(isTwitterRawTweet(tweet)).toBe(false);
    });
  });
});
