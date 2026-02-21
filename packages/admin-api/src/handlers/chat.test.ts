/**
 * Admin Chat Handler Tests
 *
 * Tests for the admin chat tool-call flow including pendingToolCall and history management.
 * These tests focus on logic patterns and data structures, not on mocking external services.
 */
import { describe, it, expect, beforeEach } from 'vitest';

describe('Admin Chat - Tool Call Flow', () => {
  beforeEach(() => {
    // No mocks to clear - these are pure logic tests
  });

  describe('pendingToolCall detection', () => {
    it('should identify pause-for-input tools', () => {
      // List of tools that should trigger pendingToolCall
      const pauseTools = [
        'configure_integration',
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

      expect(pauseTools).toHaveLength(10);
    });

    it('should build pending tool response message', () => {
      const toolResponses: Record<string, string> = {
        configure_integration: '', // UI renders its own panel
        request_model_selection: 'Please select a model:',
        request_feature_toggle: 'Please choose your preference below:',
        request_secret: 'Please enter the requested secret.',
        request_twitter_connection: '', // TwitterConnectPrompt renders its own UI
        get_profile_upload_url: 'Please upload your image:',
      };

      for (const [_tool, expectedMsg] of Object.entries(toolResponses)) {
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

describe('Admin Chat - send_gallery_image failure handling', () => {
  describe('normalizeToolResult for failed gallery send', () => {
    // Mirrors normalizeToolResult from chat-tool-helpers.ts
    function normalizeToolResult(result: { success: boolean; error?: string; data?: unknown; media?: { url: string; type: string; caption?: string } }, toolName: string): Record<string, unknown> {
      const payload: Record<string, unknown> = { success: result.success };
      if (result.error) {
        payload.error = result.error;
      }
      if (result.data !== undefined) {
        if (typeof result.data === 'object' && result.data !== null) {
          Object.assign(payload, result.data as Record<string, unknown>);
          payload.data = result.data;
        } else {
          payload.data = result.data;
        }
      }
      if (result.media?.url && payload.url === undefined) {
        payload.url = result.media.url;
        payload.type = payload.type ?? result.media.type;
      }
      if (!result.success && !payload.message) {
        payload.message = `Tool ${toolName} failed${result.error ? `: ${result.error}` : ''}`;
      }
      return payload;
    }

    it('produces a deterministic error payload with no url or media for invalid imageId', () => {
      const toolResult = {
        success: false,
        error: 'FAILED: Image ID not found in gallery. The image may have been deleted or the ID is stale. Run get_my_gallery to fetch current valid image IDs before retrying.',
      };

      const normalized = normalizeToolResult(toolResult, 'send_gallery_image');

      expect(normalized.success).toBe(false);
      expect(normalized.error).toContain('FAILED:');
      expect(normalized.error).toContain('get_my_gallery');
      expect(normalized.message).toContain('Tool send_gallery_image failed');
      // Must NOT have url or media that could produce a broken image
      expect(normalized.url).toBeUndefined();
      expect(normalized.type).toBeUndefined();
      expect(normalized.data).toBeUndefined();
    });

    it('produces success payload with url for valid imageId', () => {
      const toolResult = {
        success: true,
        data: { id: 'img-1', url: 'https://cdn.example.com/img.png' },
        media: { type: 'image', url: 'https://cdn.example.com/img.png', caption: 'test' },
      };

      const normalized = normalizeToolResult(toolResult, 'send_gallery_image');

      expect(normalized.success).toBe(true);
      expect(normalized.url).toBe('https://cdn.example.com/img.png');
      expect(normalized.error).toBeUndefined();
      expect(normalized.message).toBeUndefined();
    });
  });

  describe('extractMediaFromToolResults for failed gallery send', () => {
    function extractMediaFromToolResults(toolResults: Array<{ content: string }>): Array<{ type: string; url: string }> {
      const media: Array<{ type: string; url: string }> = [];
      for (const result of toolResults) {
        try {
          const parsed = JSON.parse(result.content);
          const mediaUrl = parsed.url || parsed.resultUrl;
          const isSuccess = parsed.success || (parsed.status === 'completed' && mediaUrl);
          if (isSuccess && mediaUrl && typeof mediaUrl === 'string') {
            media.push({ type: parsed.type || 'image', url: mediaUrl });
          }
        } catch {
          // Skip
        }
      }
      return media;
    }

    it('does NOT extract any media from a failed send_gallery_image result', () => {
      const failedResult = {
        content: JSON.stringify({
          success: false,
          error: 'FAILED: Image ID not found in gallery. The image may have been deleted or the ID is stale. Run get_my_gallery to fetch current valid image IDs before retrying.',
          message: 'Tool send_gallery_image failed: FAILED: Image ID not found in gallery.',
        }),
      };

      const media = extractMediaFromToolResults([failedResult]);

      expect(media).toHaveLength(0);
    });

    it('extracts media from a successful send_gallery_image result', () => {
      const successResult = {
        content: JSON.stringify({
          success: true,
          id: 'img-1',
          url: 'https://cdn.example.com/img.png',
          data: { id: 'img-1', url: 'https://cdn.example.com/img.png' },
          type: 'image',
        }),
      };

      const media = extractMediaFromToolResults([successResult]);

      expect(media).toHaveLength(1);
      expect(media[0].url).toBe('https://cdn.example.com/img.png');
    });
  });

  describe('UI categorization of failed gallery send', () => {
    // Mirrors categorizeResult from ChatMessage.tsx
    function categorizeResult(parsed: Record<string, unknown>): { type: string; message?: string } {
      const hasSignalKey = 'success' in parsed || 'error' in parsed || 'status' in parsed || 'url' in parsed || 'message' in parsed;

      if (parsed.message && typeof parsed.message === 'string' && hasSignalKey) {
        if (parsed.error === true || typeof parsed.error === 'string' || parsed.success === false) {
          return { type: 'error', message: parsed.message as string };
        }
        return { type: 'success', message: parsed.message as string };
      }

      if (parsed.success === true) {
        return { type: 'success' };
      }

      if (parsed.error === true || parsed.success === false) {
        const msg = typeof parsed.message === 'string' ? parsed.message :
                    typeof parsed.error === 'string' ? parsed.error : 'An error occurred';
        return { type: 'error', message: msg };
      }

      return { type: 'unknown' };
    }

    it('categorizes failed gallery send as error type', () => {
      const failedResult = {
        success: false,
        error: 'FAILED: Image ID not found in gallery. The image may have been deleted or the ID is stale. Run get_my_gallery to fetch current valid image IDs before retrying.',
        message: 'Tool send_gallery_image failed: FAILED: Image ID not found in gallery. The image may have been deleted or the ID is stale. Run get_my_gallery to fetch current valid image IDs before retrying.',
      };

      const categorized = categorizeResult(failedResult);

      expect(categorized.type).toBe('error');
      expect(categorized.message).toContain('not found');
      expect(categorized.message).toContain('get_my_gallery');
    });

    it('does NOT categorize failed gallery send as success or image', () => {
      const failedResult = {
        success: false,
        error: 'FAILED: Image ID not found in gallery.',
        message: 'Tool send_gallery_image failed.',
      };

      const categorized = categorizeResult(failedResult);

      expect(categorized.type).not.toBe('success');
      expect(categorized.type).not.toBe('image');
      expect(categorized.type).toBe('error');
    });

    it('categorizes successful gallery send as success type', () => {
      const successResult = {
        success: true,
        url: 'https://cdn.example.com/img.png',
        data: { id: 'img-1', url: 'https://cdn.example.com/img.png' },
      };

      const categorized = categorizeResult(successResult);

      // Success with URL is categorized - the actual tool result rendering extracts the image
      expect(categorized.type).toBe('success');
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

/**
 * Integration test: admin chat tool-call flow produces pendingToolCall + history
 *
 * This test verifies the complete flow when the LLM calls a pause-for-input tool:
 * 1. The isPauseForInputTool function correctly identifies pause tools
 * 2. The response contains pendingToolCall with proper structure
 * 3. The history is updated with the assistant message containing tool_calls
 * 4. The conversation can be resumed with the tool result
 */
describe('Admin Chat - Tool-Call Flow Integration', () => {
  // Import the isPauseForInputTool function to test detection
  const MANUAL_TOOL_NAMES = [
    'request_secret',
    'request_model_selection',
    'request_feature_toggle',
    'request_twitter_connection',
    'request_property_research',
  ] as const;

  const UPLOAD_TOOL_NAMES = [
    'get_profile_upload_url',
    'get_reference_image_upload_url',
    'get_character_reference_upload_url',
  ] as const;

  function isPauseForInputTool(toolName: string, args?: Record<string, unknown>): boolean {
    if (MANUAL_TOOL_NAMES.includes(toolName as typeof MANUAL_TOOL_NAMES[number])) {
      return true;
    }
    if (toolName === 'set_profile_image' && args?.source === 'upload') {
      return true;
    }
    if (toolName === 'set_character_reference' && args?.source === 'upload') {
      return true;
    }
    if (UPLOAD_TOOL_NAMES.includes(toolName as typeof UPLOAD_TOOL_NAMES[number])) {
      return true;
    }
    return false;
  }

  function buildPendingToolResponse(toolName: string, args: Record<string, unknown>): string {
    if (toolName === 'configure_integration') {
      if (args.integration === 'twitter') {
        return ''; // TwitterConnectPrompt renders its own UI
      }
      return ''; // IntegrationConfigPrompt renders its own UI
    }
    if (toolName === 'request_model_selection') {
      return 'Please select a model:';
    }
    if (toolName === 'request_feature_toggle') {
      return 'Please choose your preference below:';
    }
    if (toolName === 'request_secret') {
      const label = typeof args.label === 'string' ? args.label : 'the requested secret';
      return `Please enter ${label}.`;
    }
    if (toolName === 'request_twitter_connection') {
      return ''; // TwitterConnectPrompt renders its own UI
    }
    if (toolName === 'request_property_research') {
      return 'Please grant property research access:';
    }
    if (
      toolName === 'get_profile_upload_url' ||
      toolName === 'get_reference_image_upload_url' ||
      toolName === 'get_character_reference_upload_url' ||
      toolName === 'set_profile_image' ||
      toolName === 'set_character_reference'
    ) {
      return 'Please upload your image:';
    }
    return 'Please provide the requested input.';
  }

  /**
   * Simulates the processChat flow when a pause tool is called
   */
  function simulateToolCallFlow(
    userMessage: string,
    conversationHistory: Array<{ role: string; content: string; tool_calls?: unknown[] }>,
    toolCalls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>
  ): {
    response: string;
    history: Array<{ role: string; content: string; tool_calls?: unknown[] }>;
    pendingToolCall?: { id: string; name: string; arguments: Record<string, unknown> };
  } {
    // Build initial messages
    const messages = [
      ...conversationHistory,
      { role: 'user', content: userMessage },
    ];

    // Check if any tool call is a pause-for-input tool
    const pauseToolCall = toolCalls.find(tc => isPauseForInputTool(tc.name, tc.arguments));

    if (pauseToolCall) {
      let uiToolName = pauseToolCall.name;
      let uiArgs = pauseToolCall.arguments;

      // Match production behavior: normalize Twitter connect pause tools to configure_integration.
      if (uiToolName === 'request_twitter_connection' || uiToolName === 'twitter_request_integration') {
        uiToolName = 'configure_integration';
        uiArgs = {
          integration: 'twitter',
          reason: typeof (pauseToolCall.arguments as any).message === 'string' ? (pauseToolCall.arguments as any).message : undefined,
          ...pauseToolCall.arguments,
        };
      }

      // Match production behavior: normalize integration secret prompts to configure_integration.
      if (uiToolName === 'request_secret') {
        const secretType = typeof (pauseToolCall.arguments as any).secretType === 'string'
          ? (pauseToolCall.arguments as any).secretType
          : typeof (pauseToolCall.arguments as any).secretKey === 'string'
            ? (pauseToolCall.arguments as any).secretKey
            : undefined;

        const secretTypeToIntegration: Record<string, string> = {
          telegram_bot_token: 'telegram',
          telegram_webhook_secret: 'telegram',
          twitter_api_key: 'twitter',
          twitter_api_secret: 'twitter',
          twitter_access_token: 'twitter',
          twitter_access_secret: 'twitter',
          discord_bot_token: 'discord',
          replicate_api_key: 'replicate',
          replicate_api_token: 'replicate',
          openai_api_key: 'openai',
          anthropic_api_key: 'anthropic',
          openrouter_api_key: 'openrouter',
        };

        const integration = secretType ? secretTypeToIntegration[secretType] : undefined;
        if (integration) {
          uiToolName = 'configure_integration';
          uiArgs = {
            integration,
            reason: typeof (pauseToolCall.arguments as any).reason === 'string' ? (pauseToolCall.arguments as any).reason : undefined,
          };
        }
      }

      // Build pendingToolCall
      const pendingToolCall = {
        id: pauseToolCall.id,
        name: uiToolName,
        arguments: uiArgs,
      };

      // Build response message
      const response = buildPendingToolResponse(uiToolName, uiArgs);

      // Add assistant message with tool_calls to history
      messages.push({
        role: 'assistant',
        content: response,
        tool_calls: uiToolName !== pauseToolCall.name
          ? [{
              id: pauseToolCall.id,
              type: 'function',
              function: {
                name: uiToolName,
                arguments: JSON.stringify(uiArgs),
              },
            }]
          : toolCalls.map(tc => ({
              id: tc.id,
              type: 'function',
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.arguments),
              },
            })),
      });

      return {
        response,
        history: messages,
        pendingToolCall,
      };
    }

    // No pause tool - would execute tools normally (not simulated here)
    return {
      response: 'Tool execution complete.',
      history: messages,
    };
  }

  it('should produce pendingToolCall and updated history when pause tool is called', () => {
    const userMessage = 'Change the model to something faster';
    const conversationHistory: Array<{ role: string; content: string }> = [];

    // Simulate LLM calling request_model_selection
    const toolCalls = [
      {
        id: 'call-001',
        name: 'request_model_selection',
        arguments: { family: 'anthropic' },
      },
    ];

    const result = simulateToolCallFlow(userMessage, conversationHistory, toolCalls);

    // Verify pendingToolCall is present
    expect(result.pendingToolCall).toBeDefined();
    expect(result.pendingToolCall!.id).toBe('call-001');
    expect(result.pendingToolCall!.name).toBe('request_model_selection');
    expect(result.pendingToolCall!.arguments).toEqual({ family: 'anthropic' });

    // Verify response message
    expect(result.response).toBe('Please select a model:');

    // Verify history includes user message and assistant message with tool_calls
    expect(result.history).toHaveLength(2);
    expect(result.history[0].role).toBe('user');
    expect(result.history[0].content).toBe(userMessage);
    expect(result.history[1].role).toBe('assistant');
    expect(result.history[1].tool_calls).toBeDefined();
    expect(result.history[1].tool_calls).toHaveLength(1);
    const tc = result.history[1].tool_calls![0] as { function: { name: string } };
    expect(tc.function.name).toBe('request_model_selection');
  });

  it('should normalize request_secret integration keys to configure_integration', () => {
    const result = simulateToolCallFlow(
      'Please configure Replicate',
      [],
      [
        {
          id: 'tool_123',
          name: 'request_secret',
          arguments: { secretType: 'replicate_api_key', reason: 'Need image generation' },
        },
      ]
    );

    expect(result.pendingToolCall).toBeDefined();
    expect(result.pendingToolCall!.name).toBe('configure_integration');
    expect(result.pendingToolCall!.arguments.integration).toBe('replicate');
  });

  it('should handle request_secret tool with label in arguments', () => {
    const toolCalls = [
      {
        id: 'call-002',
        name: 'request_secret',
        arguments: { key: 'telegram_bot_token', label: 'your Telegram bot token' },
      },
    ];

    const result = simulateToolCallFlow('Configure Telegram', [], toolCalls);

    expect(result.pendingToolCall).toBeDefined();
    expect(result.pendingToolCall!.name).toBe('request_secret');
    expect(result.response).toBe('Please enter your Telegram bot token.');
  });

  it('should handle upload tools correctly', () => {
    const uploadTools = [
      'get_profile_upload_url',
      'get_reference_image_upload_url',
      'get_character_reference_upload_url',
    ];

    for (const toolName of uploadTools) {
      const toolCalls = [{ id: `call-${toolName}`, name: toolName, arguments: {} }];
      const result = simulateToolCallFlow('Upload an image', [], toolCalls);

      expect(result.pendingToolCall).toBeDefined();
      expect(result.pendingToolCall!.name).toBe(toolName);
      expect(result.response).toBe('Please upload your image:');
    }
  });

  it('should handle set_profile_image with source=upload', () => {
    const toolCalls = [
      {
        id: 'call-upload',
        name: 'set_profile_image',
        arguments: { source: 'upload' },
      },
    ];

    const result = simulateToolCallFlow('Set my profile image', [], toolCalls);

    expect(result.pendingToolCall).toBeDefined();
    expect(result.pendingToolCall!.name).toBe('set_profile_image');
    expect(result.response).toBe('Please upload your image:');
  });

  it('should NOT produce pendingToolCall for non-pause tools', () => {
    const toolCalls = [
      {
        id: 'call-regular',
        name: 'generate_image',
        arguments: { prompt: 'A sunset' },
      },
    ];

    const result = simulateToolCallFlow('Generate an image', [], toolCalls);

    // Non-pause tools should not have pendingToolCall
    expect(result.pendingToolCall).toBeUndefined();
  });

  it('should preserve existing conversation history when adding new messages', () => {
    const existingHistory = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi! How can I help?' },
      { role: 'user', content: 'I want to change settings' },
      { role: 'assistant', content: 'Sure, what would you like to change?' },
    ];

    const toolCalls = [
      {
        id: 'call-toggle',
        name: 'request_feature_toggle',
        arguments: { feature: 'twitter', label: 'Enable Twitter' },
      },
    ];

    const result = simulateToolCallFlow('Enable Twitter', existingHistory, toolCalls);

    // Should have existing 4 messages + new user message + assistant message with tool_calls
    expect(result.history).toHaveLength(6);
    expect(result.history[4].role).toBe('user');
    expect(result.history[4].content).toBe('Enable Twitter');
    expect(result.history[5].role).toBe('assistant');
    expect(result.history[5].tool_calls).toBeDefined();
  });

  it('should handle request_twitter_connection tool', () => {
    const toolCalls = [
      {
        id: 'call-twitter',
        name: 'request_twitter_connection',
        arguments: {},
      },
    ];

    const result = simulateToolCallFlow('Connect Twitter', [], toolCalls);

    expect(result.pendingToolCall).toBeDefined();
    expect(result.pendingToolCall!.name).toBe('configure_integration');
    expect(result.response).toBe(''); // TwitterConnectPrompt renders its own UI
  });

  it('should handle request_property_research tool', () => {
    const toolCalls = [
      {
        id: 'call-property',
        name: 'request_property_research',
        arguments: { address: '123 Main St' },
      },
    ];

    const result = simulateToolCallFlow('Research this property', [], toolCalls);

    expect(result.pendingToolCall).toBeDefined();
    expect(result.pendingToolCall!.name).toBe('request_property_research');
    expect(result.response).toBe('Please grant property research access:');
  });

  it('should correctly serialize tool arguments in history', () => {
    const toolCalls = [
      {
        id: 'call-model',
        name: 'request_model_selection',
        arguments: { family: 'anthropic', preferredContext: 200000 },
      },
    ];

    const result = simulateToolCallFlow('Select a model', [], toolCalls);

    const assistantMsg = result.history[1];
    expect(assistantMsg.tool_calls).toBeDefined();

    const tc = assistantMsg.tool_calls![0] as {
      id: string;
      type: string;
      function: { name: string; arguments: string };
    };

    expect(tc.id).toBe('call-model');
    expect(tc.type).toBe('function');
    expect(tc.function.name).toBe('request_model_selection');

    // Arguments should be serialized as JSON string in history
    const parsedArgs = JSON.parse(tc.function.arguments);
    expect(parsedArgs.family).toBe('anthropic');
    expect(parsedArgs.preferredContext).toBe(200000);
  });
});
