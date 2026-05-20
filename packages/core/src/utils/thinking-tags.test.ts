/**
 * Tests for thinking-tags utility
 */
import { describe, it, expect } from 'vitest';
import { extractThinking, formatThinkingForMemory, hasThinkingTags } from './thinking-tags.js';

describe('extractThinking', () => {
  it('should return empty result for empty content', () => {
    const result = extractThinking('');
    expect(result.cleanContent).toBe('');
    expect(result.thinkingBlocks).toEqual([]);
    expect(result.hasThinking).toBe(false);
  });

  it('should return original content when no thinking tags', () => {
    const result = extractThinking('Hello, how are you?');
    expect(result.cleanContent).toBe('Hello, how are you?');
    expect(result.thinkingBlocks).toEqual([]);
    expect(result.hasThinking).toBe(false);
  });

  it('should extract single thinking block', () => {
    const content = '<thinking>I should be careful here</thinking>Hello!';
    const result = extractThinking(content);
    expect(result.cleanContent).toBe('Hello!');
    expect(result.thinkingBlocks).toEqual(['I should be careful here']);
    expect(result.hasThinking).toBe(true);
  });

  it('should extract thought tags as internal reasoning', () => {
    const content = '<thought>I should not leak this</thought>Hello!';
    const result = extractThinking(content);
    expect(result.cleanContent).toBe('Hello!');
    expect(result.thinkingBlocks).toEqual(['I should not leak this']);
    expect(result.hasThinking).toBe(true);
  });

  it('should strip malformed leading thought lines', () => {
    const content = '<thought The video failed to generate and should stay hidden.\nThe transaction failed, and the video got rugged.';
    const result = extractThinking(content);
    expect(result.cleanContent).toBe('The transaction failed, and the video got rugged.');
    expect(result.thinkingBlocks).toEqual(['The video failed to generate and should stay hidden.']);
    expect(result.hasThinking).toBe(true);
  });

  it('should extract multiple thinking blocks', () => {
    const content = '<thinking>First thought</thinking>Hello <thinking>Second thought</thinking>there!';
    const result = extractThinking(content);
    expect(result.cleanContent).toBe('Hello there!');
    expect(result.thinkingBlocks).toEqual(['First thought', 'Second thought']);
    expect(result.hasThinking).toBe(true);
  });

  it('should handle multiline thinking content', () => {
    const content = `<thinking>
Line 1
Line 2
</thinking>Response text`;
    const result = extractThinking(content);
    expect(result.cleanContent).toBe('Response text');
    expect(result.thinkingBlocks).toEqual(['Line 1\nLine 2']);
    expect(result.hasThinking).toBe(true);
  });

  it('should be case-insensitive', () => {
    const content = '<THINKING>Uppercase</THINKING>Hello <Thinking>Mixed</Thinking>!';
    const result = extractThinking(content);
    expect(result.cleanContent).toBe('Hello !');
    expect(result.thinkingBlocks).toEqual(['Uppercase', 'Mixed']);
    expect(result.hasThinking).toBe(true);
  });

  it('should handle thinking at end of content', () => {
    const content = 'Hello!<thinking>Final thought</thinking>';
    const result = extractThinking(content);
    expect(result.cleanContent).toBe('Hello!');
    expect(result.thinkingBlocks).toEqual(['Final thought']);
    expect(result.hasThinking).toBe(true);
  });

  it('should clean up excessive whitespace', () => {
    const content = 'Hello\n\n<thinking>thought</thinking>\n\n\nWorld';
    const result = extractThinking(content);
    expect(result.cleanContent).toBe('Hello\n\nWorld');
    expect(result.thinkingBlocks).toEqual(['thought']);
  });

  it('should handle only thinking content', () => {
    const content = '<thinking>Just thinking out loud</thinking>';
    const result = extractThinking(content);
    expect(result.cleanContent).toBe('');
    expect(result.thinkingBlocks).toEqual(['Just thinking out loud']);
    expect(result.hasThinking).toBe(true);
  });

  it('should ignore empty thinking blocks', () => {
    const content = '<thinking></thinking>Hello<thinking>   </thinking>';
    const result = extractThinking(content);
    expect(result.cleanContent).toBe('Hello');
    expect(result.thinkingBlocks).toEqual([]);
    expect(result.hasThinking).toBe(false);
  });

  it('should strip orphan opening thinking tags', () => {
    const content = 'Hello <thinking>World';
    const result = extractThinking(content);
    expect(result.cleanContent).toBe('Hello World');
    expect(result.thinkingBlocks).toEqual([]);
  });

  it('should strip orphan closing thinking tags', () => {
    const content = 'Hello</thinking> World';
    const result = extractThinking(content);
    expect(result.cleanContent).toBe('Hello World');
    expect(result.thinkingBlocks).toEqual([]);
  });

  it('should strip self-closing thinking tags', () => {
    const content = 'Hello <thinking/> World';
    const result = extractThinking(content);
    expect(result.cleanContent).toBe('Hello World');
    expect(result.thinkingBlocks).toEqual([]);
  });

  it('should strip orphan thought tags', () => {
    const content = 'Hello <thought>World';
    const result = extractThinking(content);
    expect(result.cleanContent).toBe('Hello World');
    expect(result.thinkingBlocks).toEqual([]);
  });
});

describe('formatThinkingForMemory', () => {
  it('should return empty string for no blocks', () => {
    expect(formatThinkingForMemory([])).toBe('');
  });

  it('should format single block', () => {
    const result = formatThinkingForMemory(['Test thought']);
    expect(result).toContain('Internal thought');
    expect(result).toContain('Test thought');
  });

  it('should format multiple blocks', () => {
    const result = formatThinkingForMemory(['First', 'Second']);
    expect(result).toContain('Internal thoughts');
    expect(result).toContain('1. First');
    expect(result).toContain('2. Second');
  });

  it('should include context hint', () => {
    const result = formatThinkingForMemory(['Test'], 'chat-123');
    expect(result).toContain('context: chat-123');
  });
});

describe('hasThinkingTags', () => {
  it('should return false for empty content', () => {
    expect(hasThinkingTags('')).toBe(false);
  });

  it('should return false for content without thinking tags', () => {
    expect(hasThinkingTags('Hello world')).toBe(false);
  });

  it('should return true for content with thinking tags', () => {
    expect(hasThinkingTags('<thinking>test</thinking>')).toBe(true);
  });

  it('should return true for content with thought tags', () => {
    expect(hasThinkingTags('<thought>test</thought>')).toBe(true);
  });

  it('should return true for malformed leading thought tags', () => {
    expect(hasThinkingTags('<thought hidden note\nVisible reply')).toBe(true);
  });

  it('should be case-insensitive', () => {
    expect(hasThinkingTags('<THINKING>test</THINKING>')).toBe(true);
  });
});
