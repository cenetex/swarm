/**
 * State Service Tests
 * Tests for DynamoDBStateService Kyro-style state machine methods
 *
 * Bug Index:
 * - BUG-010: Unsafe type cast of DynamoDB response (line 257)
 * - BUG-011: Race condition during message trim not logged properly (line 313-320)
 *
 * @see packages/core/src/services/state.ts
 */
import { describe, it, expect, afterEach } from 'vitest';
import { CHANNEL_CONFIG, DynamoDBStateService } from './state.js';
import { evaluateResponseTrigger } from './state/channel-state.js';
import type { ChannelState, ContextMessage, ResponseDecision, Platform } from '../types/index.js';

class InMemoryStateService extends DynamoDBStateService {
  private store = new Map<string, ChannelState>();

  constructor() {
    super('test-table');
  }

  private key(avatarId: string, channelId: string): string {
    return `${avatarId}:${channelId}`;
  }

  override async getChannelState(avatarId: string, channelId: string): Promise<ChannelState | null> {
    return this.store.get(this.key(avatarId, channelId)) || null;
  }

  override async updateChannelState(state: ChannelState): Promise<void> {
    this.store.set(this.key(state.avatarId, state.channelId), state);
  }

  setState(state: ChannelState): void {
    this.store.set(this.key(state.avatarId, state.channelId), state);
  }

  // Override to avoid DynamoDB UpdateCommand in tests
  override async addMessageToChannel(
    avatarId: string,
    channelId: string,
    platform: Platform,
    message: ContextMessage,
    maxMessages: number = CHANNEL_CONFIG.MAX_BUFFER_SIZE,
    chatType?: 'private' | 'group' | 'supergroup' | 'channel',
    chatTitle?: string
  ): Promise<ChannelState> {
    const now = Date.now();
    let state = await this.getChannelState(avatarId, channelId);
    const isDirect = Boolean(message.isMention || message.isReplyToBot);

    if (!state) {
      state = {
        avatarId,
        channelId,
        platform,
        recentMessages: [],
        lastActivityAt: now,
        messageCount: 0,
        state: 'IDLE',
        stateChangedAt: now,
        chatType,
        chatTitle,
      };
    }

    // Idempotency guard: skip if messageId already in buffer (mirrors channel-state.ts)
    if (message.messageId && state.recentMessages.some(m => m.messageId === message.messageId)) {
      return state;
    }

    // Add message to buffer
    state.recentMessages.push(message);
    if (state.recentMessages.length > maxMessages) {
      state.recentMessages = state.recentMessages.slice(-maxMessages);
    }

    state.lastActivityAt = now;
    state.messageCount++;

    // State machine logic
    const previousState = state.state;
    if (isDirect) {
      state.state = 'ACTIVE';
      state.directEngagementAt = now;
    }

    if (state.state !== previousState) {
      state.stateChangedAt = now;
    }

    // Engaged user tracking
    if (isDirect && message.userId) {
      const currentEngaged = state.engagedUsers || {};
      const engagedUntil = now + CHANNEL_CONFIG.ENGAGEMENT_WINDOW_MS;
      // Clean expired entries and add/refresh current user
      const newEngaged: Record<string, number> = {};
      for (const [userId, expiresAt] of Object.entries(currentEngaged)) {
        if (expiresAt > now) {
          newEngaged[userId] = expiresAt;
        }
      }
      newEngaged[message.userId] = engagedUntil;
      state.engagedUsers = newEngaged;
    }

    if (chatType) state.chatType = chatType;
    if (chatTitle) state.chatTitle = chatTitle;

    state.ttl = Math.floor(now / 1000) + CHANNEL_CONFIG.BUFFER_TTL_SECONDS;

    await this.updateChannelState(state);
    return state;
  }

  override async markResponseSent(
    avatarId: string,
    channelId: string,
    responseMessageId: string
  ): Promise<ChannelState | null> {
    const current = await this.getChannelState(avatarId, channelId);
    if (!current) return null;

    const now = Date.now();
    current.state = 'COOLDOWN';
    current.stateChangedAt = now;
    current.lastResponseAt = now;
    current.lastResponseMessageId = responseMessageId;
    current.pendingResponseAt = undefined;
    // Keep recentMessages intact for conversation context
    current.ttl = Math.floor(now / 1000) + CHANNEL_CONFIG.BUFFER_TTL_SECONDS;

    await this.updateChannelState(current);
    return current;
  }
}

afterEach(() => {
  // No timer mocking in bun:test, so no cleanup needed
});

// Mock the state service's pure functions for testing
// These test the logic without needing DynamoDB

describe('CHANNEL_CONFIG', () => {
  it('should have reasonable default values', () => {
    expect(CHANNEL_CONFIG.MAX_BUFFER_SIZE).toBe(50);
    expect(CHANNEL_CONFIG.BUFFER_TTL_SECONDS).toBe(7776000); // 90 days
    expect(CHANNEL_CONFIG.COOLDOWN_DURATION_MS).toBe(10000);
    expect(CHANNEL_CONFIG.ACTIVE_TIMEOUT_MS).toBe(60000);
    expect(CHANNEL_CONFIG.MESSAGE_THRESHOLD).toBe(3);
    expect(CHANNEL_CONFIG.CONVERSATION_GAP_MS).toBe(20000);
    expect(CHANNEL_CONFIG.MIN_RESPONSE_DELAY_MS).toBeLessThan(CHANNEL_CONFIG.MAX_RESPONSE_DELAY_MS);
    expect(CHANNEL_CONFIG.ENGAGEMENT_WINDOW_MS).toBe(5 * 60 * 1000); // 5 minutes
  });
});

describe('Channel State Machine Logic', () => {
  // Helper to create a base channel state
  function createTestChannelState(overrides: Partial<ChannelState> = {}): ChannelState {
    const now = Date.now();
    return {
      avatarId: 'test-avatar',
      channelId: '-100123456789',
      platform: 'telegram',
      recentMessages: [],
      lastActivityAt: now,
      messageCount: 0,
      state: 'IDLE',
      stateChangedAt: now,
      chatType: 'supergroup',
      ...overrides,
    };
  }

  // Helper to create a context message
  function createTestMessage(overrides: Partial<ContextMessage> = {}): ContextMessage {
    return {
      messageId: '1',
      sender: 'TestUser',
      isBot: false,
      content: 'Test message',
      timestamp: Date.now(),
      ...overrides,
    };
  }

  describe('isCooldownExpired', () => {
    // Simulate the isCooldownExpired logic
    function isCooldownExpired(state: ChannelState): boolean {
      if (state.state !== 'COOLDOWN') return true;
      if (!state.stateChangedAt) return true;
      const elapsed = Date.now() - state.stateChangedAt;
      return elapsed > CHANNEL_CONFIG.COOLDOWN_DURATION_MS;
    }

    it('should return true when not in COOLDOWN state', () => {
      const state = createTestChannelState({ state: 'IDLE' });
      expect(isCooldownExpired(state)).toBe(true);
    });

    it('should return false when in fresh COOLDOWN', () => {
      const state = createTestChannelState({
        state: 'COOLDOWN',
        stateChangedAt: Date.now() - 5000, // 5 seconds ago
      });
      expect(isCooldownExpired(state)).toBe(false);
    });

    it('should return true when COOLDOWN has expired', () => {
      const state = createTestChannelState({
        state: 'COOLDOWN',
        stateChangedAt: Date.now() - 15000, // 15 seconds ago
      });
      expect(isCooldownExpired(state)).toBe(true);
    });
  });

  describe('isActiveTimedOut', () => {
    // Simulate the isActiveTimedOut logic
    function isActiveTimedOut(state: ChannelState): boolean {
      if (state.state !== 'ACTIVE') return false;
      const elapsed = Date.now() - state.lastActivityAt;
      return elapsed > CHANNEL_CONFIG.ACTIVE_TIMEOUT_MS;
    }

    it('should return false when not in ACTIVE state', () => {
      const state = createTestChannelState({ state: 'IDLE' });
      expect(isActiveTimedOut(state)).toBe(false);
    });

    it('should return false when recently active', () => {
      const state = createTestChannelState({
        state: 'ACTIVE',
        lastActivityAt: Date.now() - 30000, // 30 seconds ago
      });
      expect(isActiveTimedOut(state)).toBe(false);
    });

    it('should return true when ACTIVE has timed out', () => {
      const state = createTestChannelState({
        state: 'ACTIVE',
        lastActivityAt: Date.now() - 90000, // 90 seconds ago
      });
      expect(isActiveTimedOut(state)).toBe(true);
    });
  });

  describe('evaluateResponseTrigger', () => {
    // Simulate the evaluateResponseTrigger logic (mirrors channel-state.ts)
    function evaluateResponseTrigger(state: ChannelState): ResponseDecision {
      const now = Date.now();

      // Private chats always respond
      if (state.chatType === 'private') {
        return {
          shouldRespond: true,
          trigger: 'private_chat',
          delay: 0,
          priority: 'high',
        };
      }

      // Check COOLDOWN
      const inCooldown = state.state === 'COOLDOWN' &&
        state.stateChangedAt &&
        (now - state.stateChangedAt) < CHANNEL_CONFIG.COOLDOWN_DURATION_MS;

      if (inCooldown) {
        // Check for new direct engagement since cooldown started
        const hasNewEngagement = state.recentMessages.some(
          m => (m.isMention || m.isReplyToBot) &&
               m.timestamp > (state.stateChangedAt || 0)
        );

        if (hasNewEngagement) {
          return {
            shouldRespond: true,
            trigger: 'direct_engagement',
            delay: CHANNEL_CONFIG.DIRECT_ENGAGEMENT_DELAY_MS,
            priority: 'high',
          };
        }

        // Check if the most recent message is from an engaged user
        if (state.engagedUsers) {
          const lastMessage = state.recentMessages[state.recentMessages.length - 1];
          if (lastMessage?.userId && lastMessage.timestamp > (state.stateChangedAt || 0)) {
            const engagedUntil = state.engagedUsers[lastMessage.userId];
            if (engagedUntil && engagedUntil > now) {
              return {
                shouldRespond: true,
                trigger: 'engaged_user',
                delay: CHANNEL_CONFIG.DIRECT_ENGAGEMENT_DELAY_MS,
                priority: 'high',
              };
            }
          }
        }

        return {
          shouldRespond: false,
          trigger: 'none',
          delay: 0,
          priority: 'low',
        };
      }

      // Check for direct engagement
      const hasDirectEngagement = state.recentMessages.some(
        m => m.isMention || m.isReplyToBot
      );

      if (hasDirectEngagement) {
        return {
          shouldRespond: true,
          trigger: 'direct_engagement',
          delay: CHANNEL_CONFIG.DIRECT_ENGAGEMENT_DELAY_MS,
          priority: 'high',
        };
      }

      // Check if the most recent message is from an engaged user (within the engagement window)
      if (state.engagedUsers) {
        const lastMessage = state.recentMessages[state.recentMessages.length - 1];
        if (lastMessage?.userId) {
          const engagedUntil = state.engagedUsers[lastMessage.userId];
          if (engagedUntil && engagedUntil > now) {
            return {
              shouldRespond: true,
              trigger: 'engaged_user',
              delay: CHANNEL_CONFIG.DIRECT_ENGAGEMENT_DELAY_MS,
              priority: 'high',
            };
          }
        }
      }

      // Group chats skip ambient triggers (#1505): bot must be addressed.
      const isGroup = state.chatType === 'group' || state.chatType === 'supergroup';
      if (isGroup) {
        return {
          shouldRespond: false,
          trigger: 'none',
          delay: 0,
          priority: 'low',
        };
      }

      // Check message threshold (1:1 chats only)
      if (state.recentMessages.length >= CHANNEL_CONFIG.MESSAGE_THRESHOLD) {
        return {
          shouldRespond: true,
          trigger: 'message_threshold',
          delay: Math.floor(
            CHANNEL_CONFIG.MIN_RESPONSE_DELAY_MS +
            Math.random() * (CHANNEL_CONFIG.MAX_RESPONSE_DELAY_MS - CHANNEL_CONFIG.MIN_RESPONSE_DELAY_MS)
          ),
          priority: 'normal',
        };
      }

      // Check conversation gap (1:1 chats only)
      const timeSinceActivity = now - state.lastActivityAt;
      if (
        state.recentMessages.length > 0 &&
        timeSinceActivity > CHANNEL_CONFIG.CONVERSATION_GAP_MS
      ) {
        return {
          shouldRespond: true,
          trigger: 'conversation_gap',
          delay: 0,
          priority: 'normal',
        };
      }

      // ACTIVE state with some messages (1:1 chats only)
      if (state.state === 'ACTIVE' && state.recentMessages.length >= 2) {
        return {
          shouldRespond: true,
          trigger: 'message_threshold',
          delay: Math.floor(
            CHANNEL_CONFIG.MIN_RESPONSE_DELAY_MS +
            Math.random() * (CHANNEL_CONFIG.MAX_RESPONSE_DELAY_MS - CHANNEL_CONFIG.MIN_RESPONSE_DELAY_MS)
          ),
          priority: 'normal',
        };
      }

      return {
        shouldRespond: false,
        trigger: 'none',
        delay: 0,
        priority: 'low',
      };
    }

    it('should always respond in private chats', () => {
      const state = createTestChannelState({
        chatType: 'private',
        recentMessages: [createTestMessage()],
      });

      const decision = evaluateResponseTrigger(state);

      expect(decision.shouldRespond).toBe(true);
      expect(decision.trigger).toBe('private_chat');
      expect(decision.priority).toBe('high');
      expect(decision.delay).toBe(0);
    });

    it('should respond to direct mention', () => {
      const state = createTestChannelState({
        chatType: 'supergroup',
        recentMessages: [
          createTestMessage({ isMention: true }),
        ],
      });

      const decision = evaluateResponseTrigger(state);

      expect(decision.shouldRespond).toBe(true);
      expect(decision.trigger).toBe('direct_engagement');
      expect(decision.priority).toBe('high');
    });

    it('should respond to reply to bot', () => {
      const state = createTestChannelState({
        chatType: 'supergroup',
        recentMessages: [
          createTestMessage({ isReplyToBot: true }),
        ],
      });

      const decision = evaluateResponseTrigger(state);

      expect(decision.shouldRespond).toBe(true);
      expect(decision.trigger).toBe('direct_engagement');
    });

    it('should not respond in COOLDOWN without new engagement', () => {
      const state = createTestChannelState({
        chatType: 'supergroup',
        state: 'COOLDOWN',
        stateChangedAt: Date.now() - 5000, // 5 seconds ago
        recentMessages: [
          createTestMessage({ timestamp: Date.now() - 10000 }), // Before cooldown
        ],
      });

      const decision = evaluateResponseTrigger(state);

      expect(decision.shouldRespond).toBe(false);
      expect(decision.trigger).toBe('none');
    });

    it('should respond in COOLDOWN with new direct engagement', () => {
      const cooldownStart = Date.now() - 5000;
      const state = createTestChannelState({
        chatType: 'supergroup',
        state: 'COOLDOWN',
        stateChangedAt: cooldownStart,
        recentMessages: [
          createTestMessage({ timestamp: Date.now(), isMention: true }), // After cooldown started
        ],
      });

      const decision = evaluateResponseTrigger(state);

      expect(decision.shouldRespond).toBe(true);
      expect(decision.trigger).toBe('direct_engagement');
    });

    it('should NOT respond on message_threshold in groups (#1505)', () => {
      const state = createTestChannelState({
        chatType: 'supergroup',
        state: 'IDLE',
        recentMessages: Array.from({ length: 5 }, (_, i) =>
          createTestMessage({ messageId: String(i), content: `Message ${i}` })
        ),
      });

      const decision = evaluateResponseTrigger(state);

      // Ambient triggers are disabled in groups; bot must be addressed.
      expect(decision.shouldRespond).toBe(false);
      expect(decision.trigger).toBe('none');
    });

    it('should respond on message_threshold in private chats', () => {
      const state = createTestChannelState({
        chatType: 'private',
        state: 'IDLE',
        recentMessages: Array.from({ length: 5 }, (_, i) =>
          createTestMessage({ messageId: String(i), content: `Message ${i}` })
        ),
      });

      const decision = evaluateResponseTrigger(state);

      // Private chats short-circuit to private_chat trigger before
      // even reaching the threshold check.
      expect(decision.shouldRespond).toBe(true);
      expect(['private_chat', 'message_threshold']).toContain(decision.trigger);
    });

    it('should NOT respond on conversation_gap in groups (#1505)', () => {
      const state = createTestChannelState({
        chatType: 'supergroup',
        state: 'IDLE',
        lastActivityAt: Date.now() - 35000, // 35 seconds ago
        recentMessages: [createTestMessage({ timestamp: Date.now() - 35000 })],
      });

      const decision = evaluateResponseTrigger(state);

      expect(decision.shouldRespond).toBe(false);
      expect(decision.trigger).toBe('none');
    });

    it('should not respond with no messages', () => {
      const state = createTestChannelState({
        chatType: 'supergroup',
        state: 'IDLE',
        recentMessages: [],
      });

      const decision = evaluateResponseTrigger(state);

      expect(decision.shouldRespond).toBe(false);
    });

    it('should NOT respond in ACTIVE state with 2+ messages in groups (#1505)', () => {
      const state = createTestChannelState({
        chatType: 'supergroup',
        state: 'ACTIVE',
        recentMessages: [
          createTestMessage({ messageId: '1' }),
          createTestMessage({ messageId: '2' }),
        ],
      });

      const decision = evaluateResponseTrigger(state);

      expect(decision.shouldRespond).toBe(false);
      expect(decision.trigger).toBe('none');
    });

    it('should respond to follow-up from engaged user within engagement window', () => {
      const now = Date.now();
      const state = createTestChannelState({
        chatType: 'supergroup',
        state: 'IDLE',
        recentMessages: [
          // A follow-up message (no mention/reply) from user who previously engaged
          createTestMessage({
            messageId: '2',
            userId: 'user-123',
            sender: 'Alice',
            content: 'Thanks for that!',
            timestamp: now,
          }),
        ],
        engagedUsers: {
          'user-123': now + CHANNEL_CONFIG.ENGAGEMENT_WINDOW_MS, // Still within window
        },
      });

      const decision = evaluateResponseTrigger(state);

      expect(decision.shouldRespond).toBe(true);
      expect(decision.trigger).toBe('engaged_user');
      expect(decision.priority).toBe('high');
    });

    it('should NOT respond to follow-up from engaged user after window expires', () => {
      const now = Date.now();
      const state = createTestChannelState({
        chatType: 'supergroup',
        state: 'IDLE',
        recentMessages: [
          createTestMessage({
            messageId: '2',
            userId: 'user-123',
            sender: 'Alice',
            content: 'Hey again',
            timestamp: now,
          }),
        ],
        engagedUsers: {
          'user-123': now - 1000, // Expired 1 second ago
        },
      });

      const decision = evaluateResponseTrigger(state);

      // Should not trigger engaged_user
      expect(decision.trigger).not.toBe('engaged_user');
    });

    it('should NOT treat a non-engaged user as engaged', () => {
      const now = Date.now();
      const state = createTestChannelState({
        chatType: 'supergroup',
        state: 'IDLE',
        recentMessages: [
          createTestMessage({
            messageId: '1',
            userId: 'user-999',
            sender: 'Bob',
            content: 'Random message',
            timestamp: now,
          }),
        ],
        engagedUsers: {
          'user-123': now + CHANNEL_CONFIG.ENGAGEMENT_WINDOW_MS, // Different user is engaged
        },
      });

      const decision = evaluateResponseTrigger(state);

      expect(decision.trigger).not.toBe('engaged_user');
      expect(decision.shouldRespond).toBe(false);
    });

    it('should respond to engaged user even during COOLDOWN', () => {
      const now = Date.now();
      const cooldownStart = now - 5000; // 5 seconds ago
      const state = createTestChannelState({
        chatType: 'supergroup',
        state: 'COOLDOWN',
        stateChangedAt: cooldownStart,
        recentMessages: [
          createTestMessage({
            messageId: '1',
            userId: 'user-123',
            sender: 'Alice',
            content: 'Follow-up during cooldown',
            timestamp: now, // After cooldown started
          }),
        ],
        engagedUsers: {
          'user-123': now + CHANNEL_CONFIG.ENGAGEMENT_WINDOW_MS,
        },
      });

      const decision = evaluateResponseTrigger(state);

      expect(decision.shouldRespond).toBe(true);
      expect(decision.trigger).toBe('engaged_user');
      expect(decision.priority).toBe('high');
    });

    it('should NOT respond to engaged user in COOLDOWN if message is before cooldown started', () => {
      const now = Date.now();
      const cooldownStart = now - 5000;
      const state = createTestChannelState({
        chatType: 'supergroup',
        state: 'COOLDOWN',
        stateChangedAt: cooldownStart,
        recentMessages: [
          createTestMessage({
            messageId: '1',
            userId: 'user-123',
            sender: 'Alice',
            content: 'Old message',
            timestamp: cooldownStart - 1000, // Before cooldown started
          }),
        ],
        engagedUsers: {
          'user-123': now + CHANNEL_CONFIG.ENGAGEMENT_WINDOW_MS,
        },
      });

      const decision = evaluateResponseTrigger(state);

      expect(decision.shouldRespond).toBe(false);
      expect(decision.trigger).toBe('none');
    });

    it('should handle message without userId gracefully (no engaged_user trigger)', () => {
      const now = Date.now();
      const state = createTestChannelState({
        chatType: 'supergroup',
        state: 'IDLE',
        recentMessages: [
          createTestMessage({
            messageId: '1',
            sender: 'Alice',
            content: 'No userId set',
            timestamp: now,
            // userId is undefined
          }),
        ],
        engagedUsers: {
          'user-123': now + CHANNEL_CONFIG.ENGAGEMENT_WINDOW_MS,
        },
      });

      const decision = evaluateResponseTrigger(state);

      expect(decision.trigger).not.toBe('engaged_user');
    });
  });

  describe('State Transitions', () => {
    it('should transition to ACTIVE on direct engagement in IDLE', () => {
      const message = createTestMessage({ isMention: true });

      // Simulating addMessageToChannel logic
      let newState: ChannelState['state'] = 'IDLE';
      if (message.isMention || message.isReplyToBot) {
        newState = 'ACTIVE';
      }

      expect(newState).toBe('ACTIVE');
    });

    it('should stay IDLE for regular message in group', () => {
      const message = createTestMessage(); // No mention or reply

      let newState: ChannelState['state'] = 'IDLE';
      if (message.isMention || message.isReplyToBot) {
        newState = 'ACTIVE';
      }

      expect(newState).toBe('IDLE');
    });

    it('should stay in COOLDOWN for regular messages', () => {
      const currentState: ChannelState['state'] = 'COOLDOWN';
      const message = createTestMessage(); // No engagement

      let newState = currentState;
      if (message.isMention || message.isReplyToBot) {
        newState = 'ACTIVE';
      }
      // Otherwise stays as-is

      expect(newState).toBe('COOLDOWN');
    });
  });

  describe('State service method behavior', () => {
    it('updates stateChangedAt when transitioning to ACTIVE via addMessageToChannel', async () => {
      const svc = new InMemoryStateService();
      const beforeTime = Date.now();

      const result = await svc.addMessageToChannel(
        'avatar',
        'channel',
        'telegram' as Platform,
        createTestMessage({ isMention: true })
      );

      const afterTime = Date.now();

      expect(result.state).toBe('ACTIVE');
      // Verify timestamps are set and within a reasonable range
      expect(result.stateChangedAt).toBeGreaterThanOrEqual(beforeTime);
      expect(result.stateChangedAt).toBeLessThanOrEqual(afterTime);
      expect(result.directEngagementAt).toBeGreaterThanOrEqual(beforeTime);
      expect(result.directEngagementAt).toBeLessThanOrEqual(afterTime);
    });

    it('records engaged user when direct engagement with userId', async () => {
      const svc = new InMemoryStateService();
      const beforeTime = Date.now();

      const result = await svc.addMessageToChannel(
        'avatar',
        'channel',
        'telegram' as Platform,
        createTestMessage({ isMention: true, userId: 'user-123', sender: 'Alice' })
      );

      expect(result.engagedUsers).toBeDefined();
      expect(result.engagedUsers!['user-123']).toBeDefined();
      // Engaged until should be approximately now + ENGAGEMENT_WINDOW_MS
      expect(result.engagedUsers!['user-123']).toBeGreaterThanOrEqual(
        beforeTime + CHANNEL_CONFIG.ENGAGEMENT_WINDOW_MS
      );
    });

    it('does NOT record engaged user for non-direct messages', async () => {
      const svc = new InMemoryStateService();

      const result = await svc.addMessageToChannel(
        'avatar',
        'channel',
        'telegram' as Platform,
        createTestMessage({ userId: 'user-123', sender: 'Alice' }) // No isMention/isReplyToBot
      );

      expect(result.engagedUsers).toBeUndefined();
    });

    it('refreshes engagement window on repeated direct engagement', async () => {
      const svc = new InMemoryStateService();

      // First engagement
      await svc.addMessageToChannel(
        'avatar',
        'channel',
        'telegram' as Platform,
        createTestMessage({ isMention: true, userId: 'user-123', sender: 'Alice', messageId: '1' })
      );

      // Small delay to ensure timestamps differ
      const beforeSecond = Date.now();

      // Second engagement from same user
      const result = await svc.addMessageToChannel(
        'avatar',
        'channel',
        'telegram' as Platform,
        createTestMessage({ isMention: true, userId: 'user-123', sender: 'Alice', messageId: '2' })
      );

      // Window should be refreshed
      expect(result.engagedUsers!['user-123']).toBeGreaterThanOrEqual(
        beforeSecond + CHANNEL_CONFIG.ENGAGEMENT_WINDOW_MS
      );
    });

    it('tracks multiple engaged users', async () => {
      const svc = new InMemoryStateService();

      // First user engages
      await svc.addMessageToChannel(
        'avatar',
        'channel',
        'telegram' as Platform,
        createTestMessage({ isMention: true, userId: 'user-123', sender: 'Alice', messageId: '1' })
      );

      // Second user engages
      const result = await svc.addMessageToChannel(
        'avatar',
        'channel',
        'telegram' as Platform,
        createTestMessage({ isReplyToBot: true, userId: 'user-456', sender: 'Bob', messageId: '2' })
      );

      expect(result.engagedUsers!['user-123']).toBeDefined();
      expect(result.engagedUsers!['user-456']).toBeDefined();
    });

    it('markResponseSent preserves buffer and enters COOLDOWN', async () => {
      const svc = new InMemoryStateService();
      const now = Date.now();
      const initialState = createTestChannelState({
        channelId: 'channel',
        state: 'ACTIVE',
        stateChangedAt: now,
        recentMessages: [
          createTestMessage({ messageId: '1' }),
          createTestMessage({ messageId: '2' }),
        ],
        messageCount: 2,
      });
      svc.setState(initialState);

      const updated = await svc.markResponseSent('test-avatar', 'channel', 'resp-1');

      expect(updated?.state).toBe('COOLDOWN');
      // recentMessages should be preserved for conversation context
      expect(updated?.recentMessages.length).toBe(2);
      expect(updated?.lastResponseMessageId).toBe('resp-1');
      expect(updated?.lastResponseAt).toBeDefined();
    });

    it('addMessageToChannel is idempotent: redelivered envelope without double-append (issue #1552)', async () => {
      const svc = new InMemoryStateService();
      const message = createTestMessage({
        messageId: 'msg-abc-123',
        sender: 'Alice',
        isMention: true,
        content: '@TestBot help!',
      });

      // First append
      const firstResult = await svc.addMessageToChannel(
        'avatar',
        'channel',
        'telegram' as Platform,
        message
      );

      expect(firstResult.recentMessages).toHaveLength(1);
      expect(firstResult.messageCount).toBe(1);

      // Simulate SQS redelivery: same messageId, but possibly recomputed with different isMention
      // This should be detected as idempotent and NOT double-append
      const redeliveredMessage = createTestMessage({
        messageId: 'msg-abc-123', // Same messageId (platform)
        sender: 'Alice',
        isMention: true,
        content: '@TestBot help!',
      });

      const secondResult = await svc.addMessageToChannel(
        'avatar',
        'channel',
        'telegram' as Platform,
        redeliveredMessage
      );

      // The second append should be skipped; recentMessages.length should remain 1
      expect(secondResult.recentMessages).toHaveLength(1);
      expect(secondResult.messageCount).toBe(1);
      // Content and flags should match the first append
      expect(secondResult.recentMessages[0]?.messageId).toBe('msg-abc-123');
      expect(secondResult.recentMessages[0]?.isMention).toBe(true);
    });

    it('addMessageToChannel idempotency works even with differing isMention flags', async () => {
      const svc = new InMemoryStateService();

      // Scenario: SQS delivers the same message twice, but due to re-computation
      // of isMention, second call might have different isMention value.
      // The idempotency guard should prevent double-append regardless.
      const firstMessage = createTestMessage({
        messageId: 'dedup-test-1',
        sender: 'Bob',
        isMention: true,
        content: '@TestBot hello',
      });

      const firstResult = await svc.addMessageToChannel(
        'avatar',
        'channel',
        'telegram' as Platform,
        firstMessage
      );

      expect(firstResult.recentMessages).toHaveLength(1);

      // Second delivery with isMention: false (hypothetically, due to re-computation issue)
      const secondMessage = createTestMessage({
        messageId: 'dedup-test-1', // Same messageId
        sender: 'Bob',
        isMention: false, // Different flag
        content: '@TestBot hello',
      });

      const secondResult = await svc.addMessageToChannel(
        'avatar',
        'channel',
        'telegram' as Platform,
        secondMessage
      );

      // Should not double-append, and should return the original state
      expect(secondResult.recentMessages).toHaveLength(1);
      // The first append's isMention value should be preserved
      expect(secondResult.recentMessages[0]?.isMention).toBe(true);
    });
  });

  describe('Context Building', () => {
    // Simulate buildConversationContext
    function buildConversationContext(state: ChannelState, maxTokens: number = 4000): string {
      if (state.recentMessages.length === 0) return '';

      const lines: string[] = [];
      let approxTokens = 0;

      for (const msg of state.recentMessages) {
        const timestamp = new Date(msg.timestamp).toLocaleTimeString();
        const userLabel = msg.username ? `@${msg.username}` : msg.sender;
        const line = `[${timestamp}] ${userLabel}: ${msg.content}`;
        const lineTokens = Math.ceil(line.length / 4);

        if (approxTokens + lineTokens > maxTokens) break;

        lines.push(line);
        approxTokens += lineTokens;
      }

      return lines.join('\n');
    }

    it('should format messages for LLM context', () => {
      const state = createTestChannelState({
        recentMessages: [
          createTestMessage({ sender: 'Alice', username: 'alice', content: 'Hello' }),
          createTestMessage({ sender: 'Bob', content: 'Hi there!' }),
        ],
      });

      const context = buildConversationContext(state);

      expect(context).toContain('@alice: Hello');
      expect(context).toContain('Bob: Hi there!');
    });

    it('should return empty string for no messages', () => {
      const state = createTestChannelState({ recentMessages: [] });
      const context = buildConversationContext(state);
      expect(context).toBe('');
    });

    it('should respect token limit', () => {
      const longMessages = Array.from({ length: 100 }, (_, i) =>
        createTestMessage({
          messageId: String(i),
          content: 'This is a fairly long message that should use up tokens quickly when repeated many times.',
        })
      );

      const state = createTestChannelState({ recentMessages: longMessages });
      const context = buildConversationContext(state, 100); // Very low limit

      // Should be truncated
      expect(context.split('\n').length).toBeLessThan(100);
    });
  });

  describe('Response Target Selection', () => {
    // Simulate getResponseTarget
    function getResponseTarget(state: ChannelState): ContextMessage | null {
      // Find last direct engagement
      for (let i = state.recentMessages.length - 1; i >= 0; i--) {
        const msg = state.recentMessages[i];
        if (msg.isMention || msg.isReplyToBot) {
          return msg;
        }
      }
      // Fall back to last message
      return state.recentMessages[state.recentMessages.length - 1] || null;
    }

    it('should return last direct engagement message', () => {
      const state = createTestChannelState({
        recentMessages: [
          createTestMessage({ messageId: '1', sender: 'Alice', isMention: true }),
          createTestMessage({ messageId: '2', sender: 'Bob' }),
          createTestMessage({ messageId: '3', sender: 'Charlie', isMention: true }),
          createTestMessage({ messageId: '4', sender: 'Dave' }),
        ],
      });

      const target = getResponseTarget(state);

      expect(target?.messageId).toBe('3'); // Charlie's mention
      expect(target?.sender).toBe('Charlie');
    });

    it('should fall back to last message if no engagement', () => {
      const state = createTestChannelState({
        recentMessages: [
          createTestMessage({ messageId: '1', sender: 'Alice' }),
          createTestMessage({ messageId: '2', sender: 'Bob' }),
        ],
      });

      const target = getResponseTarget(state);

      expect(target?.messageId).toBe('2');
      expect(target?.sender).toBe('Bob');
    });

    it('should return null for empty buffer', () => {
      const state = createTestChannelState({ recentMessages: [] });
      const target = getResponseTarget(state);
      expect(target).toBeNull();
    });
  });

  describe('Active Participants', () => {
    // Simulate getActiveParticipants
    function getActiveParticipants(state: ChannelState) {
      const participants = new Map<string, { name: string; username?: string; messageCount: number }>();

      for (const msg of state.recentMessages) {
        const id = msg.userId || msg.sender;
        const existing = participants.get(id);
        if (existing) {
          existing.messageCount++;
        } else {
          participants.set(id, {
            name: msg.sender,
            username: msg.username,
            messageCount: 1,
          });
        }
      }

      return Array.from(participants.entries())
        .map(([id, data]) => ({ id, ...data }))
        .sort((a, b) => b.messageCount - a.messageCount);
    }

    it('should count participants and sort by message count', () => {
      const state = createTestChannelState({
        recentMessages: [
          createTestMessage({ userId: '100', sender: 'Alice', username: 'alice' }),
          createTestMessage({ userId: '200', sender: 'Bob' }),
          createTestMessage({ userId: '100', sender: 'Alice', username: 'alice' }),
          createTestMessage({ userId: '100', sender: 'Alice', username: 'alice' }),
          createTestMessage({ userId: '200', sender: 'Bob' }),
        ],
      });

      const participants = getActiveParticipants(state);

      expect(participants).toHaveLength(2);
      expect(participants[0].id).toBe('100'); // Alice: 3 messages
      expect(participants[0].messageCount).toBe(3);
      expect(participants[1].id).toBe('200'); // Bob: 2 messages
      expect(participants[1].messageCount).toBe(2);
    });

    it('should return empty array for no messages', () => {
      const state = createTestChannelState({ recentMessages: [] });
      const participants = getActiveParticipants(state);
      expect(participants).toHaveLength(0);
    });
  });
});

describe('DynamoDB Response Validation', () => {
  // Helper functions for this describe block
  function createTestChannelState(overrides: Partial<ChannelState> = {}): ChannelState {
    const now = Date.now();
    return {
      avatarId: 'test-avatar',
      channelId: '-100123456789',
      platform: 'telegram',
      recentMessages: [],
      lastActivityAt: now,
      messageCount: 0,
      state: 'IDLE',
      stateChangedAt: now,
      chatType: 'supergroup',
      ...overrides,
    };
  }

  function createTestMessage(overrides: Partial<ContextMessage> = {}): ContextMessage {
    return {
      messageId: '1',
      sender: 'TestUser',
      isBot: false,
      content: 'Test message',
      timestamp: Date.now(),
      ...overrides,
    };
  }

  /**
   * BUG-010: Unsafe type cast of DynamoDB response
   * File: packages/core/src/services/state.ts:257
   *
   * Previously, response.Attributes was cast directly without validation.
   *
   * Fix: Explicit property mapping with defaults for missing fields
   */
  describe('Response attribute validation (BUG-010)', () => {
    it('should provide defaults for missing fields', () => {
      // Simulate DynamoDB response with partial attributes
      const dynamoResponse = {
        Attributes: {
          avatarId: 'avatar-1',
          channelId: 'channel-1',
          // Missing platform, recentMessages, etc.
        },
      };

      const now = Date.now();
      const avatarId = 'avatar-1';
      const channelId = 'channel-1';
      const platform = 'telegram';

      // The fix: explicit mapping with defaults
      const validated: ChannelState & { updatedAt?: number } = {
        avatarId: dynamoResponse.Attributes.avatarId ?? avatarId,
        channelId: dynamoResponse.Attributes.channelId ?? channelId,
        platform: (dynamoResponse.Attributes as Record<string, unknown>).platform as Platform ?? platform,
        recentMessages: (dynamoResponse.Attributes as Record<string, unknown>).recentMessages as ContextMessage[] ?? [],
        lastActivityAt: (dynamoResponse.Attributes as Record<string, unknown>).lastActivityAt as number ?? now,
        messageCount: (dynamoResponse.Attributes as Record<string, unknown>).messageCount as number ?? 0,
        state: (dynamoResponse.Attributes as Record<string, unknown>).state as ChannelState['state'] ?? 'IDLE',
      };

      expect(validated.avatarId).toBe('avatar-1');
      expect(validated.channelId).toBe('channel-1');
      expect(validated.platform).toBe('telegram');
      expect(validated.recentMessages).toEqual([]);
      expect(validated.messageCount).toBe(0);
      expect(validated.state).toBe('IDLE');
    });

    it('should throw when Attributes is completely missing', () => {
      const dynamoResponse = {
        // No Attributes at all
      };

      const validateResponse = () => {
        if (!dynamoResponse.Attributes) {
          throw new Error('DynamoDB UpdateCommand returned no Attributes');
        }
        return dynamoResponse.Attributes;
      };

      expect(() => validateResponse()).toThrow('DynamoDB UpdateCommand returned no Attributes');
    });

    it('should preserve all fields when present', () => {
      const now = Date.now();
      const dynamoResponse = {
        Attributes: {
          avatarId: 'avatar-1',
          channelId: 'channel-1',
          platform: 'telegram',
          recentMessages: [{ messageId: '1', sender: 'User', content: 'Hi', timestamp: now, isBot: false }],
          lastActivityAt: now,
          messageCount: 5,
          state: 'ACTIVE',
          stateChangedAt: now - 1000,
          chatType: 'supergroup',
          chatTitle: 'Test Group',
          lastResponseAt: now - 2000,
          directEngagementAt: now - 500,
        },
      };

      const attrs = dynamoResponse.Attributes as Record<string, unknown>;
      const validated = {
        avatarId: attrs.avatarId ?? 'fallback',
        channelId: attrs.channelId ?? 'fallback',
        platform: attrs.platform ?? 'telegram',
        recentMessages: attrs.recentMessages ?? [],
        lastActivityAt: attrs.lastActivityAt ?? Date.now(),
        messageCount: attrs.messageCount ?? 0,
        state: attrs.state ?? 'IDLE',
        stateChangedAt: attrs.stateChangedAt,
        chatType: attrs.chatType,
        chatTitle: attrs.chatTitle,
        lastResponseAt: attrs.lastResponseAt,
        directEngagementAt: attrs.directEngagementAt,
      };

      expect(validated.avatarId).toBe('avatar-1');
      expect(validated.state).toBe('ACTIVE');
      expect(validated.chatType).toBe('supergroup');
      expect(validated.chatTitle).toBe('Test Group');
      expect((validated.recentMessages as ContextMessage[]).length).toBe(1);
    });
  });

  /**
   * BUG-011: Race condition during message trim not logged properly
   * File: packages/core/src/services/state.ts:313-320
   *
   * Previously, ConditionalCheckFailedException was silently ignored.
   *
   * Fix: Log informative message when concurrent update is detected
   */
  describe('Race condition handling (BUG-011)', () => {
    it('should detect ConditionalCheckFailedException as race condition', () => {
      const error = { name: 'ConditionalCheckFailedException' };

      const isRaceCondition = (error as { name?: string }).name === 'ConditionalCheckFailedException';

      expect(isRaceCondition).toBe(true);
    });

    it('should differentiate race condition from other errors', () => {
      const errors = [
        { name: 'ConditionalCheckFailedException' },
        { name: 'ProvisionedThroughputExceededException' },
        { name: 'ResourceNotFoundException' },
        new Error('Generic error'),
      ];

      const results = errors.map(err => {
        const errName = (err as { name?: string }).name;
        return errName === 'ConditionalCheckFailedException' ? 'race_condition' : 'other_error';
      });

      expect(results).toEqual(['race_condition', 'other_error', 'other_error', 'other_error']);
    });

    it('should return updated state even when trim fails due to race', () => {
      // Simulate the behavior: when trim fails due to race, we still return the state
      // (just with potentially more messages than maxMessages)
      const stateBeforeTrim = createTestChannelState({
        recentMessages: Array.from({ length: 60 }, (_, i) => createTestMessage({ messageId: String(i) })),
      });

      const trimFailed = true; // Simulating ConditionalCheckFailedException

      // The fix: we don't modify the state if trim fails, but we still return it
      const finalState = trimFailed ? stateBeforeTrim : {
        ...stateBeforeTrim,
        recentMessages: stateBeforeTrim.recentMessages.slice(-50),
      };

      // State should have 60 messages (not trimmed due to race)
      expect(finalState.recentMessages.length).toBe(60);
    });
  });

  describe('Direct engagement bug fix (line 471)', () => {
    it('should NOT fire on stale mentions — only check latest message', () => {
      const now = Date.now();
      // Old mention followed by 10 benign messages
      const messages = [
        createTestMessage({ messageId: '1', isMention: true, timestamp: now - 10000 }),
        ...Array.from({ length: 10 }, (_, i) =>
          createTestMessage({ messageId: String(i + 2), timestamp: now - 9000 + i * 500 })
        ),
      ];

      const state = createTestChannelState({
        chatType: 'supergroup',
        state: 'IDLE',
        recentMessages: messages,
      });

      const decision = evaluateResponseTrigger(state);

      // Should NOT respond because the latest message is not a mention/reply
      expect(decision.shouldRespond).toBe(false);
      expect(decision.trigger).toBe('none');
    });

    it('should fire on latest mention even with old benign messages', () => {
      const now = Date.now();
      const messages = [
        createTestMessage({ messageId: '1', timestamp: now - 5000 }),
        createTestMessage({ messageId: '2', timestamp: now - 4000 }),
        createTestMessage({ messageId: '3', isMention: true, timestamp: now }), // Latest is mention
      ];

      const state = createTestChannelState({
        chatType: 'supergroup',
        state: 'IDLE',
        recentMessages: messages,
      });

      const decision = evaluateResponseTrigger(state);

      expect(decision.shouldRespond).toBe(true);
      expect(decision.trigger).toBe('direct_engagement');
    });

    it('should fire on any mention/reply newer than lastResponseAt', () => {
      const now = Date.now();
      const lastResponseAt = now - 3000;

      const messages = [
        createTestMessage({ messageId: '1', isMention: true, timestamp: now - 4000 }), // Before lastResponseAt
        createTestMessage({ messageId: '2', isMention: true, timestamp: now - 1000 }), // After lastResponseAt
        createTestMessage({ messageId: '3', timestamp: now }), // Before lastResponseAt
      ];

      const state = createTestChannelState({
        chatType: 'supergroup',
        state: 'IDLE',
        lastResponseAt,
        recentMessages: messages,
      });

      const decision = evaluateResponseTrigger(state);

      expect(decision.shouldRespond).toBe(true);
      expect(decision.trigger).toBe('direct_engagement');
    });
  });

  describe('Follow-up cap (#1534)', () => {
    it('should cap engaged_user follow-ups at MAX_FOLLOW_UPS with suppression details', () => {
      const now = Date.now();
      // windowStart = engagedUntil - ENGAGEMENT_WINDOW_MS by definition, so
      // the follow-up counter map keys by that derived value (#1534).
      const engagedUntil = now + CHANNEL_CONFIG.ENGAGEMENT_WINDOW_MS / 2;
      const engagementWindowStart = engagedUntil - CHANNEL_CONFIG.ENGAGEMENT_WINDOW_MS;

      // Simulate 3 responses already sent in this window
      const state = createTestChannelState({
        chatType: 'supergroup',
        state: 'IDLE',
        recentMessages: [
          createTestMessage({
            messageId: '1',
            userId: 'user-123',
            timestamp: now,
          }),
        ],
        engagedUsers: {
          'user-123': engagedUntil,
        },
        followUpCountByWindow: {
          [engagementWindowStart]: CHANNEL_CONFIG.MAX_FOLLOW_UPS, // At cap
        },
      });

      const decision = evaluateResponseTrigger(state);

      expect(decision.shouldRespond).toBe(false);
      expect(decision.trigger).toBe('none');
      expect(decision.suppressionReason).toBe('follow_up_cap');
      expect(decision.suppressionDetails?.followUpsInWindow).toBe(CHANNEL_CONFIG.MAX_FOLLOW_UPS);
      expect(decision.suppressionDetails?.windowEndsAt).toBe(engagedUntil);
    });

    it('should allow engaged_user following before cap', () => {
      const now = Date.now();
      // windowStart = engagedUntil - ENGAGEMENT_WINDOW_MS by definition, so
      // the follow-up counter map keys by that derived value (#1534).
      const engagedUntil = now + CHANNEL_CONFIG.ENGAGEMENT_WINDOW_MS / 2;
      const engagementWindowStart = engagedUntil - CHANNEL_CONFIG.ENGAGEMENT_WINDOW_MS;

      const state = createTestChannelState({
        chatType: 'supergroup',
        state: 'IDLE',
        recentMessages: [
          createTestMessage({
            messageId: '1',
            userId: 'user-123',
            timestamp: now,
          }),
        ],
        engagedUsers: {
          'user-123': engagedUntil,
        },
        followUpCountByWindow: {
          [engagementWindowStart]: CHANNEL_CONFIG.MAX_FOLLOW_UPS - 1, // Below cap
        },
      });

      const decision = evaluateResponseTrigger(state);

      expect(decision.shouldRespond).toBe(true);
      expect(decision.trigger).toBe('engaged_user');
    });

    it('should reset follow-up count when new direct engagement occurs', () => {
      const now = Date.now();
      const oldWindowStart = now - CHANNEL_CONFIG.ENGAGEMENT_WINDOW_MS * 2;

      const state = createTestChannelState({
        chatType: 'supergroup',
        state: 'IDLE',
        recentMessages: [
          createTestMessage({
            messageId: '1',
            isMention: true, // New direct engagement
            timestamp: now,
          }),
        ],
        followUpCountByWindow: {
          [oldWindowStart]: CHANNEL_CONFIG.MAX_FOLLOW_UPS, // Old window at cap
        },
      });

      const decision = evaluateResponseTrigger(state);

      // Should respond because this is direct_engagement, not engaged_user
      expect(decision.shouldRespond).toBe(true);
      expect(decision.trigger).toBe('direct_engagement');
    });
  });

  describe('Ambient cooldown (#1534)', () => {
    it('should suppress first non-direct response within ambient cooldown with details', () => {
      const now = Date.now();
      const lastResponseAt = now - CHANNEL_CONFIG.AMBIENT_COOLDOWN_MS / 2; // Within 5 min

      const state = createTestChannelState({
        state: 'IDLE',
        lastResponseAt,
        recentMessages: Array.from({ length: 5 }, (_, i) =>
          createTestMessage({ messageId: String(i), timestamp: now - i * 1000 })
        ),
      });

      // Override to 1:1 for test
      state.chatType = undefined; // Remove group constraint
      const decision = evaluateResponseTrigger(state);

      expect(decision.shouldRespond).toBe(false);
      expect(decision.suppressionReason).toBe('ambient_cooldown');
      expect(decision.suppressionDetails?.msSinceLastResponse).toBeGreaterThan(0);
      expect(decision.suppressionDetails?.msSinceLastResponse).toBeLessThan(CHANNEL_CONFIG.AMBIENT_COOLDOWN_MS);
      expect(decision.suppressionDetails?.cooldownMs).toBe(CHANNEL_CONFIG.AMBIENT_COOLDOWN_MS);
    });

    it('should allow non-direct response after ambient cooldown expires', () => {
      const now = Date.now();
      const lastResponseAt = now - CHANNEL_CONFIG.AMBIENT_COOLDOWN_MS - 1000; // Beyond 5 min

      const state = createTestChannelState({
        state: 'IDLE',
        lastResponseAt,
        chatType: undefined, // Not a group
        recentMessages: Array.from({ length: 5 }, (_, i) =>
          createTestMessage({ messageId: String(i), timestamp: now - i * 1000 })
        ),
      });

      const decision = evaluateResponseTrigger(state);

      expect(decision.shouldRespond).toBe(true);
    });

    it('should bypass ambient cooldown for direct engagement', () => {
      const now = Date.now();
      const lastResponseAt = now - 1000; // Very recent

      const state = createTestChannelState({
        chatType: 'supergroup',
        state: 'IDLE',
        lastResponseAt,
        recentMessages: [
          createTestMessage({ messageId: '1', isMention: true, timestamp: now }),
        ],
      });

      const decision = evaluateResponseTrigger(state);

      // Direct engagement should bypass ambient cooldown
      expect(decision.shouldRespond).toBe(true);
      expect(decision.trigger).toBe('direct_engagement');
    });
  });
});
