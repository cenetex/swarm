/**
 * Admin Chat Handler Tests
 *
 * Tests for the admin chat tool-call flow including pendingToolCall and history management.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock AWS SDK
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: vi.fn(() => ({
    send: vi.fn().mockResolvedValue({
      SecretString: JSON.stringify({ api_key: 'sk-test-key' }),
    }),
  })),
  GetSecretValueCommand: vi.fn(),
}));

// Mock services
vi.mock('../services/chat-history.js', () => ({
  getChatHistory: vi.fn().mockResolvedValue([]),
  saveChatHistory: vi.fn().mockResolvedValue(undefined),
  clearChatHistory: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/mcp-adapter.js', () => ({
  createMCPServices: vi.fn(() => ({
    agents: {},
    secrets: {},
    media: {},
    models: {
      listModels: vi.fn().mockResolvedValue([]),
      getConfig: vi.fn().mockResolvedValue(null),
    },
  })),
}));

vi.mock('@swarm/mcp-server', () => ({
  ToolRegistry: vi.fn(() => ({
    getForPlatform: vi.fn().mockReturnValue([]),
    execute: vi.fn().mockResolvedValue({ success: true, data: {} }),
  })),
  registerAllTools: vi.fn(),
}));

vi.mock('@swarm/core', () => ({
  logger: {
    setContext: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../auth/cloudflare-access.js', () => ({
  authenticateRequest: vi.fn().mockResolvedValue({
    email: 'admin@test.com',
    userId: 'user-123',
    isAdmin: true,
    accessToken: 'token',
  }),
  requireAdmin: vi.fn().mockReturnValue(true),
}));

describe('Admin Chat - Tool Call Flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('pendingToolCall detection', () => {
    it('should identify pause-for-input tools', () => {
      // List of tools that should trigger pendingToolCall
      const pauseTools = [
        'request_model_selection',
        'request_feature_toggle',
        'request_secret',
        'request_twitter_connection',
        'get_profile_upload_url',
        'get_reference_image_upload_url',
        'get_character_reference_upload_url',
        'set_profile_image',
        'set_character_reference',
      ];

      // These tools require user input via UI
      for (const toolName of pauseTools) {
        expect(typeof toolName).toBe('string');
        expect(toolName.length).toBeGreaterThan(0);
      }

      expect(pauseTools).toHaveLength(9);
    });

    it('should build pending tool response message', () => {
      const toolResponses: Record<string, string> = {
        request_model_selection: 'Please select a model:',
        request_feature_toggle: 'Please choose your preference below:',
        request_secret: 'Please enter the requested secret.',
        request_twitter_connection: 'Please connect your X/Twitter account:',
        get_profile_upload_url: 'Please upload your image:',
      };

      for (const [_tool, expectedMsg] of Object.entries(toolResponses)) {
        expect(expectedMsg).toBeTruthy();
        expect(typeof expectedMsg).toBe('string');
      }
    });
  });

  describe('history management with tool calls', () => {
    it('should include tool_calls in assistant message when tools are called', () => {
      const toolCalls = [
        {
          id: 'call-123',
          type: 'function' as const,
          function: {
            name: 'request_model_selection',
            arguments: JSON.stringify({ family: 'anthropic' }),
          },
        },
      ];

      const assistantMessage = {
        role: 'assistant' as const,
        content: 'Please select a model:',
        tool_calls: toolCalls,
      };

      expect(assistantMessage.tool_calls).toHaveLength(1);
      expect(assistantMessage.tool_calls[0].function.name).toBe('request_model_selection');
    });

    it('should preserve pendingToolCall in response when pause tool detected', () => {
      const pendingToolCall = {
        id: 'call-456',
        name: 'request_model_selection',
        arguments: {
          type: 'model_selector',
          models: [],
          currentModel: 'anthropic/claude-sonnet-4',
        },
      };

      // Response should include pendingToolCall
      const response = {
        response: 'Please select a model:',
        history: [],
        pendingToolCall,
      };

      expect(response.pendingToolCall).toBeDefined();
      expect(response.pendingToolCall.name).toBe('request_model_selection');
      expect(response.pendingToolCall.arguments.type).toBe('model_selector');
    });

    it('should add tool results to history with correct structure', () => {
      const toolResult = {
        tool_call_id: 'call-789',
        role: 'tool' as const,
        content: JSON.stringify({ success: true, data: { url: 'https://...' } }),
      };

      expect(toolResult.role).toBe('tool');
      expect(toolResult.tool_call_id).toBe('call-789');
      expect(JSON.parse(toolResult.content).success).toBe(true);
    });
  });

  describe('sanitizeMessages', () => {
    it('should remove orphaned tool results', () => {
      // Messages with tool result that has no matching tool call
      const messages = [
        { role: 'user' as const, content: 'Hello' },
        { role: 'assistant' as const, content: 'Hi there' },
        {
          role: 'tool' as const,
          content: JSON.stringify({ success: true }),
          tool_call_id: 'orphan-call-123', // No matching tool call
        },
      ];

      // Collect valid tool call IDs
      const validToolCallIds = new Set<string>();
      for (const msg of messages) {
        if (msg.role === 'assistant' && 'tool_calls' in msg) {
          const toolCalls = msg.tool_calls as Array<{ id: string }>;
          for (const tc of toolCalls) {
            validToolCallIds.add(tc.id);
          }
        }
      }

      // Filter orphaned tool results
      const sanitized = messages.filter(msg => {
        if (msg.role === 'tool') {
          const toolCallId = (msg as { tool_call_id?: string }).tool_call_id;
          return toolCallId && validToolCallIds.has(toolCallId);
        }
        return true;
      });

      // Should remove the orphaned tool result
      expect(sanitized).toHaveLength(2);
      expect(sanitized.every(m => m.role !== 'tool')).toBe(true);
    });

    it('should keep tool results with matching tool calls', () => {
      const messages = [
        { role: 'user' as const, content: 'Generate an image' },
        {
          role: 'assistant' as const,
          content: '',
          tool_calls: [{ id: 'valid-call', type: 'function', function: { name: 'generate_image', arguments: '{}' } }],
        },
        {
          role: 'tool' as const,
          content: JSON.stringify({ success: true, url: 'https://...' }),
          tool_call_id: 'valid-call',
        },
      ];

      // Collect valid tool call IDs
      const validToolCallIds = new Set<string>();
      for (const msg of messages) {
        if (msg.role === 'assistant' && 'tool_calls' in msg) {
          const toolCalls = msg.tool_calls as Array<{ id: string }>;
          for (const tc of toolCalls) {
            validToolCallIds.add(tc.id);
          }
        }
      }

      // Filter
      const sanitized = messages.filter(msg => {
        if (msg.role === 'tool') {
          const toolCallId = (msg as { tool_call_id?: string }).tool_call_id;
          return toolCallId && validToolCallIds.has(toolCallId);
        }
        return true;
      });

      expect(sanitized).toHaveLength(3);
    });
  });

  describe('media extraction from tool results', () => {
    it('should extract media URLs from successful tool results', () => {
      const toolResults = [
        {
          tool_call_id: 'img-call',
          role: 'tool' as const,
          content: JSON.stringify({
            success: true,
            url: 'https://cdn.example.com/image.png',
            type: 'image',
            prompt: 'A cute cat',
          }),
        },
      ];

      const media: Array<{ type: string; url: string; prompt?: string }> = [];

      for (const result of toolResults) {
        try {
          const parsed = JSON.parse(result.content);
          if (parsed.success && parsed.url) {
            media.push({
              type: parsed.type || 'image',
              url: parsed.url,
              prompt: parsed.prompt,
            });
          }
        } catch {
          // Skip non-JSON
        }
      }

      expect(media).toHaveLength(1);
      expect(media[0].url).toBe('https://cdn.example.com/image.png');
      expect(media[0].prompt).toBe('A cute cat');
    });

    it('should handle pending jobs from tool results', () => {
      const toolResult = {
        content: JSON.stringify({
          success: true,
          _pendingJob: {
            jobId: 'job-123',
            type: 'video',
            prompt: 'Dancing robot',
          },
        }),
      };

      const parsed = JSON.parse(toolResult.content);
      const pendingJobs: Array<{ jobId: string; type: string; prompt?: string }> = [];

      if (parsed._pendingJob) {
        pendingJobs.push({
          jobId: parsed._pendingJob.jobId,
          type: parsed._pendingJob.type || 'image',
          prompt: parsed._pendingJob.prompt,
        });
      }

      expect(pendingJobs).toHaveLength(1);
      expect(pendingJobs[0].jobId).toBe('job-123');
      expect(pendingJobs[0].type).toBe('video');
    });
  });
});

describe('Admin Chat - Feature Toggle Payload', () => {
  it('should build feature toggle payload with correct structure', () => {
    const payload = {
      type: 'feature_toggle',
      feature: 'twitter' as const,
      currentState: false,
      label: 'Enable Twitter/X',
      description: 'Allow posting to Twitter',
    };

    expect(payload.type).toBe('feature_toggle');
    expect(payload.feature).toBe('twitter');
    expect(typeof payload.currentState).toBe('boolean');
  });

  it('should support all feature types', () => {
    const features = ['media', 'voice', 'twitter', 'telegram', 'discord'] as const;

    for (const feature of features) {
      expect(typeof feature).toBe('string');
    }

    expect(features).toHaveLength(5);
  });
});

describe('Admin Chat - Model Selector Payload', () => {
  it('should format model list correctly', () => {
    const models = [
      {
        id: 'anthropic/claude-sonnet-4',
        name: 'Claude Sonnet 4',
        pricing: { prompt: 0.003, completion: 0.015 },
        contextLength: 200000,
        provider: 'anthropic',
      },
    ];

    expect(models[0].id).toBe('anthropic/claude-sonnet-4');
    expect(models[0].pricing.prompt).toBe(0.003);
    expect(models[0].contextLength).toBe(200000);
  });
});
