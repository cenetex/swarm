import { describe, expect, test } from 'bun:test';
import { buildModelSelectorPayload, buildPauseToolPayload, buildPendingToolResponse, extractMediaFromToolResults, hasExecuteFunction, normalizeToolResult, sanitizeToolError, stringifyToolResultForModel, toAdminToolCall, toSdkMessages, sanitizeMessages } from './chat-tool-helpers.js';

describe('buildModelSelectorPayload', () => {
  test('filters tilde-prefixed OpenRouter registry aliases out of model selector payloads', async () => {
    const services = {
      listModels: async () => [
        {
          id: '~google/fake-registry-model',
          name: 'Fake Registry Model',
          contextLength: 1000000,
        },
        {
          id: 'google/live-model',
          name: 'Live Model',
          contextLength: 128000,
        },
      ],
      getConfig: async () => ({
        model: 'google/live-model',
        temperature: 0.7,
        maxTokens: 1024,
      }),
    } as unknown as Parameters<typeof buildModelSelectorPayload>[0];

    const payload = await buildModelSelectorPayload(services, 'avatar-1');

    expect((payload.models as Array<{ id: string }>).map(model => model.id)).toEqual(['google/live-model']);
  });
});

describe('buildPauseToolPayload', () => {
  test('normalizes request_model_selection into a renderable model selector payload', async () => {
    const services = {
      listModels: async (family?: string) => {
        expect(family).toBe('deepseek');
        return [
          {
            id: 'deepseek/deepseek-r1',
            name: 'DeepSeek R1',
            contextLength: 128000,
          },
        ];
      },
      getConfig: async () => ({
        model: 'openai/gpt-4o',
        temperature: 0.7,
        maxTokens: 1024,
      }),
    } as unknown as Parameters<typeof buildModelSelectorPayload>[0];

    const payload = await buildPauseToolPayload({
      toolName: 'request_model_selection',
      args: { family: 'deepseek' },
      mcpServices: { models: services },
      avatarId: 'avatar-1',
      tools: [],
    });

    expect(payload.toolName).toBe('request_model_selection');
    expect(payload.arguments.type).toBe('model_selector');
    expect(payload.arguments.currentModel).toBe('openai/gpt-4o');
    expect(payload.arguments.models).toEqual([
      {
        id: 'deepseek/deepseek-r1',
        name: 'DeepSeek R1',
        pricing: undefined,
        contextLength: 128000,
        provider: 'deepseek',
      },
    ]);
  });

  test('returns a model selector shell even when model services are unavailable', async () => {
    const payload = await buildPauseToolPayload({
      toolName: 'request_model_selection',
      args: { family: 'claude' },
      mcpServices: null,
      avatarId: undefined,
      tools: [],
    });

    expect(payload.toolName).toBe('request_model_selection');
    expect(payload.arguments).toEqual({
      type: 'model_selector',
      models: [],
      instructions: 'Showing models filtered by "claude".',
    });
  });
});

describe('sanitizeToolError', () => {
  test('strips IAM role ARNs from error messages', () => {
    const input =
      'User: arn:aws:iam::123456789012:role/swarm-admin-role is not authorized to perform: dynamodb:Query';
    const result = sanitizeToolError(input);
    expect(result).not.toContain('arn:aws:');
    expect(result).not.toContain('123456789012');
    expect(result).toBe('A permissions error occurred. The team has been notified.');
  });

  test('strips DynamoDB table ARNs from error messages', () => {
    const input =
      'Cannot access resource arn:aws:dynamodb:us-east-1:123456789012:table/SwarmAvatars';
    const result = sanitizeToolError(input);
    expect(result).not.toContain('arn:aws:');
    expect(result).not.toContain('123456789012');
    expect(result).toContain('[internal-resource]');
  });

  test('strips multiple ARNs from a single message', () => {
    const input =
      'Resource arn:aws:s3:::my-bucket/key failed, also arn:aws:lambda:us-west-2:111222333444:function:MyFunc';
    const result = sanitizeToolError(input);
    expect(result).not.toContain('arn:aws:');
    expect(result).not.toContain('111222333444');
    expect(result).toContain('[internal-resource]');
  });

  test('replaces "is not authorized to perform" messages with generic error', () => {
    const input =
      'User [internal-resource] is not authorized to perform: dynamodb:PutItem on resource [internal-resource]';
    const result = sanitizeToolError(input);
    expect(result).toBe('A permissions error occurred. The team has been notified.');
  });

  test('replaces AccessDeniedException messages with generic error', () => {
    const input = 'AccessDeniedException: Unable to determine service/operation';
    const result = sanitizeToolError(input);
    expect(result).toBe('A permissions error occurred. The team has been notified.');
  });

  test('passes through normal error messages unchanged', () => {
    const input = 'Something went wrong, please try again';
    expect(sanitizeToolError(input)).toBe(input);
  });

  test('passes through short error strings unchanged', () => {
    const input = 'Not found';
    expect(sanitizeToolError(input)).toBe(input);
  });

  test('extracts detail from JSON error bodies', () => {
    const json = JSON.stringify({ detail: 'Quota exceeded' });
    expect(sanitizeToolError(json)).toBe('Quota exceeded');
  });

  test('extracts error field from JSON error bodies', () => {
    const json = JSON.stringify({ error: 'Invalid request' });
    expect(sanitizeToolError(json)).toBe('Invalid request');
  });

  test('extracts message field from JSON error bodies', () => {
    const json = JSON.stringify({ message: 'Rate limited' });
    expect(sanitizeToolError(json)).toBe('Rate limited');
  });

  test('truncates long non-AWS error messages', () => {
    const longMessage = 'x'.repeat(500);
    const result = sanitizeToolError(longMessage);
    expect(result.length).toBeLessThanOrEqual(301);
    expect(result).toEndWith('\u2026');
  });

  test('truncates long messages after ARN stripping', () => {
    const longMessage =
      'Error accessing arn:aws:dynamodb:us-east-1:123456789012:table/X ' + 'y'.repeat(500);
    const result = sanitizeToolError(longMessage);
    expect(result).not.toContain('arn:aws:');
    expect(result.length).toBeLessThanOrEqual(301);
  });

  test('returns "Tool failed" for empty string', () => {
    expect(sanitizeToolError('')).toBe('Tool failed');
  });

  test('returns "Tool failed" for whitespace-only string', () => {
    expect(sanitizeToolError('   ')).toBe('Tool failed');
  });

  test('returns error message from Error instances', () => {
    expect(sanitizeToolError(new Error('boom'))).toBe('boom');
  });

  test('returns "Tool failed" for non-string, non-Error values', () => {
    expect(sanitizeToolError(42)).toBe('Tool failed');
    expect(sanitizeToolError(null)).toBe('Tool failed');
    expect(sanitizeToolError(undefined)).toBe('Tool failed');
  });
});

describe('hasExecuteFunction', () => {
  test('returns true when tool has an execute function', () => {
    const tool = {
      type: 'function' as const,
      function: {
        name: 'my_tool',
        description: 'Does something',
        parameters: {},
        execute: async (params: Record<string, unknown>) => ({ result: params }),
      },
    };
    expect(hasExecuteFunction(tool)).toBe(true);
  });

  test('returns false when execute is not a function', () => {
    const tool = {
      type: 'function' as const,
      function: {
        name: 'my_tool',
        description: 'Does something',
        parameters: {},
        execute: 'not-a-function',
      },
    };
    expect(hasExecuteFunction(tool as any)).toBe(false);
  });

  test('returns false when execute is missing', () => {
    const tool = {
      type: 'function' as const,
      function: {
        name: 'my_tool',
        description: 'Does something',
        parameters: {},
      },
    };
    expect(hasExecuteFunction(tool as any)).toBe(false);
  });

  test('throws when function property is missing', () => {
    const tool = {
      type: 'function' as const,
    };
    try {
      hasExecuteFunction(tool as any);
      expect.unreachable();
    } catch (e: any) {
      expect(e).toBeDefined();
    }
  });
});

describe('buildPendingToolResponse', () => {
  test('configure_integration returns empty string', () => {
    expect(buildPendingToolResponse('configure_integration', { integration: 'telegram' })).toBe('');
    expect(buildPendingToolResponse('configure_integration', { integration: 'twitter' })).toBe('');
  });

  test('request_model_selection returns prompt', () => {
    expect(buildPendingToolResponse('request_model_selection', {})).toBe('Please select a model:');
  });

  test('request_feature_toggle returns prompt', () => {
    expect(buildPendingToolResponse('request_feature_toggle', {})).toBe('Please choose your preference below:');
  });

  test('request_secret uses label when provided', () => {
    expect(buildPendingToolResponse('request_secret', { label: 'API Key' }))
      .toBe('Please enter API Key.');
  });

  test('request_secret uses secretType when no label', () => {
    expect(buildPendingToolResponse('request_secret', { secretType: 'openai_api_key' }))
      .toBe('Please enter openai api key.');
  });

  test('request_secret falls back to generic text', () => {
    expect(buildPendingToolResponse('request_secret', {}))
      .toBe('Please enter the requested secret.');
  });

  test('request_twitter_connection returns empty string', () => {
    expect(buildPendingToolResponse('request_twitter_connection', {})).toBe('');
    expect(buildPendingToolResponse('twitter_request_integration', {})).toBe('');
  });

  test('request_property_research returns prompt', () => {
    expect(buildPendingToolResponse('request_property_research', {})).toBe('Please grant property research access:');
  });

  test('manage_api_keys returns empty string', () => {
    expect(buildPendingToolResponse('manage_api_keys', {})).toBe('');
  });

  test('image upload tools return upload prompt', () => {
    const uploadTools = [
      'get_profile_upload_url',
      'get_reference_image_upload_url',
      'get_character_reference_upload_url',
      'set_profile_image',
      'set_character_reference',
    ];
    for (const toolName of uploadTools) {
      expect(buildPendingToolResponse(toolName, {})).toBe('Please upload your image:');
    }
  });

  test('unknown tool returns generic fallback', () => {
    expect(buildPendingToolResponse('some_unknown_tool', {}))
      .toBe('Please provide the requested input.');
  });
});

describe('stringifyToolResultForModel', () => {
  test('passes through strings unchanged', () => {
    expect(stringifyToolResultForModel('hello')).toBe('hello');
  });

  test('wraps primitives in data envelope', () => {
    expect(stringifyToolResultForModel(42)).toBe('{"data":42}');
    expect(stringifyToolResultForModel(true)).toBe('{"data":true}');
  });

  test('wraps null in data envelope', () => {
    expect(stringifyToolResultForModel(null)).toBe('{"data":null}');
  });

  test('serializes objects to JSON', () => {
    const result = stringifyToolResultForModel({ key: 'value', num: 1 });
    const parsed = JSON.parse(result);
    expect(parsed.key).toBe('value');
    expect(parsed.num).toBe(1);
  });

  test('sanitizes error and message fields in objects', () => {
    const result = stringifyToolResultForModel({
      data: 'ok',
      error: 'User: arn:aws:iam::123456789012:role/x is not authorized',
    });
    const parsed = JSON.parse(result);
    expect(parsed.data).toBe('ok');
    expect(parsed.error).toBeDefined();
  });

  test('sanitizes message field in objects', () => {
    const result = stringifyToolResultForModel({
      message: 'AccessDeniedException: no access',
    });
    const parsed = JSON.parse(result);
    expect(parsed.message).not.toContain('AccessDeniedException');
  });
});

describe('normalizeToolResult', () => {
  test('passes through success flag', () => {
    const result = normalizeToolResult({ success: true }, 'test_tool');
    expect(result.success).toBe(true);
  });

  test('includes error when present', () => {
    const result = normalizeToolResult(
      { success: false, error: 'something broke' },
      'test_tool'
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe('something broke');
  });

  test('sanitizes AWS ARNs in errors', () => {
    const result = normalizeToolResult(
      { success: false, error: 'arn:aws:iam::123456789012:role/x not authorized' },
      'test_tool'
    );
    expect(result.error).not.toContain('arn:aws:');
  });

  test('spreads data into payload when data is an object', () => {
    const result = normalizeToolResult(
      { success: true, data: { url: 'https://example.com/img.png', type: 'image' } },
      'generate_image'
    );
    expect(result.url).toBe('https://example.com/img.png');
    expect(result.type).toBe('image');
    expect(result.data).toEqual({ url: 'https://example.com/img.png', type: 'image' });
  });

  test('preserves scalar data values', () => {
    const result = normalizeToolResult(
      { success: true, data: 42 },
      'count_tool'
    );
    expect(result.data).toBe(42);
  });

  test('adds media URL from result.media', () => {
    const result = normalizeToolResult(
      { success: true, media: { url: 'https://cdn.example.com/audio.mp3', type: 'audio' } },
      'voice_clone'
    );
    expect(result.url).toBe('https://cdn.example.com/audio.mp3');
    expect(result.type).toBe('audio');
  });

  test('adds failure message for unsuccessful results', () => {
    const result = normalizeToolResult(
      { success: false, error: 'quota exceeded' },
      'some_tool'
    );
    expect(result.message).toMatch(/some_tool failed/);
    expect(result.message).toMatch(/quota exceeded/);
  });

  test('preserves pendingJob data', () => {
    const result = normalizeToolResult(
      { success: true, pendingJob: { jobId: 'j1', status: 'processing' } },
      'dream'
    );
    expect(result._pendingJob).toEqual({ jobId: 'j1', status: 'processing' });
    expect(result.jobId).toBe('j1');
    expect(result.status).toBe('processing');
  });

  test('detects uiAction upload_widget', () => {
    const result = normalizeToolResult(
      { success: true, uiAction: { type: 'upload_widget', payload: {} } },
      'upload'
    );
    expect(result.type).toBe('upload_url');
  });
});

describe('extractMediaFromToolResults', () => {
  test('extracts image URL from successful result', () => {
    const media = extractMediaFromToolResults([
      {
        tool_call_id: 'tc-1',
        role: 'tool' as const,
        content: JSON.stringify({ success: true, url: 'https://cdn.example.com/img.png' }),
      },
    ]);
    expect(media).toHaveLength(1);
    expect(media[0].type).toBe('image');
    expect(media[0].url).toBe('https://cdn.example.com/img.png');
  });

  test('extracts video from mp4 URL', () => {
    const media = extractMediaFromToolResults([
      {
        tool_call_id: 'tc-1',
        role: 'tool' as const,
        content: JSON.stringify({ success: true, url: 'https://cdn.example.com/video.mp4' }),
      },
    ]);
    expect(media).toHaveLength(1);
    expect(media[0].type).toBe('video');
  });

  test('extracts audio from mp3 URL', () => {
    const media = extractMediaFromToolResults([
      {
        tool_call_id: 'tc-1',
        role: 'tool' as const,
        content: JSON.stringify({ success: true, url: 'https://cdn.example.com/audio.mp3' }),
      },
    ]);
    expect(media).toHaveLength(1);
    expect(media[0].type).toBe('audio');
  });

  test('uses resultUrl as fallback', () => {
    const media = extractMediaFromToolResults([
      {
        tool_call_id: 'tc-1',
        role: 'tool' as const,
        content: JSON.stringify({ success: true, resultUrl: 'https://cdn.example.com/img.png' }),
      },
    ]);
    expect(media).toHaveLength(1);
    expect(media[0].url).toBe('https://cdn.example.com/img.png');
  });

  test('accepts status completed as alternative success', () => {
    const media = extractMediaFromToolResults([
      {
        tool_call_id: 'tc-1',
        role: 'tool' as const,
        content: JSON.stringify({ status: 'completed', url: 'https://cdn.example.com/img.png' }),
      },
    ]);
    expect(media).toHaveLength(1);
  });

  test('skips Twitter/X URLs', () => {
    const media = extractMediaFromToolResults([
      {
        tool_call_id: 'tc-1',
        role: 'tool' as const,
        content: JSON.stringify({ success: true, url: 'https://x.com/user/status/123' }),
      },
    ]);
    expect(media).toHaveLength(0);
  });

  test('skips unsuccessful results without URL', () => {
    const media = extractMediaFromToolResults([
      {
        tool_call_id: 'tc-1',
        role: 'tool' as const,
        content: JSON.stringify({ success: false, error: 'failed' }),
      },
    ]);
    expect(media).toHaveLength(0);
  });

  test('returns empty for empty input', () => {
    expect(extractMediaFromToolResults([])).toEqual([]);
  });

  test('returns empty for malformed JSON content', () => {
    const media = extractMediaFromToolResults([
      {
        tool_call_id: 'tc-1',
        role: 'tool' as const,
        content: 'not json',
      },
    ]);
    expect(media).toEqual([]);
  });
});


  test('extracts sticker from /sticker URL', () => {
    const media = extractMediaFromToolResults([
      { tool_call_id: 'tc-1', role: 'tool' as const, content: JSON.stringify({ success: true, url: 'https://cdn.example.com/sticker/pack/file.webp' }) },
    ]);
    expect(media).toHaveLength(1);
    expect(media[0].type).toBe('sticker');
  });

  test('extracts gallery items from items array', () => {
    const media = extractMediaFromToolResults([
      { tool_call_id: 'tc-1', role: 'tool' as const, content: JSON.stringify({
        items: [
          { url: 'https://cdn.example.com/gallery/1.png', type: 'image' },
          { url: 'https://cdn.example.com/gallery/2.png', type: 'image' },
        ],
      })},
    ]);
    expect(media).toHaveLength(2);
    expect(media[0].url).toContain('gallery/1');
    expect(media[1].url).toContain('gallery/2');
  });

  test('extracts gallery items from data array', () => {
    const media = extractMediaFromToolResults([
      { tool_call_id: 'tc-1', role: 'tool' as const, content: JSON.stringify({
        data: [{ url: 'https://cdn.example.com/data/img.png' }],
      })},
    ]);
    expect(media).toHaveLength(1);
  });

  test('extracts voice URLs from nested data object', () => {
    const media = extractMediaFromToolResults([
      { tool_call_id: 'tc-1', role: 'tool' as const, content: JSON.stringify({
        success: true,
        data: { introUrl: 'https://cdn.example.com/voice/intro.mp3', url: 'https://cdn.example.com/voice/full.mp3' },
      })},
    ]);
    expect(media.length).toBeGreaterThanOrEqual(1);
    expect(media.some(m => m.type === 'audio')).toBe(true);
  });

  test('filters Twitter URLs from voice results', () => {
    const media = extractMediaFromToolResults([
      { tool_call_id: 'tc-1', role: 'tool' as const, content: JSON.stringify({
        success: true,
        data: { url: 'https://x.com/user/status/456', introUrl: 'https://cdn.example.com/voice/preview.mp3' },
      })},
    ]);
    // Twitter URL skipped, audio URL kept
    const urls = media.map(m => m.url);
    expect(urls).not.toContain('https://x.com/user/status/456');
  });

  test('detects audio from /voice/ path', () => {
    const media = extractMediaFromToolResults([
      { tool_call_id: 'tc-1', role: 'tool' as const, content: JSON.stringify({ success: true, url: 'https://cdn.example.com/voice/clone.wav' }) },
    ]);
    expect(media).toHaveLength(1);
    expect(media[0].type).toBe('audio');
  });

  test('detects audio from /audio/ path', () => {
    const media = extractMediaFromToolResults([
      { tool_call_id: 'tc-1', role: 'tool' as const, content: JSON.stringify({ success: true, url: 'https://cdn.example.com/audio/output.opus' }) },
    ]);
    expect(media).toHaveLength(1);
    expect(media[0].type).toBe('audio');
  });

  test('includes prompt and id when available', () => {
    const media = extractMediaFromToolResults([
      { tool_call_id: 'tc-1', role: 'tool' as const, content: JSON.stringify({
        success: true, url: 'https://cdn.example.com/img.png', prompt: 'a cat', id: 'img-1',
      })},
    ]);
    expect(media).toHaveLength(1);
    expect(media[0].prompt).toBe('a cat');
    expect(media[0].id).toBe('img-1');
  });

  test('uses jobId as fallback for id', () => {
    const media = extractMediaFromToolResults([
      { tool_call_id: 'tc-1', role: 'tool' as const, content: JSON.stringify({
        success: true, url: 'https://cdn.example.com/img.png', jobId: 'job-42',
      })},
    ]);
    expect(media).toHaveLength(1);
    expect(media[0].id).toBe('job-42');
  });

describe('toSdkMessages', () => {
  test('converts user message', () => {
    const result = toSdkMessages([{ role: 'user' as const, content: 'hello' }]);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toBe('hello');
  });

  test('converts assistant message with tool_calls', () => {
    const tc = { id: '1', type: 'function' as const, function: { name: 'test', arguments: '{}' } };
    const result = toSdkMessages([
      { role: 'assistant' as const, content: 'ok', tool_calls: [tc] },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('assistant');
    expect(result[0].tool_calls).toEqual([tc]);
  });

  test('converts tool message with tool_call_id', () => {
    const result = toSdkMessages([
      { role: 'tool' as const, content: 'result', tool_call_id: 'tc-1' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('tool');
    expect(result[0].toolCallId).toBe('tc-1');
  });

  test('replaces tool message with missing tool_call_id', () => {
    const result = toSdkMessages([
      { role: 'tool' as const, content: 'orphan', tool_call_id: '' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toMatch(/tool result omitted/);
  });

  test('includes media images as multimodal content', () => {
    const result = toSdkMessages([
      {
        role: 'assistant' as const,
        content: 'Here is an image',
        media: [{ type: 'image' as const, url: 'https://cdn.example.com/img.png' }],
      },
    ]);
    expect(result).toHaveLength(1);
    const content = result[0].content;
    expect(Array.isArray(content)).toBe(true);
    const parts = content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(parts.some(p => p.type === 'image_url')).toBe(true);
  });

  test('filters out private media URLs from multimodal content', () => {
    const result = toSdkMessages([
      {
        role: 'assistant' as const,
        content: 'Here',
        media: [{ type: 'image' as const, url: 'https://s3.amazonaws.com/private-bucket/key' }],
      },
    ]);
    const content = result[0].content;
    // Private S3 URLs are stripped; content should be plain text
    expect(typeof content).toBe('string');
  });

  test('redacts media URLs from text content', () => {
    const result = toSdkMessages([
      { role: 'user' as const, content: 'See https://cdn.example.com/private/img.png' },
    ]);
    const content = result[0].content;
    expect(typeof content).toBe('string');
  });

  test('handles empty messages array', () => {
    expect(toSdkMessages([])).toEqual([]);
  });
});


  test('converts tool message with undefined tool_call_id to user fallback', () => {
    const result = toSdkMessages([
      { role: 'tool' as const, content: 'result', tool_call_id: undefined },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toMatch(/tool result omitted/);
  });

  test('preserves array content on user messages', () => {
    const result = toSdkMessages([
      { role: 'user' as const, content: [{ type: 'text', text: 'hello' }] },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
    expect(Array.isArray(result[0].content)).toBe(true);
  });

  test('preserves tool_calls only on assistant messages', () => {
    // A user message with tool_calls (shouldn't happen but test defensively)
    const result = toSdkMessages([
      { role: 'user' as const, content: 'hi', tool_calls: [{ id: 'x', type: 'function' as const, function: { name: 't', arguments: '{}' } }] },
    ]);
    expect(result).toHaveLength(1);
    expect((result[0] as any).tool_calls).toBeUndefined();
  });

  test('converts multiple messages of mixed types', () => {
    const result = toSdkMessages([
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'hi', tool_calls: [{ id: '1', type: 'function' as const, function: { name: 't', arguments: '{}' } }] },
      { role: 'tool' as const, content: 'result', tool_call_id: '1' },
    ]);
    expect(result).toHaveLength(4);
    expect(result[0].role).toBe('system');
    expect(result[1].role).toBe('user');
    expect(result[2].role).toBe('assistant');
    expect(result[2].tool_calls).toBeDefined();
    expect(result[3].role).toBe('tool');
    expect(result[3].toolCallId).toBe('1');
  });

describe('toAdminToolCall', () => {
  test('converts SdkToolCall to ToolCall', () => {
    const result = toAdminToolCall({
      id: 'call-1',
      name: 'search_web',
      arguments: { query: 'test' },
    });
    expect(result.id).toBe('call-1');
    expect(result.type).toBe('function');
    expect(result.function.name).toBe('search_web');
    expect(typeof result.function.arguments).toBe('string');
    expect(JSON.parse(result.function.arguments)).toEqual({ query: 'test' });
  });

  test('handles null arguments', () => {
    const result = toAdminToolCall({
      id: 42,
      name: 'test',
      arguments: null,
    });
    expect(result.id).toBe('42');
    expect(result.function.arguments).toBe('{}');
  });

  test('handles missing name', () => {
    const result = toAdminToolCall({
      id: 'tc-1',
      name: undefined,
      arguments: {},
    });
    expect(result.function.name).toBe('undefined');
  });
});

describe('sanitizeMessages', () => {
  test('passes through normal user-assistant conversation', () => {
    const msgs = [
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'hi there' },
    ];
    const result = sanitizeMessages(msgs);
    expect(result).toEqual(msgs);
  });

  test('enforces adjacency: moves tool results directly after matching assistant', () => {
    const msgs = [
      { role: 'user' as const, content: 'search for cats' },
      { role: 'assistant' as const, content: '', tool_calls: [{ id: 'tc-1', type: 'function' as const, function: { name: 'search', arguments: '{}' } }] },
      { role: 'tool' as const, content: 'results', tool_call_id: 'tc-1' },
      { role: 'assistant' as const, content: 'found cats' },
    ];
    const result = sanitizeMessages(msgs);
    expect(result).toHaveLength(4);
    // Tool result stays right after its assistant (already adjacent)
    expect(result[1].role).toBe('assistant');
    expect(result[2].role).toBe('tool');
    expect((result[2] as any).tool_call_id).toBe('tc-1');
  });

  test('reorders: pulls tool results past intervening messages', () => {
    const msgs = [
      { role: 'user' as const, content: 'search' },
      { role: 'assistant' as const, content: '', tool_calls: [{ id: 'tc-1', type: 'function' as const, function: { name: 'search', arguments: '{}' } }] },
      { role: 'user' as const, content: 'also look for dogs' },
      { role: 'tool' as const, content: 'cat results', tool_call_id: 'tc-1' },
      { role: 'assistant' as const, content: 'found both' },
    ];
    const result = sanitizeMessages(msgs);
    // Should be: user, assistant, tool, user(deferred), assistant
    expect(result).toHaveLength(5);
    expect(result[0].role).toBe('user');
    expect(result[1].role).toBe('assistant');
    expect(result[2].role).toBe('tool');
    expect(result[3].role).toBe('user'); // deferred
    expect(result[4].role).toBe('assistant');
  });

  test('strips tool_calls from assistant with no matching results', () => {
    const msgs = [
      { role: 'user' as const, content: 'search' },
      { role: 'assistant' as const, content: '', tool_calls: [{ id: 'tc-1', type: 'function' as const, function: { name: 'search', arguments: '{}' } }] },
      { role: 'assistant' as const, content: 'sorry try again' },
    ];
    const result = sanitizeMessages(msgs);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe('user');
    expect(result[1].role).toBe('assistant');
    expect(result[1].content).toBe('sorry try again');
  });

  test('stops scanning tool results at next assistant message', () => {
    const msgs = [
      { role: 'user' as const, content: 'search' },
      { role: 'assistant' as const, content: '', tool_calls: [{ id: 'tc-1', type: 'function' as const, function: { name: 'search', arguments: '{}' } }] },
      { role: 'assistant' as const, content: 'another one', tool_calls: [{ id: 'tc-2', type: 'function' as const, function: { name: 'web', arguments: '{}' } }] },
      { role: 'tool' as const, content: 'result 1', tool_call_id: 'tc-1' },
    ];
    const result = sanitizeMessages(msgs);
    // tc-1's result is after tc-2's assistant → tc-1 gets stripped, tc-2's result is orphaned
    // First assistant has no results → stripped; second assistant has no results either
    expect(result[0].role).toBe('user');
    expect(result[1].role).toBe('assistant');
    expect((result[1] as any).tool_calls).toBeUndefined();
  });

  test('removes orphaned tool results with no matching tool_call_id', () => {
    const msgs = [
      { role: 'user' as const, content: 'hi' },
      { role: 'assistant' as const, content: 'hello' },
      { role: 'tool' as const, content: 'orphan', tool_call_id: 'tc-missing' },
      { role: 'assistant' as const, content: 'done' },
    ];
    const result = sanitizeMessages(msgs);
    expect(result).toHaveLength(3); // orphaned tool removed
    expect(result.every(m => m.role !== 'tool')).toBe(true);
  });

  test('removes orphaned tool results with empty tool_call_id', () => {
    const msgs = [
      { role: 'assistant' as const, content: '', tool_calls: [{ id: 'tc-1', type: 'function' as const, function: { name: 't', arguments: '{}' } }] },
      { role: 'tool' as const, content: 'bad', tool_call_id: '' },
      { role: 'assistant' as const, content: 'next' },
    ];
    const result = sanitizeMessages(msgs);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('assistant');
    expect(result[0].content).toBe('next');
  });

  test('skips empty assistant messages without tool_calls', () => {
    const msgs = [
      { role: 'user' as const, content: 'hi' },
      { role: 'assistant' as const, content: '' },
      { role: 'assistant' as const, content: 'actually hello' },
    ];
    const result = sanitizeMessages(msgs);
    expect(result).toHaveLength(2);
    expect(result[1].content).toBe('actually hello');
  });

  test('preserves empty assistant with tool_calls (sets content to null)', () => {
    const msgs = [
      { role: 'user' as const, content: 'search' },
      { role: 'assistant' as const, content: '', tool_calls: [{ id: 'tc-1', type: 'function' as const, function: { name: 'search', arguments: '{}' } }] },
      { role: 'tool' as const, content: 'results', tool_call_id: 'tc-1' },
      { role: 'assistant' as const, content: 'done' },
    ];
    const result = sanitizeMessages(msgs);
    expect(result).toHaveLength(4);
    expect(result[1].content).toBeNull();
    expect(result[1].tool_calls).toBeDefined();
  });

  test('handles multiple tool calls in one assistant message', () => {
    const msgs = [
      { role: 'user' as const, content: 'do things' },
      { role: 'assistant' as const, content: '', tool_calls: [
        { id: 'tc-1', type: 'function' as const, function: { name: 'a', arguments: '{}' } },
        { id: 'tc-2', type: 'function' as const, function: { name: 'b', arguments: '{}' } },
      ]},
      { role: 'tool' as const, content: 'r1', tool_call_id: 'tc-1' },
      { role: 'user' as const, content: 'extra note' },
      { role: 'tool' as const, content: 'r2', tool_call_id: 'tc-2' },
    ];
    const result = sanitizeMessages(msgs);
    // Assistant, then tool r1, then tool r2 (reordered), then deferred user
    expect(result[0].role).toBe('user');
    expect(result[1].role).toBe('assistant');
    expect(result[2].role).toBe('tool');
    expect(result[3].role).toBe('tool');
    expect(result[4].role).toBe('user');
    expect((result[2] as any).tool_call_id).toBe('tc-1');
    expect((result[3] as any).tool_call_id).toBe('tc-2');
  });

  test('strips unmatched tool_calls when only some have results', () => {
    const msgs = [
      { role: 'user' as const, content: 'do things' },
      { role: 'assistant' as const, content: '', tool_calls: [
        { id: 'tc-1', type: 'function' as const, function: { name: 'a', arguments: '{}' } },
        { id: 'tc-2', type: 'function' as const, function: { name: 'b', arguments: '{}' } },
      ]},
      { role: 'tool' as const, content: 'r1', tool_call_id: 'tc-1' },
      { role: 'assistant' as const, content: 'done' },
    ];
    const result = sanitizeMessages(msgs);
    expect(result[1].role).toBe('assistant');
    expect((result[1] as any).tool_calls).toHaveLength(1);
    expect((result[1] as any).tool_calls[0].id).toBe('tc-1');
  });

  test('returns empty array for empty input', () => {
    expect(sanitizeMessages([])).toEqual([]);
  });

  test('handles system messages', () => {
    const msgs = [
      { role: 'system' as const, content: 'system prompt' },
      { role: 'user' as const, content: 'hello' },
    ];
    const result = sanitizeMessages(msgs);
    expect(result).toEqual(msgs);
  });
});
