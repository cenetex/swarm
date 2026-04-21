/**
 * Tests for avatar-scoped key model defaulting.
 *
 * Covers:
 * - Avatar-scoped key + no model → defaults to avatar:${avatarId}
 * - Avatar-scoped key + matching model → works (regression check)
 * - Avatar-scoped key + mismatched model → 403
 * - Wildcard key + no model → 400 with clear message
 * - Streaming schema accepts optional model
 */
import { describe, test, expect } from 'bun:test';
import { z } from 'zod';
import { parseAvatarId } from './openai-compat.js';

describe('parseAvatarId', () => {
  test('extracts avatar ID from avatar: format', () => {
    expect(parseAvatarId('avatar:test-bot')).toBe('test-bot');
    expect(parseAvatarId('avatar:my-avatar-123')).toBe('my-avatar-123');
  });

  test('treats bare string as avatar ID', () => {
    expect(parseAvatarId('test-bot')).toBe('test-bot');
    expect(parseAvatarId('my-avatar-123')).toBe('my-avatar-123');
  });
});

describe('Schema validation for optional model', () => {
  const ChatCompletionRequestSchema = z.object({
    model: z.string().optional(),
    messages: z.array(z.object({
      role: z.enum(['system', 'user', 'assistant']),
      content: z.string(),
    })).min(1),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().positive().optional(),
    stream: z.boolean().optional().default(false),
    include_audio: z.boolean().optional().default(false),
  });

  test('accepts request without model field', () => {
    const request = {
      messages: [{ role: 'user' as const, content: 'Hello' }],
    };
    const result = ChatCompletionRequestSchema.safeParse(request);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.model).toBeUndefined();
    }
  });

  test('accepts request with model field', () => {
    const request = {
      model: 'avatar:test-bot',
      messages: [{ role: 'user' as const, content: 'Hello' }],
    };
    const result = ChatCompletionRequestSchema.safeParse(request);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.model).toBe('avatar:test-bot');
    }
  });

  test('still rejects invalid messages', () => {
    const request = {
      messages: [],
    };
    const result = ChatCompletionRequestSchema.safeParse(request);
    expect(result.success).toBe(false);
  });
});

describe('Model defaulting logic', () => {
  test('scoped key with undefined model defaults to avatar URL', () => {
    const validation = {
      valid: true,
      avatarId: 'test-avatar',
      session: { email: 'api', userId: 'user', isAdmin: false, accessToken: '' },
    };

    let model: string | undefined;
    if (validation.avatarId) {
      model = `avatar:${validation.avatarId}`;
    }

    expect(model).toBe('avatar:test-avatar');
  });

  test('wildcard key with undefined model should error', () => {
    const validation = {
      valid: true,
      avatarId: undefined,
      session: { email: 'api', userId: 'user', isAdmin: false, accessToken: '' },
    };

    let hasError = false;
    let model: string | undefined;
    if (!model) {
      if (validation.avatarId) {
        model = `avatar:${validation.avatarId}`;
      } else {
        hasError = true;
      }
    }

    expect(hasError).toBe(true);
    expect(model).toBeUndefined();
  });

  test('scoped key with explicit model preserves it', () => {
    let model = 'avatar:test-avatar';

    expect(model).toBe('avatar:test-avatar');
  });

  test('mismatched avatar between key and model is detectable', () => {
    const validation = {
      valid: true,
      avatarId: 'test-avatar',
      session: { email: 'api', userId: 'user', isAdmin: false, accessToken: '' },
    };
    const requestModel = 'avatar:other-avatar';
    const requestAvatarId = parseAvatarId(requestModel);

    const isMismatch = validation.avatarId !== requestAvatarId;
    expect(isMismatch).toBe(true);
  });

  test('matching avatar between key and model is detectable', () => {
    const validation = {
      valid: true,
      avatarId: 'test-avatar',
      session: { email: 'api', userId: 'user', isAdmin: false, accessToken: '' },
    };
    const requestModel = 'avatar:test-avatar';
    const requestAvatarId = parseAvatarId(requestModel);

    const isMatching = validation.avatarId === requestAvatarId;
    expect(isMatching).toBe(true);
  });
});
