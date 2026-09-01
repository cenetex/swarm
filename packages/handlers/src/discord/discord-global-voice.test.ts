import { beforeAll, describe, expect, it } from 'bun:test';
import type { AvatarConfig, DiscordMessage } from '@swarm/core';
import { DiscordVoiceStateTracker } from './discord-voice-control.js';
import type {
  DiscordAvatarBinding,
  DiscordVoiceLaunchDependencies,
} from './discord-gateway-shared.js';

process.env.STATE_TABLE ||= 'test-state-table';
process.env.MESSAGE_QUEUE_URL ||= 'https://sqs.us-east-1.amazonaws.com/123456789012/test-queue';

let maybeLaunchDiscordVoiceSession:
  typeof import('./discord-gateway-shared.js').maybeLaunchDiscordVoiceSession;

beforeAll(async () => {
  ({ maybeLaunchDiscordVoiceSession } = await import('./discord-gateway-shared.js'));
});

function makeGlobalBinding(): DiscordAvatarBinding {
  return {
    avatarId: 'ruby',
    botToken: 'global-token',
    botUserId: 'global-bot',
    isGlobalMode: true,
    config: {
      id: 'ruby',
      name: 'Ruby',
      version: '1',
      persona: 'test',
      platforms: {
        discord: {
          enabled: true,
          mode: 'global',
          allowedGuilds: ['guild-1'],
          allowedChannels: ['text-1'],
          voice: {
            enabled: true,
            autoJoinOnMention: true,
            maxSessionSeconds: 120,
          },
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
    } as AvatarConfig,
  };
}

function makeMessage(overrides: Partial<DiscordMessage> = {}): DiscordMessage {
  return {
    id: 'message-1',
    channel_id: 'text-1',
    guild_id: 'guild-1',
    author: { id: 'user-1', username: 'alice', bot: false },
    content: '<@global-bot> join voice',
    timestamp: new Date(0).toISOString(),
    tts: false,
    mention_everyone: false,
    mentions: [{ id: 'global-bot', username: 'Swarm' }],
    attachments: [],
    embeds: [],
    type: 0,
    ...overrides,
  };
}

function makeDependencies() {
  const tracker = new DiscordVoiceStateTracker();
  tracker.record({ guild_id: 'guild-1', user_id: 'user-1', channel_id: 'voice-1' });
  const launchedAvatarIds: string[] = [];
  const dependencies: DiscordVoiceLaunchDependencies = {
    tracker,
    launcher: {
      launch: async (request) => {
        launchedAvatarIds.push(request.avatarId);
        return { launched: true, reason: 'started', taskArn: 'test-task' };
      },
    },
  };
  return { dependencies, launchedAvatarIds };
}

describe('global-mode Discord voice launch', () => {
  it('launches a voice worker when the shared bot is validly mentioned', async () => {
    const { dependencies, launchedAvatarIds } = makeDependencies();

    const handled = await maybeLaunchDiscordVoiceSession(
      makeMessage(),
      makeGlobalBinding(),
      dependencies,
    );

    expect(handled).toBe(true);
    expect(launchedAvatarIds).toEqual(['ruby']);
  });

  it('keeps mention and channel access preconditions for global avatars', async () => {
    const unmentioned = makeDependencies();
    const unmentionedHandled = await maybeLaunchDiscordVoiceSession(
      makeMessage({ content: 'hello', mentions: [] }),
      makeGlobalBinding(),
      unmentioned.dependencies,
    );

    const denied = makeDependencies();
    const deniedHandled = await maybeLaunchDiscordVoiceSession(
      makeMessage({ channel_id: 'not-allowed' }),
      makeGlobalBinding(),
      denied.dependencies,
    );

    expect(unmentionedHandled).toBe(false);
    expect(unmentioned.launchedAvatarIds).toEqual([]);
    expect(deniedHandled).toBe(false);
    expect(denied.launchedAvatarIds).toEqual([]);
  });
});
