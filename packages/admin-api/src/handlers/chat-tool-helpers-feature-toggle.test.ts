/**
 * buildFeatureTogglePayload tests — requires mocking avatars.getAvatar.
 */
import { describe, expect, it, beforeAll, mock } from 'bun:test';

// Mock the avatars module BEFORE anything imports chat-tool-helpers
mock.module('../services/avatars.js', () => ({
  getAvatar: mock(async (avatarId: string) => {
    if (avatarId === 'av-media-enabled') {
      return { id: avatarId, mediaConfig: { enabled: true } };
    }
    if (avatarId === 'av-voice-enabled') {
      return { id: avatarId, voiceConfig: { enabled: true } };
    }
    if (avatarId === 'av-twitter-enabled') {
      return { id: avatarId, platforms: { twitter: { enabled: true } } };
    }
    if (avatarId === 'av-telegram-enabled') {
      return { id: avatarId, platforms: { telegram: { enabled: true } } };
    }
    if (avatarId === 'av-discord-enabled') {
      return { id: avatarId, platforms: { discord: { enabled: true } } };
    }
    if (avatarId === 'av-all-disabled') {
      return { id: avatarId, mediaConfig: { enabled: false }, voiceConfig: { enabled: false }, platforms: {} };
    }
    return null;
  }),
  listAvatars: mock(async () => []),
  createAvatar: mock(async () => ({})),
  updateAvatar: mock(async () => ({})),
}));

import { injectTestClients } from './__test-helpers__/inject-clients.js';

let buildFeatureTogglePayload: typeof import('./chat-tool-helpers.js').buildFeatureTogglePayload;

beforeAll(async () => {
  await injectTestClients();
  const mod = await import('./chat-tool-helpers.js');
  buildFeatureTogglePayload = mod.buildFeatureTogglePayload;
});

describe('buildFeatureTogglePayload', () => {
  it('detects enabled media config', async () => {
    const result = await buildFeatureTogglePayload('av-media-enabled', {
      feature: 'media',
      label: 'Media Generation',
      description: 'Enable image generation',
    });
    expect(result.type).toBe('feature_toggle');
    expect(result.feature).toBe('media');
    expect(result.currentState).toBe(true);
    expect(result.label).toBe('Media Generation');
    expect(result.description).toBe('Enable image generation');
  });

  it('detects enabled voice config', async () => {
    const result = await buildFeatureTogglePayload('av-voice-enabled', {
      feature: 'voice',
      label: 'Voice Cloning',
    });
    expect(result.feature).toBe('voice');
    expect(result.currentState).toBe(true);
  });

  it('detects enabled twitter platform', async () => {
    const result = await buildFeatureTogglePayload('av-twitter-enabled', {
      feature: 'twitter',
      label: 'Twitter Integration',
    });
    expect(result.feature).toBe('twitter');
    expect(result.currentState).toBe(true);
  });

  it('detects enabled telegram platform', async () => {
    const result = await buildFeatureTogglePayload('av-telegram-enabled', {
      feature: 'telegram',
      label: 'Telegram Bot',
    });
    expect(result.feature).toBe('telegram');
    expect(result.currentState).toBe(true);
  });

  it('detects enabled discord platform', async () => {
    const result = await buildFeatureTogglePayload('av-discord-enabled', {
      feature: 'discord',
      label: 'Discord Bot',
    });
    expect(result.feature).toBe('discord');
    expect(result.currentState).toBe(true);
  });

  it('returns false when config has disabled features', async () => {
    const result = await buildFeatureTogglePayload('av-all-disabled', {
      feature: 'media',
      label: 'Media',
    });
    expect(result.currentState).toBe(false);
  });

  it('returns false when avatar not found', async () => {
    const result = await buildFeatureTogglePayload('av-nonexistent', {
      feature: 'media',
      label: 'Media',
    });
    expect(result.currentState).toBe(false);
  });

  it('handles null config gracefully', async () => {
    // getAvatar returns null for this ID
    const result = await buildFeatureTogglePayload('av-null-config', {
      feature: 'twitter',
      label: 'Twitter',
    });
    expect(result.currentState).toBe(false);
  });
});
