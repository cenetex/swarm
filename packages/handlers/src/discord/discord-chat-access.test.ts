/**
 * Discord Chat Access Tests
 *
 * Tests covering:
 * - Guild/channel access control (allow, deny)
 * - DM access control via respondInDMs
 * - Misconfiguration paths (disabled, undefined config)
 * - Logging of access decisions
 *
 * @see packages/handlers/src/discord/discord-chat-access.ts
 */
import { describe, it, expect } from 'bun:test';
import {
  isDiscordChatAllowed,
  logAccessDecision,
  type DiscordAccessContext,
  type DiscordAccessResult,
} from './discord-chat-access.js';
import type { DiscordConfig } from '@swarm/core';

function makeGuildCtx(overrides: Partial<DiscordAccessContext> = {}): DiscordAccessContext {
  return {
    channelId: 'channel-1',
    guildId: 'guild-1',
    isDm: false,
    senderId: 'user-1',
    senderUsername: 'testuser',
    ...overrides,
  };
}

function makeDmCtx(overrides: Partial<DiscordAccessContext> = {}): DiscordAccessContext {
  return {
    channelId: 'dm-channel-1',
    guildId: undefined,
    isDm: true,
    senderId: 'user-1',
    senderUsername: 'testuser',
    ...overrides,
  };
}

function makeConfig(overrides: Partial<DiscordConfig> = {}): DiscordConfig {
  return {
    enabled: true,
    mode: 'bot',
    ...overrides,
  };
}

// =============================================================================
// Allow paths
// =============================================================================

describe('discord-chat-access: allow paths', () => {
  it('allows guild messages when no restrictions are configured', () => {
    const result = isDiscordChatAllowed(makeGuildCtx(), makeConfig());
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('allowed');
  });

  it('allows guild messages when guild is in allowedGuilds', () => {
    const result = isDiscordChatAllowed(
      makeGuildCtx({ guildId: 'guild-1' }),
      makeConfig({ allowedGuilds: ['guild-1', 'guild-2'] })
    );
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('allowed');
  });

  it('allows messages when channel is in allowedChannels', () => {
    const result = isDiscordChatAllowed(
      makeGuildCtx({ channelId: 'channel-2' }),
      makeConfig({ allowedChannels: ['channel-2', 'channel-3'] })
    );
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('allowed');
  });

  it('allows messages when both guild and channel match', () => {
    const result = isDiscordChatAllowed(
      makeGuildCtx({ guildId: 'guild-1', channelId: 'channel-1' }),
      makeConfig({ allowedGuilds: ['guild-1'], allowedChannels: ['channel-1'] })
    );
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('allowed');
  });

  it('allows DMs when respondInDMs is true', () => {
    const result = isDiscordChatAllowed(
      makeDmCtx(),
      makeConfig({ respondInDMs: true })
    );
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('dm_allowed');
  });

  it('allows guild messages when sender has an allowed role', () => {
    const result = isDiscordChatAllowed(
      makeGuildCtx({ senderRoleIds: ['role-2', 'role-3'] }),
      makeConfig({ allowedRoleIds: ['role-1', 'role-2'] })
    );
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('allowed');
  });
});

// =============================================================================
// Deny paths
// =============================================================================

describe('discord-chat-access: deny paths', () => {
  it('denies when discord config is undefined', () => {
    const result = isDiscordChatAllowed(makeGuildCtx(), undefined);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('discord_not_enabled');
  });

  it('denies when discord is disabled', () => {
    const result = isDiscordChatAllowed(
      makeGuildCtx(),
      makeConfig({ enabled: false })
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('discord_not_enabled');
  });

  it('denies guild messages when guild is not in allowedGuilds', () => {
    const result = isDiscordChatAllowed(
      makeGuildCtx({ guildId: 'guild-99' }),
      makeConfig({ allowedGuilds: ['guild-1', 'guild-2'] })
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('guild_not_allowed');
  });

  it('denies messages when channel is not in allowedChannels', () => {
    const result = isDiscordChatAllowed(
      makeGuildCtx({ channelId: 'channel-99' }),
      makeConfig({ allowedChannels: ['channel-1', 'channel-2'] })
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('channel_not_allowed');
  });

  it('denies when guild matches but channel does not', () => {
    const result = isDiscordChatAllowed(
      makeGuildCtx({ guildId: 'guild-1', channelId: 'channel-99' }),
      makeConfig({ allowedGuilds: ['guild-1'], allowedChannels: ['channel-1'] })
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('channel_not_allowed');
  });

  it('denies DMs when respondInDMs is false', () => {
    const result = isDiscordChatAllowed(
      makeDmCtx(),
      makeConfig({ respondInDMs: false })
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('dm_not_allowed');
  });

  it('denies DMs when respondInDMs is not set (default deny)', () => {
    const result = isDiscordChatAllowed(
      makeDmCtx(),
      makeConfig()
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('dm_not_allowed');
  });

  it('denies guild messages when no guildId and allowedGuilds is set', () => {
    // Edge case: message has no guild_id but allowedGuilds is configured
    const result = isDiscordChatAllowed(
      makeGuildCtx({ guildId: undefined, isDm: false }),
      makeConfig({ allowedGuilds: ['guild-1'] })
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('guild_not_allowed');
  });

  it('denies guild messages when sender lacks an allowed role', () => {
    const result = isDiscordChatAllowed(
      makeGuildCtx({ senderRoleIds: ['role-3'] }),
      makeConfig({ allowedRoleIds: ['role-1', 'role-2'] })
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('role_not_allowed');
  });

  it('denies guild messages when role gating is configured but sender roles are missing', () => {
    const result = isDiscordChatAllowed(
      makeGuildCtx({ senderRoleIds: undefined }),
      makeConfig({ allowedRoleIds: ['role-1'] })
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('role_not_allowed');
  });
});

// =============================================================================
// Misconfiguration paths
// =============================================================================

describe('discord-chat-access: misconfiguration paths', () => {
  it('allows guild messages when allowedGuilds is empty array', () => {
    const result = isDiscordChatAllowed(
      makeGuildCtx(),
      makeConfig({ allowedGuilds: [] })
    );
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('allowed');
  });

  it('allows guild messages when allowedChannels is empty array', () => {
    const result = isDiscordChatAllowed(
      makeGuildCtx(),
      makeConfig({ allowedChannels: [] })
    );
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('allowed');
  });

  it('handles config with all optional fields undefined', () => {
    const result = isDiscordChatAllowed(
      makeGuildCtx(),
      makeConfig({
        allowedGuilds: undefined,
        allowedChannels: undefined,
        allowedRoleIds: undefined,
        respondInDMs: undefined,
      })
    );
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('allowed');
  });
});

// =============================================================================
// Logging
// =============================================================================

describe('discord-chat-access: logAccessDecision', () => {
  it('does not throw when logging allowed decisions', () => {
    const ctx = makeGuildCtx();
    const result: DiscordAccessResult = { allowed: true, reason: 'allowed' };
    expect(() => logAccessDecision('avatar-1', ctx, result)).not.toThrow();
  });

  it('does not throw when logging denied decisions', () => {
    const ctx = makeDmCtx();
    const result: DiscordAccessResult = { allowed: false, reason: 'dm_not_allowed' };
    expect(() => logAccessDecision('avatar-1', ctx, result)).not.toThrow();
  });
});
