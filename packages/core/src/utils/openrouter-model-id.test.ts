import { describe, expect, it } from 'vitest';
import { isUsableOpenRouterModelId } from './openrouter-model-id.js';

describe('isUsableOpenRouterModelId', () => {
  it('accepts normal OpenRouter catalog IDs', () => {
    expect(isUsableOpenRouterModelId('google/gemini-3-flash-preview')).toBe(true);
    expect(isUsableOpenRouterModelId('openrouter/auto')).toBe(true);
  });

  it('rejects tilde-prefixed registry aliases', () => {
    expect(isUsableOpenRouterModelId('~google/gemini-3-flash-preview')).toBe(false);
  });

  it('rejects malformed or padded IDs', () => {
    expect(isUsableOpenRouterModelId('google')).toBe(false);
    expect(isUsableOpenRouterModelId(' google/gemini-3-flash-preview ')).toBe(false);
    expect(isUsableOpenRouterModelId(undefined)).toBe(false);
  });
});
