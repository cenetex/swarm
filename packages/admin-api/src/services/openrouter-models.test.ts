import { afterEach, describe, expect, it, mock } from 'bun:test';
import { clearOpenRouterMediaCatalogCache } from '@swarm/core/services';
import { searchOpenRouterModels } from './openrouter-models.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearOpenRouterMediaCatalogCache();
});

describe('searchOpenRouterModels', () => {
  it('filters tilde-prefixed OpenRouter registry aliases out of media search results', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({
      data: [
        {
          id: '~google/nano-banana-pro',
          name: 'Fake Nano Banana',
          description: 'Internal registry alias for image generation',
          architecture: { output_modalities: ['image'] },
        },
        {
          id: 'google/gemini-3-pro-image-preview',
          name: 'Nano Banana Pro',
          description: 'Image generation model',
          architecture: { output_modalities: ['image'] },
        },
      ],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;

    const results = await searchOpenRouterModels('nano', { capability: 'image_generation' });

    expect(results.map(result => result.id)).toEqual(['google/gemini-3-pro-image-preview']);
  });

  it('does not fall back to hardcoded OpenRouter registry rows when the live catalog fails', async () => {
    globalThis.fetch = mock(async () => new Response('unavailable', { status: 503 })) as unknown as typeof fetch;

    let thrown: unknown;
    try {
      await searchOpenRouterModels('flux', { capability: 'image_generation' });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('HTTP 503');
  });
});
