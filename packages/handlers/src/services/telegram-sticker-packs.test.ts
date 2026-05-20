import { describe, expect, it } from 'bun:test';
import type { AvatarConfig, MediaService } from '@swarm/core';
import {
  createRuntimeStickerServices,
  resolveStickerOwnerUserIdFromAvatarRecord,
  resolveStickerReferenceImageUrls,
} from './telegram-sticker-packs.js';

function testAvatarConfig(): AvatarConfig {
  return {
    id: 'avatar-1-test',
    name: 'Sticker Test',
    version: '1.0.0',
    persona: 'Test avatar',
    platforms: {
      telegram: {
        enabled: true,
        botUsername: 'sticker_test_bot',
        webhookPath: '/telegram',
      },
    },
    llm: {
      provider: 'openrouter',
      model: 'test-model',
      temperature: 0,
      maxTokens: 1000,
    },
    media: {
      image: {
        provider: 'openrouter',
        model: 'test-image-model',
      },
    },
    scheduling: {},
    behavior: {},
    tools: [],
    secrets: [],
  } as AvatarConfig;
}

describe('resolveStickerReferenceImageUrls', () => {
  it('keeps reachable character references and skips unreachable profile references', async () => {
    const rejected: Array<{ kind: string; reason: string }> = [];
    const urls = await resolveStickerReferenceImageUrls({
      characterReference: { url: 'https://cdn.example.com/character.png' },
      profileImage: { url: 'https://old-cdn.example.com/profile.png' },
    }, {
      fetchImpl: async (url) => {
        if (url.includes('old-cdn')) throw new Error('getaddrinfo ENOTFOUND');
        return new Response(null, { status: 200 });
      },
      onRejected: (candidate, reason) => rejected.push({ kind: candidate.kind, reason }),
    });

    expect(urls).toEqual(['https://cdn.example.com/character.png']);
    expect(rejected).toEqual([{ kind: 'profile', reason: 'fetch_failed' }]);
  });

  it('returns no references when every configured reference is unreachable', async () => {
    const rejected: Array<{ kind: string; reason: string }> = [];
    const urls = await resolveStickerReferenceImageUrls({
      characterReference: { url: 'https://cdn.example.com/missing-character.png' },
      profileImage: { url: 'https://cdn.example.com/missing-profile.png' },
    }, {
      fetchImpl: async () => new Response(null, { status: 404 }),
      onRejected: (candidate, reason) => rejected.push({ kind: candidate.kind, reason }),
    });

    expect(urls).toEqual([]);
    expect(rejected).toEqual([
      { kind: 'character', reason: 'http_404' },
      { kind: 'profile', reason: 'http_404' },
    ]);
  });
});

describe('resolveStickerOwnerUserIdFromAvatarRecord', () => {
  it('prefers an explicit configured sticker owner', () => {
    expect(resolveStickerOwnerUserIdFromAvatarRecord({
      createdBy: 'telegram:111 (@old_owner)',
      platforms: {
        telegram: {
          stickerOwnerUserId: '222',
        },
      },
    })).toBe('222');
  });

  it('falls back to Telegram-created avatar metadata', () => {
    expect(resolveStickerOwnerUserIdFromAvatarRecord({
      createdBy: 'telegram:333 (@owner)',
    })).toBe('333');
  });
});

describe('createRuntimeStickerServices ownership', () => {
  it('does not use the message requester as a sticker owner fallback', async () => {
    let mediaCalls = 0;
    let creditCalls = 0;
    const mediaService: MediaService = {
      generateImage: async () => {
        mediaCalls += 1;
        throw new Error('generateImage should not be called without a linked owner');
      },
      generateVideo: async () => {
        throw new Error('generateVideo should not be called');
      },
      uploadToS3: async () => {
        throw new Error('uploadToS3 should not be called');
      },
    };

    const services = createRuntimeStickerServices({
      avatarId: 'avatar-1-test',
      avatarConfig: testAvatarConfig(),
      mediaService,
      mediaBucket: 'test-bucket',
      secrets: { TELEGRAM_BOT_TOKEN: 'test-token' },
      consumeStickerCredit: async () => {
        creditCalls += 1;
      },
      resolveStickerOwnerUserId: async () => undefined,
    });

    const result = await services.generateSticker(
      'avatar-1-test',
      'phantom mask',
      ':ghost:',
      '-1001'
    );

    expect(result).toEqual({
      success: false,
      error: "Telegram sticker pack creation requires the avatar's linked Telegram account",
    });
    expect(mediaCalls).toBe(0);
    expect(creditCalls).toBe(0);
  });
});
