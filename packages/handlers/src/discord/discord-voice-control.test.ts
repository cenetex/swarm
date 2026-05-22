import { describe, it, expect } from 'bun:test';
import type { AvatarConfig, DiscordMessage } from '@swarm/core';
import {
  DiscordVoiceStateTracker,
  decideDiscordVoiceLaunch,
  resolveDiscordVoiceBehavior,
} from './discord-voice-control.js';

function makeAvatarConfig(
  discordOverrides: Partial<NonNullable<AvatarConfig['platforms']['discord']>> = {},
): AvatarConfig {
  return {
    id: 'avatar-1',
    name: 'Test Avatar',
    version: '1',
    persona: 'test',
    platforms: {
      discord: {
        enabled: true,
        mode: 'bot',
        voice: {
          enabled: true,
          autoJoinOnMention: true,
          maxSessionSeconds: 120,
        },
        ...discordOverrides,
      },
    },
    llm: { provider: 'openrouter', model: 'test', temperature: 0.7, maxTokens: 1000 },
    media: { image: { provider: 'openrouter', model: 'test' } },
    scheduling: {},
    behavior: {
      responseDelayMs: [0, 0],
      typingIndicator: false,
      ignoreBots: true,
      cooldownMinutes: 0,
      maxContextMessages: 10,
    },
    tools: [],
    secrets: [],
  } as AvatarConfig;
}

function makeMessage(overrides: Partial<DiscordMessage> = {}): DiscordMessage {
  return {
    id: 'msg-1',
    channel_id: 'text-1',
    guild_id: 'guild-1',
    author: {
      id: 'user-1',
      username: 'alice',
    },
    content: '<@bot-1> join',
    timestamp: new Date(0).toISOString(),
    tts: false,
    mention_everyone: false,
    mentions: [{ id: 'bot-1', username: 'Bot' }],
    attachments: [],
    embeds: [],
    type: 0,
    ...overrides,
  };
}

describe('DiscordVoiceStateTracker', () => {
  it('records and clears the current user voice channel', () => {
    const tracker = new DiscordVoiceStateTracker();

    tracker.record({ guild_id: 'guild-1', user_id: 'user-1', channel_id: 'voice-1' });
    expect(tracker.getUserVoiceChannel('guild-1', 'user-1')).toBe('voice-1');

    tracker.record({ guild_id: 'guild-1', user_id: 'user-1', channel_id: null });
    expect(tracker.getUserVoiceChannel('guild-1', 'user-1')).toBeUndefined();
  });
});

describe('resolveDiscordVoiceBehavior', () => {
  it('keeps voice disabled unless config or env explicitly enables it', () => {
    const config = makeAvatarConfig({ voice: undefined }).platforms.discord!;

    expect(resolveDiscordVoiceBehavior(config, {}).enabled).toBe(false);
    expect(resolveDiscordVoiceBehavior(config, { DISCORD_VOICE_DEFAULT_ENABLED: 'true' }).enabled)
      .toBe(true);
  });
});

describe('decideDiscordVoiceLaunch', () => {
  it('launches when an opted-in avatar is mentioned by a user currently in voice', () => {
    const tracker = new DiscordVoiceStateTracker();
    tracker.record({ guild_id: 'guild-1', user_id: 'user-1', channel_id: 'voice-1' });

    const decision = decideDiscordVoiceLaunch({
      message: makeMessage(),
      avatarConfig: makeAvatarConfig(),
      botUserId: 'bot-1',
      tracker,
    });

    expect(decision).toEqual({
      shouldLaunch: true,
      reason: 'ready',
      voiceChannelId: 'voice-1',
      maxSessionSeconds: 120,
    });
  });

  it('does not launch when the mentioning user is not in voice', () => {
    const decision = decideDiscordVoiceLaunch({
      message: makeMessage(),
      avatarConfig: makeAvatarConfig(),
      botUserId: 'bot-1',
      tracker: new DiscordVoiceStateTracker(),
    });

    expect(decision.shouldLaunch).toBe(false);
    expect(decision.reason).toBe('sender_not_in_voice');
  });

  it('does not launch for unmentioned guild chatter', () => {
    const tracker = new DiscordVoiceStateTracker();
    tracker.record({ guild_id: 'guild-1', user_id: 'user-1', channel_id: 'voice-1' });

    const decision = decideDiscordVoiceLaunch({
      message: makeMessage({ mentions: [], content: 'hello' }),
      avatarConfig: makeAvatarConfig(),
      botUserId: 'bot-1',
      tracker,
    });

    expect(decision.shouldLaunch).toBe(false);
    expect(decision.reason).toBe('not_mentioned');
  });

  it('respects an allow-list of voice channel IDs', () => {
    const tracker = new DiscordVoiceStateTracker();
    tracker.record({ guild_id: 'guild-1', user_id: 'user-1', channel_id: 'voice-2' });

    const decision = decideDiscordVoiceLaunch({
      message: makeMessage(),
      avatarConfig: makeAvatarConfig({
        voice: {
          enabled: true,
          autoJoinOnMention: true,
          allowedVoiceChannelIds: ['voice-1'],
        },
      }),
      botUserId: 'bot-1',
      tracker,
    });

    expect(decision).toEqual({
      shouldLaunch: false,
      reason: 'voice_channel_not_allowed',
      voiceChannelId: 'voice-2',
    });
  });
});
