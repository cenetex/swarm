import { describe, it, expect } from 'vitest';
import type { AICapability } from './types.js';
import { createModelResolver } from './resolvers.js';
import { DEFAULT_MODELS } from './types.js';

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
              image_generation: 'black-forest-labs/flux.2-flex',
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
      expect(result.model).toBe('black-forest-labs/flux.2-flex');
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
      expect(result.model).toBe(DEFAULT_MODELS.image_generation);
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

      expect(image.model).toBe(DEFAULT_MODELS.image_generation);
      expect(image.provider).toBe('openrouter');
      expect(video.model).toBe(DEFAULT_MODELS.video_generation);
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

      expect(image.model).toBe(DEFAULT_MODELS.image_generation);
      expect(image.provider).toBe('openrouter');
    });

    it('falls back to OpenRouter for image and video defaults', async () => {
      const docClient = createDocClientWithItem({});

      const resolveModel = createModelResolver({ tableName: 'T', dynamoClient: docClient })!;
      const image = await resolveModel('avatar-1', 'image_generation');
      expect(image.model).toBe(DEFAULT_MODELS.image_generation);
      expect(image.provider).toBe('openrouter');

      const video = await resolveModel('avatar-1', 'video_generation');
      expect(video.model).toBe(DEFAULT_MODELS.video_generation);
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
      expect(image.model).toBe(DEFAULT_MODELS.image_generation);
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
      expect(video.model).toBe(DEFAULT_MODELS.video_generation);
      expect(video.provider).toBe('openrouter');

      const image = await resolveModel('avatar-1', 'image_generation');
      expect(image.model).toBe(DEFAULT_MODELS.image_generation);
    });
  });
});
