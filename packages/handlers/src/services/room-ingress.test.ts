import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import {
  processSharedRoomMessage,
  isSharedRoom,
  buildRoomKey,
  registerChannelAvatarResolver,
  unregisterChannelAvatarResolver,
  _setDeps,
  _resetDeps,
} from './room-ingress.js';

describe('room-ingress', () => {
  const mockClaimRoomMessage = mock(() => Promise.resolve(true));
  const mockAppendMessage = mock(() => Promise.resolve());
  const mockGetRecentMessages = mock(() => Promise.resolve([] as unknown[]));
  const mockGetChannelAvatarIds = mock(() => Promise.resolve([] as string[]));

  beforeEach(() => {
    mockClaimRoomMessage.mockClear();
    mockClaimRoomMessage.mockResolvedValue(true);
    mockAppendMessage.mockClear();
    mockGetRecentMessages.mockClear();
    mockGetRecentMessages.mockResolvedValue([]);
    mockGetChannelAvatarIds.mockClear();
    _setDeps({
      claimRoomMessage: mockClaimRoomMessage as never,
      appendMessage: mockAppendMessage as never,
      getRecentMessages: mockGetRecentMessages as never,
      getChannelAvatarIds: mockGetChannelAvatarIds as never,
    });
  });

  afterEach(() => {
    _resetDeps();
  });

  describe('buildRoomKey', () => {
    it('returns platform:channelId format', () => {
      expect(buildRoomKey('telegram', '-1001234567890')).toBe('telegram:-1001234567890');
      expect(buildRoomKey('discord', '987654321')).toBe('discord:987654321');
    });
  });

  describe('processSharedRoomMessage', () => {
    const baseMessage = {
      messageId: 'msg-001',
      senderId: 'user-123',
      senderType: 'human' as const,
      content: 'Hello room!',
      timestamp: Date.now(),
    };

    it('appends one room event for a new message', async () => {
      mockGetRecentMessages.mockResolvedValueOnce([]);

      const result = await processSharedRoomMessage('telegram', '-100123', baseMessage);

      expect(result.isNew).toBe(true);
      expect(result.roomKey).toBe('telegram:-100123');
      expect(result.messageId).toBe('msg-001');
      expect(mockClaimRoomMessage).toHaveBeenCalledWith('-100123', 'msg-001');
      expect(mockAppendMessage).toHaveBeenCalledTimes(1);
      expect(mockAppendMessage).toHaveBeenCalledWith('-100123', {
        messageId: 'msg-001',
        senderId: 'user-123',
        senderType: 'human',
        platform: 'telegram',
        content: 'Hello room!',
        timestamp: baseMessage.timestamp,
      });
    });

    it('deduplicates when messageId already exists in ledger', async () => {
      mockGetRecentMessages.mockResolvedValueOnce([
        { messageId: 'msg-001', roomId: '-100123', senderId: 'user-123', senderType: 'human', platform: 'telegram', content: 'Hello room!', timestamp: Date.now() },
      ]);

      const result = await processSharedRoomMessage('telegram', '-100123', baseMessage);

      expect(result.isNew).toBe(false);
      expect(result.roomKey).toBe('telegram:-100123');
      expect(mockAppendMessage).not.toHaveBeenCalled();
    });

    it('deduplicates when the atomic room message claim already exists', async () => {
      mockClaimRoomMessage.mockResolvedValueOnce(false);

      const result = await processSharedRoomMessage('discord', 'chan-123', baseMessage);

      expect(result.isNew).toBe(false);
      expect(result.roomKey).toBe('discord:chan-123');
      expect(mockGetRecentMessages).not.toHaveBeenCalled();
      expect(mockAppendMessage).not.toHaveBeenCalled();
    });

    it('creates one room event, not N per-avatar events', async () => {
      mockGetRecentMessages.mockResolvedValueOnce([]);

      await processSharedRoomMessage('telegram', '-100123', baseMessage);

      // Exactly one append, regardless of how many avatars are in the room
      expect(mockAppendMessage).toHaveBeenCalledTimes(1);
    });
  });

  describe('isSharedRoom', () => {
    it('returns true when 2+ avatars are registered', async () => {
      mockGetChannelAvatarIds.mockResolvedValueOnce(['avatar-a', 'avatar-b']);
      expect(await isSharedRoom('telegram', '-100123')).toBe(true);
    });

    it('returns false when only 1 avatar is registered', async () => {
      mockGetChannelAvatarIds.mockResolvedValueOnce(['avatar-a']);
      expect(await isSharedRoom('telegram', '-100123')).toBe(false);
    });

    it('returns false when no avatars are registered', async () => {
      mockGetChannelAvatarIds.mockResolvedValueOnce([]);
      expect(await isSharedRoom('telegram', '-100123')).toBe(false);
    });
  });

  describe('platform-agnostic resolver', () => {
    afterEach(() => {
      unregisterChannelAvatarResolver('discord');
    });

    it('uses a registered platform resolver for Discord instead of the default', async () => {
      const discordResolver = mock(() => Promise.resolve(['avatar-x', 'avatar-y']));
      registerChannelAvatarResolver('discord', discordResolver as never);

      const result = await isSharedRoom('discord', 'chan-123');
      expect(result).toBe(true);
      expect(discordResolver).toHaveBeenCalledWith('chan-123');
      // The default Telegram resolver should NOT have been called
      expect(mockGetChannelAvatarIds).not.toHaveBeenCalled();
    });

    it('falls back to default resolver for platforms without a registered resolver', async () => {
      // Register Discord resolver but query Telegram
      const discordResolver = mock(() => Promise.resolve(['avatar-x']));
      registerChannelAvatarResolver('discord', discordResolver as never);

      mockGetChannelAvatarIds.mockResolvedValueOnce(['avatar-a', 'avatar-b']);
      const result = await isSharedRoom('telegram', '-100123');
      expect(result).toBe(true);
      expect(discordResolver).not.toHaveBeenCalled();
      expect(mockGetChannelAvatarIds).toHaveBeenCalledWith('-100123');
    });

    it('Discord and Telegram use the same isSharedRoom interface', async () => {
      // Register Discord resolver
      registerChannelAvatarResolver('discord', async () => ['a', 'b', 'c']);

      // Both platforms through the same function
      mockGetChannelAvatarIds.mockResolvedValueOnce(['x', 'y']);

      const discordShared = await isSharedRoom('discord', 'chan-1');
      const telegramShared = await isSharedRoom('telegram', '-1001');

      expect(discordShared).toBe(true);
      expect(telegramShared).toBe(true);
    });

    it('unregisterChannelAvatarResolver removes the resolver', async () => {
      const discordResolver = mock(() => Promise.resolve(['avatar-x', 'avatar-y']));
      registerChannelAvatarResolver('discord', discordResolver as never);
      unregisterChannelAvatarResolver('discord');

      // Should now fall back to default
      mockGetChannelAvatarIds.mockResolvedValueOnce([]);
      const result = await isSharedRoom('discord', 'chan-123');
      expect(result).toBe(false);
      expect(discordResolver).not.toHaveBeenCalled();
    });
  });
});
