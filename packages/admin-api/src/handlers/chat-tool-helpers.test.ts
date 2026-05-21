import { describe, expect, test } from 'bun:test';
import { buildModelSelectorPayload, buildPauseToolPayload, sanitizeToolError } from './chat-tool-helpers.js';

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
  // -------------------------------------------------------------------------
  // AWS ARN stripping
  // -------------------------------------------------------------------------
  test('strips IAM role ARNs from error messages', () => {
    const input =
      'User: arn:aws:iam::123456789012:role/swarm-admin-role is not authorized to perform: dynamodb:Query';
    const result = sanitizeToolError(input);
    expect(result).not.toContain('arn:aws:');
    expect(result).not.toContain('123456789012');
    // Authorization error should be replaced entirely
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

  // -------------------------------------------------------------------------
  // AWS authorization error replacement
  // -------------------------------------------------------------------------
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

  // -------------------------------------------------------------------------
  // Normal (non-AWS) errors pass through unchanged
  // -------------------------------------------------------------------------
  test('passes through normal error messages unchanged', () => {
    const input = 'Something went wrong, please try again';
    expect(sanitizeToolError(input)).toBe(input);
  });

  test('passes through short error strings unchanged', () => {
    const input = 'Not found';
    expect(sanitizeToolError(input)).toBe(input);
  });

  // -------------------------------------------------------------------------
  // JSON error extraction still works
  // -------------------------------------------------------------------------
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

  // -------------------------------------------------------------------------
  // Truncation still works
  // -------------------------------------------------------------------------
  test('truncates long non-AWS error messages', () => {
    const longMessage = 'x'.repeat(500);
    const result = sanitizeToolError(longMessage);
    expect(result.length).toBeLessThanOrEqual(301); // 300 + ellipsis
    expect(result).toEndWith('\u2026'); // ends with …
  });

  test('truncates long messages after ARN stripping', () => {
    const longMessage =
      'Error accessing arn:aws:dynamodb:us-east-1:123456789012:table/X ' + 'y'.repeat(500);
    const result = sanitizeToolError(longMessage);
    expect(result).not.toContain('arn:aws:');
    expect(result.length).toBeLessThanOrEqual(301);
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------
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
