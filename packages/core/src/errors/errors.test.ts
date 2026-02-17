/**
 * Tests for the typed error hierarchy.
 */
import { describe, it, expect } from 'vitest';

import {
  SwarmError,
  PlatformError,
  LLMError,
  ConfigError,
  StateError,
  MediaError,
  AuthError,
  QueueError,
  NetworkError,
  isSwarmError,
  isSwarmErrorWithCode,
  toSwarmError,
} from './errors.js';
import { SwarmErrorCode } from './codes.js';

// ── SwarmError (base) ──────────────────────────────────────────────────────

describe('SwarmError', () => {
  it('should create with default values', () => {
    const err = new SwarmError('something went wrong');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SwarmError);
    expect(err.name).toBe('SwarmError');
    expect(err.message).toBe('something went wrong');
    expect(err.code).toBe(SwarmErrorCode.UNKNOWN);
    expect(err.retryable).toBe(false);
    expect(err.context).toEqual({});
  });

  it('should accept code, context, retryable, and cause', () => {
    const cause = new Error('root cause');
    const err = new SwarmError('wrapped', {
      code: SwarmErrorCode.NETWORK_FETCH_ERROR,
      cause,
      context: { url: 'https://example.com' },
      retryable: true,
    });

    expect(err.code).toBe(SwarmErrorCode.NETWORK_FETCH_ERROR);
    expect(err.retryable).toBe(true);
    expect(err.context).toEqual({ url: 'https://example.com' });
    expect(err.cause).toBe(cause);
  });

  it('should serialize to JSON for structured logging', () => {
    const cause = new TypeError('bad type');
    const err = new SwarmError('test', {
      code: SwarmErrorCode.LLM_API_ERROR,
      cause,
      context: { model: 'gpt-4' },
      retryable: true,
    });

    const json = err.toJSON();
    expect(json).toEqual({
      name: 'SwarmError',
      code: 'LLM_API_ERROR',
      message: 'test',
      retryable: true,
      context: { model: 'gpt-4' },
      cause: { name: 'TypeError', message: 'bad type' },
    });
  });

  it('should serialize non-Error cause values', () => {
    const err = new SwarmError('oops', { cause: 'string cause' });
    const json = err.toJSON();
    expect(json.cause).toBe('string cause');
  });

  it('should omit cause key when there is no cause', () => {
    const err = new SwarmError('no cause');
    const json = err.toJSON();
    expect('cause' in json).toBe(false);
  });

  it('should have correct prototype chain for instanceof', () => {
    const err = new SwarmError('test');
    expect(err instanceof Error).toBe(true);
    expect(err instanceof SwarmError).toBe(true);
  });
});

// ── PlatformError ──────────────────────────────────────────────────────────

describe('PlatformError', () => {
  it('should carry platform and statusCode', () => {
    const err = new PlatformError('Discord webhook failed', {
      code: SwarmErrorCode.PLATFORM_WEBHOOK_ERROR,
      platform: 'discord',
      statusCode: 403,
      retryable: false,
    });

    expect(err).toBeInstanceOf(SwarmError);
    expect(err).toBeInstanceOf(PlatformError);
    expect(err.name).toBe('PlatformError');
    expect(err.platform).toBe('discord');
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe(SwarmErrorCode.PLATFORM_WEBHOOK_ERROR);
    expect(err.context.platform).toBe('discord');
  });

  it('should default code to PLATFORM_API_ERROR', () => {
    const err = new PlatformError('generic failure', { platform: 'telegram' });
    expect(err.code).toBe(SwarmErrorCode.PLATFORM_API_ERROR);
  });

  it('should pass instanceof checks for the full chain', () => {
    const err = new PlatformError('x', { platform: 'twitter' });
    expect(err instanceof Error).toBe(true);
    expect(err instanceof SwarmError).toBe(true);
    expect(err instanceof PlatformError).toBe(true);
  });

  it('should merge additional context with platform', () => {
    const err = new PlatformError('rate limited', {
      platform: 'twitter',
      code: SwarmErrorCode.PLATFORM_RATE_LIMITED,
      context: { retryAfterMs: 30000 },
      retryable: true,
    });

    expect(err.context).toEqual({ platform: 'twitter', retryAfterMs: 30000 });
    expect(err.retryable).toBe(true);
  });
});

// ── LLMError ───────────────────────────────────────────────────────────────

describe('LLMError', () => {
  it('should carry model and statusCode', () => {
    const err = new LLMError('API returned 429', {
      code: SwarmErrorCode.LLM_API_ERROR,
      model: 'anthropic/claude-sonnet-4',
      statusCode: 429,
      retryable: true,
    });

    expect(err).toBeInstanceOf(LLMError);
    expect(err).toBeInstanceOf(SwarmError);
    expect(err.name).toBe('LLMError');
    expect(err.model).toBe('anthropic/claude-sonnet-4');
    expect(err.statusCode).toBe(429);
    expect(err.retryable).toBe(true);
  });

  it('should default code to LLM_API_ERROR', () => {
    const err = new LLMError('fail');
    expect(err.code).toBe(SwarmErrorCode.LLM_API_ERROR);
  });

  it('should include model in context', () => {
    const err = new LLMError('test', { model: 'gpt-4' });
    expect(err.context.model).toBe('gpt-4');
  });
});

// ── ConfigError ────────────────────────────────────────────────────────────

describe('ConfigError', () => {
  it('should always be non-retryable', () => {
    const err = new ConfigError('file not found', {
      code: SwarmErrorCode.CONFIG_NOT_FOUND,
      context: { filePath: '/etc/config.yaml' },
    });

    expect(err).toBeInstanceOf(ConfigError);
    expect(err).toBeInstanceOf(SwarmError);
    expect(err.name).toBe('ConfigError');
    expect(err.retryable).toBe(false);
    expect(err.code).toBe(SwarmErrorCode.CONFIG_NOT_FOUND);
  });

  it('should default code to CONFIG_VALIDATION_ERROR', () => {
    const err = new ConfigError('bad schema');
    expect(err.code).toBe(SwarmErrorCode.CONFIG_VALIDATION_ERROR);
  });
});

// ── StateError ─────────────────────────────────────────────────────────────

describe('StateError', () => {
  it('should default to retryable', () => {
    const err = new StateError('DynamoDB throttled', {
      code: SwarmErrorCode.STATE_READ_ERROR,
    });

    expect(err).toBeInstanceOf(StateError);
    expect(err.retryable).toBe(true);
  });

  it('should allow overriding retryable to false', () => {
    const err = new StateError('conditional check failed', {
      code: SwarmErrorCode.STATE_WRITE_ERROR,
      retryable: false,
    });

    expect(err.retryable).toBe(false);
  });
});

// ── MediaError ─────────────────────────────────────────────────────────────

describe('MediaError', () => {
  it('should capture media generation details', () => {
    const err = new MediaError('Replicate API error', {
      code: SwarmErrorCode.MEDIA_GENERATION_ERROR,
      context: { provider: 'replicate', model: 'flux' },
    });

    expect(err).toBeInstanceOf(MediaError);
    expect(err.name).toBe('MediaError');
    expect(err.code).toBe(SwarmErrorCode.MEDIA_GENERATION_ERROR);
    expect(err.context.provider).toBe('replicate');
  });

  it('should handle limit-reached scenario', () => {
    const err = new MediaError('Daily limit reached', {
      code: SwarmErrorCode.MEDIA_LIMIT_REACHED,
    });

    expect(err.code).toBe(SwarmErrorCode.MEDIA_LIMIT_REACHED);
    expect(err.retryable).toBe(false);
  });
});

// ── AuthError ──────────────────────────────────────────────────────────────

describe('AuthError', () => {
  it('should always be non-retryable', () => {
    const err = new AuthError('invalid token', {
      code: SwarmErrorCode.AUTH_INVALID_TOKEN,
    });

    expect(err).toBeInstanceOf(AuthError);
    expect(err.retryable).toBe(false);
  });

  it('should support forbidden code', () => {
    const err = new AuthError('not allowed', {
      code: SwarmErrorCode.AUTH_FORBIDDEN,
      context: { userId: 'u123', resource: '/admin' },
    });

    expect(err.code).toBe(SwarmErrorCode.AUTH_FORBIDDEN);
    expect(err.context.userId).toBe('u123');
  });
});

// ── QueueError ─────────────────────────────────────────────────────────────

describe('QueueError', () => {
  it('should default to retryable', () => {
    const err = new QueueError('SQS send failed', {
      code: SwarmErrorCode.QUEUE_SEND_ERROR,
      context: { queueUrl: 'https://sqs.../queue' },
    });

    expect(err).toBeInstanceOf(QueueError);
    expect(err.retryable).toBe(true);
  });

  it('should handle parse errors as non-retryable', () => {
    const err = new QueueError('invalid JSON body', {
      code: SwarmErrorCode.QUEUE_PARSE_ERROR,
      retryable: false,
    });

    expect(err.code).toBe(SwarmErrorCode.QUEUE_PARSE_ERROR);
    expect(err.retryable).toBe(false);
  });
});

// ── NetworkError ───────────────────────────────────────────────────────────

describe('NetworkError', () => {
  it('should carry statusCode and default to retryable', () => {
    const err = new NetworkError('HTTP 503', {
      code: SwarmErrorCode.NETWORK_FETCH_ERROR,
      statusCode: 503,
    });

    expect(err).toBeInstanceOf(NetworkError);
    expect(err).toBeInstanceOf(SwarmError);
    expect(err.statusCode).toBe(503);
    expect(err.retryable).toBe(true);
  });

  it('should handle timeout scenario', () => {
    const err = new NetworkError('request timed out', {
      code: SwarmErrorCode.NETWORK_TIMEOUT,
      context: { timeoutMs: 30000 },
    });

    expect(err.code).toBe(SwarmErrorCode.NETWORK_TIMEOUT);
    expect(err.context.timeoutMs).toBe(30000);
  });
});

// ── Utility functions ──────────────────────────────────────────────────────

describe('isSwarmError', () => {
  it('should return true for SwarmError instances', () => {
    expect(isSwarmError(new SwarmError('test'))).toBe(true);
  });

  it('should return true for subclass instances', () => {
    expect(isSwarmError(new PlatformError('x', { platform: 'discord' }))).toBe(true);
    expect(isSwarmError(new LLMError('x'))).toBe(true);
    expect(isSwarmError(new ConfigError('x'))).toBe(true);
    expect(isSwarmError(new StateError('x'))).toBe(true);
    expect(isSwarmError(new MediaError('x'))).toBe(true);
    expect(isSwarmError(new AuthError('x'))).toBe(true);
    expect(isSwarmError(new QueueError('x'))).toBe(true);
    expect(isSwarmError(new NetworkError('x'))).toBe(true);
  });

  it('should return false for plain Error', () => {
    expect(isSwarmError(new Error('nope'))).toBe(false);
  });

  it('should return false for non-error values', () => {
    expect(isSwarmError('string')).toBe(false);
    expect(isSwarmError(null)).toBe(false);
    expect(isSwarmError(undefined)).toBe(false);
    expect(isSwarmError(42)).toBe(false);
    expect(isSwarmError({})).toBe(false);
  });
});

describe('isSwarmErrorWithCode', () => {
  it('should match by error code', () => {
    const err = new LLMError('x', { code: SwarmErrorCode.LLM_CIRCUIT_OPEN });
    expect(isSwarmErrorWithCode(err, SwarmErrorCode.LLM_CIRCUIT_OPEN)).toBe(true);
    expect(isSwarmErrorWithCode(err, SwarmErrorCode.LLM_API_ERROR)).toBe(false);
  });

  it('should return false for non-SwarmError values', () => {
    expect(isSwarmErrorWithCode(new Error('x'), SwarmErrorCode.UNKNOWN)).toBe(false);
    expect(isSwarmErrorWithCode(null, SwarmErrorCode.UNKNOWN)).toBe(false);
  });
});

describe('toSwarmError', () => {
  it('should return SwarmError instances as-is', () => {
    const original = new LLMError('already typed', {
      code: SwarmErrorCode.LLM_TIMEOUT,
    });
    const result = toSwarmError(original);
    expect(result).toBe(original);
  });

  it('should wrap plain Error with UNKNOWN code', () => {
    const plain = new TypeError('bad type');
    const result = toSwarmError(plain);

    expect(result).toBeInstanceOf(SwarmError);
    expect(result.message).toBe('bad type');
    expect(result.code).toBe(SwarmErrorCode.UNKNOWN);
    expect(result.cause).toBe(plain);
  });

  it('should accept default code and context overrides', () => {
    const plain = new Error('oops');
    const result = toSwarmError(plain, {
      code: SwarmErrorCode.NETWORK_FETCH_ERROR,
      context: { url: 'https://api.example.com' },
      retryable: true,
    });

    expect(result.code).toBe(SwarmErrorCode.NETWORK_FETCH_ERROR);
    expect(result.context.url).toBe('https://api.example.com');
    expect(result.retryable).toBe(true);
  });

  it('should handle non-Error values (strings)', () => {
    const result = toSwarmError('something broke');
    expect(result).toBeInstanceOf(SwarmError);
    expect(result.message).toBe('something broke');
    expect(result.code).toBe(SwarmErrorCode.UNKNOWN);
  });

  it('should handle non-Error values (numbers)', () => {
    const result = toSwarmError(404);
    expect(result).toBeInstanceOf(SwarmError);
    expect(result.message).toBe('404');
  });

  it('should handle null/undefined', () => {
    expect(toSwarmError(null).message).toBe('null');
    expect(toSwarmError(undefined).message).toBe('undefined');
  });
});

// ── Error code enum completeness ───────────────────────────────────────────

describe('SwarmErrorCode', () => {
  it('should have string values matching key names', () => {
    // Verify a sample of codes — ensures we did not accidentally assign wrong values
    expect(SwarmErrorCode.UNKNOWN).toBe('UNKNOWN');
    expect(SwarmErrorCode.PLATFORM_NOT_INITIALIZED).toBe('PLATFORM_NOT_INITIALIZED');
    expect(SwarmErrorCode.LLM_MISSING_API_KEY).toBe('LLM_MISSING_API_KEY');
    expect(SwarmErrorCode.CONFIG_NOT_FOUND).toBe('CONFIG_NOT_FOUND');
    expect(SwarmErrorCode.STATE_WRITE_ERROR).toBe('STATE_WRITE_ERROR');
    expect(SwarmErrorCode.MEDIA_LIMIT_REACHED).toBe('MEDIA_LIMIT_REACHED');
    expect(SwarmErrorCode.AUTH_FORBIDDEN).toBe('AUTH_FORBIDDEN');
    expect(SwarmErrorCode.QUEUE_PARSE_ERROR).toBe('QUEUE_PARSE_ERROR');
    expect(SwarmErrorCode.NETWORK_TIMEOUT).toBe('NETWORK_TIMEOUT');
  });
});
