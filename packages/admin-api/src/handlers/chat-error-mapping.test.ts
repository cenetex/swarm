/**
 * Chat error mapping tests.
 */
import { describe, expect, it, beforeAll } from 'bun:test';
let parseOpenRouterStatusFromError: typeof import('./chat-error-mapping.js').parseOpenRouterStatusFromError;
let isTimeoutLikeError: typeof import('./chat-error-mapping.js').isTimeoutLikeError;
let mapAdminChatHandlerError: typeof import('./chat-error-mapping.js').mapAdminChatHandlerError;
beforeAll(async () => {
  const { _setDynamoClient } = await import('../services/dynamo-client.js');
  const aws = await import('../services/aws-clients.js');
  const s = { send: async () => ({}), config: {}, destroy: () => {} } as any;
  _setDynamoClient(s); aws._setS3Client(s); aws._setSQSClient(s); aws._setSecretsClient(s); aws._setLambdaClient(s);
  const mod = await import('./chat-error-mapping.js');
  parseOpenRouterStatusFromError = mod.parseOpenRouterStatusFromError;
  isTimeoutLikeError = mod.isTimeoutLikeError;
  mapAdminChatHandlerError = mod.mapAdminChatHandlerError;
});
describe('parseOpenRouterStatusFromError', () => {
  it('extracts 402 from error string', () => {
    expect(parseOpenRouterStatusFromError('OpenRouter API error: 402 Payment Required')).toBe(402);
  });
  it('extracts 429 from error string', () => {
    expect(parseOpenRouterStatusFromError('OpenRouter API error: 429 Too Many Requests')).toBe(429);
  });
  it('extracts 503 from error string', () => {
    expect(parseOpenRouterStatusFromError('OpenRouter API error: 503 Service Unavailable')).toBe(503);
  });
  it('returns null for non-OpenRouter errors', () => {
    expect(parseOpenRouterStatusFromError('Something went wrong')).toBeNull();
  });
  it('returns null for empty string', () => {
    expect(parseOpenRouterStatusFromError('')).toBeNull();
  });
  it('handles multi-line error strings', () => {
    expect(parseOpenRouterStatusFromError('Request failed\nOpenRouter API error: 402\nStack trace...')).toBe(402);
  });
});
describe('isTimeoutLikeError', () => {
  it('returns true for TimeoutError', () => {
    const err = new Error('timeout');
    err.name = 'TimeoutError';
    expect(isTimeoutLikeError(err)).toBe(true);
  });
  it('returns true for AbortError', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    expect(isTimeoutLikeError(err)).toBe(true);
  });
  it('returns true for message containing "timeout"', () => {
    expect(isTimeoutLikeError(new Error('Request timeout'))).toBe(true);
  });
  it('returns true for message containing "timed out"', () => {
    expect(isTimeoutLikeError(new Error('Connection timed out'))).toBe(true);
  });
  it('returns true for aborted with timeout', () => {
    expect(isTimeoutLikeError(new Error('Request aborted due to timeout'))).toBe(true);
  });
  it('returns false for normal errors', () => {
    expect(isTimeoutLikeError(new Error('Not found'))).toBe(false);
  });
  it('returns false for non-Error objects', () => {
    expect(isTimeoutLikeError('some string')).toBe(false);
  });
  it('returns false for null', () => {
    expect(isTimeoutLikeError(null)).toBe(false);
  });
});
describe('mapAdminChatHandlerError', () => {
  it('maps credit exhaustion to 402', () => {
    // We can't import LlmCreditsExhaustedError directly without triggering the chain,
    // but we can test the circuit-breaker and generic paths
    const result = mapAdminChatHandlerError(new Error('OpenRouter API error: 402 Payment Required'));
    expect(result.statusCode).toBe(402);
    expect(result.publicError).toMatch(/credit balance/i);
  });
  it('maps rate limiting to 429', () => {
    const result = mapAdminChatHandlerError(new Error('OpenRouter API error: 429 Too Many Requests'));
    expect(result.statusCode).toBe(429);
    expect(result.publicError).toBe('LLM rate limited');
  });
  it('maps circuit breaker open to 503', () => {
    const result = mapAdminChatHandlerError(new Error('circuit breaker open for model'));
    expect(result.statusCode).toBe(503);
    expect(result.publicError).toBe('LLM temporarily unavailable');
  });
  it('maps timeout to 504', () => {
    const err = new Error('Connection timeout');
    err.name = 'TimeoutError';
    const result = mapAdminChatHandlerError(err);
    expect(result.statusCode).toBe(504);
    expect(result.publicError).toBe('Request timed out');
  });
  it('maps AbortError timeout to 504', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    const result = mapAdminChatHandlerError(err);
    expect(result.statusCode).toBe(504);
  });
  it('maps generic errors to 500', () => {
    const result = mapAdminChatHandlerError(new Error('Something unexpected'));
    expect(result.statusCode).toBe(500);
    expect(result.publicError).toBe('Internal server error');
  });
  it('handles non-Error throws', () => {
    const result = mapAdminChatHandlerError('plain string error');
    expect(result.statusCode).toBe(500);
    expect(result.publicError).toBe('Internal server error');
  });
});
