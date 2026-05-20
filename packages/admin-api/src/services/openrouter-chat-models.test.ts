import { afterEach, describe, expect, it, mock } from 'bun:test';
import {
  _resetOpenRouterChatModelCache,
  listOpenRouterChatModels,
  resolveOpenRouterChatModelPlan,
} from './openrouter-chat-models.js';

const originalFetch = globalThis.fetch;

function mockOpenRouterCatalog(data: unknown[]): void {
  _resetOpenRouterChatModelCache();
  globalThis.fetch = mock(async () => new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  _resetOpenRouterChatModelCache();
});

describe('resolveOpenRouterChatModelPlan', () => {
  it('uses a configured model only when it is present in the live OpenRouter catalog', async () => {
    mockOpenRouterCatalog([
      {
        id: 'provider/live-avatar-model',
        name: 'Live Avatar Model',
        context_length: 128000,
        architecture: { output_modalities: ['text'] },
        supported_parameters: ['tools'],
      },
      {
        id: 'provider/live-fallback-model',
        name: 'Live Fallback Model',
        context_length: 64000,
        architecture: { output_modalities: ['text'] },
        supported_parameters: ['tools'],
      },
    ]);

    const plan = await resolveOpenRouterChatModelPlan({
      avatarModel: 'provider/live-avatar-model',
      requireTools: true,
    });

    expect(plan).toEqual({
      primaryModel: 'provider/live-avatar-model',
      fallbackModels: ['provider/live-fallback-model'],
      source: 'configured',
    });
  });

  it('ignores a stale stored model and selects from the live catalog', async () => {
    mockOpenRouterCatalog([
      {
        id: 'provider/live-best-model',
        name: 'Live Best Model',
        context_length: 256000,
        architecture: { output_modalities: ['text'] },
        supported_parameters: ['tools'],
      },
      {
        id: 'provider/live-second-model',
        name: 'Live Second Model',
        context_length: 128000,
        architecture: { output_modalities: ['text'] },
        supported_parameters: ['tools'],
      },
    ]);

    const plan = await resolveOpenRouterChatModelPlan({
      avatarModel: 'provider/stale-model',
      requireTools: true,
    });

    expect(plan.primaryModel).toBe('provider/live-best-model');
    expect(plan.fallbackModels).toEqual(['provider/live-second-model']);
    expect(plan.source).toBe('catalog');
  });

  it('filters fallback candidates by tool support when tools are required', async () => {
    mockOpenRouterCatalog([
      {
        id: 'provider/no-tools-model',
        name: 'No Tools Model',
        context_length: 512000,
        architecture: { output_modalities: ['text'] },
        supported_parameters: ['temperature'],
      },
      {
        id: 'provider/tools-model',
        name: 'Tools Model',
        context_length: 128000,
        architecture: { output_modalities: ['text'] },
        supported_parameters: ['tools'],
      },
    ]);

    const plan = await resolveOpenRouterChatModelPlan({ requireTools: true });

    expect(plan.primaryModel).toBe('provider/tools-model');
    expect(plan.fallbackModels).toEqual([]);
  });

  it('purges tilde-prefixed OpenRouter registry aliases from model selection', async () => {
    mockOpenRouterCatalog([
      {
        id: '~google/fake-registry-model',
        name: 'Fake Registry Model',
        context_length: 1000000,
        architecture: { output_modalities: ['text'] },
        supported_parameters: ['tools'],
      },
      {
        id: 'google/live-model',
        name: 'Live Model',
        context_length: 128000,
        architecture: { output_modalities: ['text'] },
        supported_parameters: ['tools'],
      },
    ]);

    const models = await listOpenRouterChatModels();
    expect(models.map(model => model.id)).toEqual(['google/live-model']);

    const plan = await resolveOpenRouterChatModelPlan({
      requestModel: '~google/fake-registry-model',
      requireTools: true,
    });

    expect(plan.primaryModel).toBe('google/live-model');
    expect(plan.fallbackModels).toEqual([]);
    expect(plan.source).toBe('catalog');
  });
});
