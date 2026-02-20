/**
 * Discord Gateway Utilities Tests
 *
 * Tests for intent validation, close code interpretation,
 * reconnect delay computation, and structured logging helpers.
 *
 * @see packages/core/src/platforms/discord-gateway-utils.ts
 */
import { describe, it, expect } from 'bun:test';
import {
  DiscordIntent,
  REQUIRED_BOT_INTENTS,
  RECOMMENDED_BOT_INTENTS,
  validateIntents,
  interpretCloseCode,
  computeReconnectDelay,
} from './discord-gateway-utils.js';

// ---------------------------------------------------------------------------
// Intent bit values
// ---------------------------------------------------------------------------

describe('DiscordIntent constants', () => {
  it('should define GUILDS as bit 0', () => {
    expect(DiscordIntent.GUILDS).toBe(1 << 0);
  });

  it('should define GUILD_MESSAGES as bit 9', () => {
    expect(DiscordIntent.GUILD_MESSAGES).toBe(1 << 9);
  });

  it('should define MESSAGE_CONTENT as bit 15', () => {
    expect(DiscordIntent.MESSAGE_CONTENT).toBe(1 << 15);
  });

  it('should define DIRECT_MESSAGES as bit 12', () => {
    expect(DiscordIntent.DIRECT_MESSAGES).toBe(1 << 12);
  });

  it('should define GUILD_MEMBERS as bit 1 (privileged)', () => {
    expect(DiscordIntent.GUILD_MEMBERS).toBe(1 << 1);
  });

  it('should define GUILD_PRESENCES as bit 8 (privileged)', () => {
    expect(DiscordIntent.GUILD_PRESENCES).toBe(1 << 8);
  });
});

describe('REQUIRED_BOT_INTENTS', () => {
  it('should include GUILDS, GUILD_MESSAGES, and MESSAGE_CONTENT', () => {
    expect(REQUIRED_BOT_INTENTS).toContain(DiscordIntent.GUILDS);
    expect(REQUIRED_BOT_INTENTS).toContain(DiscordIntent.GUILD_MESSAGES);
    expect(REQUIRED_BOT_INTENTS).toContain(DiscordIntent.MESSAGE_CONTENT);
  });

  it('should have exactly 3 required intents', () => {
    expect(REQUIRED_BOT_INTENTS.length).toBe(3);
  });
});

describe('RECOMMENDED_BOT_INTENTS', () => {
  it('should include all required intents plus DIRECT_MESSAGES', () => {
    for (const req of REQUIRED_BOT_INTENTS) {
      expect(RECOMMENDED_BOT_INTENTS).toContain(req);
    }
    expect(RECOMMENDED_BOT_INTENTS).toContain(DiscordIntent.DIRECT_MESSAGES);
  });
});

// ---------------------------------------------------------------------------
// validateIntents
// ---------------------------------------------------------------------------

describe('validateIntents', () => {
  it('should pass when all required intents are present', () => {
    const intents =
      DiscordIntent.GUILDS |
      DiscordIntent.GUILD_MESSAGES |
      DiscordIntent.MESSAGE_CONTENT;

    const result = validateIntents(intents);

    expect(result.valid).toBe(true);
    expect(result.missingRequired).toHaveLength(0);
  });

  it('should pass with all recommended intents', () => {
    const intents =
      DiscordIntent.GUILDS |
      DiscordIntent.GUILD_MESSAGES |
      DiscordIntent.MESSAGE_CONTENT |
      DiscordIntent.DIRECT_MESSAGES;

    const result = validateIntents(intents);

    expect(result.valid).toBe(true);
    expect(result.missingRequired).toHaveLength(0);
    expect(result.missingRecommended).toHaveLength(0);
  });

  it('should report success message when all intents are present', () => {
    const intents =
      DiscordIntent.GUILDS |
      DiscordIntent.GUILD_MESSAGES |
      DiscordIntent.MESSAGE_CONTENT |
      DiscordIntent.DIRECT_MESSAGES;

    const result = validateIntents(intents);

    expect(result.diagnostics.some(d => d.includes('All required and recommended'))).toBe(true);
  });

  it('should fail when GUILDS intent is missing', () => {
    const intents = DiscordIntent.GUILD_MESSAGES | DiscordIntent.MESSAGE_CONTENT;

    const result = validateIntents(intents);

    expect(result.valid).toBe(false);
    expect(result.missingRequired).toContain('GUILDS');
  });

  it('should fail when GUILD_MESSAGES intent is missing', () => {
    const intents = DiscordIntent.GUILDS | DiscordIntent.MESSAGE_CONTENT;

    const result = validateIntents(intents);

    expect(result.valid).toBe(false);
    expect(result.missingRequired).toContain('GUILD_MESSAGES');
  });

  it('should fail when MESSAGE_CONTENT intent is missing', () => {
    const intents = DiscordIntent.GUILDS | DiscordIntent.GUILD_MESSAGES;

    const result = validateIntents(intents);

    expect(result.valid).toBe(false);
    expect(result.missingRequired.some(m => m.includes('MESSAGE_CONTENT'))).toBe(true);
  });

  it('should fail with all required intents missing when intents is 0', () => {
    const result = validateIntents(0);

    expect(result.valid).toBe(false);
    expect(result.missingRequired.length).toBe(3);
  });

  it('should warn about missing DIRECT_MESSAGES when only required intents present', () => {
    const intents =
      DiscordIntent.GUILDS |
      DiscordIntent.GUILD_MESSAGES |
      DiscordIntent.MESSAGE_CONTENT;

    const result = validateIntents(intents);

    expect(result.valid).toBe(true);
    expect(result.missingRecommended).toContain('DIRECT_MESSAGES');
  });

  it('should list enabled intents correctly', () => {
    const intents =
      DiscordIntent.GUILDS |
      DiscordIntent.GUILD_MESSAGES |
      DiscordIntent.MESSAGE_CONTENT;

    const result = validateIntents(intents);

    expect(result.enabledIntents).toContain('GUILDS');
    expect(result.enabledIntents).toContain('GUILD_MESSAGES');
    expect(result.enabledIntents.some(e => e.includes('MESSAGE_CONTENT'))).toBe(true);
    // DIRECT_MESSAGES should NOT be in enabled list
    expect(result.enabledIntents).not.toContain('DIRECT_MESSAGES');
  });

  it('should include remediation steps when required intents are missing', () => {
    const result = validateIntents(0);

    expect(result.diagnostics.some(d => d.includes('[CRITICAL]'))).toBe(true);
    expect(result.diagnostics.some(d => d.includes('REMEDIATION'))).toBe(true);
    expect(result.diagnostics.some(d => d.includes('discord.com/developers/applications'))).toBe(true);
  });

  it('should include warning for missing recommended intents', () => {
    const intents =
      DiscordIntent.GUILDS |
      DiscordIntent.GUILD_MESSAGES |
      DiscordIntent.MESSAGE_CONTENT;

    const result = validateIntents(intents);

    expect(result.diagnostics.some(d => d.includes('[WARNING]'))).toBe(true);
  });

  it('should handle extra intents without error', () => {
    const intents =
      DiscordIntent.GUILDS |
      DiscordIntent.GUILD_MESSAGES |
      DiscordIntent.MESSAGE_CONTENT |
      DiscordIntent.GUILD_MEMBERS |
      DiscordIntent.GUILD_PRESENCES |
      DiscordIntent.DIRECT_MESSAGES;

    const result = validateIntents(intents);

    expect(result.valid).toBe(true);
    expect(result.missingRequired).toHaveLength(0);
    expect(result.missingRecommended).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// interpretCloseCode
// ---------------------------------------------------------------------------

describe('interpretCloseCode', () => {
  describe('known close codes', () => {
    it('should interpret 1000 as normal closure (reconnectable)', () => {
      const info = interpretCloseCode(1000);
      expect(info.code).toBe(1000);
      expect(info.description).toBe('Normal closure');
      expect(info.reconnectable).toBe(true);
      expect(info.severity).toBe('info');
    });

    it('should interpret 1001 as going away (reconnectable)', () => {
      const info = interpretCloseCode(1001);
      expect(info.reconnectable).toBe(true);
      expect(info.severity).toBe('info');
    });

    it('should interpret 1006 as abnormal closure (reconnectable)', () => {
      const info = interpretCloseCode(1006);
      expect(info.reconnectable).toBe(true);
      expect(info.severity).toBe('warn');
    });

    it('should interpret 4000 as unknown error (reconnectable)', () => {
      const info = interpretCloseCode(4000);
      expect(info.reconnectable).toBe(true);
      expect(info.severity).toBe('warn');
    });

    it('should interpret 4001 as unknown opcode (reconnectable)', () => {
      const info = interpretCloseCode(4001);
      expect(info.reconnectable).toBe(true);
      expect(info.description).toBe('Unknown opcode');
    });

    it('should interpret 4003 as not authenticated (reconnectable)', () => {
      const info = interpretCloseCode(4003);
      expect(info.reconnectable).toBe(true);
      expect(info.severity).toBe('error');
    });

    it('should interpret 4004 as authentication failed (NOT reconnectable)', () => {
      const info = interpretCloseCode(4004);
      expect(info.code).toBe(4004);
      expect(info.description).toBe('Authentication failed');
      expect(info.reconnectable).toBe(false);
      expect(info.severity).toBe('error');
      expect(info.remediation).toContain('INVALID BOT TOKEN');
    });

    it('should interpret 4007 as invalid sequence (reconnectable)', () => {
      const info = interpretCloseCode(4007);
      expect(info.reconnectable).toBe(true);
      expect(info.description).toBe('Invalid sequence');
    });

    it('should interpret 4008 as rate limited (reconnectable)', () => {
      const info = interpretCloseCode(4008);
      expect(info.reconnectable).toBe(true);
      expect(info.description).toBe('Rate limited');
    });

    it('should interpret 4009 as session timed out (reconnectable)', () => {
      const info = interpretCloseCode(4009);
      expect(info.reconnectable).toBe(true);
      expect(info.severity).toBe('info');
    });

    it('should interpret 4010 as invalid shard (NOT reconnectable)', () => {
      const info = interpretCloseCode(4010);
      expect(info.reconnectable).toBe(false);
      expect(info.severity).toBe('error');
    });

    it('should interpret 4011 as sharding required (NOT reconnectable)', () => {
      const info = interpretCloseCode(4011);
      expect(info.reconnectable).toBe(false);
      expect(info.severity).toBe('error');
      expect(info.remediation).toContain('sharding');
    });

    it('should interpret 4012 as invalid API version (NOT reconnectable)', () => {
      const info = interpretCloseCode(4012);
      expect(info.reconnectable).toBe(false);
      expect(info.severity).toBe('error');
    });

    it('should interpret 4013 as invalid intents (NOT reconnectable)', () => {
      const info = interpretCloseCode(4013);
      expect(info.reconnectable).toBe(false);
      expect(info.severity).toBe('error');
    });

    it('should interpret 4014 as disallowed intents (NOT reconnectable)', () => {
      const info = interpretCloseCode(4014);
      expect(info.code).toBe(4014);
      expect(info.description).toBe('Disallowed intents');
      expect(info.reconnectable).toBe(false);
      expect(info.severity).toBe('error');
      expect(info.remediation).toContain('PRIVILEGED INTENT NOT ENABLED');
    });
  });

  describe('unknown close codes', () => {
    it('should handle unknown standard WebSocket code as reconnectable', () => {
      const info = interpretCloseCode(1005);
      expect(info.reconnectable).toBe(true);
      expect(info.description).toContain('Unknown close code');
      expect(info.severity).toBe('warn');
    });

    it('should handle unknown Discord code (>=4000) as not reconnectable', () => {
      const info = interpretCloseCode(4999);
      expect(info.reconnectable).toBe(false);
      expect(info.description).toContain('Unknown close code');
    });

    it('should include the code number in the description', () => {
      const info = interpretCloseCode(9999);
      expect(info.description).toContain('9999');
    });
  });
});

// ---------------------------------------------------------------------------
// computeReconnectDelay
// ---------------------------------------------------------------------------

describe('computeReconnectDelay', () => {
  it('should return -1 for non-reconnectable close codes', () => {
    expect(computeReconnectDelay(4004, 0)).toBe(-1);
    expect(computeReconnectDelay(4010, 0)).toBe(-1);
    expect(computeReconnectDelay(4011, 0)).toBe(-1);
    expect(computeReconnectDelay(4013, 0)).toBe(-1);
    expect(computeReconnectDelay(4014, 0)).toBe(-1);
  });

  it('should return positive delay for reconnectable codes', () => {
    const delay = computeReconnectDelay(1000, 0);
    expect(delay).toBeGreaterThan(0);
  });

  it('should increase delay with attempt number (exponential backoff)', () => {
    // Use fixed base delay and disable jitter by computing range bounds
    const delay0 = computeReconnectDelay(1000, 0, { baseDelayMs: 1000, maxDelayMs: 30000 });
    const delay1 = computeReconnectDelay(1000, 1, { baseDelayMs: 1000, maxDelayMs: 30000 });
    const delay2 = computeReconnectDelay(1000, 2, { baseDelayMs: 1000, maxDelayMs: 30000 });

    // Each subsequent delay should be at least as large as the previous base
    // delay0 base = 1000, delay1 base = 2000, delay2 base = 4000
    // With up to 30% jitter, delay0 is in [1000, 1300], delay1 in [2000, 2600]
    expect(delay0).toBeGreaterThanOrEqual(1000);
    expect(delay0).toBeLessThanOrEqual(1300);
    expect(delay1).toBeGreaterThanOrEqual(2000);
    expect(delay1).toBeLessThanOrEqual(2600);
    expect(delay2).toBeGreaterThanOrEqual(4000);
    expect(delay2).toBeLessThanOrEqual(5200);
  });

  it('should cap delay at maxDelayMs', () => {
    const delay = computeReconnectDelay(1000, 100, {
      baseDelayMs: 1000,
      maxDelayMs: 5000,
    });

    // Should not exceed maxDelayMs + 30% jitter
    expect(delay).toBeLessThanOrEqual(5000 * 1.3 + 1);
  });

  it('should use default base delay of 1000ms', () => {
    const delay = computeReconnectDelay(1000, 0);
    // Base delay of 1000 with up to 30% jitter = [1000, 1300]
    expect(delay).toBeGreaterThanOrEqual(1000);
    expect(delay).toBeLessThanOrEqual(1300);
  });

  it('should use default max delay of 30000ms', () => {
    const delay = computeReconnectDelay(1000, 20);
    // Should not exceed 30000 + 30% jitter = 39000
    expect(delay).toBeLessThanOrEqual(39001);
  });

  it('should handle attempt 0 correctly', () => {
    const delay = computeReconnectDelay(4009, 0, {
      baseDelayMs: 500,
      maxDelayMs: 10000,
    });
    // base * 2^0 = 500, with jitter: [500, 650]
    expect(delay).toBeGreaterThanOrEqual(500);
    expect(delay).toBeLessThanOrEqual(650);
  });

  it('should handle all reconnectable Discord codes', () => {
    const reconnectableCodes = [1000, 1001, 1006, 4000, 4001, 4002, 4003, 4005, 4007, 4008, 4009];
    for (const code of reconnectableCodes) {
      const delay = computeReconnectDelay(code, 0);
      expect(delay).toBeGreaterThan(0);
    }
  });
});
