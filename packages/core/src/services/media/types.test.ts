import { describe, it, expect } from 'vitest';
import { DEFAULT_MODELS } from './types.js';

describe('core media DEFAULT_MODELS', () => {
  it('defaults image_generation to FLUX 1.1 Pro', () => {
    expect(DEFAULT_MODELS.image_generation).toBe('black-forest-labs/flux-1.1-pro');
  });
});
