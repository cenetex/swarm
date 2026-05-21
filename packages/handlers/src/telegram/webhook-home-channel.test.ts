/**
 * Tests for resolveMentionedAvatar — the @-mention -> avatarId resolver
 * used by the shared-room dispatcher to route the SQS job to the bot the
 * user actually @-mentioned (instead of whichever bot's webhook won the
 * dedup race).
 */
import { describe, it, expect } from 'bun:test';
import {
  resolveMentionedAvatar,
  resolveReplyTargetAvatar,
} from './webhook-home-channel.js';

const REGISTERED = [
  { avatarId: 'agent-3-qkwg', botUsername: 'bobthesnek_bot' },
  { avatarId: 'avatar-1-9qhu', botUsername: 'snarkle_bot' },
  { avatarId: 'agent-1-6yan', botUsername: 'Opus4_Bot' },
  { avatarId: 'avatar-4-txcl', botUsername: 'ChoppaRatiBot' },
  { avatarId: 'agent-6-1cc5', botUsername: 'NyxRatiBot' },
];

describe('resolveMentionedAvatar', () => {
  it('matches a leading @-mention to the registered avatar', () => {
    const r = resolveMentionedAvatar('@NyxRatiBot hello?', REGISTERED);
    expect(r?.avatarId).toBe('agent-6-1cc5');
    expect(r?.botUsername).toBe('NyxRatiBot');
  });

  it('is case-insensitive', () => {
    const r = resolveMentionedAvatar('@nyxratibot hi', REGISTERED);
    expect(r?.avatarId).toBe('agent-6-1cc5');
  });

  it('matches an @-mention in the middle of a sentence', () => {
    const r = resolveMentionedAvatar('hey @ChoppaRatiBot what do you think', REGISTERED);
    expect(r?.avatarId).toBe('avatar-4-txcl');
  });

  it('returns null when no registered bot is mentioned', () => {
    expect(resolveMentionedAvatar('hello world', REGISTERED)).toBeNull();
    expect(resolveMentionedAvatar('@SomeOtherBot hi', REGISTERED)).toBeNull();
  });

  it('returns null on empty inputs', () => {
    expect(resolveMentionedAvatar('', REGISTERED)).toBeNull();
    expect(resolveMentionedAvatar('@NyxRatiBot', [])).toBeNull();
  });

  it('requires a word boundary so @NyxRatiBotter does not match @NyxRatiBot', () => {
    expect(resolveMentionedAvatar('@NyxRatiBotter hi', REGISTERED)).toBeNull();
  });

  it('picks the first registered match when several bots are mentioned', () => {
    // Iteration order = registration order. Bob is registered before Nyx.
    const r = resolveMentionedAvatar('@NyxRatiBot and @bobthesnek_bot', REGISTERED);
    expect(r?.avatarId).toBe('agent-3-qkwg');
  });

  it('accepts punctuation immediately after the username', () => {
    expect(resolveMentionedAvatar('@NyxRatiBot, are you there?', REGISTERED)?.avatarId).toBe('agent-6-1cc5');
    expect(resolveMentionedAvatar('@NyxRatiBot.', REGISTERED)?.avatarId).toBe('agent-6-1cc5');
    expect(resolveMentionedAvatar('@NyxRatiBot!', REGISTERED)?.avatarId).toBe('agent-6-1cc5');
  });
});

describe('resolveReplyTargetAvatar', () => {
  it('matches a replied-to bot username to the registered avatar', () => {
    const r = resolveReplyTargetAvatar(
      { is_bot: true, username: 'ChoppaRatiBot' },
      REGISTERED,
    );

    expect(r?.avatarId).toBe('avatar-4-txcl');
    expect(r?.botUsername).toBe('ChoppaRatiBot');
  });

  it('is case-insensitive for replied-to usernames', () => {
    const r = resolveReplyTargetAvatar(
      { is_bot: true, username: 'nyxratibot' },
      REGISTERED,
    );

    expect(r?.avatarId).toBe('agent-6-1cc5');
  });

  it('ignores human replies and unregistered bot usernames', () => {
    expect(resolveReplyTargetAvatar(
      { is_bot: false, username: 'NyxRatiBot' },
      REGISTERED,
    )).toBeNull();

    expect(resolveReplyTargetAvatar(
      { is_bot: true, username: 'OtherBot' },
      REGISTERED,
    )).toBeNull();
  });
});
