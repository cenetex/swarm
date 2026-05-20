import { describe, it, expect } from 'vitest';
import type { AvatarRecord } from '../types.js';
import { convertToAvatarConfig } from './config-sync.js';

describe('config-sync convertToAvatarConfig', () => {
  it('includes Telegram allowedChatIds and allowedDmUserIds when present', () => {
    const record = {
      pk: 'AVATAR#test-avatar',
      sk: 'CONFIG',
      avatarId: 'test-avatar',
      name: 'Test Avatar',
      platforms: {
        telegram: {
          enabled: true,
          botUsername: 'testbot',
          allowedChatIds: ['-1001', '-1002'],
          allowedDmUserIds: ['111', '222'],
        },
      },
      voiceConfig: {
        enabled: true,
        ttsProvider: 'voice-clone',
        format: 'ogg',
      },
      llmConfig: {
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4',
        temperature: 0.8,
        maxTokens: 1024,
        useGlobalKey: true,
      },
      currentEra: 0,
      status: 'active',
      createdAt: Date.now(),
      createdBy: 'test@example.com',
      updatedAt: Date.now(),
      updatedBy: 'test@example.com',
    } satisfies Partial<AvatarRecord> as AvatarRecord;

    const config = convertToAvatarConfig(record);

    expect(config.platforms.telegram?.enabled).toBe(true);
    expect(config.platforms.telegram?.allowedChatTypes).toEqual(['private', 'group', 'supergroup', 'channel']);
    expect(config.platforms.telegram?.allowedChatIds).toEqual(['-1001', '-1002']);
    expect(config.platforms.telegram?.allowedDmUserIds).toEqual(['111', '222']);
  });

  it('includes Telegram allowedDmUsers and allowedChats when present', () => {
    const record = {
      pk: 'AVATAR#test-avatar',
      sk: 'CONFIG',
      avatarId: 'test-avatar',
      name: 'Test Avatar',
      platforms: {
        telegram: {
          enabled: true,
          botUsername: 'testbot',
          allowedDmUsers: [
            { userId: '111', username: 'alice', displayName: 'Alice' },
            { userId: '222' },
          ],
          allowedChats: [
            { chatId: '-1001', title: 'My Group' },
            { chatId: '-1002', username: 'mychannel' },
          ],
        },
      },
      voiceConfig: {
        enabled: true,
        ttsProvider: 'voice-clone',
        format: 'ogg',
      },
      llmConfig: {
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4',
        temperature: 0.8,
        maxTokens: 1024,
        useGlobalKey: true,
      },
      currentEra: 0,
      status: 'active',
      createdAt: Date.now(),
      createdBy: 'test@example.com',
      updatedAt: Date.now(),
      updatedBy: 'test@example.com',
    } satisfies Partial<AvatarRecord> as AvatarRecord;

    const config = convertToAvatarConfig(record);

    expect(config.platforms.telegram?.enabled).toBe(true);
    expect(config.platforms.telegram?.allowedDmUsers).toEqual([
      { userId: '111', username: 'alice', displayName: 'Alice' },
      { userId: '222' },
    ]);
    expect(config.platforms.telegram?.allowedChats).toEqual([
      { chatId: '-1001', title: 'My Group' },
      { chatId: '-1002', username: 'mychannel' },
    ]);
  });

  it('does not require Telegram allowlists to be set', () => {
    const record = {
      pk: 'AVATAR#test-avatar',
      sk: 'CONFIG',
      avatarId: 'test-avatar',
      name: 'Test Avatar',
      platforms: {
        telegram: {
          enabled: true,
          botUsername: 'testbot',
        },
      },
      voiceConfig: {
        enabled: true,
        ttsProvider: 'voice-clone',
        format: 'ogg',
      },
      llmConfig: {
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4',
        temperature: 0.8,
        maxTokens: 1024,
        useGlobalKey: true,
      },
      currentEra: 0,
      status: 'active',
      createdAt: Date.now(),
      createdBy: 'test@example.com',
      updatedAt: Date.now(),
      updatedBy: 'test@example.com',
    } satisfies Partial<AvatarRecord> as AvatarRecord;

    const config = convertToAvatarConfig(record);

    expect(config.platforms.telegram?.enabled).toBe(true);
    expect(config.platforms.telegram?.allowedChatTypes).toEqual(['private', 'group', 'supergroup', 'channel']);
    expect(config.platforms.telegram?.allowedChatIds).toBeUndefined();
    expect(config.platforms.telegram?.allowedDmUserIds).toBeUndefined();
  });

  it('defaults media generation models to current OpenRouter defaults when unset', () => {
    const record = {
      pk: 'AVATAR#test-avatar',
      sk: 'CONFIG',
      avatarId: 'test-avatar',
      name: 'Test Avatar',
      platforms: {},
      voiceConfig: {
        enabled: true,
        ttsProvider: 'voice-clone',
        format: 'ogg',
      },
      llmConfig: {
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4',
        temperature: 0.8,
        maxTokens: 1024,
        useGlobalKey: true,
      },
      currentEra: 0,
      status: 'active',
      createdAt: Date.now(),
      createdBy: 'test@example.com',
      updatedAt: Date.now(),
      updatedBy: 'test@example.com',
    } satisfies Partial<AvatarRecord> as AvatarRecord;

    const config = convertToAvatarConfig(record);
    expect(config.media.image.provider).toBe('openrouter');
    expect(config.media.image.model).toBe('');
    expect(config.media.video?.provider).toBe('openrouter');
    expect(config.media.video?.model).toBe('');
  });

  it('syncs Twitter features and autonomous posts settings', () => {
    const record = {
      pk: 'AVATAR#test-avatar',
      sk: 'CONFIG',
      avatarId: 'test-avatar',
      name: 'Test Avatar',
      platforms: {
        twitter: {
          enabled: true,
          username: 'testbot',
          features: ['mention_replies', 'autonomous_posts', 'community_posts'],
          autonomousPosts: {
            enabled: true,
            minIntervalHours: 5,
            maxIntervalHours: 7,
            imageChance: 0.5,
            useMemories: false,
            topics: ['ai'],
            dailyBudget: 3,
          },
          communities: [{ id: '123', name: 'Test Community' }],
        },
      },
      voiceConfig: {
        enabled: true,
        ttsProvider: 'voice-clone',
        format: 'ogg',
      },
      llmConfig: {
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4',
        temperature: 0.8,
        maxTokens: 1024,
        useGlobalKey: true,
      },
      currentEra: 0,
      status: 'active',
      createdAt: Date.now(),
      createdBy: 'test@example.com',
      updatedAt: Date.now(),
      updatedBy: 'test@example.com',
    } satisfies Partial<AvatarRecord> as AvatarRecord;

    const config = convertToAvatarConfig(record);

    expect(config.platforms.twitter?.features).toEqual(['mention_replies', 'autonomous_posts', 'community_posts']);
    expect(config.platforms.twitter?.autonomousPosts?.minIntervalHours).toBe(5);
    expect(config.platforms.twitter?.autonomousPosts?.dailyBudget).toBe(3);
    expect(config.platforms.twitter?.communities?.[0]?.id).toBe('123');
    expect(config.scheduling.tweets).toBeUndefined();
  });

  it('preserves system prompt overrides for runtime prompt resolution', () => {
    const record = {
      pk: 'AVATAR#prompt-avatar',
      sk: 'CONFIG',
      avatarId: 'prompt-avatar',
      name: 'Prompt Avatar',
      persona: 'Template persona',
      systemPromptOverride: {
        kind: 'inline',
        text: 'Use this exact prompt.',
      },
      platforms: {},
      voiceConfig: {
        enabled: true,
        ttsProvider: 'voice-clone',
        format: 'ogg',
      },
      llmConfig: {
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4',
        temperature: 0.8,
        maxTokens: 1024,
        useGlobalKey: true,
      },
      currentEra: 0,
      status: 'active',
      createdAt: Date.now(),
      createdBy: 'test@example.com',
      updatedAt: Date.now(),
      updatedBy: 'test@example.com',
    } satisfies Partial<AvatarRecord> as AvatarRecord;

    const config = convertToAvatarConfig(record);

    expect(config.systemPromptOverride).toEqual({
      kind: 'inline',
      text: 'Use this exact prompt.',
    });
  });

  it('preserves Replicate media settings from avatar media config', () => {
    const record = {
      pk: 'AVATAR#media-avatar',
      sk: 'CONFIG',
      avatarId: 'media-avatar',
      name: 'Media Avatar',
      mediaConfig: {
        image: {
          provider: 'replicate',
          model: 'black-forest-labs/flux-schnell',
        },
        video: {
          provider: 'replicate',
          model: 'minimax/video-01',
        },
        useProfileAsReference: true,
      },
      platforms: {},
      voiceConfig: {
        enabled: true,
        ttsProvider: 'voice-clone',
        format: 'ogg',
      },
      llmConfig: {
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4',
        temperature: 0.8,
        maxTokens: 1024,
        useGlobalKey: true,
      },
      currentEra: 0,
      status: 'active',
      createdAt: Date.now(),
      createdBy: 'test@example.com',
      updatedAt: Date.now(),
      updatedBy: 'test@example.com',
    } satisfies Partial<AvatarRecord> as AvatarRecord;

    const config = convertToAvatarConfig(record);

    expect(config.media.image).toEqual({
      provider: 'replicate',
      model: 'black-forest-labs/flux-schnell',
    });
    expect(config.media.video).toEqual({
      provider: 'replicate',
      model: 'minimax/video-01',
    });
  });

  it('enables Telegram media, gallery, and sticker tools for runtime use', () => {
    const record = {
      pk: 'AVATAR#sticker-avatar',
      sk: 'CONFIG',
      avatarId: 'sticker-avatar',
      name: 'Sticker Avatar',
      platforms: {
        telegram: {
          enabled: true,
          botUsername: 'stickerbot',
        },
      },
      voiceConfig: {
        enabled: true,
        ttsProvider: 'voice-clone',
        format: 'ogg',
      },
      llmConfig: {
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4',
        temperature: 0.8,
        maxTokens: 1024,
        useGlobalKey: true,
      },
      currentEra: 0,
      status: 'active',
      createdAt: Date.now(),
      createdBy: 'test@example.com',
      updatedAt: Date.now(),
      updatedBy: 'test@example.com',
    } satisfies Partial<AvatarRecord> as AvatarRecord;

    const config = convertToAvatarConfig(record);

    expect(config.tools).toEqual(expect.arrayContaining([
      'generate_sticker',
      'create_sticker',
      'send_sticker',
      'get_sticker_pack',
      'get_gallery_for_stickers',
    ]));
  });

  it('marks scheduled tweet templates as enabled when scheduled tweets are active', () => {
    const record = {
      pk: 'AVATAR#twitter-avatar',
      sk: 'CONFIG',
      avatarId: 'twitter-avatar',
      name: 'Twitter Avatar',
      platforms: {
        twitter: {
          enabled: true,
          username: 'twitterbot',
          features: ['scheduled_tweets'],
        },
      },
      voiceConfig: {
        enabled: true,
        ttsProvider: 'voice-clone',
        format: 'ogg',
      },
      llmConfig: {
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4',
        temperature: 0.8,
        maxTokens: 1024,
        useGlobalKey: true,
      },
      currentEra: 0,
      status: 'active',
      createdAt: Date.now(),
      createdBy: 'test@example.com',
      updatedAt: Date.now(),
      updatedBy: 'test@example.com',
    } satisfies Partial<AvatarRecord> as AvatarRecord;

    const config = convertToAvatarConfig(record);

    expect(config.scheduling.tweets).toEqual([
      { cron: '0 12 * * *', template: 'general', enabled: true },
      { cron: '0 18 * * *', template: 'general', enabled: true },
    ]);
  });

  it('propagates nftMint and creatorWallet so the handler ownership gate (#1416) can see them', () => {
    const record = {
      pk: 'AVATAR#nft-avatar',
      sk: 'CONFIG',
      avatarId: 'nft-avatar',
      name: 'NFT Avatar',
      nftMint: 'MINT_XYZ',
      creatorWallet: 'WALLET_CLAIMER',
      platforms: { telegram: { enabled: true, botUsername: 'nftbot' } },
      voiceConfig: { enabled: true, ttsProvider: 'voice-clone', format: 'ogg' },
      llmConfig: {
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4',
        temperature: 0.8,
        maxTokens: 1024,
        useGlobalKey: true,
      },
      currentEra: 0,
      status: 'active',
      createdAt: Date.now(),
      createdBy: 'test@example.com',
      updatedAt: Date.now(),
      updatedBy: 'test@example.com',
    } satisfies Partial<AvatarRecord> as AvatarRecord;

    const config = convertToAvatarConfig(record);

    expect(config.nftMint).toBe('MINT_XYZ');
    expect(config.creatorWallet).toBe('WALLET_CLAIMER');
  });

  it('leaves NFT fields undefined for non-NFT avatars so the gate is skipped', () => {
    const record = {
      pk: 'AVATAR#plain-avatar',
      sk: 'CONFIG',
      avatarId: 'plain-avatar',
      name: 'Plain Avatar',
      platforms: { telegram: { enabled: true, botUsername: 'plainbot' } },
      voiceConfig: { enabled: true, ttsProvider: 'voice-clone', format: 'ogg' },
      llmConfig: {
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4',
        temperature: 0.8,
        maxTokens: 1024,
        useGlobalKey: true,
      },
      currentEra: 0,
      status: 'active',
      createdAt: Date.now(),
      createdBy: 'test@example.com',
      updatedAt: Date.now(),
      updatedBy: 'test@example.com',
    } satisfies Partial<AvatarRecord> as AvatarRecord;

    const config = convertToAvatarConfig(record);

    expect(config.nftMint).toBeUndefined();
    expect(config.creatorWallet).toBeUndefined();
  });
});
