import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import {
  processSharedRoomMessage,
  isSharedRoom,
  buildRoomKey,
  _setDeps,
  _resetDeps,
} from './room-ingress.js';

describe('room-ingress', () => {
  const mockAppendMessage = mock(() => Promise.resolve());
  const mockGetRecentMessages = mock(() => Promise.resolve([] as unknown[]));
  const mockGetChannelAvatarIds = mock(() => Promise.resolve([] as string[]));

  beforeEach(() => {
    mockAppendMessage.mockClear();
    mockGetRecentMessages.mockClear();
    mockGetChannelAvatarIds.mockClear();
    _setDeps({
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
});
