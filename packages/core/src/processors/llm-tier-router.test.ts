import { describe, it, expect } from 'bun:test';
import { selectModel, type TierSelectionResult } from './llm-tier-router.js';
import type { AvatarConfig, SwarmEnvelope } from '../types/index.js';

function createMockAvatar(overrides: Partial<AvatarConfig> = {}): AvatarConfig {
  return {
    id: 'test-avatar',
    name: 'Test Avatar',
    version: '1.0',
    persona: 'A helpful AI',
    platforms: {},
    llm: {
      provider: 'anthropic',
      model: 'claude-3-5-sonnet-20241022',
      temperature: 0.7,
      maxTokens: 1024,
    },
    media: { image: { provider: 'dalle', model: 'dall-e-3' } },
    scheduling: {},
    behavior: {
      responseDelayMs: [0, 1000],
      typingIndicator: true,
      ignoreBots: true,
      cooldownMinutes: 0,
      maxContextMessages: 10,
    },
    tools: [],
    secrets: [],
    ...overrides,
  };
}

function createMockEnvelope(overrides: Partial<SwarmEnvelope> = {}): SwarmEnvelope {
  return {
    avatarId: 'test-avatar',
    conversationId: 'test-conv',
    messageId: 'msg-1',
    messageText: 'Hello',
    senderName: 'User',
    senderUserId: 'user-1',
    platform: 'discord',
    createdAtMs: Date.now(),
    recentMessages: [],
    ...overrides,
  } as SwarmEnvelope;
}

describe('LLM Tier Router', () => {
  describe('Fast tier routing', () => {
    it('routes short casual messages to fast tier', () => {
      const avatar = createMockAvatar();
      const envelope = createMockEnvelope();
      const messages = [{ role: 'user', content: 'lol ok' }];

      const result = selectModel(avatar, envelope, messages);

      expect(result.tier).toBe('fast');
      expect(result.modelId).toContain('haiku');
    });

    it('routes very short messages to fast tier', () => {
      const avatar = createMockAvatar();
      const envelope = createMockEnvelope();
      const messages = [{ role: 'user', content: 'ok' }];

      const result = selectModel(avatar, envelope, messages);

      expect(result.tier).toBe('fast');
    });

    it('routes casual acknowledgments to fast tier', () => {
      const avatar = createMockAvatar();
      const envelope = createMockEnvelope();
      const messages = [{ role: 'user', content: 'thanks!' }];

      const result = selectModel(avatar, envelope, messages);

      expect(result.tier).toBe('fast');
    });

    it('has lower cost for fast tier', () => {
      const avatar = createMockAvatar();
      const envelope = createMockEnvelope();
      const messages = [{ role: 'user', content: 'cool' }];

      const result = selectModel(avatar, envelope, messages);

      expect(result.estimatedCostCentsPer1kTokens).toBeLessThan(20);
    });
  });

  describe('Standard tier routing', () => {
    it('routes normal messages to standard tier by default', () => {
      const avatar = createMockAvatar();
      const envelope = createMockEnvelope();
      const messages = [{ role: 'user', content: 'What is the weather today?' }];

      const result = selectModel(avatar, envelope, messages);

      expect(result.tier).toBe('standard');
    });

    it('routes messages with moderate length to standard tier', () => {
      const avatar = createMockAvatar();
      const envelope = createMockEnvelope();
      const messages = [{ role: 'user', content: 'Tell me about how to bake a good chocolate cake' }];

      const result = selectModel(avatar, envelope, messages);

      expect(result.tier).toBe('standard');
    });
  });

  describe('Heavy tier routing', () => {
    it('routes research requests to heavy tier', () => {
      const avatar = createMockAvatar();
      const envelope = createMockEnvelope();
      const messages = [{ role: 'user', content: 'Analyze the historical trends in this dataset' }];

      const result = selectModel(avatar, envelope, messages);

      expect(result.tier).toBe('heavy');
    });

    it('routes request with explain keyword to heavy tier', () => {
      const avatar = createMockAvatar();
      const envelope = createMockEnvelope();
      const messages = [{ role: 'user', content: 'Explain quantum computing' }];

      const result = selectModel(avatar, envelope, messages);

      expect(result.tier).toBe('heavy');
    });

    it('routes complex multi-word research intent to heavy tier', () => {
      const avatar = createMockAvatar({
        llm: {
          provider: 'anthropic',
          model: 'claude-3-5-sonnet-20241022',
          temperature: 0.7,
          maxTokens: 1024,
          heavyForIntents: ['research', 'deep-analysis'],
        },
      });
      const envelope = createMockEnvelope();
      const messages = [{ role: 'user', content: 'I need a deep analysis of the market' }];

      const result = selectModel(avatar, envelope, messages);

      expect(result.tier).toBe('heavy');
    });

    it('has higher cost for heavy tier', () => {
      const avatar = createMockAvatar();
      const envelope = createMockEnvelope();
      const messages = [{ role: 'user', content: 'Analyze the data' }];

      const result = selectModel(avatar, envelope, messages);

      expect(result.estimatedCostCentsPer1kTokens).toBeGreaterThan(100);
    });
  });

  describe('Avatar tier override', () => {
    it('respects explicit fast tier override', () => {
      const avatar = createMockAvatar({
        llm: {
          provider: 'anthropic',
          model: 'claude-3-5-sonnet-20241022',
          temperature: 0.7,
          maxTokens: 1024,
          tier: 'fast',
        },
      });
      const envelope = createMockEnvelope();
      const messages = [{ role: 'user', content: 'Analyze this complex research problem' }];

      const result = selectModel(avatar, envelope, messages);

      expect(result.tier).toBe('fast');
      expect(result.reason).toContain('explicit_override');
    });

    it('respects explicit heavy tier override', () => {
      const avatar = createMockAvatar({
        llm: {
          provider: 'anthropic',
          model: 'claude-3-5-sonnet-20241022',
          temperature: 0.7,
          maxTokens: 1024,
          tier: 'heavy',
        },
      });
      const envelope = createMockEnvelope();
      const messages = [{ role: 'user', content: 'ok sure' }];

      const result = selectModel(avatar, envelope, messages);

      expect(result.tier).toBe('heavy');
    });

    it('respects explicit standard tier override', () => {
      const avatar = createMockAvatar({
        llm: {
          provider: 'anthropic',
          model: 'claude-3-5-sonnet-20241022',
          temperature: 0.7,
          maxTokens: 1024,
          tier: 'standard',
        },
      });
      const envelope = createMockEnvelope();
      const messages = [{ role: 'user', content: 'hey' }];

      const result = selectModel(avatar, envelope, messages);

      expect(result.tier).toBe('standard');
    });
  });

  describe('Custom model overrides', () => {
    it('uses custom fast model when provided', () => {
      const avatar = createMockAvatar({
        llm: {
          provider: 'anthropic',
          model: 'claude-3-5-sonnet-20241022',
          temperature: 0.7,
          maxTokens: 1024,
          fastModel: 'custom-fast-model',
        },
      });
      const envelope = createMockEnvelope();
      const messages = [{ role: 'user', content: 'lol' }];

      const result = selectModel(avatar, envelope, messages);

      expect(result.tier).toBe('fast');
      expect(result.modelId).toBe('custom-fast-model');
    });

    it('uses custom heavy model when provided', () => {
      const avatar = createMockAvatar({
        llm: {
          provider: 'anthropic',
          model: 'claude-3-5-sonnet-20241022',
          temperature: 0.7,
          maxTokens: 1024,
          heavyModel: 'custom-heavy-model',
        },
      });
      const envelope = createMockEnvelope();
      const messages = [{ role: 'user', content: 'Analyze this data' }];

      const result = selectModel(avatar, envelope, messages);

      expect(result.tier).toBe('heavy');
      expect(result.modelId).toBe('custom-heavy-model');
    });
  });

  describe('Content analysis', () => {
    it('downgrades to standard/heavy when URL is present', () => {
      const avatar = createMockAvatar();
      const envelope = createMockEnvelope();
      const messages = [{ role: 'user', content: 'Check this https://example.com ok?' }];

      const result = selectModel(avatar, envelope, messages);

      expect(result.tier).not.toBe('fast');
    });

    it('downgrades when user mention present', () => {
      const avatar = createMockAvatar();
      const envelope = createMockEnvelope();
      const messages = [{ role: 'user', content: '@john what do you think?' }];

      const result = selectModel(avatar, envelope, messages);

      expect(result.tier).not.toBe('fast');
    });

    it('downgrades when likely file reference present', () => {
      const avatar = createMockAvatar();
      const envelope = createMockEnvelope();
      const messages = [{ role: 'user', content: '[file attached] lol' }];

      const result = selectModel(avatar, envelope, messages);

      expect(result.tier).not.toBe('fast');
    });
  });

  describe('Conversation depth', () => {
    it('scores short conversations higher for fast tier', () => {
      const avatar = createMockAvatar();
      const envelope = createMockEnvelope();
      const messages = [{ role: 'user', content: 'hey' }];

      const result = selectModel(avatar, envelope, messages);

      expect(result.tier).toBe('fast');
    });

    it('downgrades long conversations', () => {
      const avatar = createMockAvatar();
      const envelope = createMockEnvelope();
      const messages = Array.from({ length: 15 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i}`,
      }));
      messages[messages.length - 1] = { role: 'user', content: 'cool' };

      const result = selectModel(avatar, envelope, messages);

      expect(result.tier).not.toBe('fast');
    });
  });

  describe('Tool requirements', () => {
    it('routes to heavy tier when image generation tool available', () => {
      const avatar = createMockAvatar();
      const envelope = createMockEnvelope();
      const messages = [{ role: 'user', content: 'ok' }];
      const tools = [{ type: 'function', function: { name: 'generate_image' } }];

      const result = selectModel(avatar, envelope, messages, tools);

      expect(result.tier).not.toBe('fast');
    });

    it('routes to heavy tier when research tool available', () => {
      const avatar = createMockAvatar();
      const envelope = createMockEnvelope();
      const messages = [{ role: 'user', content: 'lol' }];
      const tools = [{ type: 'function', function: { name: 'research_web' } }];

      const result = selectModel(avatar, envelope, messages, tools);

      expect(result.tier).not.toBe('fast');
    });

    it('allows fast tier with standard tools', () => {
      const avatar = createMockAvatar();
      const envelope = createMockEnvelope();
      const messages = [{ role: 'user', content: 'lol' }];
      const tools = [{ type: 'function', function: { name: 'get_time' } }];

      const result = selectModel(avatar, envelope, messages, tools);

      expect(result.tier).toBe('fast');
    });
  });

  describe('Edge cases', () => {
    it('handles empty messages gracefully', () => {
      const avatar = createMockAvatar();
      const envelope = createMockEnvelope();
      const messages: Array<{ role: string; content: unknown }> = [];

      const result = selectModel(avatar, envelope, messages);

      expect(result).toBeDefined();
      expect(result.modelId).toBeDefined();
    });

    it('finds last user message in multi-role messages', () => {
      const avatar = createMockAvatar();
      const envelope = createMockEnvelope();
      const messages = [
        { role: 'user', content: 'complex research question' },
        { role: 'assistant', content: 'answer' },
        { role: 'user', content: 'lol' },
      ];

      const result = selectModel(avatar, envelope, messages);

      expect(result.tier).toBe('fast');
    });

    it('case-insensitive intent matching', () => {
      const avatar = createMockAvatar({
        llm: {
          provider: 'anthropic',
          model: 'claude-3-5-sonnet-20241022',
          temperature: 0.7,
          maxTokens: 1024,
          heavyForIntents: ['RESEARCH'],
        },
      });
      const envelope = createMockEnvelope();
      const messages = [{ role: 'user', content: 'I need to research this' }];

      const result = selectModel(avatar, envelope, messages);

      expect(result.tier).toBe('heavy');
    });
  });

  describe('Auto tier mode', () => {
    it('uses auto mode by default', () => {
      const avatar = createMockAvatar();
      const envelope = createMockEnvelope();
      const messages = [{ role: 'user', content: 'hey' }];

      const result = selectModel(avatar, envelope, messages);

      expect(result.reason).toContain('heuristic');
    });
  });

  describe('Backward compatibility', () => {
    it('maintains config with only model field', () => {
      const avatar = createMockAvatar({
        llm: {
          provider: 'anthropic',
          model: 'claude-3-5-sonnet-20241022',
          temperature: 0.7,
          maxTokens: 1024,
        },
      });
      const envelope = createMockEnvelope();
      const messages = [{ role: 'user', content: 'hey' }];

      const result = selectModel(avatar, envelope, messages);

      expect(result).toBeDefined();
      expect(result.modelId).toBeDefined();
    });
  });
});
