/**
 * Tests for OpenAI-compatible streaming (SSE) support.
 *
 * Covers:
 * - formatStreamingResponse produces valid SSE with OpenAI chunk format
 * - formatStreamingError produces SSE error events
 * - Non-streaming responses are unaffected (schema validation only)
 */
import { describe, test, expect } from 'bun:test';
import {
  formatStreamingResponse,
  formatStreamingError,
  normalizeOpenAIMessageForProvider,
  usesExternalToolMode,
} from './openai-compat.js';

const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*' };

function parseSSEEvents(body: string): Array<{ type: 'data'; raw: string; parsed?: unknown }> {
  const events: Array<{ type: 'data'; raw: string; parsed?: unknown }> = [];
  const lines = body.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('data: ')) {
      const raw = trimmed.slice(6);
      if (raw === '[DONE]') {
        events.push({ type: 'data', raw });
      } else {
        try {
          events.push({ type: 'data', raw, parsed: JSON.parse(raw) });
        } catch {
          events.push({ type: 'data', raw });
        }
      }
    }
  }

  return events;
}

describe('formatStreamingResponse', () => {
  test('returns SSE content-type and headers', () => {
    const result = formatStreamingResponse(
      'chatcmpl-123', 1700000000, 'avatar:test-bot',
      'Hello world', { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      CORS_HEADERS,
    );

    expect(result.statusCode).toBe(200);
    expect(result.headers?.['Content-Type']).toBe('text/event-stream');
    expect(result.headers?.['Cache-Control']).toBe('no-cache');
    expect(result.headers?.['Connection']).toBe('keep-alive');
    expect(result.headers?.['Access-Control-Allow-Origin']).toBe('*');
  });

  test('emits role chunk, content chunk, final chunk, and [DONE]', () => {
    const result = formatStreamingResponse(
      'chatcmpl-abc', 1700000000, 'avatar:bot',
      'Hi there!', { promptTokens: 8, completionTokens: 3, totalTokens: 11 },
      CORS_HEADERS,
    );

    const events = parseSSEEvents(result.body as string);
    expect(events.length).toBe(4);

    // First chunk: role announcement
    const roleChunk = events[0].parsed as Record<string, unknown>;
    expect(roleChunk.id).toBe('chatcmpl-abc');
    expect(roleChunk.object).toBe('chat.completion.chunk');
    expect(roleChunk.created).toBe(1700000000);
    expect(roleChunk.model).toBe('avatar:bot');
    const roleChoices = roleChunk.choices as Array<Record<string, unknown>>;
    expect(roleChoices[0].delta).toEqual({ role: 'assistant', content: '' });
    expect(roleChoices[0].finish_reason).toBeNull();

    // Second chunk: content
    const contentChunk = events[1].parsed as Record<string, unknown>;
    const contentChoices = contentChunk.choices as Array<Record<string, unknown>>;
    expect((contentChoices[0].delta as Record<string, unknown>).content).toBe('Hi there!');
    expect(contentChoices[0].finish_reason).toBeNull();

    // Third chunk: finish + usage
    const finalChunk = events[2].parsed as Record<string, unknown>;
    const finalChoices = finalChunk.choices as Array<Record<string, unknown>>;
    expect(finalChoices[0].delta).toEqual({});
    expect(finalChoices[0].finish_reason).toBe('stop');
    expect(finalChunk.usage).toEqual({
      prompt_tokens: 8,
      completion_tokens: 3,
      total_tokens: 11,
    });

    // Fourth: [DONE] sentinel
    expect(events[3].raw).toBe('[DONE]');
  });

  test('handles empty content gracefully (role + final + done)', () => {
    const result = formatStreamingResponse(
      'chatcmpl-empty', 1700000000, 'avatar:bot',
      '', { promptTokens: 5, completionTokens: 0, totalTokens: 5 },
      CORS_HEADERS,
    );

    const events = parseSSEEvents(result.body as string);
    // Empty content means no content chunk emitted
    expect(events.length).toBe(3); // role, final, done

    const roleChunk = events[0].parsed as Record<string, unknown>;
    const roleChoices = roleChunk.choices as Array<Record<string, unknown>>;
    expect((roleChoices[0].delta as Record<string, unknown>).role).toBe('assistant');

    const finalChunk = events[1].parsed as Record<string, unknown>;
    const finalChoices = finalChunk.choices as Array<Record<string, unknown>>;
    expect(finalChoices[0].finish_reason).toBe('stop');

    expect(events[2].raw).toBe('[DONE]');
  });

  test('all chunks share the same id, model, and created timestamp', () => {
    const result = formatStreamingResponse(
      'chatcmpl-shared', 1700000099, 'my-model',
      'test', { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      CORS_HEADERS,
    );

    const events = parseSSEEvents(result.body as string);
    const jsonEvents = events.filter(e => e.parsed);
    for (const event of jsonEvents) {
      const chunk = event.parsed as Record<string, unknown>;
      expect(chunk.id).toBe('chatcmpl-shared');
      expect(chunk.model).toBe('my-model');
      expect(chunk.created).toBe(1700000099);
      expect(chunk.object).toBe('chat.completion.chunk');
    }
  });

  test('emits tool_calls chunk and final tool_calls finish reason', () => {
    const result = formatStreamingResponse(
      'chatcmpl-tools', 1700000000, 'avatar:bot',
      '', { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
      CORS_HEADERS,
      {
        toolCalls: [{
          id: 'call_123',
          type: 'function',
          function: {
            name: 'lookup_weather',
            arguments: '{"city":"San Francisco"}',
          },
        }],
        finishReason: 'tool_calls',
      },
    );

    const events = parseSSEEvents(result.body as string);
    expect(events.length).toBe(4); // role, tool_calls, final, done

    const toolChunk = events[1].parsed as Record<string, unknown>;
    const toolChoices = toolChunk.choices as Array<Record<string, unknown>>;
    const delta = toolChoices[0].delta as Record<string, unknown>;
    const toolCalls = delta.tool_calls as Array<Record<string, unknown>>;
    expect(toolCalls[0].index).toBe(0);
    expect(toolCalls[0].id).toBe('call_123');
    expect((toolCalls[0].function as Record<string, unknown>).name).toBe('lookup_weather');

    const finalChunk = events[2].parsed as Record<string, unknown>;
    const finalChoices = finalChunk.choices as Array<Record<string, unknown>>;
    expect(finalChoices[0].finish_reason).toBe('tool_calls');
  });
});

describe('formatStreamingError', () => {
  test('returns SSE format with error content', () => {
    const result = formatStreamingError(
      'chatcmpl-err', 1700000000, 'avatar:bot',
      'Something went wrong',
      CORS_HEADERS,
    );

    expect(result.statusCode).toBe(200);
    expect(result.headers?.['Content-Type']).toBe('text/event-stream');

    const events = parseSSEEvents(result.body as string);
    expect(events.length).toBe(3); // error content, final, done

    const errorChunk = events[0].parsed as Record<string, unknown>;
    const choices = errorChunk.choices as Array<Record<string, unknown>>;
    expect((choices[0].delta as Record<string, unknown>).content).toBe('Error: Something went wrong');

    const finalChunk = events[1].parsed as Record<string, unknown>;
    const finalChoices = finalChunk.choices as Array<Record<string, unknown>>;
    expect(finalChoices[0].finish_reason).toBe('stop');

    expect(events[2].raw).toBe('[DONE]');
  });

  test('SSE body ends with data: [DONE] line', () => {
    const result = formatStreamingError(
      'chatcmpl-err2', 1700000000, 'model',
      'fail',
      CORS_HEADERS,
    );

    const body = result.body as string;
    expect(body.trimEnd().endsWith('data: [DONE]')).toBe(true);
  });
});

describe('external tool mode helpers', () => {
  test('detects requests that must bypass Swarm tool execution', () => {
    expect(usesExternalToolMode({
      messages: [{ role: 'user' }],
      tools: [{ type: 'function' }],
    })).toBe(true);

    expect(usesExternalToolMode({
      messages: [{ role: 'user' }],
      tools: [],
    })).toBe(true);

    expect(usesExternalToolMode({
      messages: [{ role: 'user' }],
      tool_choice: 'none',
    })).toBe(true);

    expect(usesExternalToolMode({
      messages: [{ role: 'tool' }],
    })).toBe(true);

    expect(usesExternalToolMode({
      messages: [{ role: 'assistant', tool_calls: [{ id: 'call_1' }] }],
    })).toBe(true);

    expect(usesExternalToolMode({
      messages: [{ role: 'user' }],
    })).toBe(false);
  });

  test('normalizes tool messages and assistant tool_calls for provider requests', () => {
    expect(normalizeOpenAIMessageForProvider({
      role: 'tool',
      content: '{"ok":true}',
      tool_call_id: 'call_123',
    })).toEqual({
      role: 'tool',
      content: '{"ok":true}',
      tool_call_id: 'call_123',
    });

    expect(normalizeOpenAIMessageForProvider({
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call_123',
        type: 'function',
        function: { name: 'lookup_weather', arguments: '{}' },
      }],
    })).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_123',
        type: 'function',
        function: { name: 'lookup_weather', arguments: '{}' },
      }],
    });
  });
});
