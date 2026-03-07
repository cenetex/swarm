import { describe, it, expect } from 'bun:test';
import { generateRoomKey, parseRoomKey } from './room-key.js';
import {
  DefaultRoomCoordinator,
  roomEventToTurnMessage,
  mapWinReason,
} from './room-coordinator.js';
import type { RoomEvent } from '../types/room-event.js';
import type { TurnCandidate } from '../types/turn-arbiter.js';

// =============================================================================
// roomKey generation / parsing
// =============================================================================

describe('generateRoomKey', () => {
  it('generates telegram room keys', () => {
    expect(generateRoomKey('telegram', '-1001234567890')).toBe(
      'telegram:-1001234567890',
    );
  });

  it('generates discord room keys with guildId', () => {
    expect(generateRoomKey('discord', 'chan-1', 'guild-1')).toBe(
      'discord:guild-1:chan-1',
    );
  });

  it('throws when discord key missing guildId', () => {
    expect(() => generateRoomKey('discord', 'chan-1')).toThrow(
      'guildId is required',
    );
  });

  it('generates shared-chat room keys', () => {
    expect(generateRoomKey('shared-chat', 'room-abc')).toBe(
      'shared-chat:room-abc',
    );
  });

  it('generates fallback keys for other platforms', () => {
    expect(generateRoomKey('web', 'session-1')).toBe('web:session-1');
  });

  it('throws on empty channelId', () => {
    expect(() => generateRoomKey('telegram', '')).toThrow(
      'channelId is required',
    );
  });
});

describe('parseRoomKey', () => {
  it('parses telegram keys', () => {
    const parsed = parseRoomKey('telegram:-1001234567890');
    expect(parsed).toEqual({
      platform: 'telegram',
      channelId: '-1001234567890',
    });
  });

  it('parses discord keys', () => {
    const parsed = parseRoomKey('discord:guild-1:chan-1');
    expect(parsed).toEqual({
      platform: 'discord',
      guildId: 'guild-1',
      channelId: 'chan-1',
    });
  });

  it('parses shared-chat keys', () => {
    const parsed = parseRoomKey('shared-chat:room-abc');
    expect(parsed).toEqual({
      platform: 'shared-chat',
      channelId: 'room-abc',
    });
  });

  it('throws on empty key', () => {
    expect(() => parseRoomKey('')).toThrow('cannot be empty');
  });

  it('throws on key without separator', () => {
    expect(() => parseRoomKey('invalid')).toThrow('Invalid room key format');
  });

  it('throws on discord key without channelId', () => {
    expect(() => parseRoomKey('discord:guild-only')).toThrow(
      'Discord room key requires guildId',
    );
  });

  it('roundtrips correctly for each platform', () => {
    const telegramKey = generateRoomKey('telegram', 'chat-99');
    expect(parseRoomKey(telegramKey)).toEqual({
      platform: 'telegram',
      channelId: 'chat-99',
    });

    const discordKey = generateRoomKey('discord', 'ch-5', 'g-2');
    expect(parseRoomKey(discordKey)).toEqual({
      platform: 'discord',
      guildId: 'g-2',
      channelId: 'ch-5',
    });
  });
});

// =============================================================================
// RoomEvent -> TurnMessage mapping
// =============================================================================

describe('roomEventToTurnMessage', () => {
  const baseEvent: RoomEvent = {
    roomKey: 'telegram:chat-1',
    platform: 'telegram',
    messageId: 'msg-1',
    senderId: 'user-1',
    senderType: 'human',
    content: 'hello world',
    timestamp: Date.now(),
  };

  it('maps roomKey to conversationId', () => {
    const tm = roomEventToTurnMessage(baseEvent);
    expect(tm.conversationId).toBe('telegram:chat-1');
  });

  it('maps messageId', () => {
    const tm = roomEventToTurnMessage(baseEvent);
    expect(tm.messageId).toBe('msg-1');
  });

  it('sets senderIsBot=false for human senders', () => {
    const tm = roomEventToTurnMessage(baseEvent);
    expect(tm.senderIsBot).toBe(false);
  });

  it('sets senderIsBot=true for avatar senders', () => {
    const tm = roomEventToTurnMessage({ ...baseEvent, senderType: 'avatar' });
    expect(tm.senderIsBot).toBe(true);
  });

  it('sets senderIsBot=true for bot senders', () => {
    const tm = roomEventToTurnMessage({ ...baseEvent, senderType: 'bot' });
    expect(tm.senderIsBot).toBe(true);
  });

  it('maps content to text', () => {
    const tm = roomEventToTurnMessage(baseEvent);
    expect(tm.text).toBe('hello world');
  });

  it('maps platform', () => {
    const tm = roomEventToTurnMessage(baseEvent);
    expect(tm.platform).toBe('telegram');
  });
});

// =============================================================================
// mapWinReason
// =============================================================================

describe('mapWinReason', () => {
  it('maps reply-to reasons', () => {
    expect(mapWinReason('won:reply-to')).toBe('reply-to-avatar');
  });

  it('maps mention reasons', () => {
    expect(mapWinReason('won:mention')).toBe('direct-mention');
  });

  it('maps name-hit reasons', () => {
    expect(mapWinReason('won:name-hit')).toBe('direct-mention');
  });

  it('maps sticky-affinity reasons', () => {
    expect(mapWinReason('won:sticky-affinity')).toBe('sticky-affinity');
  });

  it('maps thread-owner reasons', () => {
    expect(mapWinReason('won:thread-owner')).toBe('thread-owner');
  });

  it('maps random-fallback reasons', () => {
    expect(mapWinReason('won:random-fallback')).toBe('random-fallback');
  });

  it('returns none for undefined', () => {
    expect(mapWinReason(undefined)).toBe('none');
  });

  it('returns none for unknown reasons', () => {
    expect(mapWinReason('something-unknown')).toBe('none');
  });
});

// =============================================================================
// DefaultRoomCoordinator
// =============================================================================

describe('DefaultRoomCoordinator', () => {
  const coordinator = new DefaultRoomCoordinator();

  function makeCandidate(overrides: Partial<TurnCandidate> = {}): TurnCandidate {
    return {
      avatarId: 'avatar-1',
      avatarName: 'TestAvatar',
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

  const baseEvent: RoomEvent = {
    roomKey: 'telegram:chat-1',
    platform: 'telegram',
    messageId: 'msg-100',
    senderId: 'user-1',
    senderType: 'human',
    content: 'hello',
    timestamp: Date.now(),
  };

  it('returns roomKey on the decision', async () => {
    const decision = await coordinator.evaluateTurn(baseEvent, [
      makeCandidate(),
    ]);
    expect(decision.roomKey).toBe('telegram:chat-1');
  });

  it('returns a decisionReason', async () => {
    const decision = await coordinator.evaluateTurn(baseEvent, [
      makeCandidate(),
    ]);
    // Single candidate with no signals -> random-fallback
    expect(decision.decisionReason).toBe('random-fallback');
  });

  it('elects mentioned candidate with direct-mention reason', async () => {
    const mentioned = makeCandidate({
      avatarId: 'avatar-m',
      isMentioned: true,
    });
    const other = makeCandidate({ avatarId: 'avatar-o' });

    const decision = await coordinator.evaluateTurn(baseEvent, [
      other,
      mentioned,
    ]);
    expect(decision.primary?.avatarId).toBe('avatar-m');
    expect(decision.decisionReason).toBe('direct-mention');
  });

  it('returns none reason when no candidates', async () => {
    const decision = await coordinator.evaluateTurn(baseEvent, []);
    expect(decision.primary).toBeNull();
    expect(decision.decisionReason).toBe('none');
  });

  it('suppresses bot-to-bot by default', async () => {
    const botEvent: RoomEvent = {
      ...baseEvent,
      senderType: 'bot',
    };
    const decision = await coordinator.evaluateTurn(botEvent, [
      makeCandidate(),
    ]);
    expect(decision.primary).toBeNull();
    expect(decision.suppressed.length).toBe(1);
  });

  it('delegates correctly to selectPrimaryResponder', async () => {
    const replyTarget = makeCandidate({
      avatarId: 'avatar-r',
      isReplyTarget: true,
      replyConfidence: 0.9,
    });
    const mentioned = makeCandidate({
      avatarId: 'avatar-m',
      isMentioned: true,
    });

    const decision = await coordinator.evaluateTurn(baseEvent, [
      mentioned,
      replyTarget,
    ]);
    // reply-to wins over mention
    expect(decision.primary?.avatarId).toBe('avatar-r');
    expect(decision.decisionReason).toBe('reply-to-avatar');
    expect(decision.suppressed.length).toBe(1);
    expect(decision.suppressed[0].avatarId).toBe('avatar-m');
  });
});
