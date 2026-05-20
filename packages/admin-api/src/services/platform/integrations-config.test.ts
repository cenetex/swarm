import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearOpenRouterMediaCatalogCache } from '@swarm/core';
import type { UserSession } from '../../types.js';
import { _setDynamoClient } from '../dynamo-client.js';

process.env.ADMIN_TABLE = 'AdminTable';
process.env.OPENROUTER_MEDIA_CATALOG_TTL_MS = '1';

vi.mock('../avatars.js', () => ({
  getAvatar: vi.fn(),
}));

vi.mock('../secrets.js', () => ({
  _getSecretValueInternal: vi.fn(),
  secretExists: vi.fn(),
  storeSecret: vi.fn(),
}));

vi.mock('../openrouter-key.js', () => ({
  hasSystemOpenRouterApiKey: vi.fn(),
}));

import * as avatars from '../avatars.js';

let configureIntegration: typeof import('./integrations.js').configureIntegration;
let getConfiguredModel: typeof import('./integrations.js').getConfiguredModel;
let setModelPreference: typeof import('./integrations.js').setModelPreference;

const mockSend = vi.fn();
const getAvatarMock = avatars.getAvatar as unknown as ReturnType<typeof vi.fn>;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  _setDynamoClient({ send: mockSend } as never);
  const integrations = await import('./integrations.js');
  configureIntegration = integrations.configureIntegration;
  getConfiguredModel = integrations.getConfiguredModel;
  setModelPreference = integrations.setModelPreference;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  _setDynamoClient(null);
});

const session: UserSession = {
  email: 'owner@example.com',
  userId: 'user-1',
  isAdmin: true,
  accessToken: '',
};

function integrationsValue(): Record<string, unknown> {
  const command = mockSend.mock.calls.at(-1)?.[0] as {
    input?: { ExpressionAttributeValues?: Record<string, unknown> };
  };
  const values = command?.input?.ExpressionAttributeValues || {};
  const integrations = Object.values(values).find(
    (value): value is Record<string, unknown> =>
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      'openrouter' in value
  );
  if (!integrations) throw new Error('No integrations value found in update expression');
  return integrations;
}

describe('configureIntegration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = originalFetch;
    clearOpenRouterMediaCatalogCache();
    mockSend.mockResolvedValue({});
    getAvatarMock.mockResolvedValue({ id: 'avatar-1' });
  });

  it('creates the integrations map when the avatar has no integration config yet', async () => {
    await configureIntegration({
      avatarId: 'avatar-1',
      integration: 'openrouter',
      enabled: true,
      useGlobalKey: true,
      models: { video_generation: 'google/veo-3.1-fast' },
      session,
    });

    expect(integrationsValue()).toEqual({
      openrouter: {
        enabled: true,
        useGlobalKey: true,
        models: {
          video_generation: 'google/veo-3.1-fast',
        },
      },
    });
  });

  it('preserves existing integrations and merges model preferences', async () => {
    getAvatarMock.mockResolvedValue({
      id: 'avatar-1',
      integrations: {
        twitter: { enabled: true, username: 'snarkle89' },
        openrouter: {
          enabled: false,
          useGlobalKey: false,
          models: { image_generation: 'google/gemini-3-pro-image-preview' },
        },
      },
    });

    await configureIntegration({
      avatarId: 'avatar-1',
      integration: 'openrouter',
      useGlobalKey: true,
      models: { video_generation: 'google/veo-3.1-fast' },
      settings: {
        pollIntervalMs: 1000,
        'ignored.path': true,
      },
      session,
    });

    expect(integrationsValue()).toEqual({
      twitter: { enabled: true, username: 'snarkle89' },
      openrouter: {
        enabled: true,
        useGlobalKey: true,
        pollIntervalMs: 1000,
        models: {
          image_generation: 'google/gemini-3-pro-image-preview',
          video_generation: 'google/veo-3.1-fast',
        },
      },
    });
  });
});

describe('setModelPreference', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    getAvatarMock.mockResolvedValue({ id: 'avatar-1' });
  });

  it('creates parent integration config before storing a model preference', async () => {
    await setModelPreference(
      'avatar-1',
      'openrouter',
      'video_generation',
      'google/veo-3.1-fast',
      session
    );

    expect(integrationsValue()).toEqual({
      openrouter: {
        enabled: false,
        useGlobalKey: false,
        models: {
          video_generation: 'google/veo-3.1-fast',
        },
      },
    });
  });
});

describe('getConfiguredModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    globalThis.fetch = originalFetch;
    clearOpenRouterMediaCatalogCache();
    getAvatarMock.mockResolvedValue({
      id: 'avatar-1',
      integrations: {
        openrouter: {
          enabled: true,
          useGlobalKey: true,
          models: {},
        },
      },
    });
  });

  it('returns the live OpenRouter media default when no explicit model is configured', async () => {
    globalThis.fetch = (async () => ({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'google/veo-3.1-fast',
            name: 'Google Veo 3.1 Fast',
            description: 'Video generation model',
          },
        ],
      }),
    })) as typeof fetch;

    await expect(
      getConfiguredModel('avatar-1', 'video_generation', 'openrouter')
    ).resolves.toBe('google/veo-3.1-fast');
  });
});
