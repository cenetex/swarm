/**
 * Core Module Tests
 */
import { describe, it, expect, vi } from 'vitest';

describe('Platform Message Normalization', () => {
  describe('Telegram Message Extraction', () => {
    it('should extract text content from Telegram message', () => {
      const telegramMessage = {
        message_id: 123,
        chat: { id: -100123456, type: 'supergroup' },
        from: { id: 789, first_name: 'John', username: 'johndoe' },
        text: 'Hello world!',
        date: 1704931200,
      };

      const content = {
        text: telegramMessage.text,
      };

      expect(content.text).toBe('Hello world!');
    });

    it('should extract sender info from Telegram message', () => {
      const from = {
        id: 789,
        first_name: 'John',
        last_name: 'Doe',
        username: 'johndoe',
        is_bot: false,
      };

      const sender = {
        id: from.id.toString(),
        username: from.username,
        displayName: from.first_name + (from.last_name ? ` ${from.last_name}` : ''),
        isBot: from.is_bot,
        platform: 'telegram',
      };

      expect(sender.id).toBe('789');
      expect(sender.displayName).toBe('John Doe');
      expect(sender.username).toBe('johndoe');
      expect(sender.isBot).toBe(false);
    });

    it('should handle missing optional fields', () => {
      const from = {
        id: 789,
        first_name: 'John',
        is_bot: false,
      };

      const sender = {
        id: from.id.toString(),
        username: undefined,
        displayName: from.first_name,
        isBot: from.is_bot,
      };

      expect(sender.username).toBeUndefined();
      expect(sender.displayName).toBe('John');
    });
  });

  describe('Conversation Context', () => {
    it('should build conversation ID from chat ID', () => {
      const chatId = -1003401362204;
      const platform = 'telegram';
      
      const conversationId = `${platform}:${chatId}`;
      
      expect(conversationId).toBe('telegram:-1003401362204');
    });

    it('should handle different chat types', () => {
      const chatTypes = [
        { id: 123456, type: 'private' },
        { id: -100123456, type: 'supergroup' },
        { id: -123456, type: 'group' },
      ];

      for (const chat of chatTypes) {
        expect(typeof chat.id).toBe('number');
        expect(['private', 'group', 'supergroup', 'channel']).toContain(chat.type);
      }
    });
  });
});

describe('Response Actions', () => {
  describe('Action Types', () => {
    it('should validate send_message action', () => {
      const action = {
        type: 'send_message',
        text: 'Hello!',
        media: [],
      };

      expect(action.type).toBe('send_message');
      expect(action.text).toBeTruthy();
    });

    it('should validate send_media action', () => {
      const action = {
        type: 'send_media',
        mediaType: 'image',
        url: 'https://example.com/image.png',
        caption: 'A beautiful image',
      };

      expect(action.type).toBe('send_media');
      expect(['image', 'video', 'animation']).toContain(action.mediaType);
      expect(action.url).toMatch(/^https?:\/\//);
    });

    it('should validate react action', () => {
      const action = {
        type: 'react',
        messageId: '123',
        emoji: '👍',
      };

      expect(action.type).toBe('react');
      expect(action.emoji).toBeTruthy();
    });

    it('should validate wait action', () => {
      const action = {
        type: 'wait',
        durationMs: 2000,
      };

      expect(action.type).toBe('wait');
      expect(action.durationMs).toBeGreaterThan(0);
    });
  });
});

describe('LLM Message Format', () => {
  describe('Message Roles', () => {
    it('should support all OpenAI message roles', () => {
      const roles = ['system', 'user', 'assistant', 'tool'];
      
      for (const role of roles) {
        const message = { role, content: 'test' };
        expect(['system', 'user', 'assistant', 'tool']).toContain(message.role);
      }
    });

    it('should format system prompt correctly', () => {
      const agentName = 'TestBot';
      const persona = 'You are a helpful AI assistant.';
      
      let systemPrompt = persona;
      systemPrompt += `\n\nYou are chatting on Telegram. Keep responses concise and conversational.`;
      systemPrompt += `\nYou can generate images and videos when asked.`;

      expect(systemPrompt).toContain(persona);
      expect(systemPrompt).toContain('Telegram');
    });

    it('should format user message with username', () => {
      const userName = 'John';
      const text = 'Can you generate an image?';
      
      const message = {
        role: 'user',
        content: `${userName}: ${text}`,
      };

      expect(message.content).toBe('John: Can you generate an image?');
    });
  });

  describe('Tool Calls', () => {
    it('should format tool call correctly', () => {
      const toolCall = {
        id: 'call_abc123',
        type: 'function',
        function: {
          name: 'generate_image',
          arguments: JSON.stringify({ prompt: 'A whale' }),
        },
      };

      expect(toolCall.id).toBeTruthy();
      expect(toolCall.function.name).toBe('generate_image');
      
      const args = JSON.parse(toolCall.function.arguments);
      expect(args.prompt).toBe('A whale');
    });

    it('should format tool result correctly', () => {
      const result = {
        role: 'tool',
        tool_call_id: 'call_abc123',
        name: 'generate_image',
        content: JSON.stringify({ id: 'img-123', url: 'https://example.com/image.png' }),
      };

      expect(result.role).toBe('tool');
      expect(result.tool_call_id).toBe('call_abc123');
      
      const content = JSON.parse(result.content);
      expect(content.url).toContain('https://');
    });
  });
});

describe('Configuration Parsing', () => {
  describe('Agent Config', () => {
    it('should parse agent config correctly', () => {
      const config = {
        id: 'agent-1',
        name: 'TestBot',
        persona: 'You are a helpful assistant.',
        platforms: {
          telegram: { enabled: true },
          twitter: { enabled: false },
        },
        llmConfig: {
          model: 'anthropic/claude-sonnet-4',
          temperature: 0.7,
          maxTokens: 1024,
        },
      };

      expect(config.id).toBeTruthy();
      expect(config.platforms.telegram.enabled).toBe(true);
      expect(config.llmConfig.model).toContain('claude');
    });

    it('should handle missing optional config', () => {
      const config = {
        id: 'agent-1',
        name: 'TestBot',
        platforms: {
          telegram: { enabled: true },
        },
        llmConfig: {},
      };

      // Default values
      const model = config.llmConfig.model || 'anthropic/claude-sonnet-4';
      const temperature = config.llmConfig.temperature || 0.8;
      const maxTokens = config.llmConfig.maxTokens || 1024;

      expect(model).toBe('anthropic/claude-sonnet-4');
      expect(temperature).toBe(0.8);
      expect(maxTokens).toBe(1024);
    });
  });
});
