/**
 * OutboundSender Tests
 * Tests for structured ActionError handling (#368)
 */
import { describe, it, expect } from 'vitest';
import { OutboundSender } from './outbound-sender.js';
import type { ActionError } from './outbound-sender.js';
import { PlatformRegistry } from '../platforms/base.js';
import { PlatformError } from '../errors/errors.js';
import { SwarmErrorCode } from '../errors/codes.js';
import type { SwarmResponse, ResponseAction } from '../types/index.js';

/**
 * Minimal mock adapter for testing OutboundSender error propagation.
 */
function createMockAdapter(behavior: {
  executeAction?: (action: ResponseAction) => Promise<boolean>;
}) {
  return {
    platform: 'twitter' as const,
    isConfigured: () => true,
    getDisplayName: () => 'Mock Twitter',
    verifyRequest: async () => true,
    parseMessage: async () => null,
    sendTypingIndicator: async () => {},
    executeAction: behavior.executeAction ?? (async () => true),
  };
}

function makeResponse(overrides: Partial<SwarmResponse> = {}): SwarmResponse {
  return {
    avatarId: 'test-avatar',
    platform: 'twitter',
    conversationId: 'conv-123',
    actions: [{ type: 'send_message', text: 'Hello!' } as ResponseAction],
    replyToMessageId: 'tweet-456',
    ...overrides,
  } as SwarmResponse;
}

describe('OutboundSender - ActionError structure (#368)', () => {
  it('should return empty errors array on success', async () => {
    const registry = new PlatformRegistry();
    registry.register(createMockAdapter({}) as never);

    const sender = new OutboundSender(registry);
    const result = await sender.send(makeResponse());

    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.sentMessages).toEqual(['Hello!']);
  });

  it('should return ActionError with isRetryable=false for non-retryable PlatformError', async () => {
    const registry = new PlatformRegistry();
    registry.register(
      createMockAdapter({
        executeAction: async () => {
          throw new PlatformError('Forbidden: reply restriction', {
            platform: 'twitter',
            statusCode: 403,
            retryable: false,
            code: SwarmErrorCode.PLATFORM_API_ERROR,
          });
        },
      }) as never,
    );

    const sender = new OutboundSender(registry);
    const result = await sender.send(makeResponse());

    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);

    const err: ActionError = result.errors[0];
    expect(err.action).toBe('send_message');
    expect(err.statusCode).toBe(403);
    expect(err.isRetryable).toBe(false);
    expect(err.message).toContain('Forbidden');
  });

  it('should return ActionError with isRetryable=true for retryable PlatformError (500)', async () => {
    const registry = new PlatformRegistry();
    registry.register(
      createMockAdapter({
        executeAction: async () => {
          throw new PlatformError('Internal Server Error', {
            platform: 'twitter',
            statusCode: 500,
            retryable: true,
            code: SwarmErrorCode.PLATFORM_API_ERROR,
          });
        },
      }) as never,
    );

    const sender = new OutboundSender(registry);
    const result = await sender.send(makeResponse());

    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);

    const err: ActionError = result.errors[0];
    expect(err.statusCode).toBe(500);
    expect(err.isRetryable).toBe(true);
  });

  it('should default isRetryable to true for generic errors', async () => {
    const registry = new PlatformRegistry();
    registry.register(
      createMockAdapter({
        executeAction: async () => {
          throw new Error('Something unexpected');
        },
      }) as never,
    );

    const sender = new OutboundSender(registry);
    const result = await sender.send(makeResponse());

    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);

    const err: ActionError = result.errors[0];
    expect(err.isRetryable).toBe(true);
    expect(err.statusCode).toBeUndefined();
  });

  it('should return non-retryable ActionError when adapter returns false', async () => {
    const registry = new PlatformRegistry();
    registry.register(
      createMockAdapter({
        executeAction: async () => false,
      }) as never,
    );

    const sender = new OutboundSender(registry);
    const result = await sender.send(makeResponse());

    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].action).toBe('send_message');
    expect(result.errors[0].isRetryable).toBe(true);
  });

  it('should return non-retryable error for missing platform adapter', async () => {
    const registry = new PlatformRegistry();
    // Don't register any adapter

    const sender = new OutboundSender(registry);
    const result = await sender.send(makeResponse());

    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].isRetryable).toBe(false);
    expect(result.errors[0].message).toContain('No adapter found');
  });
});
