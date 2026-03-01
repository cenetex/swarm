/**
 * Discord Intent & Permission Validation Tests
 *
 * Tests for the bot configuration validation added in #661:
 * - checkPrivilegedIntents: validates application flags for privileged intents
 * - checkGuildPermissions: validates bot permissions in guilds
 * - checkBotIntentsAndPermissions: integration test for the full validation flow
 */
import { describe, it, expect } from 'vitest';
import {
  DiscordApplicationFlag,
  checkPrivilegedIntents,
  checkGuildPermissions,
  type DiscordBotWarning,
} from './discord-bot-validation.js';

// =============================================================================
// checkPrivilegedIntents
// =============================================================================

describe('checkPrivilegedIntents', () => {
  it('returns no warnings when all privileged intents are enabled (full flags)', () => {
    const flags =
      DiscordApplicationFlag.GATEWAY_MESSAGE_CONTENT |
      DiscordApplicationFlag.GATEWAY_GUILD_MEMBERS |
      DiscordApplicationFlag.GATEWAY_PRESENCE;

    const warnings = checkPrivilegedIntents(flags);
    expect(warnings).toHaveLength(0);
  });

  it('returns no warnings when all privileged intents are enabled (limited flags)', () => {
    const flags =
      DiscordApplicationFlag.GATEWAY_MESSAGE_CONTENT_LIMITED |
      DiscordApplicationFlag.GATEWAY_GUILD_MEMBERS_LIMITED |
      DiscordApplicationFlag.GATEWAY_PRESENCE_LIMITED;

    const warnings = checkPrivilegedIntents(flags);
    expect(warnings).toHaveLength(0);
  });

  it('returns no warnings with mixed full and limited flags', () => {
    const flags =
      DiscordApplicationFlag.GATEWAY_MESSAGE_CONTENT |
      DiscordApplicationFlag.GATEWAY_GUILD_MEMBERS_LIMITED |
      DiscordApplicationFlag.GATEWAY_PRESENCE;

    const warnings = checkPrivilegedIntents(flags);
    expect(warnings).toHaveLength(0);
  });

  it('returns error for missing Message Content Intent', () => {
    // Has members + presence but NOT message content
    const flags =
      DiscordApplicationFlag.GATEWAY_GUILD_MEMBERS |
      DiscordApplicationFlag.GATEWAY_PRESENCE;

    const warnings = checkPrivilegedIntents(flags);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].severity).toBe('error');
    expect(warnings[0].code).toBe('missing_intent_message_content_intent');
    expect(warnings[0].message).toContain('Message Content Intent');
    expect(warnings[0].message).toContain('REQUIRED');
    expect(warnings[0].message).toContain('discord.com/developers/applications');
  });

  it('returns warning for missing Server Members Intent', () => {
    // Has message content + presence but NOT members
    const flags =
      DiscordApplicationFlag.GATEWAY_MESSAGE_CONTENT |
      DiscordApplicationFlag.GATEWAY_PRESENCE;

    const warnings = checkPrivilegedIntents(flags);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].severity).toBe('warning');
    expect(warnings[0].code).toBe('missing_intent_server_members_intent');
    expect(warnings[0].message).toContain('Server Members Intent');
    expect(warnings[0].message).not.toContain('REQUIRED');
  });

  it('returns warning for missing Presence Intent', () => {
    // Has message content + members but NOT presence
    const flags =
      DiscordApplicationFlag.GATEWAY_MESSAGE_CONTENT |
      DiscordApplicationFlag.GATEWAY_GUILD_MEMBERS;

    const warnings = checkPrivilegedIntents(flags);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].severity).toBe('warning');
    expect(warnings[0].code).toBe('missing_intent_presence_intent');
    expect(warnings[0].message).toContain('Presence Intent');
  });

  it('returns all three warnings when no privileged intents are enabled', () => {
    const warnings = checkPrivilegedIntents(0);
    expect(warnings).toHaveLength(3);

    const codes = warnings.map((w: DiscordBotWarning) => w.code);
    expect(codes).toContain('missing_intent_message_content_intent');
    expect(codes).toContain('missing_intent_server_members_intent');
    expect(codes).toContain('missing_intent_presence_intent');

    // Message Content is required (error), others are warnings
    const messageContent = warnings.find((w: DiscordBotWarning) => w.code === 'missing_intent_message_content_intent');
    expect(messageContent?.severity).toBe('error');

    const members = warnings.find((w: DiscordBotWarning) => w.code === 'missing_intent_server_members_intent');
    expect(members?.severity).toBe('warning');

    const presence = warnings.find((w: DiscordBotWarning) => w.code === 'missing_intent_presence_intent');
    expect(presence?.severity).toBe('warning');
  });

  it('ignores non-privileged flags', () => {
    // Random flags that are not privileged intent flags
    const flags = (1 << 0) | (1 << 1) | (1 << 2);
    const warnings = checkPrivilegedIntents(flags);
    expect(warnings).toHaveLength(3); // All three privileged intents are missing
  });
});

// =============================================================================
// checkGuildPermissions
// =============================================================================

describe('checkGuildPermissions', () => {
  // Permission bits as strings (BigInt)
  const VIEW_CHANNEL = BigInt(1) << BigInt(10);
  const SEND_MESSAGES = BigInt(1) << BigInt(11);
  const EMBED_LINKS = BigInt(1) << BigInt(14);
  const ATTACH_FILES = BigInt(1) << BigInt(15);
  const READ_MESSAGE_HISTORY = BigInt(1) << BigInt(16);
  const USE_EXTERNAL_EMOJIS = BigInt(1) << BigInt(18);
  const ADMINISTRATOR = BigInt(1) << BigInt(3);

  it('returns no warnings when bot has all required and recommended permissions', () => {
    const perms = VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY |
      EMBED_LINKS | ATTACH_FILES | USE_EXTERNAL_EMOJIS;

    const warnings = checkGuildPermissions([
      { id: '123', name: 'Test Server', permissions: perms.toString() },
    ]);

    expect(warnings).toHaveLength(0);
  });

  it('returns no warnings when bot has Administrator permission', () => {
    const warnings = checkGuildPermissions([
      { id: '123', name: 'Test Server', permissions: ADMINISTRATOR.toString() },
    ]);

    expect(warnings).toHaveLength(0);
  });

  it('returns error when bot is missing required permissions', () => {
    // Has view channel but missing send messages and read history
    const perms = VIEW_CHANNEL;

    const warnings = checkGuildPermissions([
      { id: '123', name: 'Test Server', permissions: perms.toString() },
    ]);

    const errors = warnings.filter((w: DiscordBotWarning) => w.severity === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('missing_guild_permissions');
    expect(errors[0].message).toContain('Test Server');
    expect(errors[0].message).toContain('SEND MESSAGES');
    expect(errors[0].message).toContain('READ MESSAGE HISTORY');
  });

  it('returns warning when bot is missing only recommended permissions', () => {
    // Has all required but missing recommended
    const perms = VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY;

    const warnings = checkGuildPermissions([
      { id: '123', name: 'Test Server', permissions: perms.toString() },
    ]);

    const warningsList = warnings.filter((w: DiscordBotWarning) => w.severity === 'warning');
    expect(warningsList).toHaveLength(1);
    expect(warningsList[0].code).toBe('missing_recommended_permissions');
    expect(warningsList[0].message).toContain('Test Server');
    expect(warningsList[0].message).toContain('EMBED LINKS');
  });

  it('does not emit recommended warning when required permissions are also missing', () => {
    // Missing everything — only error-severity warning should appear
    const warnings = checkGuildPermissions([
      { id: '123', name: 'Test Server', permissions: '0' },
    ]);

    // Should have error for missing required, but NOT warning for missing recommended
    expect(warnings).toHaveLength(1);
    expect(warnings[0].severity).toBe('error');
    expect(warnings[0].code).toBe('missing_guild_permissions');
  });

  it('checks permissions per guild independently', () => {
    const goodPerms = VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY |
      EMBED_LINKS | ATTACH_FILES | USE_EXTERNAL_EMOJIS;

    const warnings = checkGuildPermissions([
      { id: '111', name: 'Good Server', permissions: goodPerms.toString() },
      { id: '222', name: 'Bad Server', permissions: '0' },
    ]);

    // Should only have warnings for Bad Server
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('Bad Server');
    expect(warnings[0].message).not.toContain('Good Server');
  });

  it('returns empty warnings for empty guild list', () => {
    const warnings = checkGuildPermissions([]);
    expect(warnings).toHaveLength(0);
  });
});
