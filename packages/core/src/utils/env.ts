/**
 * Centralized Environment Variable Validation
 *
 * Provides Zod schemas for validating Lambda handler environment variables
 * at startup. Replaces ad-hoc `process.env.FOO!` assertions with structured
 * validation that gives clear, actionable error messages.
 *
 * Usage:
 *   import { validateEnv, HandlerEnvSchema } from '@swarm/core';
 *
 *   // At handler initialization:
 *   const env = validateEnv(HandlerEnvSchema);
 *   // env.STATE_TABLE is guaranteed to be a non-empty string
 *
 * Handler-specific schemas compose the base schemas:
 *   const MyHandlerEnv = BaseEnvSchema.extend({ EXTRA_VAR: z.string() });
 *   const env = validateEnv(MyHandlerEnv);
 */
import { z } from 'zod';

// =============================================================================
// PRIMITIVE HELPERS
// =============================================================================

/**
 * A required non-empty string environment variable.
 */
const requiredString = z.string().min(1, 'must not be empty');

/**
 * An optional string that may be absent or empty.
 * Returns `undefined` when the value is missing or empty-string.
 */
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === '' ? undefined : v));

/**
 * A boolean env var expressed as the string "true" / "false".
 * Missing values default to `false`.
 */
const booleanFlag = z
  .string()
  .optional()
  .transform((v) => v === 'true');

/**
 * A numeric env var (parsed from string).
 * Returns `undefined` when the value is missing or non-numeric.
 */
const optionalNumber = z
  .string()
  .optional()
  .transform((v) => {
    if (v === undefined || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  });

/**
 * A comma-separated list env var.
 * Returns an empty array when the value is missing.
 */
const commaSeparatedList = z
  .string()
  .optional()
  .transform((v) => {
    if (!v) return [];
    return v.split(',').map((s) => s.trim()).filter(Boolean);
  });

// =============================================================================
// BASE SCHEMA
// =============================================================================

/**
 * Shared base environment variables used across most handlers.
 *
 * STATE_TABLE and SECRET_PREFIX are required by virtually every handler.
 * ENVIRONMENT and LOG_LEVEL are optional but commonly used.
 */
export const BaseEnvSchema = z.object({
  /** DynamoDB state table name (avatar configs, channel state, etc.) */
  STATE_TABLE: requiredString,

  /** Prefix for Secrets Manager secret names (default: 'swarm') */
  SECRET_PREFIX: z.string().default('swarm'),

  /** Deployment environment (staging / production) */
  ENVIRONMENT: optionalString,

  /** Minimum log level (debug / info / warn / error) */
  LOG_LEVEL: optionalString,

  /** Node environment (development / production / test) */
  NODE_ENV: optionalString,
});

export type BaseEnv = z.infer<typeof BaseEnvSchema>;

// =============================================================================
// HANDLER-SPECIFIC SCHEMAS
// =============================================================================

/**
 * Telegram webhook handler environment.
 */
export const TelegramWebhookEnvSchema = BaseEnvSchema.extend({
  /** SQS FIFO queue URL for inbound messages */
  MESSAGE_QUEUE_URL: requiredString,

  /** Webhook domain for Telegram (e.g. api.swarm.rati.chat) */
  WEBHOOK_DOMAIN: optionalString,

  /** Comma-separated list of Telegram superadmin usernames */
  TELEGRAM_SUPERADMIN_USERNAMES: optionalString,
});

export type TelegramWebhookEnv = z.infer<typeof TelegramWebhookEnvSchema>;

/**
 * Message processor handler environment.
 */
export const MessageProcessorEnvSchema = BaseEnvSchema.extend({
  /** SQS queue URL for outbound responses */
  RESPONSE_QUEUE_URL: requiredString,

  /** S3 bucket for media uploads */
  MEDIA_BUCKET: requiredString,

  /** CDN URL prefix for media files */
  CDN_URL: optionalString,

  /** DynamoDB activity table */
  ACTIVITY_TABLE: optionalString,

  /** Replicate API key (direct env var) */
  REPLICATE_API_TOKEN: optionalString,

  /** Replicate API key Secrets Manager ARN */
  REPLICATE_API_KEY_SECRET_ARN: optionalString,

  /** SQS queue URL for media processing */
  MEDIA_QUEUE_URL: optionalString,

  /** LLM triage model override */
  TRIAGE_MODEL: optionalString,

  /** Feature flag: enable voice tools */
  ENABLE_VOICE_TOOLS: booleanFlag,

  /** Feature flag: brain context injection */
  BRAIN_INJECT_CONTEXT: booleanFlag,

  /** Brain read/write mode overrides */
  BRAIN_READ_MODE: optionalString,
  BRAIN_WRITE_MODE: optionalString,
});

export type MessageProcessorEnv = z.infer<typeof MessageProcessorEnvSchema>;

/**
 * Response sender handler environment.
 */
export const ResponseSenderEnvSchema = BaseEnvSchema.extend({
  /** DynamoDB activity table */
  ACTIVITY_TABLE: requiredString,

  /** S3 bucket for media */
  MEDIA_BUCKET: optionalString,

  /** SQS queue URL for media processing */
  MEDIA_QUEUE_URL: optionalString,

  /** Legacy single-avatar ID (deprecated) */
  AVATAR_ID: optionalString,
});

export type ResponseSenderEnv = z.infer<typeof ResponseSenderEnvSchema>;

/**
 * Autonomous tweet poster handler environment.
 */
export const TweetPosterEnvSchema = BaseEnvSchema.extend({
  /** DynamoDB activity table */
  ACTIVITY_TABLE: requiredString,

  /** S3 bucket for media */
  MEDIA_BUCKET: requiredString,

  /** CDN URL prefix for media files */
  CDN_URL: optionalString,

  /** SQS queue URL for decoupled post publishing */
  POST_QUEUE_URL: optionalString,

  /** Feature flag: content store for simulation mode */
  ENABLE_CONTENT_STORE: booleanFlag,

  /** Feature flag: decoupled posting via SQS */
  ENABLE_DECOUPLED_POSTING: booleanFlag,
});

export type TweetPosterEnv = z.infer<typeof TweetPosterEnvSchema>;

/**
 * Admin API chat handler environment.
 */
export const AdminApiEnvSchema = BaseEnvSchema.extend({
  /** DynamoDB admin table */
  ADMIN_TABLE: optionalString,

  /** LLM API key (direct env var or ARN) */
  LLM_API_KEY_SECRET_ARN: optionalString,

  /** LLM model override */
  LLM_MODEL: optionalString,

  /** LLM max tokens override */
  LLM_MAX_TOKENS: optionalNumber,

  /** Privy app ID for auth */

  /** Session cookie name override */
  SESSION_COOKIE_NAME: optionalString,

  /** Auth domain for cookies */
  AUTH_DOMAIN: optionalString,

  /** CORS allowed origins (comma-separated) */
  ALLOWED_ORIGINS: commaSeparatedList,

  /** Admin wallet addresses */
  ADMIN_WALLETS: commaSeparatedList,

  /** Internal test key for bypass auth */
  INTERNAL_TEST_KEY: optionalString,
});

export type AdminApiEnv = z.infer<typeof AdminApiEnvSchema>;

// =============================================================================
// VALIDATION FUNCTION
// =============================================================================

/**
 * Configuration validation error with formatted details.
 */
export class EnvValidationError extends Error {
  public readonly issues: z.ZodIssue[];

  constructor(error: z.ZodError) {
    const lines = error.issues.map((issue) => {
      const path = issue.path.join('.') || '(root)';
      return `  - ${path}: ${issue.message}`;
    });
    const message = [
      'Environment variable validation failed:',
      ...lines,
    ].join('\n');

    super(message);
    this.name = 'EnvValidationError';
    this.issues = error.issues;
  }
}

/**
 * Validate process.env against a Zod schema.
 *
 * Reads from `process.env` by default, but accepts an explicit source
 * for testing.
 *
 * @param schema - Zod object schema describing required/optional env vars
 * @param source - Environment object (defaults to `process.env`)
 * @returns Parsed and validated environment
 * @throws {EnvValidationError} when validation fails
 *
 * @example
 * ```ts
 * const env = validateEnv(MessageProcessorEnvSchema);
 * // env.STATE_TABLE is guaranteed to be a non-empty string
 * // env.CDN_URL is string | undefined
 * ```
 */
export function validateEnv<T extends z.ZodTypeAny>(
  schema: T,
  source: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(result.error);
  }
  return result.data;
}

/**
 * Validate and return env, or return null with logged warnings.
 *
 * Useful when you want to gracefully degrade instead of crashing.
 *
 * @param schema - Zod object schema
 * @param source - Environment object (defaults to `process.env`)
 * @returns Parsed environment or null
 */
export function tryValidateEnv<T extends z.ZodTypeAny>(
  schema: T,
  source: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): z.infer<T> | null {
  const result = schema.safeParse(source);
  if (!result.success) {
    return null;
  }
  return result.data;
}

// =============================================================================
// CONVENIENCE: SINGLE ENV VAR HELPERS
// =============================================================================

/**
 * Get a required environment variable or throw with a clear message.
 *
 * Drop-in replacement for `process.env.FOO!` that gives an actionable error.
 */
export function requireEnv(name: string, source: Record<string, string | undefined> = process.env): string {
  const value = source[name];
  if (!value) {
    throw new EnvValidationError(
      new z.ZodError([{
        code: 'custom',
        message: `Required environment variable ${name} is not set`,
        path: [name],
      }]),
    );
  }
  return value;
}

/**
 * Get an optional environment variable, returning undefined when absent or empty.
 */
export function optionalEnv(name: string, source: Record<string, string | undefined> = process.env): string | undefined {
  const value = source[name];
  return value === '' ? undefined : value;
}

// =============================================================================
// RE-EXPORT PRIMITIVES FOR COMPOSING CUSTOM SCHEMAS
// =============================================================================

export const envPrimitives = {
  requiredString,
  optionalString,
  booleanFlag,
  optionalNumber,
  commaSeparatedList,
} as const;
