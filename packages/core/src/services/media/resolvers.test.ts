import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { AICapability } from './types.js';
import { createModelResolver } from './resolvers.js';
import { DEFAULT_MODELS } from './types.js';
import { clearOpenRouterMediaCatalogCache } from './openrouter-catalog.js';

const originalFetch = globalThis.fetch;
const LIVE_IMAGE_MODEL = 'google/gemini-3-pro-image-preview';
const LIVE_VIDEO_MODEL = 'google/veo-3.1-fast';

function installOpenRouterCatalogMock(): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/videos/models')) {
      return new Response(JSON.stringify({
        data: [
          { id: LIVE_VIDEO_MODEL, name: 'Google: Veo 3.1 Fast' },
        ],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      data: [
        {
          id: LIVE_IMAGE_MODEL,
          name: 'Google: Nano Banana Pro (Gemini 3 Pro Image Preview)',
          architecture: { output_modalities: ['image'] },
        },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  clearOpenRouterMediaCatalogCache();
  installOpenRouterCatalogMock();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearOpenRouterMediaCatalogCache();
});

function createDocClientWithItem(item: any) {
  return {
    // Mimic DynamoDBDocumentClient#send
    send: async () => ({ Item: item }),
  } as any;
}

describe('core media resolvers', () => {
  describe('createModelResolver', () => {
    it('prefers integrations.openrouter.models[capability] for image generation', async () => {
      const docClient = createDocClientWithItem({
        integrations: {
          openrouter: {
            models: {
              image_generation: LIVE_IMAGE_MODEL,
            },
          },
          replicate: {
            models: {
              image_generation: 'google/nano-banana-pro',
            },
          },
        },
      });

      const resolveModel = createModelResolver({ tableName: 'T', dynamoClient: docClient })!;
      const result = await resolveModel('avatar-1', 'image_generation');
      expect(result.model).toBe(LIVE_IMAGE_MODEL);
      expect(result.provider).toBe('openrouter');
    });

    it('ignores legacy integrations.replicate image models and uses OpenRouter defaults', async () => {
      const docClient = createDocClientWithItem({
        integrations: {
          replicate: {
            models: {
              image_generation: 'google/nano-banana-pro',
            },
          },
        },
      });

      const resolveModel = createModelResolver({ tableName: 'T', dynamoClient: docClient })!;
      const result = await resolveModel('avatar-1', 'image_generation');
      expect(result.model).toBe(LIVE_IMAGE_MODEL);
      expect(result.provider).toBe('openrouter');
    });

    it('ignores unusable tilde-prefixed OpenRouter media model aliases', async () => {
      const docClient = createDocClientWithItem({
        integrations: {
          openrouter: {
            models: {
              image_generation: '~google/nano-banana-pro',
              video_generation: '~google/veo-3.1-fast',
            },
          },
        },
      });

      const resolveModel = createModelResolver({ tableName: 'T', dynamoClient: docClient })!;
      const image = await resolveModel('avatar-1', 'image_generation');
      const video = await resolveModel('avatar-1', 'video_generation');

      expect(image.model).toBe(LIVE_IMAGE_MODEL);
      expect(image.provider).toBe('openrouter');
      expect(video.model).toBe(LIVE_VIDEO_MODEL);
      expect(video.provider).toBe('openrouter');
    });

    it('ignores unusable synced OpenRouter media model aliases', async () => {
      const docClient = createDocClientWithItem({
        config: {
          media: {
            image: { model: '~google/nano-banana-pro', provider: 'openrouter' },
          },
        },
      });

      const resolveModel = createModelResolver({ tableName: 'T', dynamoClient: docClient })!;
      const image = await resolveModel('avatar-1', 'image_generation');

      expect(image.model).toBe(LIVE_IMAGE_MODEL);
      expect(image.provider).toBe('openrouter');
    });

    it('falls back to OpenRouter for image and video defaults', async () => {
      const docClient = createDocClientWithItem({});

      const resolveModel = createModelResolver({ tableName: 'T', dynamoClient: docClient })!;
      const image = await resolveModel('avatar-1', 'image_generation');
      expect(image.model).toBe(LIVE_IMAGE_MODEL);
      expect(image.provider).toBe('openrouter');

      const video = await resolveModel('avatar-1', 'video_generation');
      expect(video.model).toBe(LIVE_VIDEO_MODEL);
      expect(video.provider).toBe('openrouter');
    });

    it('ignores legacy synced Replicate image config', async () => {
      const docClient = createDocClientWithItem({
        config: {
          media: {
            image: { model: 'synced/image-model', provider: 'replicate' },
          },
        },
      });

      const resolveModel = createModelResolver({ tableName: 'T', dynamoClient: docClient })!;
      const image = await resolveModel('avatar-1', 'image_generation');
      expect(image.model).toBe(LIVE_IMAGE_MODEL);
      expect(image.provider).toBe('openrouter');

      const audio = await resolveModel('avatar-1', 'audio_generation' as AICapability);
      expect(audio.model).toBe(DEFAULT_MODELS.audio_generation);
    });

    it('ignores legacy synced Replicate video config', async () => {
      const docClient = createDocClientWithItem({
        config: {
          media: {
            video: { model: 'synced/video-model', provider: 'replicate' },
          },
        },
      });

      const resolveModel = createModelResolver({ tableName: 'T', dynamoClient: docClient })!;
      const video = await resolveModel('avatar-1', 'video_generation');
      expect(video.model).toBe(LIVE_VIDEO_MODEL);
      expect(video.provider).toBe('openrouter');

      const image = await resolveModel('avatar-1', 'image_generation');
      expect(image.model).toBe(LIVE_IMAGE_MODEL);
    });
  });
});
