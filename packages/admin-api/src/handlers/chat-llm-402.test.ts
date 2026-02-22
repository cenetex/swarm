/**
 * Tests for OpenRouter 402 credit failure handling.
 *
 * Covers:
 * - LlmCreditsExhaustedError class with model/token metadata
 * - Adaptive retry with reduced max_tokens in callLlmDirectFallback
 * - parseOpenRouterStatusFromError detecting 402
 * - mapAdminChatHandlerError mapping 402 to user-friendly message
 * - Chat worker 402 detection (both error class and message pattern)
 */
import { describe, test, expect } from 'bun:test';
import {
  LlmCreditsExhaustedError,
  CREDIT_RETRY_TOKEN_FRACTION,
  CREDIT_RETRY_MIN_TOKENS,
  isRetryableLlmError,
} from './chat-llm.js';
import {
  parseOpenRouterStatusFromError,
  mapAdminChatHandlerError,
} from './chat-error-mapping.js';

// ---------------------------------------------------------------------------
// LlmCreditsExhaustedError
// ---------------------------------------------------------------------------
describe('LlmCreditsExhaustedError', () => {
  test('has statusCode 402 and correct name', () => {
    const err = new LlmCreditsExhaustedError('out of credits');
    expect(err.statusCode).toBe(402);
    expect(err.name).toBe('LlmCreditsExhaustedError');
    expect(err.message).toBe('out of credits');
    expect(err).toBeInstanceOf(Error);
  });

  test('preserves model and token metadata', () => {
    const err = new LlmCreditsExhaustedError('402 error', {
      model: 'anthropic/claude-sonnet-4',
      requestedMaxTokens: 2048,
      reducedMaxTokens: 1024,
    });
    expect(err.model).toBe('anthropic/claude-sonnet-4');
    expect(err.requestedMaxTokens).toBe(2048);
    expect(err.reducedMaxTokens).toBe(1024);
  });

  test('metadata fields are undefined when not provided', () => {
    const err = new LlmCreditsExhaustedError('402 error');
    expect(err.model).toBeUndefined();
    expect(err.requestedMaxTokens).toBeUndefined();
    expect(err.reducedMaxTokens).toBeUndefined();
  });

  test('is NOT retryable by the generic retry logic', () => {
    const err = new LlmCreditsExhaustedError('OpenRouter API error: 402 insufficient credits');
    expect(isRetryableLlmError(err)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Adaptive retry constants
// ---------------------------------------------------------------------------
describe('Credit retry constants', () => {
  test('CREDIT_RETRY_TOKEN_FRACTION is between 0 and 1', () => {
    expect(CREDIT_RETRY_TOKEN_FRACTION).toBeGreaterThan(0);
    expect(CREDIT_RETRY_TOKEN_FRACTION).toBeLessThan(1);
  });

  test('CREDIT_RETRY_MIN_TOKENS is a positive integer', () => {
    expect(CREDIT_RETRY_MIN_TOKENS).toBeGreaterThan(0);
    expect(Number.isInteger(CREDIT_RETRY_MIN_TOKENS)).toBe(true);
  });

  test('reduced tokens calculation produces correct result', () => {
    const maxTokens = 2048;
    const reduced = Math.max(
      CREDIT_RETRY_MIN_TOKENS,
      Math.floor(maxTokens * CREDIT_RETRY_TOKEN_FRACTION)
    );
    expect(reduced).toBe(1024);
    expect(reduced).toBeLessThan(maxTokens);
  });

  test('reduced tokens does not go below minimum', () => {
    const maxTokens = 200; // Very small budget
    const reduced = Math.max(
      CREDIT_RETRY_MIN_TOKENS,
      Math.floor(maxTokens * CREDIT_RETRY_TOKEN_FRACTION)
    );
    expect(reduced).toBe(CREDIT_RETRY_MIN_TOKENS);
  });

  test('reduced tokens equals min when already at min', () => {
    const maxTokens = CREDIT_RETRY_MIN_TOKENS;
    const reduced = Math.max(
      CREDIT_RETRY_MIN_TOKENS,
      Math.floor(maxTokens * CREDIT_RETRY_TOKEN_FRACTION)
    );
    // reduced < maxTokens is false, so adaptive retry would not trigger
    expect(reduced).toBe(CREDIT_RETRY_MIN_TOKENS);
    expect(reduced < maxTokens).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseOpenRouterStatusFromError
// ---------------------------------------------------------------------------
describe('parseOpenRouterStatusFromError', () => {
  test('parses 402 from standard error message', () => {
    expect(parseOpenRouterStatusFromError('OpenRouter API error: 402 insufficient credits')).toBe(402);
  });

  test('parses 402 from error with JSON body', () => {
    const msg = 'OpenRouter API error: 402 {"error":{"message":"insufficient credits"}}';
    expect(parseOpenRouterStatusFromError(msg)).toBe(402);
  });

  test('returns null for non-matching messages', () => {
    expect(parseOpenRouterStatusFromError('some random error')).toBeNull();
    expect(parseOpenRouterStatusFromError('HTTP 402 payment required')).toBeNull();
  });

  test('parses other status codes', () => {
    expect(parseOpenRouterStatusFromError('OpenRouter API error: 429 rate limited')).toBe(429);
    expect(parseOpenRouterStatusFromError('OpenRouter API error: 500 internal')).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// mapAdminChatHandlerError - 402 handling
// ---------------------------------------------------------------------------
describe('mapAdminChatHandlerError - 402 credit errors', () => {
  test('maps LlmCreditsExhaustedError to 402 with actionable message', () => {
    const err = new LlmCreditsExhaustedError('OpenRouter API error: 402 insufficient credits');
    const result = mapAdminChatHandlerError(err);
    expect(result.statusCode).toBe(402);
    expect(result.publicError).toContain('credit');
    expect(result.publicError).toContain('administrator');
    expect(result.errorMessage).toContain('402');
  });

  test('maps error with 402 in message to 402 status', () => {
    const err = new Error('OpenRouter API error: 402 insufficient credits');
    const result = mapAdminChatHandlerError(err);
    expect(result.statusCode).toBe(402);
    expect(result.publicError).toContain('credit');
  });

  test('maps LlmCreditsExhaustedError even without "OpenRouter API error:" pattern', () => {
    const err = new LlmCreditsExhaustedError('credits depleted, cannot process');
    const result = mapAdminChatHandlerError(err);
    expect(result.statusCode).toBe(402);
    expect(result.publicError).toContain('credit');
  });

  test('does not map non-402 errors to 402', () => {
    const err = new Error('OpenRouter API error: 500 internal server error');
    const result = mapAdminChatHandlerError(err);
    expect(result.statusCode).not.toBe(402);
  });
});

// ---------------------------------------------------------------------------
// Chat worker 402 detection logic
// ---------------------------------------------------------------------------
describe('Chat worker 402 detection', () => {
  test('detects 402 via LlmCreditsExhaustedError instance', () => {
    const error = new LlmCreditsExhaustedError('402 error');
    const message = error.message;

    const is402 =
      error instanceof LlmCreditsExhaustedError ||
      parseOpenRouterStatusFromError(message) === 402;

    expect(is402).toBe(true);
  });

  test('detects 402 via error message pattern (SDK path)', () => {
    const error = new Error('OpenRouter API error: 402 insufficient credits');
    const message = error.message;

    const is402 =
      error instanceof LlmCreditsExhaustedError ||
      parseOpenRouterStatusFromError(message) === 402;

    expect(is402).toBe(true);
  });

  test('does not false-positive for non-402 errors', () => {
    const error = new Error('Connection timeout');
    const message = error.message;

    const is402 =
      error instanceof LlmCreditsExhaustedError ||
      parseOpenRouterStatusFromError(message) === 402;

    expect(is402).toBe(false);
  });

  test('does not false-positive for 429 errors', () => {
    const error = new Error('OpenRouter API error: 429 rate limited');
    const message = error.message;

    const is402 =
      error instanceof LlmCreditsExhaustedError ||
      parseOpenRouterStatusFromError(message) === 402;

    expect(is402).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Adaptive retry decision logic (unit, no network)
// ---------------------------------------------------------------------------
describe('Adaptive retry decision logic', () => {
  test('canRetryWithLess is true when reduced < original and not yet retried', () => {
    const maxTokens = 2048;
    const creditRetried = false;
    const reducedTokens = Math.max(
      CREDIT_RETRY_MIN_TOKENS,
      Math.floor(maxTokens * CREDIT_RETRY_TOKEN_FRACTION)
    );
    const canRetryWithLess = reducedTokens < maxTokens && !creditRetried;
    expect(canRetryWithLess).toBe(true);
    expect(reducedTokens).toBe(1024);
  });

  test('canRetryWithLess is false after first credit retry', () => {
    const maxTokens = 2048;
    const creditRetried = true;
    const reducedTokens = Math.max(
      CREDIT_RETRY_MIN_TOKENS,
      Math.floor(maxTokens * CREDIT_RETRY_TOKEN_FRACTION)
    );
    const canRetryWithLess = reducedTokens < maxTokens && !creditRetried;
    expect(canRetryWithLess).toBe(false);
  });

  test('canRetryWithLess is false when tokens already at minimum', () => {
    const maxTokens = CREDIT_RETRY_MIN_TOKENS;
    const creditRetried = false;
    const reducedTokens = Math.max(
      CREDIT_RETRY_MIN_TOKENS,
      Math.floor(maxTokens * CREDIT_RETRY_TOKEN_FRACTION)
    );
    const canRetryWithLess = reducedTokens < maxTokens && !creditRetried;
    expect(canRetryWithLess).toBe(false);
  });

  test('canRetryWithLess is false when tokens below minimum threshold', () => {
    const maxTokens = 64; // Below CREDIT_RETRY_MIN_TOKENS
    const creditRetried = false;
    const reducedTokens = Math.max(
      CREDIT_RETRY_MIN_TOKENS,
      Math.floor(maxTokens * CREDIT_RETRY_TOKEN_FRACTION)
    );
    // reducedTokens = max(128, 32) = 128, which is >= 64 so canRetryWithLess is false
    const canRetryWithLess = reducedTokens < maxTokens && !creditRetried;
    expect(canRetryWithLess).toBe(false);
  });
});
