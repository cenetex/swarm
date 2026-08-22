import { AuthError, SwarmErrorCode } from '@swarm/core';
/**
 * Tests for authentication error handling in the chat handler.
 *
 * Covers:
 * - Missing auth token → 401
 * - Expired session → 401
 * - AuthError passthrough in mapAdminChatHandlerError
 * - Valid auth proceeds normally (no 401)
 */
import { describe, test, expect } from 'bun:test';
import { mapAdminChatHandlerError } from './chat-error-mapping.js';

describe('mapAdminChatHandlerError - 401 auth errors', () => {
  test('maps AuthError with statusCode 401 for missing token', () => {
    const err = new AuthError('No authentication token provided', {
      code: SwarmErrorCode.AUTH_INVALID_TOKEN,
      statusCode: 401,
    });
    const result = mapAdminChatHandlerError(err);
    expect(result.statusCode).toBe(401);
    expect(result.publicError).toBe('No authentication token provided');
    expect(result.errorMessage).toBe('No authentication token provided');
  });

  test('maps AuthError with statusCode 401 for expired session', () => {
    const err = new AuthError('Session expired', {
      code: SwarmErrorCode.AUTH_INVALID_TOKEN,
      statusCode: 401,
    });
    const result = mapAdminChatHandlerError(err);
    expect(result.statusCode).toBe(401);
    expect(result.publicError).toBe('Session expired');
    expect(result.errorMessage).toBe('Session expired');
  });

  test('maps AuthError with statusCode 403 for access denied', () => {
    const err = new AuthError('Active user slots full', {
      code: SwarmErrorCode.AUTH_ACCESS_DENIED,
      statusCode: 403,
    });
    const result = mapAdminChatHandlerError(err);
    expect(result.statusCode).toBe(403);
    expect(result.publicError).toBe('Active user slots full');
  });

  test('does not map plain Error to 401', () => {
    const err = new Error('Something went wrong');
    const result = mapAdminChatHandlerError(err);
    expect(result.statusCode).toBe(500);
  });

  test('does not interfere with LLM error mapping', () => {
    const err = new Error('OpenRouter API error: 429 rate limited');
    const result = mapAdminChatHandlerError(err);
    expect(result.statusCode).toBe(429);
  });
});
