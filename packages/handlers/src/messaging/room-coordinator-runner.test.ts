/**
 * Tests for buildTurnCandidates — the pure scoring layer used by
 * the message-processor's room coordinator (#1571).
 *
 * Covers mention, reply-target, and name-hit signal detection.
 * Sticky-affinity signals are deferred to a follow-up PR.
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

  it('matches Discord user mention tokens by bot id', () => {
    const room = [
      { avatarId: 'shoggothe', avatarName: 'shoggothé', platformHandle: '1504126043693387796' },
      { avatarId: 'snarkle', avatarName: 'Snarkle', platformHandle: '1477745469756014734' },
    ];
    const c = buildTurnCandidates(room, '<@1504126043693387796> are you online?', 'discord');
    expect(c.find((x) => x.avatarId === 'shoggothe')?.isMentioned).toBe(true);
    expect(c.find((x) => x.avatarId === 'snarkle')?.isMentioned).toBe(false);
  });

  it('can flag the envelope-addressed avatar as mentioned without a platform handle', () => {
    const room = [
      { avatarId: 'shoggothe', avatarName: 'shoggothé' },
      { avatarId: 'phantom', avatarName: 'Continuum Phantom' },
    ];
    const c = buildTurnCandidates(room, '<@1504126043693387796> hello', 'discord', {
      mentionedAvatarId: 'shoggothe',
    });

    expect(c.find((x) => x.avatarId === 'shoggothe')?.isMentioned).toBe(true);
    expect(c.find((x) => x.avatarId === 'phantom')?.isMentioned).toBe(false);
  });

  it('matches Discord nickname mention tokens by bot id', () => {
    const room = [
      { avatarId: 'phantom', avatarName: 'Continuum Phantom', platformHandle: '1481443912869478420' },
    ];
    const c = buildTurnCandidates(room, '<@!1481443912869478420> hello', 'discord');
    expect(c[0].isMentioned).toBe(true);
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

describe('buildTurnCandidates — reply-target scoring', () => {
  it('flags a Discord candidate when replying to its bot user id', () => {
    const room = [
      { avatarId: 'shoggothe', avatarName: 'Shoggothé Divine', platformHandle: '1504126043693387796' },
      { avatarId: 'snarkle', avatarName: 'Snarkle', platformHandle: '1477745469756014734' },
    ];
    const c = buildTurnCandidates(room, 'hmm', 'discord', {
      replyTargetPlatformHandles: ['1504126043693387796'],
    });

    expect(c.find((x) => x.avatarId === 'shoggothe')?.isReplyTarget).toBe(true);
    expect(c.find((x) => x.avatarId === 'shoggothe')?.replyConfidence).toBe(1);
    expect(c.find((x) => x.avatarId === 'snarkle')?.isReplyTarget).toBe(false);
  });

  it('can flag a reply target by avatar id', () => {
    const c = buildTurnCandidates(ROOM, 'following up', 'telegram', {
      replyTargetAvatarId: 'agent-6-1cc5',
    });

    expect(c.find((x) => x.avatarId === 'agent-6-1cc5')?.isReplyTarget).toBe(true);
    expect(c.find((x) => x.avatarId === 'avatar-4-txcl')?.isReplyTarget).toBe(false);
  });

  it('can flag a reply target by avatar id without a platform handle', () => {
    const room = [
      { avatarId: 'shoggothe', avatarName: 'shoggothé' },
      { avatarId: 'phantom', avatarName: 'Continuum Phantom' },
    ];
    const c = buildTurnCandidates(room, 'hello', 'discord', {
      replyTargetAvatarId: 'shoggothe',
    });

    expect(c.find((x) => x.avatarId === 'shoggothe')?.isReplyTarget).toBe(true);
    expect(c.find((x) => x.avatarId === 'shoggothe')?.replyConfidence).toBe(1);
    expect(c.find((x) => x.avatarId === 'phantom')?.isReplyTarget).toBe(false);
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
