import { describe, expect, it, vi } from 'vitest';
import type { AvatarConfig, ChannelState, ContextMessage } from '../types/index.js';
import type { ChannelInfo, PresenceService } from './presence.js';
import {
  buildAvatarContextSnapshot,
  renderAvatarContextSnapshot,
  resolveHomeChannelFromAvatarConfig,
} from './avatar-context-snapshot.js';
import type { ChannelSummaryService } from './channel-summary.js';

function makeMessage(overrides: Partial<ContextMessage>): ContextMessage {
  return {
    messageId: overrides.messageId || 'msg-1',
    sender: overrides.sender || 'Alice',
    isBot: overrides.isBot ?? false,
    content: overrides.content || 'hello',
    timestamp: overrides.timestamp || Date.now(),
    username: overrides.username,
  };
}

function makeState(messages: ContextMessage[]): ChannelState {
  return {
    avatarId: 'avatar-1',
    channelId: 'channel-1',
    platform: 'telegram',
    recentMessages: messages,
    lastActivityAt: messages.at(-1)?.timestamp || Date.now(),
    messageCount: messages.length,
  };
}

function makePresenceService(channels: ChannelInfo[]): Pick<PresenceService, 'getAllChannels' | 'getChannelWithSummary'> {
  return {
    getAllChannels: vi.fn().mockResolvedValue(channels),
    getChannelWithSummary: vi.fn().mockResolvedValue(null),
  };
}

function makeSummaryService(summary = 'A concise high level summary.'): Pick<ChannelSummaryService, 'getOrGenerateSummary'> {
  return {
    getOrGenerateSummary: vi.fn().mockResolvedValue(summary),
  };
}

describe('avatar context snapshot', () => {
  it('builds bounded recent activity and excludes the current channel', async () => {
    const now = 1_700_000_000_000;
    const channels: ChannelInfo[] = [
      { channelId: 'current', platform: 'telegram', lastActivityAt: now },
      { channelId: 'discord-1', platform: 'discord', title: 'Ops', lastActivityAt: now - 60_000 },
      { channelId: 'telegram-2', platform: 'telegram', title: 'Rati Chat', lastActivityAt: now - 120_000 },
    ];
    const stateGetter = vi.fn().mockImplementation((_avatarId: string, channelId: string) => {
      if (channelId === 'current') {
        return Promise.resolve(makeState([makeMessage({ content: 'current channel should not appear', timestamp: now })]));
      }
      return Promise.resolve(makeState([makeMessage({
        content: `message from ${channelId}`,
        timestamp: channelId === 'discord-1' ? now - 60_000 : now - 120_000,
        username: 'alice',
      })]));
    });

    const snapshot = await buildAvatarContextSnapshot({
      avatarId: 'avatar-1',
      currentChannelId: 'current',
      currentPlatform: 'telegram',
      presenceService: makePresenceService(channels),
      stateGetter,
      now,
      options: {
        includeHomeChannelSummary: false,
        warmChannelSummaries: false,
      },
    });

    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.items.map((item) => item.source?.channelId)).toEqual(['discord-1', 'telegram-2']);
    expect(snapshot.items[0]?.policyLabels).toEqual(['private-source', 'cross-platform-context', 'recent-activity']);
    expect(renderAvatarContextSnapshot(snapshot)).toContain('discord/Ops (1m ago, alice): message from discord-1');
  });

  it('drops recent activity outside the configured age window', async () => {
    const now = 1_700_000_000_000;
    const staleTimestamp = now - 7 * 60 * 60_000;
    const snapshot = await buildAvatarContextSnapshot({
      avatarId: 'avatar-1',
      presenceService: makePresenceService([
        { channelId: 'old', platform: 'telegram', lastActivityAt: staleTimestamp },
      ]),
      stateGetter: vi.fn().mockResolvedValue(makeState([makeMessage({
        content: 'old message',
        timestamp: staleTimestamp,
      })])),
      now,
      options: {
        includeHomeChannelSummary: false,
        warmChannelSummaries: false,
      },
    });

    expect(snapshot.items).toEqual([]);
    expect(renderAvatarContextSnapshot(snapshot)).toBeNull();
  });

  it('adds a policy-labeled home channel summary', async () => {
    const now = 1_700_000_000_000;
    const presenceService = makePresenceService([
      { channelId: '-100123', platform: 'telegram', title: 'Home', lastActivityAt: now },
    ]);
    (presenceService.getChannelWithSummary as ReturnType<typeof vi.fn>).mockResolvedValue({
      channelId: '-100123',
      platform: 'telegram',
      title: 'Home',
      type: 'supergroup',
      lastActivityAt: now,
      summary: 'cached',
      summaryUpdatedAt: now - 30_000,
    });

    const snapshot = await buildAvatarContextSnapshot({
      avatarId: 'avatar-1',
      currentChannelId: '-100123',
      currentPlatform: 'telegram',
      homeChannel: {
        channelId: '-100123',
        platform: 'telegram',
        username: 'ratichat',
      },
      presenceService,
      stateGetter: vi.fn().mockResolvedValue(makeState([makeMessage({ timestamp: now })])),
      summaryService: makeSummaryService('People are discussing launch timing and pending follow-up.'),
      now,
      options: {
        includeRecentActivity: false,
        warmChannelSummaries: false,
      },
    });

    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]?.kind).toBe('home_channel_summary');
    expect(snapshot.items[0]?.policyLabels).toEqual(['private-source', 'public-safe-summary', 'home-channel']);
    expect(renderAvatarContextSnapshot(snapshot)).toContain('Home channel (Telegram Home (current channel))');
    expect(renderAvatarContextSnapshot(snapshot)).toContain('do not quote or attribute private chat');
  });

  it('warms background summaries without rendering them as snapshot items', async () => {
    const now = 1_700_000_000_000;
    const summaryService = makeSummaryService();
    const channels: ChannelInfo[] = [
      { channelId: 'recent-1', platform: 'discord', lastActivityAt: now - 60_000 },
      { channelId: 'recent-2', platform: 'telegram', lastActivityAt: now - 120_000 },
      { channelId: 'old', platform: 'telegram', lastActivityAt: now - 30 * 60 * 60_000 },
    ];

    const snapshot = await buildAvatarContextSnapshot({
      avatarId: 'avatar-1',
      presenceService: makePresenceService(channels),
      stateGetter: vi.fn().mockResolvedValue(makeState([makeMessage({ timestamp: now })])),
      summaryService,
      now,
      options: {
        includeRecentActivity: false,
        includeHomeChannelSummary: false,
        backgroundSummaryMaxChannels: 2,
      },
    });

    expect(snapshot.items).toEqual([]);
    expect(summaryService.getOrGenerateSummary).toHaveBeenCalledTimes(2);
    expect(summaryService.getOrGenerateSummary).toHaveBeenNthCalledWith(
      1,
      'avatar-1',
      'recent-1',
      'discord',
      expect.anything(),
      expect.any(Function)
    );
  });

  it('resolves Telegram home channel configuration from avatar config', () => {
    const avatarConfig = {
      platforms: {
        telegram: {
          homeChannelId: '-100123',
          homeChannelUsername: 'ratichat',
        },
      },
    } as AvatarConfig;

    expect(resolveHomeChannelFromAvatarConfig(avatarConfig)).toEqual({
      channelId: '-100123',
      platform: 'telegram',
      username: 'ratichat',
      label: '@ratichat',
    });
  });
});
