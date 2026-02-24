import { describe, it, expect } from 'bun:test';
import { resolveChatModel } from './models-registry.js';

describe('resolveChatModel', () => {
  it('prefers request model over avatar model', () => {
    expect(
      resolveChatModel({
        requestModel: 'anthropic/claude-3-opus-latest',
        avatarModel: 'anthropic/claude-3-5-sonnet-latest',
        defaultModel: 'openai/gpt-4o',
      })
    ).toBe('anthropic/claude-3-opus-latest');
  });

  it('falls back to avatar model when request model is missing/blank', () => {
    expect(
      resolveChatModel({
        requestModel: '   ',
        avatarModel: 'anthropic/claude-3-5-sonnet-latest',
        defaultModel: 'openai/gpt-4o',
      })
    ).toBe('anthropic/claude-3-5-sonnet-latest');
  });

  it('falls back to default model when neither request nor avatar specify a model', () => {
    expect(
      resolveChatModel({
        requestModel: undefined,
        avatarModel: null,
        defaultModel: 'openai/gpt-4o',
      })
    ).toBe('openai/gpt-4o');
  });
});
