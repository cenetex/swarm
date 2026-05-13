/**
 * Tests for Discord message chunking utility
 */
import { describe, it, expect } from 'bun:test';
import { splitForDiscord, DISCORD_MESSAGE_LIMIT } from './discord-chunk.js';

describe('splitForDiscord', () => {
  it('should return single chunk when text fits within limit', () => {
    const text = 'Hello world!';
    const chunks = splitForDiscord(text);
    expect(chunks).toEqual([text]);
  });

  it('should return single chunk when text equals limit', () => {
    const text = 'x'.repeat(DISCORD_MESSAGE_LIMIT);
    const chunks = splitForDiscord(text);
    expect(chunks).toEqual([text]);
  });

  it('should split text exceeding 2000 chars into multiple chunks', () => {
    const text = 'x'.repeat(5000);
    const chunks = splitForDiscord(text);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    }
  });

  it('should preserve all content when splitting', () => {
    const text = 'Hello world! '.repeat(200); // ~2600 chars
    const chunks = splitForDiscord(text);
    const rejoined = chunks.join('');

    expect(rejoined.replace(/\s+/g, ' ').trim())
      .toBe(text.replace(/\s+/g, ' ').trim());
  });

  it('should split on sentence boundaries when possible', () => {
    const text = 'First sentence. Second sentence. Third sentence.'.repeat(50);
    const chunks = splitForDiscord(text);

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    }

    // Should have multiple chunks due to length
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('should split on word boundaries when sentence boundary unavailable', () => {
    const text = 'verylongwordwithoutanybreaks '.repeat(100);
    const chunks = splitForDiscord(text);

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    }
  });

  it('should handle 5000 char content producing approximately 3 chunks', () => {
    const text = 'x'.repeat(5000);
    const chunks = splitForDiscord(text);

    expect(chunks.length).toBe(3);
    expect(chunks[0].length).toBe(DISCORD_MESSAGE_LIMIT);
    expect(chunks[1].length).toBe(DISCORD_MESSAGE_LIMIT);
    expect(chunks[2].length).toBe(1000);
  });

  it('should preserve whitespace at chunk boundaries', () => {
    const text = 'First part.   \n\n   Second part.   \n\n   Third part.'.repeat(50);
    const chunks = splitForDiscord(text);

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    }
    expect(chunks.join('')).toBe(text);
  });

  it('should handle text with multiple sentence terminators', () => {
    const sentences = 'This is a sentence. ';
    const text = sentences.repeat(110); // ~2200 chars
    const chunks = splitForDiscord(text);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    }
  });

  it('should handle text with newlines', () => {
    const text = 'Line one\nLine two\nLine three\n'.repeat(100);
    const chunks = splitForDiscord(text);

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    }
  });

  it('should not produce empty chunks', () => {
    const text = 'a '.repeat(1500);
    const chunks = splitForDiscord(text);

    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
    }
  });

  it('should split a 2928-char persona (Continuum Phantom case)', () => {
    // Simulate the Continuum Phantom 2928-char persona mentioned in the issue
    const text = 'x'.repeat(2928);
    const chunks = splitForDiscord(text);

    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(DISCORD_MESSAGE_LIMIT);
    expect(chunks[1].length).toBe(928);
  });

  it('should split a 1644-char persona plus response (Snarkle case)', () => {
    // Simulate Snarkle 1644-char persona producing verbose response
    const text = 'x'.repeat(1644 + 500); // persona + typical verbose response
    const chunks = splitForDiscord(text);

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT);
    }
  });

  it('should respect custom maxLen parameter', () => {
    const text = 'x'.repeat(1000);
    const chunks = splitForDiscord(text, 300);

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(300);
    }
  });

  it('should throw on invalid maxLen', () => {
    expect(() => splitForDiscord('text', 0)).toThrow();
    expect(() => splitForDiscord('text', -1)).toThrow();
  });

  it('should handle empty string', () => {
    const chunks = splitForDiscord('');
    expect(chunks).toEqual([]);
  });

  it('should handle string with only whitespace', () => {
    const chunks = splitForDiscord('   \n\n   ');
    expect(chunks).toEqual([]);
  });
});
