import { describe, it, expect } from 'vitest';
import { DEFAULT_MODELS } from './types.js';

describe('core media DEFAULT_MODELS', () => {
  it('defaults media generation to the current OpenRouter media models', () => {
    expect(DEFAULT_MODELS.image_generation).toBe('google/nano-banana-pro');
    expect(DEFAULT_MODELS.video_generation).toBe('google/veo-3.1-fast');
  });
});
