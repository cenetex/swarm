/**
 * Canonical error classification (aws-swarm#1550).
 *
 * One function, one return shape, every layer calls it. Replaces the
 * scattered hand-rolled "is this retryable?" logic that caused CHOPPA's
 * SQS retry loop (#1538) — where an inner layer correctly set
 * `retryable: false` on a PlatformError and the outer layer silently
 * flipped it back to `true` by re-reading `.status` (PlatformError
 * exposes `.statusCode`, not `.status`).
 *
 * Rules, in order:
 *  1. `PlatformError` (or anything with an explicit `.retryable` boolean) →
 *     honour whatever the inner layer decided. Do not re-classify.
 *  2. Anything with a 4xx HTTP status (from `.status` / `.statusCode` /
 *     `.error_code`) → non-retryable, UNLESS it's 429 (rate limit).
 *  3. 5xx → retryable.
 *  4. Common network / timeout / abort markers → retryable.
 *  5. Unknown → retryable (safe default — we don't silently swallow
 *     potentially transient errors).
 */

import type { Platform } from '../types/platform.js';
import { PlatformError } from './errors.js';
import { SwarmErrorCode } from './codes.js';

/** Reason code — stable string key useful for metrics dimensions. */
export type ErrorReason =
  | 'rate_limit'
  | 'reply_target_deleted'
  | 'auth'
  | 'validation'
  | 'not_found'
  | 'forbidden'
  | 'server'
  | 'network'
  | 'timeout'
  | 'unknown';

export interface ErrorClassification {
  retryable: boolean;
  /** HTTP-equivalent status if one could be extracted. */
  statusCode?: number;
  platform?: Platform;
  reason: ErrorReason;
  /** milliseconds to wait before retrying (currently only set for 429). */
  retryAfter?: number;
  /** SwarmErrorCode if the error carried one. */
  code?: SwarmErrorCode;
}

interface ErrorLike {
  status?: unknown;
  statusCode?: unknown;
  error_code?: unknown;
  code?: unknown;
  name?: unknown;
  message?: unknown;
  retryable?: unknown;
  retryAfter?: unknown;
}

function readStatus(err: ErrorLike): number | undefined {
  for (const v of [err.status, err.statusCode, err.error_code]) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

function readMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && typeof (err as ErrorLike).message === 'string') {
    return (err as ErrorLike).message as string;
  }
  return '';
}

function statusReason(status: number): ErrorReason {
  if (status === 429) return 'rate_limit';
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status >= 400 && status < 500) return 'validation';
  if (status >= 500) return 'server';
  return 'unknown';
}

function messageHasAny(msg: string, markers: readonly string[]): boolean {
  const lower = msg.toLowerCase();
  return markers.some(m => lower.includes(m));
}

const NETWORK_MARKERS = [
  'econnreset', 'econnrefused', 'epipe', 'enotfound', 'eai_again',
  'socket hang up', 'network error', 'network request failed',
  'fetch failed', 'connection refused',
] as const;

const TIMEOUT_MARKERS = [
  'timeout', 'timed out', 'aborted', 'aborterror',
] as const;

/**
 * Classify an unknown error into a canonical shape.
 *
 * Call this anywhere you need to decide "retry?" or "what kind of
 * failure is this?" — never hand-roll the checks again.
 */
export function classifyError(
  error: unknown,
  ctx?: { platform?: Platform }
): ErrorClassification {
  // Rule 1 — PlatformError (or anything explicitly typed) wins. Trust it.
  if (error instanceof PlatformError) {
    const reply404 = typeof error.message === 'string'
      && error.message.toLowerCase().includes('reply target message was deleted');
    return {
      retryable: error.retryable,
      statusCode: error.statusCode,
      platform: error.platform ?? ctx?.platform,
      reason: reply404 ? 'reply_target_deleted' : statusReason(error.statusCode ?? 0),
      code: error.code as SwarmErrorCode | undefined,
    };
  }

  const errObj: ErrorLike = (typeof error === 'object' && error !== null)
    ? (error as ErrorLike)
    : {};

  // Any error carrying an explicit boolean `retryable` hint → trust it too,
  // but still derive a reason from status if one exists.
  if (typeof errObj.retryable === 'boolean') {
    const status = readStatus(errObj);
    return {
      retryable: errObj.retryable,
      statusCode: status,
      platform: ctx?.platform,
      reason: status !== undefined ? statusReason(status) : 'unknown',
      retryAfter: typeof errObj.retryAfter === 'number' ? errObj.retryAfter : undefined,
    };
  }

  const status = readStatus(errObj);
  const msg = readMessage(error);

  // Rule 2/3 — HTTP-ish status classification.
  if (status !== undefined) {
    if (status === 429) {
      return {
        retryable: true,
        statusCode: 429,
        platform: ctx?.platform,
        reason: 'rate_limit',
        retryAfter: typeof errObj.retryAfter === 'number' ? errObj.retryAfter : undefined,
      };
    }
    if (status >= 400 && status < 500) {
      return {
        retryable: false,
        statusCode: status,
        platform: ctx?.platform,
        reason: statusReason(status),
      };
    }
    if (status >= 500) {
      return {
        retryable: true,
        statusCode: status,
        platform: ctx?.platform,
        reason: 'server',
      };
    }
  }

  // Rule 4 — network / timeout markers in message or code.
  if (messageHasAny(msg, TIMEOUT_MARKERS)) {
    return { retryable: true, platform: ctx?.platform, reason: 'timeout' };
  }
  if (messageHasAny(msg, NETWORK_MARKERS)) {
    return { retryable: true, platform: ctx?.platform, reason: 'network' };
  }
  // Some SDKs use `.name` for classification (e.g. 'AbortError', 'TimeoutError')
  if (typeof errObj.name === 'string') {
    const name = errObj.name.toLowerCase();
    if (name.includes('abort') || name.includes('timeout')) {
      return { retryable: true, platform: ctx?.platform, reason: 'timeout' };
    }
  }

  // Rule 5 — unknown → retryable default. We'd rather re-attempt a
  // transient error than silently swallow it.
  return { retryable: true, platform: ctx?.platform, reason: 'unknown' };
}
