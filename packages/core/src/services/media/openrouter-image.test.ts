import { describe, expect, it } from 'bun:test';
import {
  getOpenRouterImageModalities,
  openRouterImageModelSupportsTextOutput,
} from './openrouter-image.js';

describe('OpenRouter image model modalities', () => {
  it('uses image-only modalities for FLUX image models', () => {
    expect(getOpenRouterImageModalities('black-forest-labs/flux.2-pro')).toEqual(['image']);
    expect(getOpenRouterImageModalities('black-forest-labs/flux.2-flex')).toEqual(['image']);
  });

  it('uses image-only modalities by default for unknown image models', () => {
    expect(getOpenRouterImageModalities('sourceful/riverflow-v2-standard-preview')).toEqual(['image']);
    expect(getOpenRouterImageModalities('custom/image-model')).toEqual(['image']);
  });

  it('keeps text output for Gemini image models', () => {
    expect(openRouterImageModelSupportsTextOutput('google/gemini-2.5-flash-image')).toBe(true);
    expect(getOpenRouterImageModalities('google/gemini-2.5-flash-image')).toEqual(['image', 'text']);
  });
});
