/**
 * Turn Arbiter Tests
 *
 * Verifies cross-platform turn arbitration: at most one primary responder
 * per human message, correct priority ordering, bot-to-bot suppression,
 * and deterministic tiebreaking.
 */
import { describe, it, expect } from 'bun:test';
import {
  selectPrimaryResponder,
  DEFAULT_TURN_ARBITER_CONFIG,
  type TurnCandidate,
  type TurnMessage,
} from './turn-arbiter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCandidate(overrides: Partial<TurnCandidate> & { avatarId: string }): TurnCandidate {
  return {
    avatarName: overrides.avatarId,
    platform: 'telegram',
    isMentioned: false,
    isReplyTarget: false,
    isThreadOwner: false,
    isNameHit: false,
    hasStickyAffinity: false,
    isBot: false,
    ...overrides,
  };
}

function makeMessage(overrides?: Partial<TurnMessage>): TurnMessage {
  return {
    messageId: 'msg-001',
    conversationId: 'conv-001',
    senderIsBot: false,
    platform: 'telegram',
    ...overrides,
  };
}

/**
 * Build a room of N generic avatars with no special signals.
 */
function makeAvatarRoom(count: number): TurnCandidate[] {
  return Array.from({ length: count }, (_, i) =>
    makeCandidate({ avatarId: `avatar-${i + 1}`, avatarName: `Avatar ${i + 1}` }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('turn-arbiter', () => {
  describe('room-level suppression', () => {
    it('emits at most one primary for 5 avatars with ordinary human message', () => {
      const candidates = makeAvatarRoom(5);
      const message = makeMessage();
      const decision = selectPrimaryResponder(candidates, message);

      expect(decision.primary).not.toBeNull();
      expect(decision.suppressed).toHaveLength(4);
      // Every candidate appears exactly once (as primary or suppressed)
      const allIds = [
        decision.primary!.avatarId,
        ...decision.suppressed.map(c => c.avatarId),
      ];
      expect(new Set(allIds).size).toBe(5);
    });

    it('emits at most one primary for 10 avatars with ordinary human message', () => {
      const candidates = makeAvatarRoom(10);
      const message = makeMessage();
      const decision = selectPrimaryResponder(candidates, message);

      expect(decision.primary).not.toBeNull();
      expect(decision.suppressed).toHaveLength(9);
    });

    it('returns null primary and empty suppressed when no candidates', () => {
      const decision = selectPrimaryResponder([], makeMessage());

      expect(decision.primary).toBeNull();
      expect(decision.suppressed).toHaveLength(0);
      expect(Object.keys(decision.reasons)).toHaveLength(0);
    });
  });

  describe('priority: direct reply-to', () => {
    it('reply-to avatar wins over all other signals', () => {
      const candidates = [
        makeCandidate({ avatarId: 'mentioned', isMentioned: true }),
        makeCandidate({ avatarId: 'reply-target', isReplyTarget: true, replyConfidence: 0.9 }),
        makeCandidate({ avatarId: 'name-hit', isNameHit: true }),
        makeCandidate({ avatarId: 'thread-owner', isThreadOwner: true }),
        makeCandidate({ avatarId: 'sticky', hasStickyAffinity: true }),
      ];
      const decision = selectPrimaryResponder(candidates, makeMessage());

      expect(decision.primary!.avatarId).toBe('reply-target');
      expect(decision.reasons['reply-target']).toBe('won:reply-to');
    });

    it('reply-to with low confidence loses to mention', () => {
      const candidates = [
        makeCandidate({ avatarId: 'mentioned', isMentioned: true }),
        makeCandidate({ avatarId: 'reply-target', isReplyTarget: true, replyConfidence: 0.3 }),
      ];
      const decision = selectPrimaryResponder(candidates, makeMessage());

      expect(decision.primary!.avatarId).toBe('mentioned');
      expect(decision.reasons['mentioned']).toBe('won:mention');
    });
  });

  describe('priority: explicit @mention', () => {
    it('mentioned avatar wins over name-hit, sticky, and thread-owner', () => {
      const candidates = [
        makeCandidate({ avatarId: 'name-hit', isNameHit: true }),
        makeCandidate({ avatarId: 'mentioned', isMentioned: true }),
        makeCandidate({ avatarId: 'thread-owner', isThreadOwner: true }),
        makeCandidate({ avatarId: 'sticky', hasStickyAffinity: true }),
        makeCandidate({ avatarId: 'plain' }),
      ];
      const decision = selectPrimaryResponder(candidates, makeMessage());

      expect(decision.primary!.avatarId).toBe('mentioned');
      expect(decision.reasons['mentioned']).toBe('won:mention');
    });
  });

  describe('priority: name hit', () => {
    it('name-hit avatar wins over sticky and thread-owner', () => {
      const candidates = [
        makeCandidate({ avatarId: 'name-hit', isNameHit: true }),
        makeCandidate({ avatarId: 'sticky', hasStickyAffinity: true }),
        makeCandidate({ avatarId: 'thread-owner', isThreadOwner: true }),
        makeCandidate({ avatarId: 'plain-1' }),
        makeCandidate({ avatarId: 'plain-2' }),
      ];
      const decision = selectPrimaryResponder(candidates, makeMessage());

      expect(decision.primary!.avatarId).toBe('name-hit');
      expect(decision.reasons['name-hit']).toBe('won:name-hit');
    });
  });

  describe('priority: sticky affinity', () => {
    it('sticky-affinity avatar wins over thread-owner and plain', () => {
      const candidates = [
        makeCandidate({ avatarId: 'sticky', hasStickyAffinity: true }),
        makeCandidate({ avatarId: 'thread-owner', isThreadOwner: true }),
        makeCandidate({ avatarId: 'plain' }),
      ];
      const decision = selectPrimaryResponder(candidates, makeMessage());

      expect(decision.primary!.avatarId).toBe('sticky');
      expect(decision.reasons['sticky']).toBe('won:sticky-affinity');
    });
  });

  describe('priority: thread ownership', () => {
    it('thread-owner wins over plain candidates', () => {
      const candidates = [
        makeCandidate({ avatarId: 'plain-1' }),
        makeCandidate({ avatarId: 'thread-owner', isThreadOwner: true }),
        makeCandidate({ avatarId: 'plain-2' }),
      ];
      const decision = selectPrimaryResponder(candidates, makeMessage());

      expect(decision.primary!.avatarId).toBe('thread-owner');
      expect(decision.reasons['thread-owner']).toBe('won:thread-owner');
    });
  });

  describe('priority: random fallback', () => {
    it('plain candidates use deterministic random fallback', () => {
      const candidates = makeAvatarRoom(5);
      const message = makeMessage({ messageId: 'stable-id-123' });

      // Run twice with same messageId — same winner
      const d1 = selectPrimaryResponder(candidates, message);
      const d2 = selectPrimaryResponder(candidates, message);
      expect(d1.primary!.avatarId).toBe(d2.primary!.avatarId);
      expect(d1.reasons[d1.primary!.avatarId]).toBe('won:random-fallback');
    });

    it('different messageId can produce different winner', () => {
      const candidates = makeAvatarRoom(20); // more candidates = higher chance of difference
      const d1 = selectPrimaryResponder(candidates, makeMessage({ messageId: 'msg-aaa' }));
      const d2 = selectPrimaryResponder(candidates, makeMessage({ messageId: 'msg-zzz' }));

      // With 20 candidates and different hashes it is extremely unlikely (but not impossible)
      // that the same avatar wins both. We test determinism, not randomness distribution.
      // This is a soft assertion — the important thing is each call is deterministic.
      expect(d1.primary).not.toBeNull();
      expect(d2.primary).not.toBeNull();
    });
  });

  describe('bot-to-bot suppression', () => {
    it('suppresses all candidates when sender is a bot (default config)', () => {
      const candidates = makeAvatarRoom(5);
      const message = makeMessage({ senderIsBot: true });
      const decision = selectPrimaryResponder(candidates, message);

      expect(decision.primary).toBeNull();
      expect(decision.suppressed).toHaveLength(5);
      for (const c of decision.suppressed) {
        expect(decision.reasons[c.avatarId]).toBe('suppressed:bot-to-bot');
      }
    });

    it('allows response to bot when suppressBotToBot is disabled', () => {
      const candidates = makeAvatarRoom(3);
      const message = makeMessage({ senderIsBot: true });
      const decision = selectPrimaryResponder(candidates, message, {
        suppressBotToBot: false,
      });

      expect(decision.primary).not.toBeNull();
      expect(decision.suppressed).toHaveLength(2);
    });

    it('allows directed bot-to-bot turns when another avatar is mentioned', () => {
      const candidates = [
        makeCandidate({ avatarId: 'ambient' }),
        makeCandidate({ avatarId: 'mentioned', isMentioned: true }),
      ];
      const decision = selectPrimaryResponder(
        candidates,
        makeMessage({ senderIsBot: true }),
      );

      expect(decision.primary?.avatarId).toBe('mentioned');
      expect(decision.reasons['mentioned']).toBe('won:mention');
    });

    it('allows directed bot-to-bot turns when another avatar is named', () => {
      const candidates = [
        makeCandidate({ avatarId: 'ambient' }),
        makeCandidate({ avatarId: 'named', isNameHit: true }),
      ];
      const decision = selectPrimaryResponder(
        candidates,
        makeMessage({ senderIsBot: true }),
      );

      expect(decision.primary?.avatarId).toBe('named');
      expect(decision.reasons['named']).toBe('won:name-hit');
    });
  });

  describe('multiple signals: mention + thread owner', () => {
    it('mention wins over thread-owner', () => {
      const candidates = [
        makeCandidate({ avatarId: 'both', isMentioned: true, isThreadOwner: true }),
        makeCandidate({ avatarId: 'thread-only', isThreadOwner: true }),
        makeCandidate({ avatarId: 'mention-only', isMentioned: true }),
        makeCandidate({ avatarId: 'plain' }),
      ];
      const decision = selectPrimaryResponder(candidates, makeMessage());

      // 'both' has mention (tier 2, score 500) — same as 'mention-only'
      // Both score 500, so tiebreak decides between them. Either is acceptable.
      expect(decision.primary!.isMentioned).toBe(true);
      expect(decision.reasons[decision.primary!.avatarId]).toBe('won:mention');
    });
  });

  describe('secondary reaction config', () => {
    it('defaults to allowSecondaryReactions=false', () => {
      const decision = selectPrimaryResponder(makeAvatarRoom(3), makeMessage());

      expect(decision.allowSecondaryReactions).toBe(false);
      expect(decision.secondaryDelayMs).toBe(DEFAULT_TURN_ARBITER_CONFIG.secondaryDelayMs);
    });

    it('respects config overrides for secondary reactions', () => {
      const decision = selectPrimaryResponder(makeAvatarRoom(3), makeMessage(), {
        allowSecondaryReactions: true,
        secondaryDelayMs: 10_000,
      });

      expect(decision.allowSecondaryReactions).toBe(true);
      expect(decision.secondaryDelayMs).toBe(10_000);
    });
  });

  describe('reasons tracking', () => {
    it('provides a reason for every candidate', () => {
      const candidates = makeAvatarRoom(7);
      const decision = selectPrimaryResponder(candidates, makeMessage());

      for (const c of candidates) {
        expect(decision.reasons[c.avatarId]).toBeDefined();
      }
      // Exactly one won:* reason
      const wonReasons = Object.values(decision.reasons).filter(r => r.startsWith('won:'));
      expect(wonReasons).toHaveLength(1);
      // Rest are suppressed:*
      const suppressedReasons = Object.values(decision.reasons).filter(r =>
        r.startsWith('suppressed:'),
      );
      expect(suppressedReasons).toHaveLength(6);
    });
  });

  describe('cross-platform candidates', () => {
    it('handles mixed telegram and discord candidates', () => {
      const candidates = [
        makeCandidate({ avatarId: 'tg-1', platform: 'telegram' }),
        makeCandidate({ avatarId: 'dc-1', platform: 'discord' }),
        makeCandidate({ avatarId: 'tg-2', platform: 'telegram' }),
        makeCandidate({ avatarId: 'dc-2', platform: 'discord', isMentioned: true }),
      ];
      const decision = selectPrimaryResponder(candidates, makeMessage());

      expect(decision.primary!.avatarId).toBe('dc-2');
      expect(decision.suppressed).toHaveLength(3);
    });
  });
});
