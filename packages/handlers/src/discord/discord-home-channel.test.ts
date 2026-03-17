/**
 * Discord Home Channel Bootstrap Tests
 *
 * Tests covering:
 * - Discovery: resolve persisted home channel from config
 * - Discovery: resolve from ADMIN_TABLE registry
 * - Creation: bootstrap from guild engagement (first mention)
 * - Reuse: subsequent calls return the same persisted channel
 * - Failure: fail closed when no channel found and no fallback
 * - Error handling: DynamoDB errors logged and fail closed
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import type { AvatarConfig } from '@swarm/core';

process.env.ADMIN_TABLE ||= 'TEST_ADMIN_TABLE';
process.env.STATE_TABLE ||= 'TEST_STATE_TABLE';

const modPromise = import('./discord-home-channel.js');

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeAvatarConfig(overrides: Partial<AvatarConfig['platforms']['discord']> = {}): AvatarConfig {
  return {
    id: 'test-avatar',
    name: 'Test Avatar',
    version: '1',
    persona: 'test',
    platforms: {
      discord: {
        enabled: true,
        mode: 'bot' as const,
        botUsername: 'TestBot',
        ...overrides,
      },
    },
    llm: { provider: 'openrouter', model: 'test', temperature: 0.7, maxTokens: 1000 },
    media: { image: { provider: 'openrouter', model: 'test' } },
    scheduling: {},
    behavior: { responseDelayMs: [0, 0], typingIndicator: false, ignoreBots: false, cooldownMinutes: 0, maxContextMessages: 10 },
    tools: [],
    secrets: [],
  } as AvatarConfig;
}

type SendCall = { input: Record<string, unknown> };

function createMockDeps(options: {
  getResponse?: Record<string, unknown>;
  queryItems?: Array<Record<string, unknown>>;
  failOnSend?: boolean;
  errorMessage?: string;
} = {}) {
  const calls: SendCall[] = [];
  const mockDynamo = {
    send: async (cmd: unknown) => {
      const input = (cmd as { input: Record<string, unknown> }).input;
      calls.push({ input });

      if (options.failOnSend) {
        throw new Error(options.errorMessage || 'DynamoDB error');
      }

      // Route by command type
      const cmdName = (cmd as { constructor: { name: string } }).constructor.name;
      if (cmdName === 'GetCommand') {
        return { Item: options.getResponse || undefined };
      }
      if (cmdName === 'QueryCommand') {
        return { Items: options.queryItems || [] };
      }
      return {};
    },
  };

  const logs: Array<{ level: string; message: string; meta?: Record<string, unknown> }> = [];
  const mockLogger = {
    info: (message: string, meta?: Record<string, unknown>) => {
      logs.push({ level: 'info', message, meta });
    },
    warn: (message: string, meta?: Record<string, unknown>) => {
      logs.push({ level: 'warn', message, meta });
    },
  };

  return {
    deps: {
      getDynamo: () => mockDynamo,
      logger: mockLogger,
    },
    calls,
    logs,
  };
}

// =============================================================================
// Discovery: resolve from avatar config
// =============================================================================

describe('discord home channel - discovery from config', () => {
  beforeEach(async () => {
    const mod = await modPromise;
    mod.invalidateDiscordHomeChannelCache();
  });

  it('returns persisted home channel from avatar config', async () => {
    const { resolveDiscordHomeChannel } = await modPromise;
    const { deps } = createMockDeps();

    const result = await resolveDiscordHomeChannel(
      {
        avatarId: 'a1',
        avatarConfig: makeAvatarConfig({
          homeChannelId: 'ch-123',
          homeGuildId: 'guild-1',
          homeChannelName: 'kyro-chat',
        }),
      },
      deps
    );

    expect(result).toEqual({
      channelId: 'ch-123',
      guildId: 'guild-1',
      channelName: 'kyro-chat',
      source: 'persisted',
    });
  });

  it('does not query DynamoDB when config has homeChannelId', async () => {
    const { resolveDiscordHomeChannel } = await modPromise;
    const { deps, calls } = createMockDeps();

    await resolveDiscordHomeChannel(
      {
        avatarId: 'a1',
        avatarConfig: makeAvatarConfig({ homeChannelId: 'ch-123' }),
      },
      deps
    );

    // No DynamoDB calls should be made
    expect(calls.length).toBe(0);
  });
});

// =============================================================================
// Discovery: resolve from registry
// =============================================================================

describe('discord home channel - discovery from registry', () => {
  beforeEach(async () => {
    const mod = await modPromise;
    mod.invalidateDiscordHomeChannelCache();
  });

  it('discovers home channel from ADMIN_TABLE registry', async () => {
    const { resolveDiscordHomeChannel } = await modPromise;
    const { deps } = createMockDeps({
      queryItems: [
        { sk: 'ch-456', registeredAvatars: [{ avatarId: 'a1', botUsername: 'TestBot' }] },
      ],
    });

    const result = await resolveDiscordHomeChannel(
      {
        avatarId: 'a1',
        avatarConfig: makeAvatarConfig(),
      },
      deps
    );

    expect(result).toEqual({
      channelId: 'ch-456',
      source: 'discovered',
    });
  });

  it('skips channels where avatar is not registered', async () => {
    const { resolveDiscordHomeChannel } = await modPromise;
    const { deps, logs } = createMockDeps({
      queryItems: [
        { sk: 'ch-789', registeredAvatars: [{ avatarId: 'other-avatar', botUsername: 'OtherBot' }] },
      ],
    });

    const result = await resolveDiscordHomeChannel(
      {
        avatarId: 'a1',
        avatarConfig: makeAvatarConfig(),
      },
      deps
    );

    expect(result).toBeNull();
    expect(logs.some((l) => l.level === 'warn' && l.message.includes('No Discord home channel found'))).toBe(true);
  });
});

// =============================================================================
// Creation: fallback channel
// =============================================================================

describe('discord home channel - fallback creation', () => {
  beforeEach(async () => {
    const mod = await modPromise;
    mod.invalidateDiscordHomeChannelCache();
  });

  it('creates home channel from fallback when no persisted or discovered channel', async () => {
    const { resolveDiscordHomeChannel } = await modPromise;
    const { deps, calls } = createMockDeps({
      queryItems: [], // No registered channels
      getResponse: undefined, // Channel record doesn't exist yet
    });

    const result = await resolveDiscordHomeChannel(
      {
        avatarId: 'a1',
        avatarConfig: makeAvatarConfig(),
        fallbackChannelId: 'ch-fallback',
        fallbackGuildId: 'guild-99',
        fallbackChannelName: 'general',
      },
      deps
    );

    expect(result).toEqual({
      channelId: 'ch-fallback',
      guildId: 'guild-99',
      channelName: 'general',
      source: 'fallback',
    });

    // Should have written to DynamoDB (register + update state + update admin)
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });
});

// =============================================================================
// Bootstrap from guild engagement
// =============================================================================

describe('discord home channel - bootstrap from engagement', () => {
  beforeEach(async () => {
    const mod = await modPromise;
    mod.invalidateDiscordHomeChannelCache();
  });

  it('bootstraps home channel from first guild mention when none exists', async () => {
    const { maybeBootstrapDiscordHomeChannel } = await modPromise;
    const { deps, calls, logs } = createMockDeps({
      getResponse: undefined, // No existing record
    });

    const bootstrapped = await maybeBootstrapDiscordHomeChannel(
      {
        avatarId: 'a1',
        avatarConfig: makeAvatarConfig(),
        channelId: 'ch-001',
        guildId: 'guild-1',
        channelName: 'general',
        isMention: true,
      },
      deps
    );

    expect(bootstrapped).toBe(true);
    expect(logs.some((l) => l.level === 'info' && l.message.includes('Bootstrapped'))).toBe(true);
    expect(calls.length).toBeGreaterThanOrEqual(1); // At least register + update
  });

  it('does not bootstrap for DMs (no guildId)', async () => {
    const { maybeBootstrapDiscordHomeChannel } = await modPromise;
    const { deps, calls } = createMockDeps();

    const bootstrapped = await maybeBootstrapDiscordHomeChannel(
      {
        avatarId: 'a1',
        avatarConfig: makeAvatarConfig(),
        channelId: 'ch-001',
        // No guildId — this is a DM
        isMention: true,
      },
      deps
    );

    expect(bootstrapped).toBe(false);
    expect(calls.length).toBe(0);
  });

  it('does not bootstrap when already has homeChannelId', async () => {
    const { maybeBootstrapDiscordHomeChannel } = await modPromise;
    const { deps, calls } = createMockDeps();

    const bootstrapped = await maybeBootstrapDiscordHomeChannel(
      {
        avatarId: 'a1',
        avatarConfig: makeAvatarConfig({ homeChannelId: 'ch-existing' }),
        channelId: 'ch-001',
        guildId: 'guild-1',
        isMention: true,
      },
      deps
    );

    expect(bootstrapped).toBe(false);
    expect(calls.length).toBe(0);
  });

  it('does not bootstrap without engagement (no mention or reply)', async () => {
    const { maybeBootstrapDiscordHomeChannel } = await modPromise;
    const { deps, calls } = createMockDeps();

    const bootstrapped = await maybeBootstrapDiscordHomeChannel(
      {
        avatarId: 'a1',
        avatarConfig: makeAvatarConfig(),
        channelId: 'ch-001',
        guildId: 'guild-1',
        // No isMention or isReplyToBot
      },
      deps
    );

    expect(bootstrapped).toBe(false);
    expect(calls.length).toBe(0);
  });

  it('bootstraps from reply-to-bot engagement', async () => {
    const { maybeBootstrapDiscordHomeChannel } = await modPromise;
    const { deps } = createMockDeps({
      getResponse: undefined,
    });

    const bootstrapped = await maybeBootstrapDiscordHomeChannel(
      {
        avatarId: 'a1',
        avatarConfig: makeAvatarConfig(),
        channelId: 'ch-001',
        guildId: 'guild-1',
        isReplyToBot: true,
      },
      deps
    );

    expect(bootstrapped).toBe(true);
  });
});

// =============================================================================
// Reuse: subsequent calls return persisted channel
// =============================================================================

describe('discord home channel - reuse', () => {
  beforeEach(async () => {
    const mod = await modPromise;
    mod.invalidateDiscordHomeChannelCache();
  });

  it('reuses persisted home channel on subsequent calls', async () => {
    const { resolveDiscordHomeChannel } = await modPromise;
    const { deps } = createMockDeps();

    const config = makeAvatarConfig({ homeChannelId: 'ch-reuse', homeGuildId: 'guild-1' });

    const result1 = await resolveDiscordHomeChannel({ avatarId: 'a1', avatarConfig: config }, deps);
    const result2 = await resolveDiscordHomeChannel({ avatarId: 'a1', avatarConfig: config }, deps);

    expect(result1?.channelId).toBe('ch-reuse');
    expect(result2?.channelId).toBe('ch-reuse');
    expect(result1?.source).toBe('persisted');
    expect(result2?.source).toBe('persisted');
  });

  it('uses cached registry entries within TTL', async () => {
    const { resolveDiscordHomeChannel, invalidateDiscordHomeChannelCache } = await modPromise;

    let queryCount = 0;
    const mockDynamo = {
      send: async (cmd: unknown) => {
        const cmdName = (cmd as { constructor: { name: string } }).constructor.name;
        if (cmdName === 'QueryCommand') {
          queryCount++;
          return {
            Items: [{ sk: 'ch-cached', registeredAvatars: [{ avatarId: 'a1', botUsername: 'TestBot' }] }],
          };
        }
        return {};
      },
    };

    const deps = {
      getDynamo: () => mockDynamo,
      logger: { info: () => {}, warn: () => {} },
    };

    invalidateDiscordHomeChannelCache();

    const result1 = await resolveDiscordHomeChannel({ avatarId: 'a1', avatarConfig: makeAvatarConfig() }, deps);
    const result2 = await resolveDiscordHomeChannel({ avatarId: 'a1', avatarConfig: makeAvatarConfig() }, deps);

    expect(result1?.channelId).toBe('ch-cached');
    expect(result2?.channelId).toBe('ch-cached');
    // Only one query should have been made (second used cache)
    expect(queryCount).toBe(1);
  });
});

// =============================================================================
// Failure: fail closed
// =============================================================================

describe('discord home channel - failure handling', () => {
  beforeEach(async () => {
    const mod = await modPromise;
    mod.invalidateDiscordHomeChannelCache();
  });

  it('returns null when no channel found and no fallback', async () => {
    const { resolveDiscordHomeChannel } = await modPromise;
    const { deps, logs } = createMockDeps({ queryItems: [] });

    const result = await resolveDiscordHomeChannel(
      { avatarId: 'a1', avatarConfig: makeAvatarConfig() },
      deps
    );

    expect(result).toBeNull();
    expect(logs.some((l) => l.level === 'warn')).toBe(true);
  });

  it('fails closed on DynamoDB error during registry query', async () => {
    const { resolveDiscordHomeChannel } = await modPromise;
    const { deps, logs } = createMockDeps({
      failOnSend: true,
      errorMessage: 'Connection refused',
    });

    const result = await resolveDiscordHomeChannel(
      { avatarId: 'a1', avatarConfig: makeAvatarConfig() },
      deps
    );

    expect(result).toBeNull();
    expect(logs.some((l) => l.level === 'warn' && l.meta?.error === 'Connection refused')).toBe(true);
  });

  it('fails closed on DynamoDB error during bootstrap', async () => {
    const { maybeBootstrapDiscordHomeChannel } = await modPromise;
    const { deps, logs } = createMockDeps({
      failOnSend: true,
      errorMessage: 'Throttled',
    });

    const bootstrapped = await maybeBootstrapDiscordHomeChannel(
      {
        avatarId: 'a1',
        avatarConfig: makeAvatarConfig(),
        channelId: 'ch-001',
        guildId: 'guild-1',
        isMention: true,
      },
      deps
    );

    expect(bootstrapped).toBe(false);
    expect(logs.some((l) => l.level === 'warn' && l.message.includes('Failed to bootstrap'))).toBe(true);
  });
});

// =============================================================================
// Channel avatar IDs query
// =============================================================================

describe('discord home channel - channel avatar queries', () => {
  beforeEach(async () => {
    const mod = await modPromise;
    mod.invalidateDiscordHomeChannelCache();
  });

  it('returns avatar IDs for a specific channel', async () => {
    const { getDiscordChannelAvatarIds } = await modPromise;
    const { deps } = createMockDeps({
      queryItems: [
        {
          sk: 'ch-multi',
          registeredAvatars: [
            { avatarId: 'a1', botUsername: 'Bot1' },
            { avatarId: 'a2', botUsername: 'Bot2' },
          ],
        },
      ],
    });

    const ids = await getDiscordChannelAvatarIds('ch-multi', deps);
    expect(ids).toEqual(['a1', 'a2']);
  });

  it('returns empty array for unknown channel', async () => {
    const { getDiscordChannelAvatarIds } = await modPromise;
    const { deps } = createMockDeps({ queryItems: [] });

    const ids = await getDiscordChannelAvatarIds('ch-unknown', deps);
    expect(ids).toEqual([]);
  });
});
