import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageEvaluator } from './message-evaluator.js';
import type { AgentConfig } from '../types/index.js';

describe('MessageEvaluator', () => {
  let mockAgentConfig: AgentConfig;
  let mockStateService: any;
  let mockEvaluatorConfig: any;
  let evaluator: MessageEvaluator;

  beforeEach(() => {
    mockAgentConfig = {
      id: 'test-agent',
      behavior: {
        ignoreBots: true,
      },
      platforms: {
        telegram: { enabled: true, botUsername: 'test_bot' },
        web: { enabled: true, tokenGated: { enabled: false } }
      }
    } as any;

    mockStateService = {
      getUserCooldown: vi.fn().mockResolvedValue(null),
      getChannelState: vi.fn().mockResolvedValue(null),
    };

    mockEvaluatorConfig = {
      botUsernames: ['test_bot'],
    };

    evaluator = new MessageEvaluator(mockAgentConfig, mockStateService, mockEvaluatorConfig);
  });

  describe('Global Rules', () => {
    it('should ignore bot messages if ignoreBots is true', async () => {
      const envelope = {
        sender: { isBot: true },
        metadata: {}
      } as any;

      const result = await evaluator.evaluate(envelope);
      expect(result.shouldRespond).toBe(false);
      expect(result.reason).toBe('Sender is a bot');
    });

    it('should respond if bot is mentioned (high priority)', async () => {
      const envelope = {
        agentId: 'test-agent',
        platform: 'telegram',
        sender: { isBot: false, id: 'user-1' },
        content: { text: 'Hello @test_bot' },
        mentions: [],
        metadata: {}
      } as any;

      const result = await evaluator.evaluate(envelope);
      expect(result.shouldRespond).toBe(true);
      expect(result.reason).toBe('Bot was directly mentioned');
      expect(result.priority).toBe('high');
    });

    it('should respond if replying to bot message (high priority)', async () => {
      const envelope = {
        agentId: 'test-agent',
        conversationId: 'chat-1',
        sender: { isBot: false, id: 'user-1' },
        replyTo: 'msg-bot-1',
        content: { text: 'Yes, I agree' },
        mentions: [],
        metadata: {}
      } as any;

      mockStateService.getChannelState.mockResolvedValue({
        recentMessages: [
          { messageId: 'msg-bot-1', isBot: true }
        ]
      });

      const result = await evaluator.evaluate(envelope);
      expect(result.shouldRespond).toBe(true);
      expect(result.reason).toBe('Reply to bot message');
      expect(result.priority).toBe('high');
    });
  });

  describe('Commands', () => {
    it('should respond to known commands', async () => {
      const envelope = {
        sender: { isBot: false, id: 'user-1' },
        content: {
          command: { command: 'help', args: [], raw: '/help' }
        },
        metadata: {}
      } as any;

      const result = await evaluator.evaluate(envelope);
      expect(result.shouldRespond).toBe(true);
      expect(result.reason).toContain('Command: /help');
      expect(result.skipQueue).toBe(true);
    });

    it('should respond to unknown commands (normal priority)', async () => {
      const envelope = {
        sender: { isBot: false, id: 'user-1' },
        content: {
          command: { command: 'unknown', args: [], raw: '/unknown' }
        },
        metadata: {}
      } as any;

      const result = await evaluator.evaluate(envelope);
      expect(result.shouldRespond).toBe(true);
      expect(result.reason).toBe('Unknown command: /unknown');
      expect(result.priority).toBe('normal');
    });
  });

  describe('Cooldown', () => {
    it('should ignore users on cooldown', async () => {
      const cooldownUntil = Date.now() + 60000;
      mockStateService.getUserCooldown.mockResolvedValue({ cooldownUntil });

      const envelope = {
        agentId: 'test-agent',
        platform: 'telegram',
        sender: { isBot: false, id: 'user-1' },
        content: { text: 'Hello' },
        mentions: [],
        metadata: {}
      } as any;

      const result = await evaluator.evaluate(envelope);
      expect(result.shouldRespond).toBe(false);
      expect(result.reason).toContain('User on cooldown');
    });

    it('should bypass cooldown for admin users', async () => {
      mockEvaluatorConfig.adminUserIds = ['admin-1'];
      const cooldownUntil = Date.now() + 60000;
      mockStateService.getUserCooldown.mockResolvedValue({ cooldownUntil });

      const envelope = {
        agentId: 'test-agent',
        platform: 'telegram',
        sender: { isBot: false, id: 'admin-1' },
        content: { text: 'Hello' },
        mentions: [],
        metadata: {}
      } as any;

      const result = await evaluator.evaluate(envelope);
      // It will fall through to platform-specific evaluation
      // For Telegram it might still be false if not mentioned, but reason won't be cooldown
      expect(result.reason).not.toContain('User on cooldown');
    });
  });

  describe('Platform: Telegram', () => {
    it('should always respond in private chats', async () => {
      const envelope = {
        agentId: 'test-agent',
        platform: 'telegram',
        sender: { isBot: false, id: 'user-1' },
        content: { text: 'Hello' },
        mentions: [],
        raw: { message: { chat: { type: 'private' } } },
        metadata: {}
      } as any;

      const result = await evaluator.evaluate(envelope);
      expect(result.shouldRespond).toBe(true);
      expect(result.reason).toBe('Private chat');
    });

    it('should respond in groups if recently active and conversational', async () => {
      const envelope = {
        agentId: 'test-agent',
        conversationId: 'group-1',
        platform: 'telegram',
        sender: { isBot: false, id: 'user-1' },
        content: { text: 'How are you?' },
        mentions: [],
        raw: { message: { chat: { type: 'supergroup' } } },
        metadata: {}
      } as any;

      mockStateService.getChannelState.mockResolvedValue({
        lastActivityAt: Date.now() - 60000, // 1 minute ago
      });

      const result = await evaluator.evaluate(envelope);
      expect(result.shouldRespond).toBe(true);
      expect(result.reason).toBe('Recent activity + conversational message');
    });

    it('should ignore group messages if not mentioned and no recent activity', async () => {
      const envelope = {
        agentId: 'test-agent',
        conversationId: 'group-1',
        platform: 'telegram',
        sender: { isBot: false, id: 'user-1' },
        content: { text: 'Plain message' },
        mentions: [],
        raw: { message: { chat: { type: 'supergroup' } } },
        metadata: {}
      } as any;

      const result = await evaluator.evaluate(envelope);
      expect(result.shouldRespond).toBe(false);
      expect(result.reason).toBe('Group chat, not mentioned');
    });
  });

  describe('Platform: Web', () => {
    it('should always respond in web chat by default', async () => {
      const envelope = {
        agentId: 'test-agent',
        platform: 'web',
        sender: { isBot: false, id: 'user-1' },
        content: { text: 'Hello' },
        mentions: [],
        metadata: {}
      } as any;

      const result = await evaluator.evaluate(envelope);
      expect(result.shouldRespond).toBe(true);
      expect(result.reason).toBe('Web chat');
    });

    it('should implement token gating if enabled', async () => {
      mockAgentConfig.platforms.web = {
        enabled: true,
        tokenGated: { enabled: true, tokenMint: 'mint-1', minBalance: 10 }
      } as any;

      const envelope = {
        agentId: 'test-agent',
        platform: 'web',
        sender: { isBot: false, id: 'user-1' }, // No walletAddress
        content: { text: 'Hello' },
        mentions: [],
        metadata: {}
      } as any;

      const result = await evaluator.evaluate(envelope);
      expect(result.shouldRespond).toBe(false);
      expect(result.reason).toBe('Wallet not connected (token-gated)');
    });
  });
});
