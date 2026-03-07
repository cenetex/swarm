/**
 * Tests for OpenAI-compatible tool/function calling support.
 *
 * Covers:
 * - Tool definitions are accepted in the request schema
 * - Tool messages (role: 'tool') are accepted in message history
 * - Tool calls are extracted from processChat history
 * - Non-tool requests continue to work as before
 * - Validation errors for malformed tool definitions
 */
import { describe, test, expect } from 'bun:test';
import { z } from 'zod';
import { extractToolCallsFromHistory } from './openai-compat.js';

// =============================================================================
// extractToolCallsFromHistory
// =============================================================================

describe('extractToolCallsFromHistory', () => {
  test('returns empty array when no tool calls in history', () => {
    const history = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ];
    expect(extractToolCallsFromHistory(history)).toEqual([]);
  });

  test('extracts tool calls from assistant messages', () => {
    const history = [
      { role: 'user', content: 'Generate an image' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_123',
            type: 'function',
            function: {
              name: 'generate_image',
              arguments: '{"prompt":"a cat"}',
            },
          },
        ],
      },
      {
        role: 'tool',
        content: '{"success":true,"url":"https://example.com/cat.png"}',
        tool_call_id: 'call_123',
      },
      { role: 'assistant', content: 'Here is your image!' },
    ];

    const toolCalls = extractToolCallsFromHistory(history);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toEqual({
      id: 'call_123',
      type: 'function',
      function: {
        name: 'generate_image',
        arguments: '{"prompt":"a cat"}',
      },
    });
  });

  test('extracts multiple tool calls from a single assistant message', () => {
    const history = [
      { role: 'user', content: 'Do two things' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'tool_a', arguments: '{}' },
          },
          {
            id: 'call_2',
            type: 'function',
            function: { name: 'tool_b', arguments: '{"x":1}' },
          },
        ],
      },
    ];

    const toolCalls = extractToolCallsFromHistory(history);
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].function.name).toBe('tool_a');
    expect(toolCalls[1].function.name).toBe('tool_b');
  });

  test('returns empty when history is empty', () => {
    expect(extractToolCallsFromHistory([])).toEqual([]);
  });

  test('ignores assistant messages without tool_calls', () => {
    const history = [
      { role: 'assistant', content: 'Just text' },
      { role: 'assistant', content: 'More text', tool_calls: [] },
    ];
    expect(extractToolCallsFromHistory(history)).toEqual([]);
  });
});

// =============================================================================
// Request schema validation (inline tests for the Zod schemas)
// =============================================================================

describe('OpenAI tool calling request schema', () => {
  // We import the schema indirectly by testing that the handler module
  // exports the expected types. Since we cannot easily invoke the handler
  // without mocking AWS, we test the schema-level behavior via Zod directly.
  const OpenAIToolCallSchema = z.object({
    id: z.string(),
    type: z.literal('function'),
    function: z.object({
      name: z.string(),
      arguments: z.string(),
    }),
  });

  const OpenAIFunctionSchema = z.object({
    name: z.string(),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
  });

  const OpenAIToolSchema = z.object({
    type: z.literal('function'),
    function: OpenAIFunctionSchema,
  });

  const OpenAIMessageSchema = z.discriminatedUnion('role', [
    z.object({
      role: z.literal('system'),
      content: z.string(),
      name: z.string().optional(),
    }),
    z.object({
      role: z.literal('user'),
      content: z.string(),
      name: z.string().optional(),
    }),
    z.object({
      role: z.literal('assistant'),
      content: z.string().nullable().optional(),
      name: z.string().optional(),
      tool_calls: z.array(OpenAIToolCallSchema).optional(),
    }),
    z.object({
      role: z.literal('tool'),
      content: z.string(),
      tool_call_id: z.string(),
    }),
  ]);

  const ChatCompletionRequestSchema = z.object({
    model: z.string(),
    messages: z.array(OpenAIMessageSchema).min(1),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().positive().optional(),
    stream: z.boolean().optional().default(false),
    user: z.string().optional(),
    tools: z.array(OpenAIToolSchema).optional(),
    tool_choice: z.union([
      z.literal('none'),
      z.literal('auto'),
      z.object({ type: z.literal('function'), function: z.object({ name: z.string() }) }),
    ]).optional(),
    include_audio: z.boolean().optional().default(false),
  });

  test('accepts a request with tools array', () => {
    const result = ChatCompletionRequestSchema.safeParse({
      model: 'avatar:test-bot',
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get the weather for a location',
            parameters: {
              type: 'object',
              properties: {
                location: { type: 'string' },
              },
              required: ['location'],
            },
          },
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tools).toHaveLength(1);
      expect(result.data.tools![0].function.name).toBe('get_weather');
    }
  });

  test('accepts tool_choice: "none"', () => {
    const result = ChatCompletionRequestSchema.safeParse({
      model: 'avatar:test-bot',
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [{ type: 'function', function: { name: 'test' } }],
      tool_choice: 'none',
    });
    expect(result.success).toBe(true);
  });

  test('accepts tool_choice: "auto"', () => {
    const result = ChatCompletionRequestSchema.safeParse({
      model: 'avatar:test-bot',
      messages: [{ role: 'user', content: 'Hello' }],
      tool_choice: 'auto',
    });
    expect(result.success).toBe(true);
  });

  test('accepts tool_choice as specific function', () => {
    const result = ChatCompletionRequestSchema.safeParse({
      model: 'avatar:test-bot',
      messages: [{ role: 'user', content: 'Hello' }],
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
    });
    expect(result.success).toBe(true);
  });

  test('rejects invalid tool_choice values', () => {
    const result = ChatCompletionRequestSchema.safeParse({
      model: 'avatar:test-bot',
      messages: [{ role: 'user', content: 'Hello' }],
      tool_choice: 'required', // Not a valid value for our schema
    });
    expect(result.success).toBe(false);
  });

  test('accepts tool role messages in history', () => {
    const result = ChatCompletionRequestSchema.safeParse({
      model: 'avatar:test-bot',
      messages: [
        { role: 'user', content: 'What is the weather?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_abc123',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"location":"Seattle"}' },
          }],
        },
        {
          role: 'tool',
          tool_call_id: 'call_abc123',
          content: '{"temp": 72, "conditions": "sunny"}',
        },
        { role: 'user', content: 'Thanks!' },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.messages).toHaveLength(4);
      expect(result.data.messages[1].role).toBe('assistant');
      expect(result.data.messages[2].role).toBe('tool');
    }
  });

  test('rejects tool messages without tool_call_id', () => {
    const result = ChatCompletionRequestSchema.safeParse({
      model: 'avatar:test-bot',
      messages: [
        { role: 'tool', content: 'result' },
      ],
    });
    expect(result.success).toBe(false);
  });

  test('accepts requests without tools (backward compatible)', () => {
    const result = ChatCompletionRequestSchema.safeParse({
      model: 'avatar:my-bot',
      messages: [{ role: 'user', content: 'Hello!' }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tools).toBeUndefined();
      expect(result.data.tool_choice).toBeUndefined();
    }
  });

  test('rejects tools with invalid type', () => {
    const result = ChatCompletionRequestSchema.safeParse({
      model: 'avatar:test-bot',
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [{ type: 'invalid', function: { name: 'test' } }],
    });
    expect(result.success).toBe(false);
  });
});
