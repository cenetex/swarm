import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResponseGenerator } from './response-generator.js';
import type { SwarmEnvelope, AgentConfig } from '../types/index.js';

describe('ResponseGenerator', () => {
  let mockAgentConfig: AgentConfig;
  let mockLLMService: any;
  let mockStateService: any;
  let generator: ResponseGenerator;
  let mockTools: any[];

  beforeEach(() => {
    mockAgentConfig = {
      id: 'test-agent',
      name: 'Test Agent',
      persona: 'You are a test agent.',
      llm: { provider: 'openrouter', model: 'gpt-4' } as any,
      behavior: {
        responseDelayMs: [0, 0], // No delay by default in tests
      }
    } as any;

    mockLLMService = {
      generateResponse: vi.fn().mockResolvedValue({
        content: 'Hello from LLM!',
        model: 'gpt-4',
        tokensUsed: 10,
        finishReason: 'end_turn'
      }),
    };

    mockStateService = {
      getChannelState: vi.fn().mockResolvedValue(null),
    };

    mockTools = [];

    generator = new ResponseGenerator(
      mockAgentConfig,
      mockLLMService,
      mockStateService,
      mockTools,
      { maxContextMessages: 10, defaultSystemPrompt: 'Base prompt' }
    );
  });

  it('should generate a text response', async () => {
    const envelope = {
      agentId: 'test-agent',
      platform: 'telegram',
      conversationId: 'chat-1',
      messageId: 'msg-1',
      sender: { id: 'user-1', displayName: 'User', username: 'user', isBot: false, platform: 'telegram', platformUserId: '123' },
      content: { text: 'Hello' },
      metadata: {}
    } as SwarmEnvelope;

    const response = await generator.generate(envelope);

    expect(response.actions).toContainEqual(expect.objectContaining({
      type: 'send_message',
      text: 'Hello from LLM!'
    }));
    expect(response.llmModel).toBe('gpt-4');
  });

  it('should include a wait action if response delay is configured', async () => {
    mockAgentConfig.behavior.responseDelayMs = [100, 200];
    
    const envelope = {
      agentId: 'test-agent',
      platform: 'telegram',
      conversationId: 'chat-1',
      messageId: 'msg-1',
      sender: { id: 'user-1', displayName: 'User', username: 'user', isBot: false, platform: 'telegram', platformUserId: '123' },
      content: { text: 'Hello' },
      metadata: {}
    } as SwarmEnvelope;

    const response = await generator.generate(envelope);

    expect(response.actions).toContainEqual(expect.objectContaining({
      type: 'wait'
    }));
    expect(response.actions[0].type).toBe('wait');
  });

  it('should generate tool calls when returned by LLM', async () => {
    mockLLMService.generateResponse.mockResolvedValue({
      toolCalls: [
        { id: 'tc-1', name: 'send_message', input: { text: 'Tool response' } }
      ],
      model: 'gpt-4',
      tokensUsed: 15,
      finishReason: 'tool_use'
    });

    const envelope = {
      agentId: 'test-agent',
      platform: 'telegram',
      conversationId: 'chat-1',
      messageId: 'msg-1',
      sender: { id: 'user-1', displayName: 'User', username: 'user', isBot: false, platform: 'telegram', platformUserId: '123' },
      content: { text: 'Use a tool' },
      metadata: {}
    } as SwarmEnvelope;

    const response = await generator.generate(envelope);

    expect(response.actions).toContainEqual(expect.objectContaining({
      type: 'send_message',
      text: 'Tool response'
    }));
  });

  it('should correctly format message history from channel state', async () => {
    mockStateService.getChannelState.mockResolvedValue({
      recentMessages: [
        { sender: 'Bot', content: 'Hi there!', isBot: true },
        { sender: 'User', content: 'Hello!', isBot: false }
      ]
    });

    const envelope = {
      agentId: 'test-agent',
      platform: 'telegram',
      conversationId: 'chat-1',
      messageId: 'msg-2',
      sender: { id: 'user-1', username: 'johndoe', isBot: false, platform: 'telegram', platformUserId: '123' },
      content: { text: 'How are you?' },
      metadata: {}
    } as SwarmEnvelope;

    await generator.generate(envelope);

    expect(mockLLMService.generateResponse).toHaveBeenCalledWith(expect.objectContaining({
      messages: [
        { role: 'assistant', content: '[Bot]: Hi there!' },
        { role: 'user', content: '[User]: Hello!' },
        { role: 'user', content: '[johndoe]: How are you?' }
      ]
    }));
  });
});
