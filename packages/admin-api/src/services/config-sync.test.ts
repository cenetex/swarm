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

  it('defaults image generation model to OpenRouter FLUX 2 Pro when unset', () => {
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
    expect(config.media.image.model).toBe('black-forest-labs/flux.2-pro');
    expect(config.media.video?.provider).toBe('openrouter');
    expect(config.media.video?.model).toBe('bytedance/seedance-2.0-fast');
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
    expect(config.platforms.twitter?.communities?.[0]?.id).toBe('123');
    expect(config.scheduling.tweets).toBeUndefined();
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
