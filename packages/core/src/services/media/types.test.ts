import { describe, it, expect } from 'vitest';
import { DEFAULT_MODELS } from './types.js';

describe('core media DEFAULT_MODELS', () => {
  it('defaults image_generation to OpenRouter FLUX 2 Pro', () => {
    expect(DEFAULT_MODELS.image_generation).toBe('black-forest-labs/flux.2-pro');
  });
});
