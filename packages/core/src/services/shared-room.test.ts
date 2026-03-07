import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  _setDynamoClient,
  appendMessage,
  getRecentMessages,
  updateOverlay,
  getOverlay,
  getRoomState,
  MESSAGE_TTL_DAYS,
  OVERLAY_TTL_DAYS,
} from './shared-room.js';

describe('SharedRoomService', () => {
  let mockSend: ReturnType<typeof mock>;

  beforeEach(() => {
    mockSend = mock(() => Promise.resolve({}));
    const mockDocClient = { send: mockSend } as unknown as DynamoDBDocumentClient;
    _setDynamoClient(mockDocClient);
    process.env.SHARED_ROOM_TABLE = 'test-shared-room';
  });

  afterEach(() => {
    _setDynamoClient(null);
    delete process.env.SHARED_ROOM_TABLE;
  });

  // ===========================================================================
  // appendMessage
  // ===========================================================================

  describe('appendMessage', () => {
    it('writes message and upserts META', async () => {
      await appendMessage('room-1', {
        timestamp: 1700000000000,
        senderId: 'user-1',
        senderType: 'human',
        platform: 'telegram',
        content: 'Hello world',
        messageId: 'msg-1',
      });

      // Two DynamoDB calls: PutCommand (message) + UpdateCommand (META)
      expect(mockSend).toHaveBeenCalledTimes(2);

      // Verify message write
      const putInput = mockSend.mock.calls[0][0].input;
      expect(putInput.TableName).toBe('test-shared-room');
      expect(putInput.Item.pk).toBe('ROOM#room-1');
      expect(putInput.Item.sk).toMatch(/^MSG#\d{15}#msg-1$/);
      expect(putInput.Item.roomId).toBe('room-1');
      expect(putInput.Item.senderId).toBe('user-1');
      expect(putInput.Item.senderType).toBe('human');
      expect(putInput.Item.platform).toBe('telegram');
      expect(putInput.Item.content).toBe('Hello world');
      expect(putInput.Item.messageId).toBe('msg-1');
      expect(putInput.Item.ttl).toBeGreaterThan(0);

      // Verify META upsert
      const updateInput = mockSend.mock.calls[1][0].input;
      expect(updateInput.TableName).toBe('test-shared-room');
      expect(updateInput.Key.pk).toBe('ROOM#room-1');
      expect(updateInput.Key.sk).toBe('META');
      expect(updateInput.ExpressionAttributeValues[':roomId']).toBe('room-1');
      expect(updateInput.ExpressionAttributeValues[':platform']).toBe('telegram');
      expect(updateInput.ExpressionAttributeValues[':one']).toBe(1);
    });

    it('sets correct TTL for messages (7 days)', async () => {
      const now = Date.now();
      await appendMessage('room-1', {
        timestamp: now,
        senderId: 'user-1',
        senderType: 'human',
        platform: 'telegram',
        content: 'test',
        messageId: 'msg-1',
      });

      const putInput = mockSend.mock.calls[0][0].input;
      const ttl = putInput.Item.ttl;
      const expectedMin = Math.floor(now / 1000) + MESSAGE_TTL_DAYS * 86400 - 5;
      const expectedMax = Math.floor(now / 1000) + MESSAGE_TTL_DAYS * 86400 + 5;
      expect(ttl).toBeGreaterThanOrEqual(expectedMin);
      expect(ttl).toBeLessThanOrEqual(expectedMax);
    });

    it('accepts explicit tableName parameter', async () => {
      await appendMessage(
        'room-1',
        {
          timestamp: 1700000000000,
          senderId: 'user-1',
          senderType: 'avatar',
          platform: 'discord',
          content: 'Bot reply',
          messageId: 'msg-2',
        },
        'custom-table',
      );

      const putInput = mockSend.mock.calls[0][0].input;
      expect(putInput.TableName).toBe('custom-table');
    });

    it('handles avatar senderType correctly', async () => {
      await appendMessage('room-1', {
        timestamp: 1700000000000,
        senderId: 'avatar-kyro',
        senderType: 'avatar',
        platform: 'telegram',
        content: 'meow',
        messageId: 'msg-3',
      });

      const putInput = mockSend.mock.calls[0][0].input;
      expect(putInput.Item.senderType).toBe('avatar');
      expect(putInput.Item.senderId).toBe('avatar-kyro');
    });
  });

  // ===========================================================================
  // getRecentMessages
  // ===========================================================================

  describe('getRecentMessages', () => {
    it('returns messages in chronological order (oldest first)', async () => {
      mockSend = mock(() =>
        Promise.resolve({
          Items: [
            // DynamoDB returns newest first (ScanIndexForward: false)
            {
              roomId: 'room-1',
              timestamp: 1700000003000,
              senderId: 'user-2',
              senderType: 'human',
              platform: 'telegram',
              content: 'Third',
              messageId: 'msg-3',
            },
            {
              roomId: 'room-1',
              timestamp: 1700000002000,
              senderId: 'avatar-1',
              senderType: 'avatar',
              platform: 'telegram',
              content: 'Second',
              messageId: 'msg-2',
            },
            {
              roomId: 'room-1',
              timestamp: 1700000001000,
              senderId: 'user-1',
              senderType: 'human',
              platform: 'telegram',
              content: 'First',
              messageId: 'msg-1',
            },
          ],
        }),
      );
      const mockDocClient = { send: mockSend } as unknown as DynamoDBDocumentClient;
      _setDynamoClient(mockDocClient);

      const messages = await getRecentMessages('room-1');

      expect(messages).toHaveLength(3);
      // Chronological order: oldest first
      expect(messages[0].content).toBe('First');
      expect(messages[1].content).toBe('Second');
      expect(messages[2].content).toBe('Third');
    });

    it('passes limit to DynamoDB query', async () => {
      mockSend = mock(() => Promise.resolve({ Items: [] }));
      const mockDocClient = { send: mockSend } as unknown as DynamoDBDocumentClient;
      _setDynamoClient(mockDocClient);

      await getRecentMessages('room-1', 10);

      const queryInput = mockSend.mock.calls[0][0].input;
      expect(queryInput.Limit).toBe(10);
      expect(queryInput.ScanIndexForward).toBe(false);
      expect(queryInput.KeyConditionExpression).toBe(
        'pk = :pk AND begins_with(sk, :prefix)',
      );
      expect(queryInput.ExpressionAttributeValues[':pk']).toBe('ROOM#room-1');
      expect(queryInput.ExpressionAttributeValues[':prefix']).toBe('MSG#');
    });

    it('returns empty array when no messages exist', async () => {
      mockSend = mock(() => Promise.resolve({ Items: undefined }));
      const mockDocClient = { send: mockSend } as unknown as DynamoDBDocumentClient;
      _setDynamoClient(mockDocClient);

      const messages = await getRecentMessages('room-1');
      expect(messages).toEqual([]);
    });
  });

  // ===========================================================================
  // updateOverlay / getOverlay
  // ===========================================================================

  describe('overlay CRUD', () => {
    it('writes overlay with correct key structure', async () => {
      await updateOverlay('room-1', 'avatar-kyro', {
        lastParticipatedAt: 1700000001000,
        messagesSinceLastReply: 3,
        affinityScore: 0.85,
      });

      expect(mockSend).toHaveBeenCalledTimes(1);
      const updateInput = mockSend.mock.calls[0][0].input;
      expect(updateInput.TableName).toBe('test-shared-room');
      expect(updateInput.Key.pk).toBe('ROOM#room-1');
      expect(updateInput.Key.sk).toBe('OVERLAY#avatar-kyro');
      expect(updateInput.ExpressionAttributeValues[':avatarId']).toBe('avatar-kyro');
      expect(updateInput.ExpressionAttributeValues[':roomId']).toBe('room-1');
      expect(updateInput.ExpressionAttributeValues[':lastParticipatedAt']).toBe(1700000001000);
      expect(updateInput.ExpressionAttributeValues[':messagesSinceLastReply']).toBe(3);
      expect(updateInput.ExpressionAttributeValues[':affinityScore']).toBe(0.85);
    });

    it('sets correct TTL for overlays (30 days)', async () => {
      const now = Date.now();
      await updateOverlay('room-1', 'avatar-kyro', {
        lastParticipatedAt: now,
        messagesSinceLastReply: 0,
      });

      const updateInput = mockSend.mock.calls[0][0].input;
      const ttl = updateInput.ExpressionAttributeValues[':ttl'];
      const expectedMin = Math.floor(now / 1000) + OVERLAY_TTL_DAYS * 86400 - 5;
      const expectedMax = Math.floor(now / 1000) + OVERLAY_TTL_DAYS * 86400 + 5;
      expect(ttl).toBeGreaterThanOrEqual(expectedMin);
      expect(ttl).toBeLessThanOrEqual(expectedMax);
    });

    it('reads overlay when it exists', async () => {
      mockSend = mock(() =>
        Promise.resolve({
          Item: {
            pk: 'ROOM#room-1',
            sk: 'OVERLAY#avatar-kyro',
            avatarId: 'avatar-kyro',
            roomId: 'room-1',
            lastParticipatedAt: 1700000001000,
            messagesSinceLastReply: 5,
            cooldownUntil: 1700000010000,
            threadHints: ['topic-42'],
            affinityScore: 0.9,
          },
        }),
      );
      const mockDocClient = { send: mockSend } as unknown as DynamoDBDocumentClient;
      _setDynamoClient(mockDocClient);

      const overlay = await getOverlay('room-1', 'avatar-kyro');

      expect(overlay).not.toBeNull();
      expect(overlay!.avatarId).toBe('avatar-kyro');
      expect(overlay!.roomId).toBe('room-1');
      expect(overlay!.lastParticipatedAt).toBe(1700000001000);
      expect(overlay!.messagesSinceLastReply).toBe(5);
      expect(overlay!.cooldownUntil).toBe(1700000010000);
      expect(overlay!.threadHints).toEqual(['topic-42']);
      expect(overlay!.affinityScore).toBe(0.9);
    });

    it('returns null when overlay does not exist', async () => {
      mockSend = mock(() => Promise.resolve({ Item: undefined }));
      const mockDocClient = { send: mockSend } as unknown as DynamoDBDocumentClient;
      _setDynamoClient(mockDocClient);

      const overlay = await getOverlay('room-1', 'avatar-missing');
      expect(overlay).toBeNull();
    });

    it('multiple avatars have independent overlays', async () => {
      // Write two overlays for the same room but different avatars
      await updateOverlay('room-1', 'avatar-a', {
        lastParticipatedAt: 1000,
        messagesSinceLastReply: 1,
        affinityScore: 0.5,
      });

      await updateOverlay('room-1', 'avatar-b', {
        lastParticipatedAt: 2000,
        messagesSinceLastReply: 10,
        affinityScore: 0.9,
      });

      expect(mockSend).toHaveBeenCalledTimes(2);

      // Verify different SK keys
      const call1 = mockSend.mock.calls[0][0].input;
      const call2 = mockSend.mock.calls[1][0].input;
      expect(call1.Key.sk).toBe('OVERLAY#avatar-a');
      expect(call2.Key.sk).toBe('OVERLAY#avatar-b');

      // Same PK
      expect(call1.Key.pk).toBe('ROOM#room-1');
      expect(call2.Key.pk).toBe('ROOM#room-1');
    });

    it('writes cooldownUntil and threadHints when provided', async () => {
      await updateOverlay('room-1', 'avatar-kyro', {
        lastParticipatedAt: 1700000001000,
        messagesSinceLastReply: 0,
        cooldownUntil: 1700000060000,
        threadHints: ['thread-a', 'thread-b'],
      });

      const updateInput = mockSend.mock.calls[0][0].input;
      expect(updateInput.ExpressionAttributeValues[':cooldownUntil']).toBe(1700000060000);
      expect(updateInput.ExpressionAttributeValues[':threadHints']).toEqual([
        'thread-a',
        'thread-b',
      ]);
    });
  });

  // ===========================================================================
  // getRoomState
  // ===========================================================================

  describe('getRoomState', () => {
    it('returns room metadata when it exists', async () => {
      mockSend = mock(() =>
        Promise.resolve({
          Item: {
            pk: 'ROOM#room-1',
            sk: 'META',
            roomId: 'room-1',
            platform: 'telegram',
            createdAt: 1700000000000,
            messageCount: 42,
          },
        }),
      );
      const mockDocClient = { send: mockSend } as unknown as DynamoDBDocumentClient;
      _setDynamoClient(mockDocClient);

      const state = await getRoomState('room-1');

      expect(state).not.toBeNull();
      expect(state!.roomId).toBe('room-1');
      expect(state!.platform).toBe('telegram');
      expect(state!.createdAt).toBe(1700000000000);
      expect(state!.messageCount).toBe(42);

      // Verify correct key
      const getInput = mockSend.mock.calls[0][0].input;
      expect(getInput.Key.pk).toBe('ROOM#room-1');
      expect(getInput.Key.sk).toBe('META');
    });

    it('returns null when room does not exist', async () => {
      mockSend = mock(() => Promise.resolve({ Item: undefined }));
      const mockDocClient = { send: mockSend } as unknown as DynamoDBDocumentClient;
      _setDynamoClient(mockDocClient);

      const state = await getRoomState('nonexistent');
      expect(state).toBeNull();
    });
  });
});
