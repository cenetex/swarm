import { describe, it, expect } from 'vitest';
import { DEFAULT_MODELS } from './types.js';

describe('core media DEFAULT_MODELS', () => {
  it('does not hard-code OpenRouter media model IDs', () => {
    expect(DEFAULT_MODELS.image_generation).toBe('');
    expect(DEFAULT_MODELS.video_generation).toBe('');
  });
});
