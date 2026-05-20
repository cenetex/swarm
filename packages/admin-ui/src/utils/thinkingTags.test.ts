import { describe, expect, it } from 'vitest';
import { extractThinkingTags } from './thinkingTags';

describe('extractThinkingTags', () => {
  it('extracts standard thinking tags', () => {
    const result = extractThinkingTags('<thinking>private note</thinking>Public reply');
    expect(result.cleanContent).toBe('Public reply');
    expect(result.thinkingBlocks).toEqual(['private note']);
  });

  it('extracts thought tags', () => {
    const result = extractThinkingTags('<thought>private note</thought>Public reply');
    expect(result.cleanContent).toBe('Public reply');
    expect(result.thinkingBlocks).toEqual(['private note']);
  });

  it('strips malformed leading thought lines before rendering', () => {
    const result = extractThinkingTags(
      '<thought The video failed to generate and should stay hidden.\nThe transaction failed, and the video got rugged.'
    );

    expect(result.cleanContent).toBe('The transaction failed, and the video got rugged.');
    expect(result.thinkingBlocks).toEqual(['The video failed to generate and should stay hidden.']);
  });
});
