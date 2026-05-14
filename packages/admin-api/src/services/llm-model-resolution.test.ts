import { describe, it, expect } from 'bun:test';
import {
  DEFAULT_MODELS,
  MODEL_ALIASES,
  getValidModelId,
  isOpenRouterCatalogModelId,
  normalizeModel,
  resolveChatModel,
  withOpenRouterFallbackRouting,
} from './models-registry.js';

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

  it('resolves stale avatar model ID via alias', () => {
    expect(
      resolveChatModel({
        requestModel: undefined,
        avatarModel: 'anthropic/claude-3-5-sonnet',
        defaultModel: 'openai/gpt-4o',
      })
    ).toBe('anthropic/claude-3-5-sonnet-latest');
  });

  it('falls back to registry default when configured models are malformed', () => {
    expect(
      resolveChatModel({
        requestModel: undefined,
        avatarModel: 'not-a-model',
        defaultModel: 'unknown/nonexistent-model',
      })
    ).toBe(DEFAULT_MODELS.llm);
  });

  it('allows OpenRouter catalog-shaped model IDs outside the local curated list', () => {
    expect(
      resolveChatModel({
        requestModel: undefined,
        avatarModel: 'google/gemini-3-flash-preview',
        defaultModel: DEFAULT_MODELS.llm,
      })
    ).toBe('google/gemini-3-flash-preview');
  });
});

describe('normalizeModel', () => {
  it('returns undefined for non-string values', () => {
    expect(normalizeModel(undefined)).toBeUndefined();
    expect(normalizeModel(null)).toBeUndefined();
    expect(normalizeModel(42)).toBeUndefined();
  });

  it('returns undefined for empty/whitespace strings', () => {
    expect(normalizeModel('')).toBeUndefined();
    expect(normalizeModel('   ')).toBeUndefined();
  });

  it('passes through unknown model IDs unchanged', () => {
    expect(normalizeModel('openai/gpt-4o')).toBe('openai/gpt-4o');
  });

  it('maps stale model IDs to current canonical IDs', () => {
    expect(normalizeModel('anthropic/claude-3-5-sonnet')).toBe('anthropic/claude-3-5-sonnet-latest');
    expect(normalizeModel('anthropic/claude-3-opus')).toBe('anthropic/claude-3-opus-latest');
  });

  it('maps dated snapshot IDs to current canonical IDs', () => {
    expect(normalizeModel('anthropic/claude-3-5-sonnet-20241022')).toBe('anthropic/claude-3-5-sonnet-latest');
    expect(normalizeModel('anthropic/claude-3-opus-20240229')).toBe('anthropic/claude-3-opus-latest');
  });

  it('trims whitespace before applying aliases', () => {
    expect(normalizeModel('  anthropic/claude-3-5-sonnet  ')).toBe('anthropic/claude-3-5-sonnet-latest');
  });
});

describe('getValidModelId', () => {
  it('returns canonical ID for a stale alias', () => {
    expect(getValidModelId('anthropic/claude-3-5-sonnet')).toBe('anthropic/claude-3-5-sonnet-latest');
  });

  it('returns undefined for truly unknown models', () => {
    expect(getValidModelId('unknown/nonexistent-model')).toBeUndefined();
  });

  it('returns catalog-shaped OpenRouter model IDs even before local curation', () => {
    expect(getValidModelId('google/gemini-3-flash-preview')).toBe('google/gemini-3-flash-preview');
  });

  it('returns the ID for a known model', () => {
    expect(getValidModelId('anthropic/claude-3-5-sonnet-latest')).toBe('anthropic/claude-3-5-sonnet-latest');
  });
});

describe('OpenRouter fallback routing', () => {
  it('adds model fallback routing without dropping request fields', () => {
    const routed = withOpenRouterFallbackRouting(
      {
        messages: [{ role: 'user', content: 'hello' }],
        tools: [{ type: 'function', function: { name: 'search', parameters: { type: 'object' } } }],
      },
      'google/gemini-3-flash-preview',
      { requireParameters: true },
    );

    expect(routed.model).toBe('google/gemini-3-flash-preview');
    expect(routed.route).toBe('fallback');
    expect(routed.models).toContain('google/gemini-3-flash-preview');
    expect(routed.models).toContain('openrouter/auto');
    expect(routed.provider).toMatchObject({
      allow_fallbacks: true,
      require_parameters: true,
    });
    expect(routed.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('recognizes supported OpenRouter catalog ID shapes', () => {
    expect(isOpenRouterCatalogModelId('openrouter/auto')).toBe(true);
    expect(isOpenRouterCatalogModelId('google/gemini-3-flash-preview')).toBe(true);
    expect(isOpenRouterCatalogModelId('unknown/nonexistent-model')).toBe(false);
  });
});

describe('MODEL_ALIASES', () => {
  it('all alias targets exist in AVAILABLE_MODELS or fallback chains', () => {
    // Every alias target should be a valid model ID (resolvable without warning)
    for (const [, canonical] of Object.entries(MODEL_ALIASES)) {
      const result = getValidModelId(canonical);
      expect(result).toBe(canonical);
    }
  });
});
