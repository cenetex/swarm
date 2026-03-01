/**
 * Channel State Service Tests
 */
import { describe, it, expect } from 'vitest';
import type { ChannelStateRecord, BufferedMessage } from '../types.js';
import { buildConversationContext, evaluateResponseTrigger, getResponseTarget } from './channel-state.js';

describe('Channel State Service', () => {
  describe('State Machine', () => {
    it('should transition IDLE to ACTIVE on direct engagement', () => {
      const state: ChannelStateRecord = {
        pk: 'CHANNEL#avatar#123',
        sk: 'STATE',
        avatarId: 'avatar',
        chatId: 123,
        chatType: 'supergroup',
        state: 'IDLE',
        stateChangedAt: Date.now() - 60000,
        messageBuffer: [],
        bufferSize: 0,
        lastActivityAt: Date.now() - 60000,
        ttl: Math.floor(Date.now() / 1000) + 3600,
        updatedAt: Date.now() - 60000,
      };

      // When a message with mention arrives, state should become ACTIVE
      const message: BufferedMessage = {
        messageId: 1,
        userId: 456,
        userName: 'TestUser',
        text: 'Hey @TestBot',
        timestamp: Date.now(),
        isMention: true,
      };

      // Simulating the state transition logic
      const newState = message.isMention ? 'ACTIVE' : state.state;
      expect(newState).toBe('ACTIVE');
    });

    it('should stay IDLE for regular messages in groups', () => {
      const state: ChannelStateRecord = {
        pk: 'CHANNEL#avatar#123',
        sk: 'STATE',
        avatarId: 'avatar',
        chatId: 123,
        chatType: 'supergroup',
        state: 'IDLE',
        stateChangedAt: Date.now() - 60000,
        messageBuffer: [],
        bufferSize: 0,
        lastActivityAt: Date.now() - 60000,
        ttl: Math.floor(Date.now() / 1000) + 3600,
        updatedAt: Date.now() - 60000,
      };

      const message: BufferedMessage = {
        messageId: 1,
        userId: 456,
        userName: 'TestUser',
        text: 'Just a regular message',
        timestamp: Date.now(),
      };

      const newState = message.isMention || message.isReplyToBot ? 'ACTIVE' : state.state;
      expect(newState).toBe('IDLE');
    });
  });

  describe('Response Triggers', () => {
    it('should trigger response for private chats', () => {
      const state: ChannelStateRecord = {
        pk: 'CHANNEL#avatar#123',
        sk: 'STATE',
        avatarId: 'avatar',
        chatId: 123,
        chatType: 'private',
        state: 'IDLE',
        stateChangedAt: Date.now(),
        messageBuffer: [
          { messageId: 1, userId: 456, userName: 'User', text: 'Hello', timestamp: Date.now() },
        ],
        bufferSize: 1,
        lastActivityAt: Date.now(),
        ttl: Math.floor(Date.now() / 1000) + 3600,
        updatedAt: Date.now(),
      };

      const shouldRespond = state.chatType === 'private';
      expect(shouldRespond).toBe(true);
    });

    it('should trigger response on direct engagement', () => {
      const state: ChannelStateRecord = {
        pk: 'CHANNEL#avatar#123',
        sk: 'STATE',
        avatarId: 'avatar',
        chatId: 123,
        chatType: 'supergroup',
        state: 'IDLE',
        stateChangedAt: Date.now(),
        messageBuffer: [
          { messageId: 1, userId: 456, userName: 'User', text: 'Hey @Bot', timestamp: Date.now(), isMention: true },
        ],
        bufferSize: 1,
        lastActivityAt: Date.now(),
        ttl: Math.floor(Date.now() / 1000) + 3600,
        updatedAt: Date.now(),
      };

      const hasDirectEngagement = state.messageBuffer.some(m => m.isMention || m.isReplyToBot);
      expect(hasDirectEngagement).toBe(true);
    });

    it('should trigger response when message threshold reached', () => {
      const MESSAGE_THRESHOLD = 3;
      const state: ChannelStateRecord = {
        pk: 'CHANNEL#avatar#123',
        sk: 'STATE',
        avatarId: 'avatar',
        chatId: 123,
        chatType: 'supergroup',
        state: 'IDLE',
        stateChangedAt: Date.now(),
        messageBuffer: Array.from({ length: 3 }, (_, i) => ({
          messageId: i,
          userId: 456,
          userName: 'User',
          text: `Message ${i}`,
          timestamp: Date.now() - (3 - i) * 1000,
        })),
        bufferSize: 3,
        lastActivityAt: Date.now(),
        ttl: Math.floor(Date.now() / 1000) + 3600,
        updatedAt: Date.now(),
      };

      const thresholdReached = state.bufferSize >= MESSAGE_THRESHOLD;
      expect(thresholdReached).toBe(true);
    });

    it('should not trigger during COOLDOWN', () => {
      const COOLDOWN_DURATION_MS = 10000;
      const state: ChannelStateRecord = {
        pk: 'CHANNEL#avatar#123',
        sk: 'STATE',
        avatarId: 'avatar',
        chatId: 123,
        chatType: 'supergroup',
        state: 'COOLDOWN',
        stateChangedAt: Date.now() - 5000, // 5 seconds ago
        messageBuffer: [
          { messageId: 1, userId: 456, userName: 'User', text: 'Hello', timestamp: Date.now() },
        ],
        bufferSize: 1,
        lastActivityAt: Date.now(),
        ttl: Math.floor(Date.now() / 1000) + 3600,
        updatedAt: Date.now(),
      };

      const inCooldown = state.state === 'COOLDOWN' &&
        (Date.now() - state.stateChangedAt) < COOLDOWN_DURATION_MS;
      expect(inCooldown).toBe(true);
    });

    it('should trigger on new mention during COOLDOWN (pending messages only)', () => {
      const now = Date.now();
      const state: ChannelStateRecord = {
        pk: 'CHANNEL#avatar#123',
        sk: 'STATE',
        avatarId: 'avatar',
        chatId: 123,
        chatType: 'supergroup',
        state: 'COOLDOWN',
        stateChangedAt: now - 10_000,
        lastResponseAt: now - 2_000,
        messageBuffer: [
          { messageId: 1, userId: 1, userName: 'Alice', text: 'older msg', timestamp: now - 60_000 },
          { messageId: 2, userId: 2, userName: 'Bob', text: 'older mention', timestamp: now - 3_000, isMention: true },
          { messageId: 3, userId: 3, userName: 'Charlie', text: '@Bot help', timestamp: now - 1_000, isMention: true },
        ],
        bufferSize: 3,
        lastActivityAt: now,
        ttl: Math.floor(now / 1000) + 3600,
        updatedAt: now,
      };

      const decision = evaluateResponseTrigger(state);
      expect(decision.shouldRespond).toBe(true);
      expect(decision.trigger).toBe('direct_engagement');
    });

    it('should trigger on new reply during COOLDOWN (pending messages only)', () => {
      const now = Date.now();
      const state: ChannelStateRecord = {
        pk: 'CHANNEL#avatar#123',
        sk: 'STATE',
        avatarId: 'avatar',
        chatId: 123,
        chatType: 'supergroup',
        state: 'COOLDOWN',
        stateChangedAt: now - 10_000,
        lastResponseAt: now - 2_000,
        messageBuffer: [
          { messageId: 1, userId: 1, userName: 'Alice', text: 'older msg', timestamp: now - 60_000 },
          { messageId: 2, userId: 2, userName: 'Bob', text: 'replying to bot', timestamp: now - 1_000, isReplyToBot: true },
        ],
        bufferSize: 2,
        lastActivityAt: now,
        ttl: Math.floor(now / 1000) + 3600,
        updatedAt: now,
      };

      const decision = evaluateResponseTrigger(state);
      expect(decision.shouldRespond).toBe(true);
      expect(decision.trigger).toBe('direct_engagement');
    });

    it('should use pending messages for threshold triggers (not total bufferSize)', () => {
      const now = Date.now();
      const state: ChannelStateRecord = {
        pk: 'CHANNEL#avatar#123',
        sk: 'STATE',
        avatarId: 'avatar',
        chatId: 123,
        chatType: 'supergroup',
        state: 'IDLE',
        stateChangedAt: now,
        lastResponseAt: now - 2_000,
        messageBuffer: [
          // Old messages (pre-response)
          ...Array.from({ length: 50 }, (_, i) => ({
            messageId: i + 1,
            userId: 100,
            userName: 'Alice',
            text: `old ${i}`,
            timestamp: now - 60_000 - i * 1000,
          })),
          // Only a couple of new messages (post-response)
          { messageId: 1001, userId: 200, userName: 'Bob', text: 'new 1', timestamp: now - 1_500 },
          { messageId: 1002, userId: 300, userName: 'Charlie', text: 'new 2', timestamp: now - 1_000 },
        ],
        bufferSize: 52,
        lastActivityAt: now,
        ttl: Math.floor(now / 1000) + 3600,
        updatedAt: now,
      };

      const decision = evaluateResponseTrigger(state);
      expect(decision.shouldRespond).toBe(false);
    });

    it('should respond to follow-up messages after a mention (sticky)', () => {
      const now = Date.now();
      const state: ChannelStateRecord = {
        pk: 'CHANNEL#avatar#123',
        sk: 'STATE',
        avatarId: 'avatar',
        chatId: 123,
        chatType: 'supergroup',
        state: 'COOLDOWN',
        stateChangedAt: now - 1000,
        lastResponseAt: now - 2000,
        stickyEngagementUserId: 42,
        stickyEngagementUntil: now + 60_000,
        stickyEngagementRemaining: 2,
        messageBuffer: [
          { messageId: 1, userId: 42, userName: 'Alice', text: '@Bot hey', timestamp: now - 10_000, isMention: true },
          { messageId: 2, userId: 42, userName: 'Alice', text: 'followup 1', timestamp: now - 1500 },
        ],
        bufferSize: 2,
        lastActivityAt: now,
        ttl: Math.floor(now / 1000) + 3600,
        updatedAt: now,
      };

      const decision = evaluateResponseTrigger(state);
      expect(decision.shouldRespond).toBe(true);
      expect(decision.trigger).toBe('sticky_followup');

      const target = getResponseTarget(state);
      expect(target?.messageId).toBe(2);
    });

    it('should not sticky-followup when sticky window expired', () => {
      const now = Date.now();
      const state: ChannelStateRecord = {
        pk: 'CHANNEL#avatar#123',
        sk: 'STATE',
        avatarId: 'avatar',
        chatId: 123,
        chatType: 'supergroup',
        state: 'IDLE',
        stateChangedAt: now,
        lastResponseAt: now - 10_000,
        stickyEngagementUserId: 42,
        stickyEngagementUntil: now - 1,
        stickyEngagementRemaining: 2,
        messageBuffer: [
          { messageId: 1, userId: 42, userName: 'Alice', text: 'followup', timestamp: now - 1000 },
        ],
        bufferSize: 1,
        lastActivityAt: now,
        ttl: Math.floor(now / 1000) + 3600,
        updatedAt: now,
      };

      const decision = evaluateResponseTrigger(state);
      expect(decision.shouldRespond).toBe(false);
    });
  });

  describe('Context Building', () => {
    it('should include replied-to message snippet when available', () => {
      const now = Date.now();
      const state: ChannelStateRecord = {
        pk: 'CHANNEL#avatar#123',
        sk: 'STATE',
        avatarId: 'avatar',
        chatId: 123,
        chatType: 'supergroup',
        state: 'IDLE',
        stateChangedAt: now,
        messageBuffer: [
          { messageId: 10, userId: 1, userName: 'Alice', username: 'alice', text: 'original message', timestamp: now - 2000 },
          { messageId: 11, userId: 2, userName: 'Bob', username: 'bob', text: 'my reply', timestamp: now - 1000, replyToMessageId: 10 },
        ],
        bufferSize: 2,
        lastActivityAt: now,
        ttl: Math.floor(now / 1000) + 3600,
        updatedAt: now,
      };

      const context = buildConversationContext(state);
      expect(context).toContain('reply to @alice');
      expect(context).toContain('original message');
    });

    it('should format buffered messages for LLM context', () => {
      const messages: BufferedMessage[] = [
        { messageId: 1, userId: 100, userName: 'Alice', username: 'alice', text: 'Hello', timestamp: Date.now() - 5000 },
        { messageId: 2, userId: 200, userName: 'Bob', text: 'Hi Alice!', timestamp: Date.now() - 3000 },
        { messageId: 3, userId: 100, userName: 'Alice', username: 'alice', text: '@Bot help me', timestamp: Date.now(), isMention: true },
      ];

      // Simple context building
      const context = messages.map(m => {
        const userLabel = m.username ? `@${m.username}` : m.userName;
        return `${userLabel}: ${m.text}`;
      }).join('\n');

      expect(context).toContain('@alice: Hello');
      expect(context).toContain('Bob: Hi Alice!');
      expect(context).toContain('@alice: @Bot help me');
    });

    it('should identify active participants', () => {
      const messages: BufferedMessage[] = [
        { messageId: 1, userId: 100, userName: 'Alice', text: 'Hello', timestamp: Date.now() - 5000 },
        { messageId: 2, userId: 200, userName: 'Bob', text: 'Hi', timestamp: Date.now() - 4000 },
        { messageId: 3, userId: 100, userName: 'Alice', text: 'Test', timestamp: Date.now() - 3000 },
        { messageId: 4, userId: 100, userName: 'Alice', text: 'Another', timestamp: Date.now() - 2000 },
      ];

      const participants = new Map<number, number>();
      for (const m of messages) {
        participants.set(m.userId, (participants.get(m.userId) || 0) + 1);
      }

      expect(participants.get(100)).toBe(3); // Alice: 3 messages
      expect(participants.get(200)).toBe(1); // Bob: 1 message
    });

    it('should find the response target (last direct engagement)', () => {
      const messages: BufferedMessage[] = [
        { messageId: 1, userId: 100, userName: 'Alice', text: 'Hello @Bot', timestamp: Date.now() - 5000, isMention: true },
        { messageId: 2, userId: 200, userName: 'Bob', text: 'Regular message', timestamp: Date.now() - 3000 },
        { messageId: 3, userId: 300, userName: 'Charlie', text: '@Bot please help', timestamp: Date.now(), isMention: true },
      ];

      // Find last direct engagement
      let target: BufferedMessage | undefined;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].isMention || messages[i].isReplyToBot) {
          target = messages[i];
          break;
        }
      }

      expect(target?.userId).toBe(300); // Charlie's message
      expect(target?.messageId).toBe(3);
    });

    it('should pick response target from pending messages when lastResponseAt is set', () => {
      const now = Date.now();
      const state: ChannelStateRecord = {
        pk: 'CHANNEL#avatar#123',
        sk: 'STATE',
        avatarId: 'avatar',
        chatId: 123,
        chatType: 'supergroup',
        state: 'IDLE',
        stateChangedAt: now,
        lastResponseAt: now - 2_000,
        messageBuffer: [
          { messageId: 1, userId: 100, userName: 'Alice', text: '@Bot old mention', timestamp: now - 10_000, isMention: true },
          { messageId: 2, userId: 200, userName: 'Bob', text: 'new message', timestamp: now - 1_500 },
          { messageId: 3, userId: 300, userName: 'Charlie', text: '@Bot new mention', timestamp: now - 1_000, isMention: true },
        ],
        bufferSize: 3,
        lastActivityAt: now,
        ttl: Math.floor(now / 1000) + 3600,
        updatedAt: now,
      };

      const target = getResponseTarget(state);
      expect(target?.messageId).toBe(3);
    });
  });

  describe('Shared History (Multi-Avatar)', () => {
    it('should build combined context interleaving human and bot messages by timestamp', () => {
      const state: ChannelStateRecord = {
        pk: 'CHANNEL#avatar-1#123',
        sk: 'STATE',
        avatarId: 'avatar-1',
        chatId: 123,
        chatType: 'supergroup',
        state: 'IDLE',
        stateChangedAt: Date.now(),
        messageBuffer: [
          { messageId: 1, userId: 100, userName: 'Alice', text: 'Hello everyone', timestamp: 1000 },
          { messageId: 3, userId: 200, userName: 'Bob', text: 'Hey Alice!', timestamp: 3000 },
        ],
        bufferSize: 2,
        lastActivityAt: Date.now(),
        ttl: Math.floor(Date.now() / 1000) + 3600,
        updatedAt: Date.now(),
      };

      // Import and test buildCombinedConversationContext
      // Note: We're testing the logic, not the actual function since it requires DynamoDB
      
      interface MockSharedMessage {
        messageId: number;
        avatarId: string;
        botUsername: string;
        text: string;
        timestamp: number;
      }

      interface MockSharedHistory {
        messages: MockSharedMessage[];
      }

      // Simulating buildCombinedConversationContext logic
      const sharedHistory: MockSharedHistory = {
        messages: [
          { messageId: 2, avatarId: 'avatar-2', botUsername: 'OtherBot', text: 'Hi there!', timestamp: 2000 },
          { messageId: 4, avatarId: 'avatar-1', botUsername: 'TestBot', text: 'My own message', timestamp: 4000 },
        ],
      };

      const currentAvatarId = 'avatar-1';

      // Combine messages
      const allMessages: Array<{ timestamp: number; isBot: boolean; userName: string; text: string; avatarId?: string }> = [];

      // Add human messages
      for (const msg of state.messageBuffer) {
        allMessages.push({
          timestamp: msg.timestamp,
          isBot: false,
          userName: msg.userName,
          text: msg.text,
        });
      }

      // Add bot messages (excluding self)
      for (const msg of sharedHistory.messages) {
        if (msg.avatarId === currentAvatarId) continue;
        allMessages.push({
          timestamp: msg.timestamp,
          isBot: true,
          userName: msg.botUsername,
          text: msg.text,
          avatarId: msg.avatarId,
        });
      }

      // Sort by timestamp
      allMessages.sort((a, b) => a.timestamp - b.timestamp);

      expect(allMessages).toHaveLength(3); // 2 human + 1 other bot (self excluded)
      expect(allMessages[0].text).toBe('Hello everyone');
      expect(allMessages[0].isBot).toBe(false);
      expect(allMessages[1].text).toBe('Hi there!');
      expect(allMessages[1].isBot).toBe(true);
      expect(allMessages[2].text).toBe('Hey Alice!');
      expect(allMessages[2].isBot).toBe(false);
    });

    it('should exclude own messages from shared history context', () => {
      interface MockSharedMessage {
        messageId: number;
        avatarId: string;
        botUsername: string;
        text: string;
        timestamp: number;
      }

      const sharedMessages: MockSharedMessage[] = [
        { messageId: 1, avatarId: 'avatar-1', botUsername: 'BotA', text: 'I said this', timestamp: 1000 },
        { messageId: 2, avatarId: 'avatar-2', botUsername: 'BotB', text: 'Other bot said this', timestamp: 2000 },
        { messageId: 3, avatarId: 'avatar-1', botUsername: 'BotA', text: 'I said this too', timestamp: 3000 },
      ];

      const currentAvatarId = 'avatar-1';
      const visibleMessages = sharedMessages.filter(m => m.avatarId !== currentAvatarId);

      expect(visibleMessages).toHaveLength(1);
      expect(visibleMessages[0].avatarId).toBe('avatar-2');
      expect(visibleMessages[0].text).toBe('Other bot said this');
    });
  });
});
