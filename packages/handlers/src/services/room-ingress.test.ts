import { describe, it, expect, beforeEach, mock } from 'bun:test';

// Mock @swarm/core before importing the module under test
const mockAppendMessage = mock(() => Promise.resolve());
const mockGetRecentMessages = mock(() => Promise.resolve([]));
const mockLogger = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
  setContext: mock(() => {}),
};

mock.module('@swarm/core', () => ({
  appendMessage: mockAppendMessage,
  getRecentMessages: mockGetRecentMessages,
  logger: mockLogger,
}));

// Mock getChannelAvatarIds
const mockGetChannelAvatarIds = mock(() => Promise.resolve([]));
mock.module('../telegram/webhook-home-channel.js', () => ({
  getChannelAvatarIds: mockGetChannelAvatarIds,
}));

// Now import the module under test
const { processSharedRoomMessage, isSharedRoom, buildRoomKey } = await import('./room-ingress.js');

describe('room-ingress', () => {
  beforeEach(() => {
    mockAppendMessage.mockClear();
    mockGetRecentMessages.mockClear();
    mockGetChannelAvatarIds.mockClear();
    mockLogger.info.mockClear();
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

    it('emits structured log for appended message', async () => {
      mockGetRecentMessages.mockResolvedValueOnce([]);

      await processSharedRoomMessage('telegram', '-100123', baseMessage);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Room ingress: message appended to shared ledger',
        expect.objectContaining({
          event: 'room_ingress_appended',
          subsystem: 'room-ingress',
          roomKey: 'telegram:-100123',
          messageId: 'msg-001',
        }),
      );
    });

    it('emits structured log for deduplicated message', async () => {
      mockGetRecentMessages.mockResolvedValueOnce([
        { messageId: 'msg-001', roomId: '-100123', senderId: 'user-123', senderType: 'human', platform: 'telegram', content: 'Hello room!', timestamp: Date.now() },
      ]);

      await processSharedRoomMessage('telegram', '-100123', baseMessage);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Room ingress dedup: message already in ledger',
        expect.objectContaining({
          event: 'room_ingress_dedup',
          subsystem: 'room-ingress',
          roomKey: 'telegram:-100123',
          messageId: 'msg-001',
        }),
      );
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
