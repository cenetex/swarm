import { describe, it, expect, vi } from 'vitest';
import {
  formatBrainMemoryContext,
  truncateForPrompt,
  formatRelativeTime,
  buildRecentBotActivityDigest,
  buildCrossPlatformCustomContext,
} from './context-builder.js';
import type { AvatarConfig, BrainMemoryFact, ChannelInfo, PresenceService, SwarmEnvelope } from '@swarm/core';

describe('formatBrainMemoryContext', () => {
  it('returns empty string for empty facts array', () => {
    expect(formatBrainMemoryContext([])).toBe('');
  });

  it('formats a single fact with about field', () => {
    const facts: BrainMemoryFact[] = [
      { fact: 'Dogs are loyal', about: 'dogs', timestamp: 1000 },
    ];
    expect(formatBrainMemoryContext(facts)).toBe(
      '## Relevant Memories\n- Dogs are loyal (about dogs)'
    );
  });

  it('formats a single fact without about field', () => {
    const facts: BrainMemoryFact[] = [
      { fact: 'Something happened', timestamp: 1000 },
    ];
    expect(formatBrainMemoryContext(facts)).toBe(
      '## Relevant Memories\n- Something happened'
    );
  });

  it('formats multiple facts as a bullet list', () => {
    const facts: BrainMemoryFact[] = [
      { fact: 'Dogs are loyal', about: 'dogs', timestamp: 1000 },
      { fact: 'Cats are independent', about: 'cats', timestamp: 900 },
      { fact: 'Fish swim', timestamp: 800 },
    ];
    const result = formatBrainMemoryContext(facts);
    expect(result).toBe(
      '## Relevant Memories\n- Dogs are loyal (about dogs)\n- Cats are independent (about cats)\n- Fish swim'
    );
  });

  it('truncates output to default maxChars (1600)', () => {
    const facts: BrainMemoryFact[] = Array.from({ length: 100 }, (_, i) => ({
      fact: `This is a moderately long fact number ${i} that takes up some space in the output`,
      about: 'testing',
      timestamp: 1000 - i,
    }));
    const result = formatBrainMemoryContext(facts);
    expect(result.length).toBeLessThanOrEqual(1600);
    expect(result.startsWith('## Relevant Memories')).toBe(true);
  });

  it('respects custom maxChars parameter', () => {
    const facts: BrainMemoryFact[] = [
      { fact: 'A'.repeat(200), about: 'test', timestamp: 1000 },
      { fact: 'B'.repeat(200), about: 'test', timestamp: 900 },
    ];
    const result = formatBrainMemoryContext(facts, 100);
    expect(result.length).toBeLessThanOrEqual(100);
  });

  it('does not truncate when output is under maxChars', () => {
    const facts: BrainMemoryFact[] = [
      { fact: 'Short fact', timestamp: 1000 },
    ];
    const result = formatBrainMemoryContext(facts);
    expect(result).toBe('## Relevant Memories\n- Short fact');
  });

  it('handles facts with special characters', () => {
    const facts: BrainMemoryFact[] = [
      { fact: 'User said "hello & goodbye"', about: 'greetings <>', timestamp: 1000 },
    ];
    const result = formatBrainMemoryContext(facts);
    expect(result).toBe(
      '## Relevant Memories\n- User said "hello & goodbye" (about greetings <>)'
    );
  });

  it('includes strength field in facts without affecting output', () => {
    const facts: BrainMemoryFact[] = [
      { fact: 'Strong memory', about: 'test', timestamp: 1000, strength: 1.5 },
    ];
    const result = formatBrainMemoryContext(facts);
    expect(result).toBe('## Relevant Memories\n- Strong memory (about test)');
  });
});

describe('truncateForPrompt', () => {
  it('returns text unchanged when under limit', () => {
    expect(truncateForPrompt('hello', 10)).toBe('hello');
  });

  it('returns text unchanged when exactly at limit', () => {
    expect(truncateForPrompt('hello', 5)).toBe('hello');
  });

  it('truncates and adds ellipsis when over limit', () => {
    const result = truncateForPrompt('hello world', 6);
    expect(result.length).toBeLessThanOrEqual(6);
    expect(result.endsWith('…')).toBe(true);
  });
});

describe('formatRelativeTime', () => {
  const now = 1_000_000;

  it('returns "just now" for less than 1 minute', () => {
    expect(formatRelativeTime(now - 30_000, now)).toBe('just now');
  });

  it('returns minutes for less than 1 hour', () => {
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m ago');
  });

  it('returns hours for less than 1 day', () => {
    expect(formatRelativeTime(now - 3 * 60 * 60_000, now)).toBe('3h ago');
  });

  it('returns days for 1 day or more', () => {
    expect(formatRelativeTime(now - 2 * 24 * 60 * 60_000, now)).toBe('2d ago');
  });

  it('handles future timestamps gracefully', () => {
    expect(formatRelativeTime(now + 60_000, now)).toBe('just now');
  });
});

// ── buildRecentBotActivityDigest ──────────────────────────────────────────────

describe('buildRecentBotActivityDigest', () => {
  function makePresenceService(channels: ChannelInfo[]): PresenceService {
    return {
      getAllChannels: vi.fn().mockResolvedValue(channels),
      getConnectedPlatforms: vi.fn().mockResolvedValue([]),
      getChannelsForPlatform: vi.fn().mockResolvedValue([]),
      getChannelWithSummary: vi.fn().mockResolvedValue(null),
      buildPresenceContext: vi.fn().mockResolvedValue(''),
      checkGlobalRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 20, windowStart: 0, windowEnd: 0, totalPosts: 0, maxPosts: 20 }),
      recordPost: vi.fn().mockResolvedValue(undefined),
      registerChannel: vi.fn().mockResolvedValue(undefined),
      updateChannelSummary: vi.fn().mockResolvedValue(undefined),
    } as unknown as PresenceService;
  }

  function makeStateService(messagesByChannel: Record<string, Array<{ content: string; isBot: boolean; sender: string; username?: string; timestamp: number }>>) {
    return {
      getChannelState: vi.fn().mockImplementation((_avatarId: string, channelId: string) => {
        const msgs = messagesByChannel[channelId];
        if (!msgs) return Promise.resolve(null);
        return Promise.resolve({ recentMessages: msgs });
      }),
    };
  }

  it('returns null when no channels exist', async () => {
    const result = await buildRecentBotActivityDigest({
      avatarId: 'av1',
      presenceService: makePresenceService([]),
      stateService: makeStateService({}) as any,
    });
    expect(result).toBeNull();
  });

  it('returns null when all messages are older than 6h', async () => {
    const staleTs = Date.now() - 7 * 60 * 60_000;
    const result = await buildRecentBotActivityDigest({
      avatarId: 'av1',
      presenceService: makePresenceService([{ channelId: 'ch1', platform: 'telegram', lastActivityAt: staleTs }]),
      stateService: makeStateService({ ch1: [{ content: 'old message', isBot: false, sender: 'alice', timestamp: staleTs }] }) as any,
    });
    expect(result).toBeNull();
  });

  it('includes user messages, not only bot messages', async () => {
    const recentTs = Date.now() - 10 * 60_000;
    const result = await buildRecentBotActivityDigest({
      avatarId: 'av1',
      presenceService: makePresenceService([{ channelId: 'ch1', platform: 'discord', lastActivityAt: recentTs }]),
      stateService: makeStateService({
        ch1: [{ content: 'hello from user', isBot: false, sender: 'alice', username: 'alice', timestamp: recentTs }],
      }) as any,
    });
    expect(result).not.toBeNull();
    expect(result).toContain('discord/');
    expect(result).toContain('alice');
    expect(result).toContain('hello from user');
  });

  it('skips the current channel/platform', async () => {
    const recentTs = Date.now() - 5 * 60_000;
    const result = await buildRecentBotActivityDigest({
      avatarId: 'av1',
      currentChannelId: 'ch1',
      currentPlatform: 'telegram',
      presenceService: makePresenceService([{ channelId: 'ch1', platform: 'telegram', lastActivityAt: recentTs }]),
      stateService: makeStateService({ ch1: [{ content: 'current chat message', isBot: false, sender: 'bob', timestamp: recentTs }] }) as any,
    });
    expect(result).toBeNull();
  });

  it('uses 6h cutoff, including messages up to 6h old', async () => {
    const fiveHoursAgo = Date.now() - 5 * 60 * 60_000;
    const result = await buildRecentBotActivityDigest({
      avatarId: 'av1',
      presenceService: makePresenceService([{ channelId: 'ch2', platform: 'telegram', lastActivityAt: fiveHoursAgo }]),
      stateService: makeStateService({ ch2: [{ content: 'five hours old message', isBot: true, sender: 'bot', timestamp: fiveHoursAgo }] }) as any,
    });
    expect(result).not.toBeNull();
    expect(result).toContain('five hours old message');
  });

  it('limits output to 4 channels', async () => {
    const recentTs = Date.now() - 1 * 60_000;
    const channels: ChannelInfo[] = Array.from({ length: 6 }, (_, i) => ({
      channelId: `ch${i}`,
      platform: 'telegram' as const,
      lastActivityAt: recentTs - i * 1000,
    }));
    const messages: Record<string, Array<{ content: string; isBot: boolean; sender: string; timestamp: number }>> = {};
    for (let i = 0; i < 6; i++) {
      messages[`ch${i}`] = [{ content: `msg from ch${i}`, isBot: false, sender: 'user', timestamp: recentTs - i * 1000 }];
    }
    const result = await buildRecentBotActivityDigest({
      avatarId: 'av1',
      presenceService: makePresenceService(channels),
      stateService: makeStateService(messages) as any,
    });
    expect(result).not.toBeNull();
    const lines = result!.split('\n').filter((l) => l.startsWith('-'));
    expect(lines.length).toBeLessThanOrEqual(4);
  });
});

describe('buildCrossPlatformCustomContext', () => {
  function makeStateService(messagesByChannel: Record<string, Array<{ content: string; isBot: boolean; sender: string; username?: string; timestamp: number }>>) {
    return {
      getChannelState: vi.fn().mockImplementation((_avatarId: string, channelId: string) => {
        const msgs = messagesByChannel[channelId];
        if (!msgs) return Promise.resolve(null);
        return Promise.resolve({
          avatarId: 'av1',
          channelId,
          platform: 'telegram',
          recentMessages: msgs.map((message, index) => ({
            messageId: `${channelId}-${index}`,
            ...message,
          })),
          lastActivityAt: msgs.at(-1)?.timestamp || Date.now(),
          messageCount: msgs.length,
        });
      }),
    };
  }

  it('renders snapshot-backed recent activity and home summary sections', async () => {
    const now = Date.now();
    const presenceService = {
      getAllChannels: vi.fn().mockResolvedValue([
        { channelId: 'current', platform: 'telegram', lastActivityAt: now },
        { channelId: 'discord-1', platform: 'discord', title: 'Ops', lastActivityAt: now - 60_000 },
        { channelId: '-100home', platform: 'telegram', title: 'Home', lastActivityAt: now - 120_000 },
      ]),
      getConnectedPlatforms: vi.fn().mockResolvedValue([]),
      getChannelsForPlatform: vi.fn().mockResolvedValue([]),
      getChannelWithSummary: vi.fn().mockResolvedValue({
        channelId: '-100home',
        platform: 'telegram',
        title: 'Home',
        type: 'supergroup',
        lastActivityAt: now - 120_000,
      }),
      buildPresenceContext: vi.fn().mockResolvedValue(''),
      checkGlobalRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 20, windowStart: 0, windowEnd: 0, totalPosts: 0, maxPosts: 20 }),
      recordPost: vi.fn().mockResolvedValue(undefined),
      registerChannel: vi.fn().mockResolvedValue(undefined),
      updateChannelSummary: vi.fn().mockResolvedValue(undefined),
    } as unknown as PresenceService;

    const stateService = makeStateService({
      current: [{ content: 'current message', isBot: false, sender: 'Bob', timestamp: now }],
      'discord-1': [{ content: 'discord context', isBot: false, sender: 'Alice', username: 'alice', timestamp: now - 60_000 }],
      '-100home': [
        { content: 'home one', isBot: false, sender: 'Carol', timestamp: now - 180_000 },
        { content: 'home two', isBot: false, sender: 'Dan', timestamp: now - 120_000 },
      ],
    });

    const result = await buildCrossPlatformCustomContext({
      avatarId: 'av1',
      avatarConfig: {
        platforms: {
          telegram: {
            homeChannelId: '-100home',
            homeChannelUsername: 'home',
          },
        },
      } as AvatarConfig,
      avatarSecrets: {},
      envelope: {
        platform: 'telegram',
        conversationId: 'current',
      } as SwarmEnvelope,
      presenceService,
      stateService: stateService as any,
    });

    expect(result).toContain('## Recent Cross-Platform Activity');
    expect(result).toContain('discord/Ops');
    expect(result).toContain('discord context');
    expect(result).toContain('## Home Channel Summary');
    expect(result).toContain('Home channel (Telegram Home)');
    expect(result).toContain('do not quote or attribute private chat');
  });
});
