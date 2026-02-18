import { describe, it, expect } from 'vitest';
import { formatBrainMemoryContext, truncateForPrompt, formatRelativeTime } from './context-builder.js';
import type { BrainMemoryFact } from '@swarm/core';

describe('formatBrainMemoryContext', () => {
  it('returns empty string for empty facts array', () => {
    expect(formatBrainMemoryContext([])).toBe('');
  });

  it('formats a single fact with about field', () => {
    const facts: BrainMemoryFact[] = [
      { fact: 'Dogs are loyal', about: 'dogs', timestamp: 1000 },
    ];
    expect(formatBrainMemoryContext(facts)).toBe(
      '## Relevant Memories\n- Dogs are loyal (about dogs)'
    );
  });

  it('formats a single fact without about field', () => {
    const facts: BrainMemoryFact[] = [
      { fact: 'Something happened', timestamp: 1000 },
    ];
    expect(formatBrainMemoryContext(facts)).toBe(
      '## Relevant Memories\n- Something happened'
    );
  });

  it('formats multiple facts as a bullet list', () => {
    const facts: BrainMemoryFact[] = [
      { fact: 'Dogs are loyal', about: 'dogs', timestamp: 1000 },
      { fact: 'Cats are independent', about: 'cats', timestamp: 900 },
      { fact: 'Fish swim', timestamp: 800 },
    ];
    const result = formatBrainMemoryContext(facts);
    expect(result).toBe(
      '## Relevant Memories\n- Dogs are loyal (about dogs)\n- Cats are independent (about cats)\n- Fish swim'
    );
  });

  it('truncates output to default maxChars (1600)', () => {
    const facts: BrainMemoryFact[] = Array.from({ length: 100 }, (_, i) => ({
      fact: `This is a moderately long fact number ${i} that takes up some space in the output`,
      about: 'testing',
      timestamp: 1000 - i,
    }));
    const result = formatBrainMemoryContext(facts);
    expect(result.length).toBeLessThanOrEqual(1600);
    expect(result.startsWith('## Relevant Memories')).toBe(true);
  });

  it('respects custom maxChars parameter', () => {
    const facts: BrainMemoryFact[] = [
      { fact: 'A'.repeat(200), about: 'test', timestamp: 1000 },
      { fact: 'B'.repeat(200), about: 'test', timestamp: 900 },
    ];
    const result = formatBrainMemoryContext(facts, 100);
    expect(result.length).toBeLessThanOrEqual(100);
  });

  it('does not truncate when output is under maxChars', () => {
    const facts: BrainMemoryFact[] = [
      { fact: 'Short fact', timestamp: 1000 },
    ];
    const result = formatBrainMemoryContext(facts);
    expect(result).toBe('## Relevant Memories\n- Short fact');
  });

  it('handles facts with special characters', () => {
    const facts: BrainMemoryFact[] = [
      { fact: 'User said "hello & goodbye"', about: 'greetings <>', timestamp: 1000 },
    ];
    const result = formatBrainMemoryContext(facts);
    expect(result).toBe(
      '## Relevant Memories\n- User said "hello & goodbye" (about greetings <>)'
    );
  });

  it('includes strength field in facts without affecting output', () => {
    const facts: BrainMemoryFact[] = [
      { fact: 'Strong memory', about: 'test', timestamp: 1000, strength: 1.5 },
    ];
    const result = formatBrainMemoryContext(facts);
    expect(result).toBe('## Relevant Memories\n- Strong memory (about test)');
  });
});

describe('truncateForPrompt', () => {
  it('returns text unchanged when under limit', () => {
    expect(truncateForPrompt('hello', 10)).toBe('hello');
  });

  it('returns text unchanged when exactly at limit', () => {
    expect(truncateForPrompt('hello', 5)).toBe('hello');
  });

  it('truncates and adds ellipsis when over limit', () => {
    const result = truncateForPrompt('hello world', 6);
    expect(result.length).toBeLessThanOrEqual(6);
    expect(result.endsWith('…')).toBe(true);
  });
});

describe('formatRelativeTime', () => {
  const now = 1_000_000;

  it('returns "just now" for less than 1 minute', () => {
    expect(formatRelativeTime(now - 30_000, now)).toBe('just now');
  });

  it('returns minutes for less than 1 hour', () => {
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m ago');
  });

  it('returns hours for less than 1 day', () => {
    expect(formatRelativeTime(now - 3 * 60 * 60_000, now)).toBe('3h ago');
  });

  it('returns days for 1 day or more', () => {
    expect(formatRelativeTime(now - 2 * 24 * 60 * 60_000, now)).toBe('2d ago');
  });

  it('handles future timestamps gracefully', () => {
    expect(formatRelativeTime(now + 60_000, now)).toBe('just now');
  });
});
