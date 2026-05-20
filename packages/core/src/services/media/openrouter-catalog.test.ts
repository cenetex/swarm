import { describe, expect, it } from 'vitest';
import {
  isLiveOpenRouterMediaModelId,
  listOpenRouterMediaModels,
  resolveDefaultOpenRouterMediaModel,
} from './openrouter-catalog.js';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('OpenRouter media catalog', () => {
  it('selects Nano Banana Pro by live catalog name without hardcoded IDs', async () => {
    const fetchImpl = async () => jsonResponse({
      data: [
        {
          id: 'google/gemini-2.5-flash-image',
          name: 'Google: Nano Banana (Gemini 2.5 Flash Image)',
          architecture: { output_modalities: ['image'] },
        },
        {
          id: 'google/gemini-3-pro-image-preview',
          name: 'Google: Nano Banana Pro (Gemini 3 Pro Image Preview)',
          architecture: { output_modalities: ['image'] },
        },
      ],
    });

    const selected = await resolveDefaultOpenRouterMediaModel('image_generation', {
      fetchImpl,
      bypassCache: true,
    });

    expect(selected.id).toBe('google/gemini-3-pro-image-preview');
  });

  it('selects Veo 3.1 Fast by live video catalog name', async () => {
    const fetchImpl = async () => jsonResponse({
      data: [
        { id: 'google/veo-3.1', name: 'Google: Veo 3.1' },
        { id: 'google/veo-3.1-fast', name: 'Google: Veo 3.1 Fast' },
      ],
    });

    const selected = await resolveDefaultOpenRouterMediaModel('video_generation', {
      fetchImpl,
      bypassCache: true,
    });

    expect(selected.id).toBe('google/veo-3.1-fast');
  });

  it('filters fake tilde-prefixed catalog rows and validates IDs against live rows', async () => {
    const fetchImpl = async () => jsonResponse({
      data: [
        {
          id: '~google/nano-banana-pro',
          name: 'Fake Nano Banana Pro',
          architecture: { output_modalities: ['image'] },
        },
        {
          id: 'google/gemini-3-pro-image-preview',
          name: 'Google: Nano Banana Pro',
          architecture: { output_modalities: ['image'] },
        },
      ],
    });

    const models = await listOpenRouterMediaModels('image_generation', {
      fetchImpl,
      bypassCache: true,
    });

    expect(models.map((model) => model.id)).toEqual(['google/gemini-3-pro-image-preview']);
    await expect(isLiveOpenRouterMediaModelId('image_generation', 'google/nano-banana-pro', {
      fetchImpl,
      bypassCache: true,
    })).resolves.toBe(false);
  });

  it('fails closed when the live catalog is unavailable', async () => {
    const fetchImpl = async () => new Response('unavailable', { status: 503 });

    await expect(resolveDefaultOpenRouterMediaModel('image_generation', {
      fetchImpl,
      bypassCache: true,
    })).rejects.toThrow('HTTP 503');
  });
});
