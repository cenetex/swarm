/**
 * Discord Message Split Tests
 * Tests for message splitting logic that enforces Discord's 2000-char limit
 *
 * @see packages/core/src/platforms/discord.ts
 */
import { describe, it, expect } from 'bun:test';
import { splitMessageForDiscord } from './discord.js';
import { PLATFORM_CHAR_LIMITS } from '../types/long-form.js';

const DISCORD_MAX_MESSAGE_LENGTH = PLATFORM_CHAR_LIMITS.discord || 2000;

describe('Discord Message Splitting', () => {
  describe('Short messages', () => {
    it('should not split messages under 2000 chars', () => {
      const short = 'Hello, this is a short message';
      const result = splitMessageForDiscord(short);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(short);
    });

    it('should not split message exactly at 2000 chars', () => {
      const exactly2000 = 'x'.repeat(DISCORD_MAX_MESSAGE_LENGTH);
      const result = splitMessageForDiscord(exactly2000);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe(exactly2000);
    });
  });

  describe('Paragraph boundary splitting', () => {
    it('should split on paragraph boundaries', () => {
      const para1 = 'A'.repeat(DISCORD_MAX_MESSAGE_LENGTH - 100);
      const para2 = 'B'.repeat(200);
      const content = `${para1}\n\n${para2}`;

      const result = splitMessageForDiscord(content);
      expect(result.length).toBeGreaterThan(1);
      expect(result[0]).toContain('A');
      expect(result[1]).toContain('B');
    });
  });

  describe('Sentence boundary splitting', () => {
    it('should split on sentence boundaries', () => {
      const sent1 = 'A '.repeat(700) + '. ';
      const sent2 = 'B '.repeat(700);
      const content = `${sent1}${sent2}`;

      const result = splitMessageForDiscord(content);
      expect(result.length).toBeGreaterThan(1);
      expect(result[0]).toEndWith('. ');
    });

    it('should handle exclamation marks', () => {
      const sent1 = 'A '.repeat(700) + '! ';
      const sent2 = 'B '.repeat(700);
      const content = `${sent1}${sent2}`;

      const result = splitMessageForDiscord(content);
      expect(result.length).toBeGreaterThan(1);
    });

    it('should handle question marks', () => {
      const sent1 = 'A '.repeat(700) + '? ';
      const sent2 = 'B '.repeat(700);
      const content = `${sent1}${sent2}`;

      const result = splitMessageForDiscord(content);
      expect(result.length).toBeGreaterThan(1);
    });
  });

  describe('Word boundary splitting', () => {
    it('should split on word boundaries when no sentence boundary available', () => {
      const word1 = 'A'.repeat(DISCORD_MAX_MESSAGE_LENGTH - 10);
      const word2 = 'B'.repeat(100);
      const content = `${word1} ${word2}`;

      const result = splitMessageForDiscord(content);
      expect(result.length).toBeGreaterThan(1);
      // Check that no chunk exceeds the limit
      result.forEach(chunk => {
        expect(chunk.length).toBeLessThanOrEqual(DISCORD_MAX_MESSAGE_LENGTH);
      });
    });
  });

  describe('Hard character split fallback', () => {
    it('should hard split if no word boundary available', () => {
      const noSpaces = 'A'.repeat(DISCORD_MAX_MESSAGE_LENGTH + 500);
      const result = splitMessageForDiscord(noSpaces);

      expect(result.length).toBeGreaterThan(1);
      // Each chunk should be at most DISCORD_MAX_MESSAGE_LENGTH chars
      result.forEach(chunk => {
        expect(chunk.length).toBeLessThanOrEqual(DISCORD_MAX_MESSAGE_LENGTH);
      });
    });
  });

  describe('Very long messages', () => {
    it('should split very long messages into multiple chunks', () => {
      const veryLong = 'This is a test. '.repeat(500);
      const result = splitMessageForDiscord(veryLong);

      expect(result.length).toBeGreaterThan(1);
      // All chunks should be valid
      result.forEach(chunk => {
        expect(chunk.length).toBeLessThanOrEqual(DISCORD_MAX_MESSAGE_LENGTH);
      });
      // Reassembled (without trim) should be close to original
      const reassembled = result.join(' ');
      expect(reassembled.length).toBeLessThanOrEqual(veryLong.length + 100); // Allow some tolerance for trimming
    });
  });

  describe('Edge cases', () => {
    it('should handle empty string', () => {
      const result = splitMessageForDiscord('');
      expect(result).toHaveLength(1);
      expect(result[0]).toBe('');
    });

    it('should trim whitespace after splits', () => {
      const content = 'A '.repeat(1100) + '   \n\n    ' + 'B '.repeat(100);
      const result = splitMessageForDiscord(content);

      expect(result.length).toBeGreaterThan(1);
      result.forEach(chunk => {
        expect(chunk).not.toMatch(/^\s/); // No leading whitespace
        expect(chunk).not.toMatch(/\s$/); // No trailing whitespace
      });
    });

    it('should handle multiple consecutive newlines', () => {
      const content = 'A '.repeat(700) + '\n\n\n\n' + 'B '.repeat(700);
      const result = splitMessageForDiscord(content);

      expect(result.length).toBeGreaterThan(1);
      result.forEach(chunk => {
        expect(chunk.length).toBeLessThanOrEqual(DISCORD_MAX_MESSAGE_LENGTH);
      });
    });
  });
});
