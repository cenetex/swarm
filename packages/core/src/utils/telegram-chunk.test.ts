import { describe, it, expect } from 'bun:test';
import {
  splitForTelegram,
  TELEGRAM_MESSAGE_LIMIT,
  TELEGRAM_CAPTION_LIMIT,
} from './telegram-chunk.js';

describe('splitForTelegram', () => {
  it('returns the input unchanged when under the limit', () => {
    expect(splitForTelegram('hello world')).toEqual(['hello world']);
  });

  it('returns the input unchanged at exactly the limit', () => {
    const text = 'x'.repeat(TELEGRAM_MESSAGE_LIMIT);
    const chunks = splitForTelegram(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe(text);
  });

  it('splits at paragraph boundaries when possible', () => {
    const para = 'a'.repeat(3000);
    const para2 = 'b'.repeat(3000);
    const text = `${para}\n\n${para2}`;
    const chunks = splitForTelegram(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(para);
    expect(chunks[1]).toBe(para2);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
  });

  it('falls back to sentence boundaries when no paragraph break is in the window', () => {
    const sentence = 'This is a sentence. ';
    const text = sentence.repeat(250); // ~5000 chars
    const chunks = splitForTelegram(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    }
    expect(chunks.every(c => /sentence\.$/.test(c.trimEnd()))).toBe(true);
  });

  it('hard-cuts only when no boundary exists in the second half', () => {
    const text = 'x'.repeat(5000);
    const chunks = splitForTelegram(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].length).toBe(TELEGRAM_MESSAGE_LIMIT);
    expect(chunks[1].length).toBe(5000 - TELEGRAM_MESSAGE_LIMIT);
  });

  it('handles a 10k LLM reply with mixed paragraphs', () => {
    const para = 'Lorem ipsum dolor sit amet. '.repeat(100); // ~2800 chars
    const text = [para, para, para, para].join('\n\n'); // ~11k chars
    const chunks = splitForTelegram(text);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    // No empty chunks.
    for (const c of chunks) expect(c.length).toBeGreaterThan(0);
    // Concatenation reassembles (modulo trimmed whitespace between chunks).
    expect(chunks.join(' ').replace(/\s+/g, ' ').length).toBeGreaterThanOrEqual(
      text.replace(/\s+/g, ' ').length - 10,
    );
  });

  it('respects a custom caption limit', () => {
    const text = 'a'.repeat(2000);
    const chunks = splitForTelegram(text, TELEGRAM_CAPTION_LIMIT);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(TELEGRAM_CAPTION_LIMIT);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it('drops empty chunks produced by trimming', () => {
    const text = `${'a'.repeat(4090)}\n\n\n\n${'b'.repeat(100)}`;
    const chunks = splitForTelegram(text);
    for (const c of chunks) expect(c.length).toBeGreaterThan(0);
  });

  it('rejects non-positive maxLen', () => {
    expect(() => splitForTelegram('x', 0)).toThrow();
    expect(() => splitForTelegram('x', -1)).toThrow();
  });
});
