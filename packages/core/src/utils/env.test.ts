/**
 * Tests for centralized environment variable validation.
 *
 * Tests use bun:test (project convention).
 */
import { describe, it, expect } from 'bun:test';
import { z } from 'zod';
import {
  BaseEnvSchema,
  TelegramWebhookEnvSchema,
  MessageProcessorEnvSchema,
  ResponseSenderEnvSchema,
  TweetPosterEnvSchema,
  AdminApiEnvSchema,
  EnvValidationError,
  validateEnv,
  tryValidateEnv,
  requireEnv,
  optionalEnv,
  envPrimitives,
} from './env.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid env for BaseEnvSchema */
function baseEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    STATE_TABLE: 'swarm-state-staging',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// BaseEnvSchema
// ---------------------------------------------------------------------------

describe('BaseEnvSchema', () => {
  it('accepts valid minimal env', () => {
    const env = validateEnv(BaseEnvSchema, baseEnv());
    expect(env.STATE_TABLE).toBe('swarm-state-staging');
    expect(env.SECRET_PREFIX).toBe('swarm'); // default
    expect(env.ENVIRONMENT).toBeUndefined();
    expect(env.LOG_LEVEL).toBeUndefined();
    expect(env.NODE_ENV).toBeUndefined();
  });

  it('applies SECRET_PREFIX default when not provided', () => {
    const env = validateEnv(BaseEnvSchema, baseEnv());
    expect(env.SECRET_PREFIX).toBe('swarm');
  });

  it('accepts explicit SECRET_PREFIX', () => {
    const env = validateEnv(BaseEnvSchema, baseEnv({ SECRET_PREFIX: 'custom' }));
    expect(env.SECRET_PREFIX).toBe('custom');
  });

  it('rejects missing STATE_TABLE', () => {
    expect(() => validateEnv(BaseEnvSchema, {})).toThrow(EnvValidationError);
  });

  it('rejects empty STATE_TABLE', () => {
    expect(() => validateEnv(BaseEnvSchema, { STATE_TABLE: '' })).toThrow(EnvValidationError);
  });

  it('accepts optional fields', () => {
    const env = validateEnv(BaseEnvSchema, baseEnv({
      ENVIRONMENT: 'staging',
      LOG_LEVEL: 'debug',
      NODE_ENV: 'production',
    }));
    expect(env.ENVIRONMENT).toBe('staging');
    expect(env.LOG_LEVEL).toBe('debug');
    expect(env.NODE_ENV).toBe('production');
  });

  it('converts empty optional strings to undefined', () => {
    const env = validateEnv(BaseEnvSchema, baseEnv({ ENVIRONMENT: '' }));
    expect(env.ENVIRONMENT).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TelegramWebhookEnvSchema
// ---------------------------------------------------------------------------

describe('TelegramWebhookEnvSchema', () => {
  it('accepts valid env', () => {
    const env = validateEnv(TelegramWebhookEnvSchema, {
      ...baseEnv(),
      MESSAGE_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123/swarm-messages.fifo',
    });
    expect(env.MESSAGE_QUEUE_URL).toContain('sqs');
    expect(env.WEBHOOK_DOMAIN).toBeUndefined();
  });

  it('rejects missing MESSAGE_QUEUE_URL', () => {
    expect(() => validateEnv(TelegramWebhookEnvSchema, baseEnv())).toThrow(EnvValidationError);
  });

  it('parses optional TELEGRAM_SUPERADMIN_USERNAMES', () => {
    const env = validateEnv(TelegramWebhookEnvSchema, {
      ...baseEnv(),
      MESSAGE_QUEUE_URL: 'https://sqs.example.com/queue',
      TELEGRAM_SUPERADMIN_USERNAMES: 'admin1',
    });
    expect(env.TELEGRAM_SUPERADMIN_USERNAMES).toBe('admin1');
  });
});

// ---------------------------------------------------------------------------
// MessageProcessorEnvSchema
// ---------------------------------------------------------------------------

describe('MessageProcessorEnvSchema', () => {
  const validEnv = {
    ...baseEnv(),
    RESPONSE_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123/responses.fifo',
    MEDIA_BUCKET: 'swarm-media-staging',
  };

  it('accepts valid env', () => {
    const env = validateEnv(MessageProcessorEnvSchema, validEnv);
    expect(env.RESPONSE_QUEUE_URL).toContain('responses');
    expect(env.MEDIA_BUCKET).toBe('swarm-media-staging');
    expect(env.ENABLE_VOICE_TOOLS).toBe(false); // default
    expect(env.BRAIN_INJECT_CONTEXT).toBe(false); // default
  });

  it('rejects missing RESPONSE_QUEUE_URL', () => {
    const { RESPONSE_QUEUE_URL: _, ...missing } = validEnv;
    expect(() => validateEnv(MessageProcessorEnvSchema, missing)).toThrow(EnvValidationError);
  });

  it('rejects missing MEDIA_BUCKET', () => {
    const { MEDIA_BUCKET: _, ...missing } = validEnv;
    expect(() => validateEnv(MessageProcessorEnvSchema, missing)).toThrow(EnvValidationError);
  });

  it('parses boolean flags correctly', () => {
    const env = validateEnv(MessageProcessorEnvSchema, {
      ...validEnv,
      ENABLE_VOICE_TOOLS: 'true',
      BRAIN_INJECT_CONTEXT: 'false',
    });
    expect(env.ENABLE_VOICE_TOOLS).toBe(true);
    expect(env.BRAIN_INJECT_CONTEXT).toBe(false);
  });

  it('treats missing boolean flags as false', () => {
    const env = validateEnv(MessageProcessorEnvSchema, validEnv);
    expect(env.ENABLE_VOICE_TOOLS).toBe(false);
    expect(env.BRAIN_INJECT_CONTEXT).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ResponseSenderEnvSchema
// ---------------------------------------------------------------------------

describe('ResponseSenderEnvSchema', () => {
  it('accepts valid env', () => {
    const env = validateEnv(ResponseSenderEnvSchema, {
      ...baseEnv(),
      ACTIVITY_TABLE: 'swarm-activity-staging',
    });
    expect(env.ACTIVITY_TABLE).toBe('swarm-activity-staging');
    expect(env.MEDIA_BUCKET).toBeUndefined();
    expect(env.AVATAR_ID).toBeUndefined();
  });

  it('rejects missing ACTIVITY_TABLE', () => {
    expect(() => validateEnv(ResponseSenderEnvSchema, baseEnv())).toThrow(EnvValidationError);
  });
});

// ---------------------------------------------------------------------------
// TweetPosterEnvSchema
// ---------------------------------------------------------------------------

describe('TweetPosterEnvSchema', () => {
  const validEnv = {
    ...baseEnv(),
    ACTIVITY_TABLE: 'swarm-activity-staging',
    MEDIA_BUCKET: 'swarm-media-staging',
  };

  it('accepts valid env', () => {
    const env = validateEnv(TweetPosterEnvSchema, validEnv);
    expect(env.ACTIVITY_TABLE).toBe('swarm-activity-staging');
    expect(env.MEDIA_BUCKET).toBe('swarm-media-staging');
    expect(env.ENABLE_CONTENT_STORE).toBe(false);
    expect(env.ENABLE_DECOUPLED_POSTING).toBe(false);
  });

  it('parses feature flags', () => {
    const env = validateEnv(TweetPosterEnvSchema, {
      ...validEnv,
      ENABLE_CONTENT_STORE: 'true',
      ENABLE_DECOUPLED_POSTING: 'true',
    });
    expect(env.ENABLE_CONTENT_STORE).toBe(true);
    expect(env.ENABLE_DECOUPLED_POSTING).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AdminApiEnvSchema
// ---------------------------------------------------------------------------

describe('AdminApiEnvSchema', () => {
  it('accepts valid env with defaults', () => {
    const env = validateEnv(AdminApiEnvSchema, baseEnv());
    expect(env.ALLOWED_ORIGINS).toEqual([]);
    expect(env.ADMIN_WALLETS).toEqual([]);
    expect(env.LLM_MAX_TOKENS).toBeUndefined();
  });

  it('parses comma-separated ALLOWED_ORIGINS', () => {
    const env = validateEnv(AdminApiEnvSchema, baseEnv({
      ALLOWED_ORIGINS: 'https://admin.example.com, https://dev.example.com',
    }));
    expect(env.ALLOWED_ORIGINS).toEqual([
      'https://admin.example.com',
      'https://dev.example.com',
    ]);
  });

  it('parses ADMIN_WALLETS', () => {
    const env = validateEnv(AdminApiEnvSchema, baseEnv({
      ADMIN_WALLETS: 'wallet1,wallet2,wallet3',
    }));
    expect(env.ADMIN_WALLETS).toEqual(['wallet1', 'wallet2', 'wallet3']);
  });

  it('parses LLM_MAX_TOKENS as number', () => {
    const env = validateEnv(AdminApiEnvSchema, baseEnv({
      LLM_MAX_TOKENS: '2048',
    }));
    expect(env.LLM_MAX_TOKENS).toBe(2048);
  });

  it('returns undefined for non-numeric LLM_MAX_TOKENS', () => {
    const env = validateEnv(AdminApiEnvSchema, baseEnv({
      LLM_MAX_TOKENS: 'not-a-number',
    }));
    expect(env.LLM_MAX_TOKENS).toBeUndefined();
  });

  it('returns empty array for empty comma-separated lists', () => {
    const env = validateEnv(AdminApiEnvSchema, baseEnv({
      ALLOWED_ORIGINS: '',
    }));
    expect(env.ALLOWED_ORIGINS).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// EnvValidationError
// ---------------------------------------------------------------------------

describe('EnvValidationError', () => {
  it('formats multiple issues into readable message', () => {
    const error = new z.ZodError([
      { code: 'invalid_type', expected: 'string', received: 'undefined', path: ['STATE_TABLE'], message: 'Required' },
      { code: 'invalid_type', expected: 'string', received: 'undefined', path: ['RESPONSE_QUEUE_URL'], message: 'Required' },
    ]);
    const envError = new EnvValidationError(error);

    expect(envError.name).toBe('EnvValidationError');
    expect(envError.message).toContain('STATE_TABLE');
    expect(envError.message).toContain('RESPONSE_QUEUE_URL');
    expect(envError.issues).toHaveLength(2);
  });

  it('includes the "Environment variable validation failed" prefix', () => {
    const error = new z.ZodError([
      { code: 'too_small', minimum: 1, type: 'string', inclusive: true, exact: false, path: ['FOO'], message: 'must not be empty' },
    ]);
    const envError = new EnvValidationError(error);
    expect(envError.message).toContain('Environment variable validation failed');
  });
});

// ---------------------------------------------------------------------------
// validateEnv / tryValidateEnv
// ---------------------------------------------------------------------------

describe('validateEnv', () => {
  it('throws EnvValidationError on invalid input', () => {
    try {
      validateEnv(BaseEnvSchema, {});
      // Should not reach here
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
    }
  });

  it('returns parsed env on valid input', () => {
    const result = validateEnv(BaseEnvSchema, baseEnv());
    expect(result.STATE_TABLE).toBe('swarm-state-staging');
  });
});

describe('tryValidateEnv', () => {
  it('returns null on invalid input', () => {
    const result = tryValidateEnv(BaseEnvSchema, {});
    expect(result).toBeNull();
  });

  it('returns parsed env on valid input', () => {
    const result = tryValidateEnv(BaseEnvSchema, baseEnv());
    expect(result).not.toBeNull();
    expect(result!.STATE_TABLE).toBe('swarm-state-staging');
  });
});

// ---------------------------------------------------------------------------
// requireEnv / optionalEnv
// ---------------------------------------------------------------------------

describe('requireEnv', () => {
  it('returns value when present', () => {
    expect(requireEnv('FOO', { FOO: 'bar' })).toBe('bar');
  });

  it('throws when missing', () => {
    expect(() => requireEnv('MISSING', {})).toThrow(EnvValidationError);
  });

  it('throws when empty', () => {
    expect(() => requireEnv('EMPTY', { EMPTY: '' })).toThrow(EnvValidationError);
  });
});

describe('optionalEnv', () => {
  it('returns value when present', () => {
    expect(optionalEnv('FOO', { FOO: 'bar' })).toBe('bar');
  });

  it('returns undefined when missing', () => {
    expect(optionalEnv('MISSING', {})).toBeUndefined();
  });

  it('returns undefined when empty', () => {
    expect(optionalEnv('EMPTY', { EMPTY: '' })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// envPrimitives
// ---------------------------------------------------------------------------

describe('envPrimitives', () => {
  it('requiredString rejects empty', () => {
    const result = envPrimitives.requiredString.safeParse('');
    expect(result.success).toBe(false);
  });

  it('requiredString accepts non-empty', () => {
    const result = envPrimitives.requiredString.safeParse('hello');
    expect(result.success).toBe(true);
  });

  it('booleanFlag parses "true"', () => {
    const result = envPrimitives.booleanFlag.safeParse('true');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(true);
  });

  it('booleanFlag parses "false"', () => {
    const result = envPrimitives.booleanFlag.safeParse('false');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(false);
  });

  it('booleanFlag defaults to false for undefined', () => {
    const result = envPrimitives.booleanFlag.safeParse(undefined);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(false);
  });

  it('optionalNumber parses valid number', () => {
    const result = envPrimitives.optionalNumber.safeParse('42');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(42);
  });

  it('optionalNumber returns undefined for non-numeric', () => {
    const result = envPrimitives.optionalNumber.safeParse('abc');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBeUndefined();
  });

  it('optionalNumber returns undefined for empty string', () => {
    const result = envPrimitives.optionalNumber.safeParse('');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBeUndefined();
  });

  it('commaSeparatedList parses values', () => {
    const result = envPrimitives.commaSeparatedList.safeParse('a, b, c');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(['a', 'b', 'c']);
  });

  it('commaSeparatedList returns empty array for undefined', () => {
    const result = envPrimitives.commaSeparatedList.safeParse(undefined);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual([]);
  });

  it('commaSeparatedList filters empty entries', () => {
    const result = envPrimitives.commaSeparatedList.safeParse('a,,b,');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// Schema composition
// ---------------------------------------------------------------------------

describe('schema composition', () => {
  it('allows extending BaseEnvSchema with custom fields', () => {
    const CustomSchema = BaseEnvSchema.extend({
      MY_CUSTOM_VAR: z.string().min(1),
    });

    const env = validateEnv(CustomSchema, {
      ...baseEnv(),
      MY_CUSTOM_VAR: 'custom-value',
    });

    expect(env.STATE_TABLE).toBe('swarm-state-staging');
    expect(env.MY_CUSTOM_VAR).toBe('custom-value');
  });

  it('rejects when custom required field is missing', () => {
    const CustomSchema = BaseEnvSchema.extend({
      MY_CUSTOM_VAR: z.string().min(1),
    });

    expect(() => validateEnv(CustomSchema, baseEnv())).toThrow(EnvValidationError);
  });
});

// ---------------------------------------------------------------------------
// Passthrough behavior (extra env vars are ignored)
// ---------------------------------------------------------------------------

describe('passthrough behavior', () => {
  it('does not fail on extra env vars', () => {
    const env = validateEnv(BaseEnvSchema, {
      ...baseEnv(),
      RANDOM_EXTRA_VAR: 'should-be-ignored',
      ANOTHER_VAR: 'also-ignored',
    });
    expect(env.STATE_TABLE).toBe('swarm-state-staging');
  });
});
