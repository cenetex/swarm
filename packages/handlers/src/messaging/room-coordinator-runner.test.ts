/**
 * Tests for buildTurnCandidates — the pure scoring layer used by
 * the message-processor's room coordinator (#1571).
 *
 * Covers mention and name-hit signal detection. Sticky-affinity and
 * reply-target signals are deferred to a follow-up PR.
 */
import { describe, it, expect } from 'bun:test';
import { buildTurnCandidates } from './room-coordinator-runner.js';

const ROOM = [
  { avatarId: 'agent-6-1cc5', avatarName: 'Nyx', platformHandle: 'NyxRatiBot' },
  { avatarId: 'avatar-4-txcl', avatarName: 'CHOPPA', platformHandle: 'ChoppaRatiBot' },
  { avatarId: 'agent-3-qkwg', avatarName: 'Bob', platformHandle: 'bobthesnek_bot' },
];

describe('buildTurnCandidates — mention scoring', () => {
  it('flags isMentioned when @<platformHandle> appears (case-insensitive)', () => {
    const c = buildTurnCandidates(ROOM, '@NyxRatiBot hello?', 'telegram');
    expect(c.find((x) => x.avatarId === 'agent-6-1cc5')?.isMentioned).toBe(true);
    expect(c.find((x) => x.avatarId === 'avatar-4-txcl')?.isMentioned).toBe(false);
  });

  it('respects word boundary so @NyxRatiBotter does not match @NyxRatiBot', () => {
    const c = buildTurnCandidates(ROOM, '@NyxRatiBotter hello', 'telegram');
    expect(c.find((x) => x.avatarId === 'agent-6-1cc5')?.isMentioned).toBe(false);
  });

  it('matches @-mention in the middle of a sentence', () => {
    const c = buildTurnCandidates(ROOM, 'hey @ChoppaRatiBot what do you think', 'telegram');
    expect(c.find((x) => x.avatarId === 'avatar-4-txcl')?.isMentioned).toBe(true);
  });

  it('matches when followed by punctuation', () => {
    const c = buildTurnCandidates(ROOM, '@NyxRatiBot, are you there?', 'telegram');
    expect(c.find((x) => x.avatarId === 'agent-6-1cc5')?.isMentioned).toBe(true);
  });
});

describe('buildTurnCandidates — name-hit scoring', () => {
  it('flags isNameHit when avatar name appears as a standalone token', () => {
    const c = buildTurnCandidates(ROOM, 'Nyx, what do you think?', 'telegram');
    expect(c.find((x) => x.avatarId === 'agent-6-1cc5')?.isNameHit).toBe(true);
  });

  it('is case-insensitive', () => {
    const c = buildTurnCandidates(ROOM, 'hey nyx help me out', 'telegram');
    expect(c.find((x) => x.avatarId === 'agent-6-1cc5')?.isNameHit).toBe(true);
  });

  it('does not match the avatar name as a substring inside another word', () => {
    // "Nyx" is in "Nyxology" but should not flag a name-hit.
    const c = buildTurnCandidates(ROOM, 'I love nyxology', 'telegram');
    expect(c.find((x) => x.avatarId === 'agent-6-1cc5')?.isNameHit).toBe(false);
  });

  it('does not flag name-hit on empty text', () => {
    const c = buildTurnCandidates(ROOM, '', 'telegram');
    expect(c.every((x) => !x.isNameHit)).toBe(true);
    expect(c.every((x) => !x.isMentioned)).toBe(true);
  });

  it('treats single-letter names as too noisy to match', () => {
    // Defensive: if an avatar has a 1-letter name, name-hit should not fire.
    const room = [{ avatarId: 'a', avatarName: 'X', platformHandle: 'x_bot' }];
    const c = buildTurnCandidates(room, 'send X-rays please', 'telegram');
    expect(c[0].isNameHit).toBe(false);
  });
});

describe('buildTurnCandidates — both signals together', () => {
  it('a mentioned avatar can also be a name-hit; both flags set', () => {
    const c = buildTurnCandidates(ROOM, '@NyxRatiBot Nyx are you there?', 'telegram');
    const nyx = c.find((x) => x.avatarId === 'agent-6-1cc5');
    expect(nyx?.isMentioned).toBe(true);
    expect(nyx?.isNameHit).toBe(true);
  });

  it('non-matching avatars stay clean of both flags', () => {
    const c = buildTurnCandidates(ROOM, '@NyxRatiBot help', 'telegram');
    const choppa = c.find((x) => x.avatarId === 'avatar-4-txcl');
    expect(choppa?.isMentioned).toBe(false);
    expect(choppa?.isNameHit).toBe(false);
  });
});
