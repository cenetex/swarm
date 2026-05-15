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
        requestModel: 'google/live-request-model',
        avatarModel: 'google/live-avatar-model',
        defaultModel: '',
      })
    ).toBe('google/live-request-model');
  });

  it('falls back to avatar model when request model is missing/blank', () => {
    expect(
      resolveChatModel({
        requestModel: '   ',
        avatarModel: 'google/live-avatar-model',
        defaultModel: '',
      })
    ).toBe('google/live-avatar-model');
  });

  it('falls back to default model when neither request nor avatar specify a model', () => {
    expect(
      resolveChatModel({
        requestModel: undefined,
        avatarModel: null,
        defaultModel: 'google/live-default-model',
      })
    ).toBe('google/live-default-model');
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

  it('trims whitespace without mapping to a hard-coded ID', () => {
    expect(normalizeModel('  provider/live-model  ')).toBe('provider/live-model');
  });
});

describe('getValidModelId', () => {
  it('returns undefined for truly unknown models', () => {
    expect(getValidModelId('unknown/nonexistent-model')).toBeUndefined();
  });

  it('returns catalog-shaped OpenRouter model IDs even before local curation', () => {
    expect(getValidModelId('google/gemini-3-flash-preview')).toBe('google/gemini-3-flash-preview');
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
      { requireParameters: true, fallbackModels: ['provider/live-fallback-model'] },
    );

    expect(routed.model).toBe('google/gemini-3-flash-preview');
    expect(routed.route).toBe('fallback');
    expect(routed.models).toContain('google/gemini-3-flash-preview');
    expect(routed.models).toContain('provider/live-fallback-model');
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
