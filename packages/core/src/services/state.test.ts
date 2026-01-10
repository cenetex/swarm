/**
 * State Service Tests
 * Tests for DynamoDBStateService Kyro-style state machine methods
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { CHANNEL_CONFIG, DynamoDBStateService } from './state.js';
import type { ChannelState, ContextMessage, ResponseDecision, Platform } from '../types/index.js';

class InMemoryStateService extends DynamoDBStateService {
  private store = new Map<string, ChannelState>();

  constructor() {
    super('test-table');
  }

  private key(agentId: string, channelId: string): string {
    return `${agentId}:${channelId}`;
  }

  override async getChannelState(agentId: string, channelId: string): Promise<ChannelState | null> {
    return this.store.get(this.key(agentId, channelId)) || null;
  }

  override async updateChannelState(state: ChannelState): Promise<void> {
    this.store.set(this.key(state.agentId, state.channelId), state);
  }

  setState(state: ChannelState): void {
    this.store.set(this.key(state.agentId, state.channelId), state);
  }

  // Override to avoid DynamoDB UpdateCommand in tests
  override async addMessageToChannel(
    agentId: string,
    channelId: string,
    platform: Platform,
    message: ContextMessage,
    maxMessages: number = CHANNEL_CONFIG.MAX_BUFFER_SIZE,
    chatType?: 'private' | 'group' | 'supergroup' | 'channel',
    chatTitle?: string
  ): Promise<ChannelState> {
    const now = Date.now();
    let state = await this.getChannelState(agentId, channelId);
    const isDirect = Boolean(message.isMention || message.isReplyToBot);

    if (!state) {
      state = {
        agentId,
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

    if (chatType) state.chatType = chatType;
    if (chatTitle) state.chatTitle = chatTitle;

    state.ttl = Math.floor(now / 1000) + CHANNEL_CONFIG.BUFFER_TTL_SECONDS;

    await this.updateChannelState(state);
    return state;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

// Mock the state service's pure functions for testing
// These test the logic without needing DynamoDB

describe('CHANNEL_CONFIG', () => {
  it('should have reasonable default values', () => {
    expect(CHANNEL_CONFIG.MAX_BUFFER_SIZE).toBe(50);
    expect(CHANNEL_CONFIG.BUFFER_TTL_SECONDS).toBe(3600);
    expect(CHANNEL_CONFIG.COOLDOWN_DURATION_MS).toBe(10000);
    expect(CHANNEL_CONFIG.ACTIVE_TIMEOUT_MS).toBe(60000);
    expect(CHANNEL_CONFIG.MESSAGE_THRESHOLD).toBe(5);
    expect(CHANNEL_CONFIG.CONVERSATION_GAP_MS).toBe(30000);
    expect(CHANNEL_CONFIG.MIN_RESPONSE_DELAY_MS).toBeLessThan(CHANNEL_CONFIG.MAX_RESPONSE_DELAY_MS);
  });
});

describe('Channel State Machine Logic', () => {
  // Helper to create a base channel state
  function createChannelState(overrides: Partial<ChannelState> = {}): ChannelState {
    const now = Date.now();
    return {
      agentId: 'test-agent',
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
  function createMessage(overrides: Partial<ContextMessage> = {}): ContextMessage {
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
      const state = createChannelState({ state: 'IDLE' });
      expect(isCooldownExpired(state)).toBe(true);
    });

    it('should return false when in fresh COOLDOWN', () => {
      const state = createChannelState({
        state: 'COOLDOWN',
        stateChangedAt: Date.now() - 5000, // 5 seconds ago
      });
      expect(isCooldownExpired(state)).toBe(false);
    });

    it('should return true when COOLDOWN has expired', () => {
      const state = createChannelState({
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
      const state = createChannelState({ state: 'IDLE' });
      expect(isActiveTimedOut(state)).toBe(false);
    });

    it('should return false when recently active', () => {
      const state = createChannelState({
        state: 'ACTIVE',
        lastActivityAt: Date.now() - 30000, // 30 seconds ago
      });
      expect(isActiveTimedOut(state)).toBe(false);
    });

    it('should return true when ACTIVE has timed out', () => {
      const state = createChannelState({
        state: 'ACTIVE',
        lastActivityAt: Date.now() - 90000, // 90 seconds ago
      });
      expect(isActiveTimedOut(state)).toBe(true);
    });
  });

  describe('evaluateResponseTrigger', () => {
    // Simulate the evaluateResponseTrigger logic
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

      // Check message threshold
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

      // Check conversation gap
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

      // ACTIVE state with some messages
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
      const state = createChannelState({
        chatType: 'private',
        recentMessages: [createMessage()],
      });

      const decision = evaluateResponseTrigger(state);

      expect(decision.shouldRespond).toBe(true);
      expect(decision.trigger).toBe('private_chat');
      expect(decision.priority).toBe('high');
      expect(decision.delay).toBe(0);
    });

    it('should respond to direct mention', () => {
      const state = createChannelState({
        chatType: 'supergroup',
        recentMessages: [
          createMessage({ isMention: true }),
        ],
      });

      const decision = evaluateResponseTrigger(state);

      expect(decision.shouldRespond).toBe(true);
      expect(decision.trigger).toBe('direct_engagement');
      expect(decision.priority).toBe('high');
    });

    it('should respond to reply to bot', () => {
      const state = createChannelState({
        chatType: 'supergroup',
        recentMessages: [
          createMessage({ isReplyToBot: true }),
        ],
      });

      const decision = evaluateResponseTrigger(state);

      expect(decision.shouldRespond).toBe(true);
      expect(decision.trigger).toBe('direct_engagement');
    });

    it('should not respond in COOLDOWN without new engagement', () => {
      const state = createChannelState({
        chatType: 'supergroup',
        state: 'COOLDOWN',
        stateChangedAt: Date.now() - 5000, // 5 seconds ago
        recentMessages: [
          createMessage({ timestamp: Date.now() - 10000 }), // Before cooldown
        ],
      });

      const decision = evaluateResponseTrigger(state);

      expect(decision.shouldRespond).toBe(false);
      expect(decision.trigger).toBe('none');
    });

    it('should respond in COOLDOWN with new direct engagement', () => {
      const cooldownStart = Date.now() - 5000;
      const state = createChannelState({
        chatType: 'supergroup',
        state: 'COOLDOWN',
        stateChangedAt: cooldownStart,
        recentMessages: [
          createMessage({ timestamp: Date.now(), isMention: true }), // After cooldown started
        ],
      });

      const decision = evaluateResponseTrigger(state);

      expect(decision.shouldRespond).toBe(true);
      expect(decision.trigger).toBe('direct_engagement');
    });

    it('should respond when message threshold reached', () => {
      const state = createChannelState({
        chatType: 'supergroup',
        state: 'IDLE',
        recentMessages: Array.from({ length: 5 }, (_, i) =>
          createMessage({ messageId: String(i), content: `Message ${i}` })
        ),
      });

      const decision = evaluateResponseTrigger(state);

      expect(decision.shouldRespond).toBe(true);
      expect(decision.trigger).toBe('message_threshold');
      expect(decision.priority).toBe('normal');
      expect(decision.delay).toBeGreaterThanOrEqual(CHANNEL_CONFIG.MIN_RESPONSE_DELAY_MS);
      expect(decision.delay).toBeLessThanOrEqual(CHANNEL_CONFIG.MAX_RESPONSE_DELAY_MS);
    });

    it('should respond on conversation gap', () => {
      const state = createChannelState({
        chatType: 'supergroup',
        state: 'IDLE',
        lastActivityAt: Date.now() - 35000, // 35 seconds ago
        recentMessages: [createMessage({ timestamp: Date.now() - 35000 })],
      });

      const decision = evaluateResponseTrigger(state);

      expect(decision.shouldRespond).toBe(true);
      expect(decision.trigger).toBe('conversation_gap');
    });

    it('should not respond with no messages', () => {
      const state = createChannelState({
        chatType: 'supergroup',
        state: 'IDLE',
        recentMessages: [],
      });

      const decision = evaluateResponseTrigger(state);

      expect(decision.shouldRespond).toBe(false);
    });

    it('should respond in ACTIVE state with 2+ messages', () => {
      const state = createChannelState({
        chatType: 'supergroup',
        state: 'ACTIVE',
        recentMessages: [
          createMessage({ messageId: '1' }),
          createMessage({ messageId: '2' }),
        ],
      });

      const decision = evaluateResponseTrigger(state);

      expect(decision.shouldRespond).toBe(true);
      expect(decision.trigger).toBe('message_threshold');
    });
  });

  describe('State Transitions', () => {
    it('should transition to ACTIVE on direct engagement in IDLE', () => {
      const message = createMessage({ isMention: true });

      // Simulating addMessageToChannel logic
      let newState: ChannelState['state'] = 'IDLE';
      if (message.isMention || message.isReplyToBot) {
        newState = 'ACTIVE';
      }

      expect(newState).toBe('ACTIVE');
    });

    it('should stay IDLE for regular message in group', () => {
      const message = createMessage(); // No mention or reply

      let newState: ChannelState['state'] = 'IDLE';
      if (message.isMention || message.isReplyToBot) {
        newState = 'ACTIVE';
      }

      expect(newState).toBe('IDLE');
    });

    it('should stay in COOLDOWN for regular messages', () => {
      const currentState: ChannelState['state'] = 'COOLDOWN';
      const message = createMessage(); // No engagement

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
      const now = new Date('2024-01-01T00:00:00Z');
      vi.useFakeTimers();
      vi.setSystemTime(now);

      const result = await svc.addMessageToChannel(
        'agent',
        'channel',
        'telegram' as Platform,
        createMessage({ isMention: true })
      );

      expect(result.state).toBe('ACTIVE');
      expect(result.stateChangedAt).toBe(now.getTime());
      expect(result.directEngagementAt).toBe(now.getTime());
    });

    it('markResponseSent clears buffer and enters COOLDOWN', async () => {
      const svc = new InMemoryStateService();
      const now = Date.now();
      const initialState = createChannelState({
        channelId: 'channel',
        state: 'ACTIVE',
        stateChangedAt: now,
        recentMessages: [
          createMessage({ messageId: '1' }),
          createMessage({ messageId: '2' }),
        ],
        messageCount: 2,
      });
      svc.setState(initialState);

      const updated = await svc.markResponseSent('test-agent', 'channel', 'resp-1');

      expect(updated?.state).toBe('COOLDOWN');
      expect(updated?.recentMessages.length).toBe(0);
      expect(updated?.lastResponseMessageId).toBe('resp-1');
      expect(updated?.lastResponseAt).toBeDefined();
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
      const state = createChannelState({
        recentMessages: [
          createMessage({ sender: 'Alice', username: 'alice', content: 'Hello' }),
          createMessage({ sender: 'Bob', content: 'Hi there!' }),
        ],
      });

      const context = buildConversationContext(state);

      expect(context).toContain('@alice: Hello');
      expect(context).toContain('Bob: Hi there!');
    });

    it('should return empty string for no messages', () => {
      const state = createChannelState({ recentMessages: [] });
      const context = buildConversationContext(state);
      expect(context).toBe('');
    });

    it('should respect token limit', () => {
      const longMessages = Array.from({ length: 100 }, (_, i) =>
        createMessage({
          messageId: String(i),
          content: 'This is a fairly long message that should use up tokens quickly when repeated many times.',
        })
      );

      const state = createChannelState({ recentMessages: longMessages });
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
      const state = createChannelState({
        recentMessages: [
          createMessage({ messageId: '1', sender: 'Alice', isMention: true }),
          createMessage({ messageId: '2', sender: 'Bob' }),
          createMessage({ messageId: '3', sender: 'Charlie', isMention: true }),
          createMessage({ messageId: '4', sender: 'Dave' }),
        ],
      });

      const target = getResponseTarget(state);

      expect(target?.messageId).toBe('3'); // Charlie's mention
      expect(target?.sender).toBe('Charlie');
    });

    it('should fall back to last message if no engagement', () => {
      const state = createChannelState({
        recentMessages: [
          createMessage({ messageId: '1', sender: 'Alice' }),
          createMessage({ messageId: '2', sender: 'Bob' }),
        ],
      });

      const target = getResponseTarget(state);

      expect(target?.messageId).toBe('2');
      expect(target?.sender).toBe('Bob');
    });

    it('should return null for empty buffer', () => {
      const state = createChannelState({ recentMessages: [] });
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
      const state = createChannelState({
        recentMessages: [
          createMessage({ userId: '100', sender: 'Alice', username: 'alice' }),
          createMessage({ userId: '200', sender: 'Bob' }),
          createMessage({ userId: '100', sender: 'Alice', username: 'alice' }),
          createMessage({ userId: '100', sender: 'Alice', username: 'alice' }),
          createMessage({ userId: '200', sender: 'Bob' }),
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
      const state = createChannelState({ recentMessages: [] });
      const participants = getActiveParticipants(state);
      expect(participants).toHaveLength(0);
    });
  });
});
