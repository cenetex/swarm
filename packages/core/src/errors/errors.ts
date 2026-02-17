/**
 * Typed error hierarchy for the Swarm framework.
 *
 * Hierarchy:
 *   SwarmError                 (base — carries code, context, retryable flag)
 *   ├── PlatformError          (adapter-level: Telegram, Discord, Twitter, Web)
 *   ├── LLMError               (LLM service errors)
 *   ├── ConfigError            (config loading / validation)
 *   ├── StateError             (DynamoDB / persistence)
 *   ├── MediaError             (media generation / fetch)
 *   ├── AuthError              (authn / authz)
 *   ├── QueueError             (SQS / messaging)
 *   └── NetworkError           (HTTP fetch / timeout)
 *
 * All subclasses preserve the original Error prototype chain so that
 * `instanceof` checks work correctly, and every error carries structured
 * metadata for observability.
 */

import { SwarmErrorCode } from './codes.js';
import type { Platform } from '../types/platform.js';

// ─── Shared context type ─────────────────────────────────────────────────────

/** Arbitrary structured metadata attached to a SwarmError. */
export type ErrorContext = Record<string, unknown>;

// ─── Base class ──────────────────────────────────────────────────────────────

/**
 * Base error for all Swarm-specific errors.
 *
 * Every SwarmError carries:
 * - `code`      – a structured {@link SwarmErrorCode}
 * - `context`   – free-form metadata for structured logging
 * - `retryable` – hint for callers on whether the operation may succeed on retry
 * - `cause`     – the original error (standard ES2022 cause)
 */
export class SwarmError extends Error {
  public readonly code: SwarmErrorCode;
  public readonly context: ErrorContext;
  public readonly retryable: boolean;

  constructor(
    message: string,
    options: {
      code?: SwarmErrorCode;
      cause?: unknown;
      context?: ErrorContext;
      retryable?: boolean;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'SwarmError';
    this.code = options.code ?? SwarmErrorCode.UNKNOWN;
    this.context = options.context ?? {};
    this.retryable = options.retryable ?? false;

    // Ensure correct prototype chain for instanceof checks after transpilation.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Serialise to a JSON-safe object for structured logging.
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      context: this.context,
      ...(this.cause instanceof Error
        ? { cause: { name: (this.cause as Error).name, message: (this.cause as Error).message } }
        : this.cause !== undefined
          ? { cause: this.cause }
          : {}),
    };
  }
}

// ─── Domain subclasses ───────────────────────────────────────────────────────

/**
 * Error originating from a platform adapter (Telegram, Discord, Twitter, Web).
 */
export class PlatformError extends SwarmError {
  public readonly platform: Platform;
  public readonly statusCode?: number;

  constructor(
    message: string,
    options: {
      code?: SwarmErrorCode;
      platform: Platform;
      statusCode?: number;
      cause?: unknown;
      context?: ErrorContext;
      retryable?: boolean;
    },
  ) {
    super(message, {
      code: options.code ?? SwarmErrorCode.PLATFORM_API_ERROR,
      cause: options.cause,
      context: { platform: options.platform, ...options.context },
      retryable: options.retryable,
    });
    this.name = 'PlatformError';
    this.platform = options.platform;
    this.statusCode = options.statusCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Error originating from the LLM service layer.
 */
export class LLMError extends SwarmError {
  public readonly model?: string;
  public readonly statusCode?: number;

  constructor(
    message: string,
    options: {
      code?: SwarmErrorCode;
      model?: string;
      statusCode?: number;
      cause?: unknown;
      context?: ErrorContext;
      retryable?: boolean;
    } = {},
  ) {
    super(message, {
      code: options.code ?? SwarmErrorCode.LLM_API_ERROR,
      cause: options.cause,
      context: { model: options.model, ...options.context },
      retryable: options.retryable,
    });
    this.name = 'LLMError';
    this.model = options.model;
    this.statusCode = options.statusCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Error in configuration loading or validation.
 */
export class ConfigError extends SwarmError {
  constructor(
    message: string,
    options: {
      code?: SwarmErrorCode;
      cause?: unknown;
      context?: ErrorContext;
    } = {},
  ) {
    super(message, {
      code: options.code ?? SwarmErrorCode.CONFIG_VALIDATION_ERROR,
      cause: options.cause,
      context: options.context,
      retryable: false, // config errors are never retryable
    });
    this.name = 'ConfigError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Error from the persistence / state layer (DynamoDB).
 */
export class StateError extends SwarmError {
  constructor(
    message: string,
    options: {
      code?: SwarmErrorCode;
      cause?: unknown;
      context?: ErrorContext;
      retryable?: boolean;
    } = {},
  ) {
    super(message, {
      code: options.code ?? SwarmErrorCode.STATE_READ_ERROR,
      cause: options.cause,
      context: options.context,
      retryable: options.retryable ?? true, // DynamoDB errors are often transient
    });
    this.name = 'StateError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Error from media generation or fetching.
 */
export class MediaError extends SwarmError {
  constructor(
    message: string,
    options: {
      code?: SwarmErrorCode;
      cause?: unknown;
      context?: ErrorContext;
      retryable?: boolean;
    } = {},
  ) {
    super(message, {
      code: options.code ?? SwarmErrorCode.MEDIA_GENERATION_ERROR,
      cause: options.cause,
      context: options.context,
      retryable: options.retryable ?? false,
    });
    this.name = 'MediaError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Authentication or authorization error.
 */
export class AuthError extends SwarmError {
  constructor(
    message: string,
    options: {
      code?: SwarmErrorCode;
      cause?: unknown;
      context?: ErrorContext;
    } = {},
  ) {
    super(message, {
      code: options.code ?? SwarmErrorCode.AUTH_INVALID_TOKEN,
      cause: options.cause,
      context: options.context,
      retryable: false,
    });
    this.name = 'AuthError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Error in queue (SQS) operations.
 */
export class QueueError extends SwarmError {
  constructor(
    message: string,
    options: {
      code?: SwarmErrorCode;
      cause?: unknown;
      context?: ErrorContext;
      retryable?: boolean;
    } = {},
  ) {
    super(message, {
      code: options.code ?? SwarmErrorCode.QUEUE_SEND_ERROR,
      cause: options.cause,
      context: options.context,
      retryable: options.retryable ?? true,
    });
    this.name = 'QueueError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Network-level error (HTTP fetch, timeout, DNS).
 */
export class NetworkError extends SwarmError {
  public readonly statusCode?: number;

  constructor(
    message: string,
    options: {
      code?: SwarmErrorCode;
      statusCode?: number;
      cause?: unknown;
      context?: ErrorContext;
      retryable?: boolean;
    } = {},
  ) {
    super(message, {
      code: options.code ?? SwarmErrorCode.NETWORK_FETCH_ERROR,
      cause: options.cause,
      context: options.context,
      retryable: options.retryable ?? true,
    });
    this.name = 'NetworkError';
    this.statusCode = options.statusCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─── Utilities ───────────────────────────────────────────────────────────────

/**
 * Type-guard: returns `true` if the value is a {@link SwarmError}.
 */
export function isSwarmError(err: unknown): err is SwarmError {
  return err instanceof SwarmError;
}

/**
 * Type-guard: returns `true` if the value is a {@link SwarmError} with
 * the given error code.
 */
export function isSwarmErrorWithCode(
  err: unknown,
  code: SwarmErrorCode,
): err is SwarmError {
  return isSwarmError(err) && err.code === code;
}

/**
 * Wrap an unknown caught value into a {@link SwarmError}.
 *
 * - If it is already a `SwarmError`, return it as-is.
 * - If it is a plain `Error`, wrap it with `UNKNOWN` code.
 * - Otherwise stringify it.
 */
export function toSwarmError(
  err: unknown,
  defaults?: { code?: SwarmErrorCode; context?: ErrorContext; retryable?: boolean },
): SwarmError {
  if (err instanceof SwarmError) return err;
  if (err instanceof Error) {
    return new SwarmError(err.message, {
      code: defaults?.code ?? SwarmErrorCode.UNKNOWN,
      cause: err,
      context: defaults?.context,
      retryable: defaults?.retryable,
    });
  }
  return new SwarmError(String(err), {
    code: defaults?.code ?? SwarmErrorCode.UNKNOWN,
    context: defaults?.context,
    retryable: defaults?.retryable,
  });
}
