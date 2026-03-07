/**
 * Proactive Participation Scheduler Tests
 *
 * Covers quiet-room, busy-room, bot-heavy-room, budget, silence-window,
 * disabled config, and bot-to-bot continuation scenarios.
 */
import { describe, it, expect } from 'bun:test';
import {
  evaluateProactive,
  calculateBotDensity,
  DEFAULT_PROACTIVE_CONFIG,
} from './proactive-scheduler.js';
import type { SharedRoomMessage, AvatarRoomOverlay } from '../types/shared-room.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000; // fixed "now" for determinism

function makeMsg(
  overrides: Partial<SharedRoomMessage> & { timestamp: number },
): SharedRoomMessage {
  return {
    roomId: 'room-1',
    senderId: 'user-1',
    senderType: 'human',
    platform: 'telegram',
    content: 'hello',
    messageId: `msg-${overrides.timestamp}`,
    ...overrides,
  };
}

function makeOverlay(
  overrides?: Partial<AvatarRoomOverlay>,
): AvatarRoomOverlay {
  return {
    avatarId: 'avatar-1',
    roomId: 'room-1',
    lastParticipatedAt: NOW - 120_000,
    messagesSinceLastReply: 5,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('proactive-scheduler', () => {
  describe('calculateBotDensity', () => {
    it('returns 0 for empty messages', () => {
      expect(calculateBotDensity([])).toBe(0);
    });

    it('returns 0 when all messages are human', () => {
      const msgs = [
        makeMsg({ timestamp: NOW - 5000 }),
        makeMsg({ timestamp: NOW - 4000 }),
      ];
      expect(calculateBotDensity(msgs)).toBe(0);
    });

    it('returns 1 when all messages are avatar', () => {
      const msgs = [
        makeMsg({ timestamp: NOW - 5000, senderType: 'avatar', senderId: 'bot-1' }),
        makeMsg({ timestamp: NOW - 4000, senderType: 'avatar', senderId: 'bot-2' }),
      ];
      expect(calculateBotDensity(msgs)).toBe(1);
    });

    it('returns correct ratio for mixed messages', () => {
      const msgs = [
        makeMsg({ timestamp: NOW - 5000, senderType: 'human' }),
        makeMsg({ timestamp: NOW - 4000, senderType: 'avatar', senderId: 'bot-1' }),
        makeMsg({ timestamp: NOW - 3000, senderType: 'human' }),
        makeMsg({ timestamp: NOW - 2000, senderType: 'avatar', senderId: 'bot-2' }),
      ];
      expect(calculateBotDensity(msgs)).toBe(0.5);
    });
  });

  describe('evaluateProactive', () => {
    it('returns disabled when config.enabled is false', () => {
      const result = evaluateProactive(
        'room-1',
        'avatar-1',
        { enabled: false },
        [],
        null,
        NOW,
      );
      expect(result.shouldSpeak).toBe(false);
      expect(result.reason).toBe('disabled');
      expect(result.avatarId).toBe('avatar-1');
    });

    it('quiet room (no recent messages, past silence window) is eligible', () => {
      const result = evaluateProactive(
        'room-1',
        'avatar-1',
        undefined,
        [],
        null,
        NOW,
      );
      expect(result.shouldSpeak).toBe(true);
      expect(result.reason).toBe('eligible');
      expect(result.delayMs).toBe(0);
    });

    it('suppresses when silence window has not elapsed', () => {
      // Last message was 30s ago, default silence window is 60s
      const msgs = [makeMsg({ timestamp: NOW - 30_000 })];
      const result = evaluateProactive(
        'room-1',
        'avatar-1',
        undefined,
        msgs,
        null,
        NOW,
      );
      expect(result.shouldSpeak).toBe(false);
      expect(result.reason).toBe('silence-window');
    });

    it('allows when silence window has elapsed', () => {
      // Last message was 90s ago, default silence window is 60s
      const msgs = [makeMsg({ timestamp: NOW - 90_000 })];
      const result = evaluateProactive(
        'room-1',
        'avatar-1',
        undefined,
        msgs,
        null,
        NOW,
      );
      expect(result.shouldSpeak).toBe(true);
      expect(result.reason).toBe('eligible');
    });

    it('suppresses when bot density exceeds threshold', () => {
      // 3 bot messages, 1 human = 75% density, threshold is 50%
      const msgs = [
        makeMsg({ timestamp: NOW - 300_000, senderType: 'avatar', senderId: 'bot-1' }),
        makeMsg({ timestamp: NOW - 250_000, senderType: 'avatar', senderId: 'bot-2' }),
        makeMsg({ timestamp: NOW - 200_000, senderType: 'human' }),
        makeMsg({ timestamp: NOW - 150_000, senderType: 'avatar', senderId: 'bot-3' }),
      ];
      const result = evaluateProactive(
        'room-1',
        'avatar-1',
        undefined,
        msgs,
        null,
        NOW,
      );
      expect(result.shouldSpeak).toBe(false);
      expect(result.reason).toBe('bot-density-high');
    });

    it('allows when bot density is at threshold (boundary: not exceeded)', () => {
      // 1 bot, 1 human = 50% density, threshold is 50% (not exceeded, equal)
      const msgs = [
        makeMsg({ timestamp: NOW - 300_000, senderType: 'avatar', senderId: 'bot-1' }),
        makeMsg({ timestamp: NOW - 200_000, senderType: 'human' }),
      ];
      const result = evaluateProactive(
        'room-1',
        'avatar-1',
        undefined,
        msgs,
        null,
        NOW,
      );
      expect(result.shouldSpeak).toBe(true);
      expect(result.reason).toBe('eligible');
    });

    it('suppresses when room budget is exceeded', () => {
      // 4 avatar messages in the last hour = budget of 4 hit
      const msgs = [
        makeMsg({ timestamp: NOW - 300_000, senderType: 'avatar', senderId: 'bot-1' }),
        makeMsg({ timestamp: NOW - 250_000, senderType: 'human' }),
        makeMsg({ timestamp: NOW - 200_000, senderType: 'avatar', senderId: 'bot-2' }),
        makeMsg({ timestamp: NOW - 180_000, senderType: 'human' }),
        makeMsg({ timestamp: NOW - 150_000, senderType: 'avatar', senderId: 'bot-1' }),
        makeMsg({ timestamp: NOW - 130_000, senderType: 'human' }),
        makeMsg({ timestamp: NOW - 100_000, senderType: 'avatar', senderId: 'bot-2' }),
        makeMsg({ timestamp: NOW - 80_000, senderType: 'human' }),
      ];
      const result = evaluateProactive(
        'room-1',
        'avatar-1',
        { maxProactivePerHour: 4 },
        msgs,
        null,
        NOW,
      );
      expect(result.shouldSpeak).toBe(false);
      expect(result.reason).toBe('budget-exceeded');
    });

    it('allows busy room when budget still available', () => {
      // Many messages but only 2 avatar messages in last hour
      const msgs = [
        makeMsg({ timestamp: NOW - 300_000, senderType: 'avatar', senderId: 'bot-1' }),
        makeMsg({ timestamp: NOW - 250_000, senderType: 'human' }),
        makeMsg({ timestamp: NOW - 200_000, senderType: 'human' }),
        makeMsg({ timestamp: NOW - 150_000, senderType: 'avatar', senderId: 'bot-2' }),
        makeMsg({ timestamp: NOW - 120_000, senderType: 'human' }),
        makeMsg({ timestamp: NOW - 100_000, senderType: 'human' }),
        makeMsg({ timestamp: NOW - 80_000, senderType: 'human' }),
      ];
      const result = evaluateProactive(
        'room-1',
        'avatar-1',
        { maxProactivePerHour: 4 },
        msgs,
        null,
        NOW,
      );
      expect(result.shouldSpeak).toBe(true);
      expect(result.reason).toBe('eligible');
    });

    it('suppresses when avatar is on cooldown', () => {
      const overlay = makeOverlay({ cooldownUntil: NOW + 60_000 });
      const result = evaluateProactive(
        'room-1',
        'avatar-1',
        undefined,
        [],
        overlay,
        NOW,
      );
      expect(result.shouldSpeak).toBe(false);
      expect(result.reason).toBe('cooldown');
    });

    it('allows when cooldown has expired', () => {
      const overlay = makeOverlay({ cooldownUntil: NOW - 1000 });
      const result = evaluateProactive(
        'room-1',
        'avatar-1',
        undefined,
        [],
        overlay,
        NOW,
      );
      expect(result.shouldSpeak).toBe(true);
      expect(result.reason).toBe('eligible');
    });

    it('applies extra delay when last message was from an avatar (bot-to-bot)', () => {
      // Last message from avatar, silence window passed, density at threshold (50%)
      const msgs = [
        makeMsg({ timestamp: NOW - 120_000, senderType: 'human' }),
        makeMsg({ timestamp: NOW - 90_000, senderType: 'avatar', senderId: 'bot-1' }),
      ];
      const result = evaluateProactive(
        'room-1',
        'avatar-1',
        undefined,
        msgs,
        null,
        NOW,
      );
      expect(result.shouldSpeak).toBe(true);
      expect(result.reason).toBe('eligible');
      expect(result.delayMs).toBe(DEFAULT_PROACTIVE_CONFIG.botToBotDelayMs);
    });

    it('no extra delay when last message was from a human', () => {
      const msgs = [
        makeMsg({ timestamp: NOW - 90_000, senderType: 'human' }),
      ];
      const result = evaluateProactive(
        'room-1',
        'avatar-1',
        undefined,
        msgs,
        null,
        NOW,
      );
      expect(result.shouldSpeak).toBe(true);
      expect(result.reason).toBe('eligible');
      expect(result.delayMs).toBe(0);
    });

    it('suppresses when bot-to-bot budget is exceeded', () => {
      // 2 bot-to-bot continuations already in last hour (at default budget of 2)
      // Keep density at 50% to pass density check, but have consecutive avatar pairs
      const msgs = [
        makeMsg({ timestamp: NOW - 500_000, senderType: 'human' }),
        makeMsg({ timestamp: NOW - 450_000, senderType: 'human' }),
        makeMsg({ timestamp: NOW - 400_000, senderType: 'avatar', senderId: 'bot-1' }),
        makeMsg({ timestamp: NOW - 350_000, senderType: 'avatar', senderId: 'bot-2' }),
        makeMsg({ timestamp: NOW - 300_000, senderType: 'human' }),
        makeMsg({ timestamp: NOW - 250_000, senderType: 'avatar', senderId: 'bot-1' }),
        makeMsg({ timestamp: NOW - 200_000, senderType: 'avatar', senderId: 'bot-2' }),
        makeMsg({ timestamp: NOW - 150_000, senderType: 'human' }),
      ];
      const result = evaluateProactive(
        'room-1',
        'avatar-1',
        { botToBotBudgetPerHour: 2 },
        msgs,
        null,
        NOW,
      );
      expect(result.shouldSpeak).toBe(false);
      expect(result.reason).toBe('budget-exceeded');
    });

    it('uses default config when no overrides provided', () => {
      const result = evaluateProactive('room-1', 'avatar-1', undefined, [], null, NOW);
      expect(result.shouldSpeak).toBe(true);
      expect(result.reason).toBe('eligible');
    });

    it('merges partial config with defaults', () => {
      // Override only silenceWindowMs, rest should be defaults
      const msgs = [makeMsg({ timestamp: NOW - 5_000 })];
      const result = evaluateProactive(
        'room-1',
        'avatar-1',
        { silenceWindowMs: 3_000 },
        msgs,
        null,
        NOW,
      );
      // 5s > 3s custom silence window, should be eligible
      expect(result.shouldSpeak).toBe(true);
      expect(result.reason).toBe('eligible');
    });
  });
});
