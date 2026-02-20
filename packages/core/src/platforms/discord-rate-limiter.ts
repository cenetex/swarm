/**
 * Discord API Rate Limiter
 *
 * Implements per-route bucket tracking with queue-based throttling
 * and exponential backoff. Respects Discord's X-RateLimit-* headers
 * and queues outbound requests when rate limited.
 *
 * @see https://discord.com/developers/docs/topics/rate-limits
 */
import { logger } from '../utils/logger.js';

/** Rate limit bucket state for a single route */
export interface RateLimitBucket {
  /** Number of requests remaining in the current window */
  remaining: number;
  /** Total requests allowed per window */
  limit: number;
  /** Unix timestamp (seconds) when the bucket resets */
  resetAt: number;
  /** Bucket identifier from Discord headers */
  bucketId?: string;
}

/** Options for the Discord rate limiter */
export interface DiscordRateLimiterOptions {
  /** Maximum number of queued requests per route before rejecting (default: 50) */
  maxQueueSize?: number;
  /** Maximum backoff delay in ms (default: 60000) */
  maxBackoffMs?: number;
  /** Base backoff delay in ms for global rate limits (default: 1000) */
  baseBackoffMs?: number;
  /** Enable logging of rate limit events (default: true) */
  enableLogging?: boolean;
}

/** Result of a rate-limited request */
export interface RateLimitedResult {
  /** Whether the request was allowed to proceed */
  allowed: boolean;
  /** If not allowed, how long to wait (ms) before retrying */
  retryAfterMs?: number;
  /** Reason the request was blocked */
  reason?: 'route_limited' | 'global_limited' | 'queue_full';
}

/** Queued request waiting to be executed */
interface QueuedRequest {
  resolve: (value: RateLimitedResult) => void;
  reject: (reason: unknown) => void;
  enqueuedAt: number;
}

/**
 * Extract the route key from a Discord API URL.
 * Discord rate limits are per-route, where the route is the
 * URL path with major parameters (channel_id, guild_id, webhook_id) preserved
 * and minor parameters (message_id, etc.) replaced with placeholders.
 */
export function extractRouteKey(url: string): string {
  try {
    const parsed = new URL(url);
    let path = parsed.pathname;

    // Normalize webhook URLs: preserve webhook ID and token
    // e.g., /api/v10/webhooks/123/abc -> webhooks/123/abc
    const webhookMatch = path.match(/\/api\/v\d+\/webhooks\/(\d+)\/([^/]+)(.*)/);
    if (webhookMatch) {
      const suffix = webhookMatch[3].replace(/\/[^/]+$/, '/:id');
      return `webhooks/${webhookMatch[1]}/${webhookMatch[2]}${suffix}`;
    }

    // Strip API version prefix
    path = path.replace(/^\/api\/v\d+\//, '');

    // Replace message IDs, reaction emoji, and other minor params with placeholders
    // Keep channel_id and guild_id (major parameters)
    const parts = path.split('/');
    const normalized: string[] = [];

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const prev = i > 0 ? parts[i - 1] : '';

      // Major parameters: channels/{id}, guilds/{id}
      if (prev === 'channels' || prev === 'guilds' || prev === 'webhooks') {
        normalized.push(part);
      } else if (/^\d+$/.test(part) && prev !== 'channels' && prev !== 'guilds') {
        // Minor parameter (message ID, etc.) - replace with placeholder
        normalized.push(':id');
      } else {
        normalized.push(part);
      }
    }

    return normalized.filter(Boolean).join('/');
  } catch {
    // If URL parsing fails, use the raw URL as the key
    return url;
  }
}

/**
 * Discord API Rate Limiter
 *
 * Tracks per-route rate limit buckets and queues requests when
 * a route is rate limited. Also handles global rate limits.
 */
export class DiscordRateLimiter {
  /** Per-route bucket state */
  private buckets = new Map<string, RateLimitBucket>();

  /** Per-route request queues */
  private queues = new Map<string, QueuedRequest[]>();

  /** Global rate limit state */
  private globalResetAt = 0;

  /** Consecutive global rate limit hits for backoff */
  private consecutiveGlobalHits = 0;

  private readonly maxQueueSize: number;
  private readonly maxBackoffMs: number;
  private readonly enableLogging: boolean;

  /** Drain timers per route (for cleanup) */
  private drainTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: DiscordRateLimiterOptions = {}) {
    this.maxQueueSize = options.maxQueueSize ?? 50;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.enableLogging = options.enableLogging ?? true;
  }

  /**
   * Check whether a request to the given URL can proceed.
   * If the route is rate limited, the request is queued and
   * the returned promise resolves when the request can proceed.
   */
  async acquire(url: string): Promise<RateLimitedResult> {
    const routeKey = extractRouteKey(url);
    const now = Date.now() / 1000;

    // Check global rate limit
    if (this.globalResetAt > now) {
      const retryAfterMs = Math.ceil((this.globalResetAt - now) * 1000);
      if (this.enableLogging) {
        logger.warn('Discord global rate limit active', {
          event: 'discord_global_rate_limit',
          subsystem: 'discord',
          retryAfterMs,
        });
      }
      return this.enqueueOrReject(routeKey, retryAfterMs);
    }

    // Check per-route bucket
    const bucket = this.buckets.get(routeKey);
    if (bucket && bucket.remaining <= 0 && bucket.resetAt > now) {
      const retryAfterMs = Math.ceil((bucket.resetAt - now) * 1000);
      if (this.enableLogging) {
        logger.warn('Discord route rate limit active', {
          event: 'discord_route_rate_limit',
          subsystem: 'discord',
          routeKey,
          retryAfterMs,
          bucketId: bucket.bucketId,
        });
      }
      return this.enqueueOrReject(routeKey, retryAfterMs);
    }

    // Decrement remaining if bucket exists
    if (bucket && bucket.remaining > 0) {
      bucket.remaining--;
    }

    return { allowed: true };
  }

  /**
   * Update rate limit state from Discord API response headers.
   * Must be called after every Discord API response.
   */
  updateFromResponse(url: string, headers: Headers | Record<string, string>): void {
    const routeKey = extractRouteKey(url);
    const getHeader = (name: string): string | null => {
      if (headers instanceof Headers) {
        return headers.get(name);
      }
      return headers[name] ?? headers[name.toLowerCase()] ?? null;
    };

    // Check for global rate limit
    const isGlobal = getHeader('X-RateLimit-Global') === 'true';
    const retryAfterStr = getHeader('Retry-After');

    if (isGlobal && retryAfterStr) {
      const retryAfterSec = parseFloat(retryAfterStr);
      if (!isNaN(retryAfterSec)) {
        this.globalResetAt = Date.now() / 1000 + retryAfterSec;
        this.consecutiveGlobalHits++;

        if (this.enableLogging) {
          logger.error('Discord GLOBAL rate limit hit', undefined, {
            event: 'discord_global_rate_limit_hit',
            subsystem: 'discord',
            retryAfterSec,
            consecutiveHits: this.consecutiveGlobalHits,
          });
        }

        // Schedule queue drain for all routes
        for (const route of this.queues.keys()) {
          this.scheduleDrain(route, retryAfterSec * 1000);
        }
        return;
      }
    }

    // Reset global consecutive hits on non-global response
    if (!isGlobal) {
      this.consecutiveGlobalHits = 0;
    }

    // Parse per-route headers
    const remaining = getHeader('X-RateLimit-Remaining');
    const limit = getHeader('X-RateLimit-Limit');
    const resetAfter = getHeader('X-RateLimit-Reset-After');
    const bucketId = getHeader('X-RateLimit-Bucket');

    if (remaining !== null && limit !== null && resetAfter !== null) {
      const bucket: RateLimitBucket = {
        remaining: parseInt(remaining, 10),
        limit: parseInt(limit, 10),
        resetAt: Date.now() / 1000 + parseFloat(resetAfter),
        bucketId: bucketId ?? undefined,
      };

      this.buckets.set(routeKey, bucket);

      // If we just got rate limited (remaining = 0), log it
      if (bucket.remaining === 0 && this.enableLogging) {
        logger.info('Discord route bucket exhausted', {
          event: 'discord_bucket_exhausted',
          subsystem: 'discord',
          routeKey,
          resetAfterSec: parseFloat(resetAfter),
          bucketId: bucket.bucketId,
          limit: bucket.limit,
        });
      }
    }

    // Handle 429 with Retry-After but no global flag
    if (retryAfterStr && !isGlobal) {
      const retryAfterSec = parseFloat(retryAfterStr);
      if (!isNaN(retryAfterSec)) {
        const bucket = this.buckets.get(routeKey) ?? {
          remaining: 0,
          limit: 1,
          resetAt: 0,
        };
        bucket.remaining = 0;
        bucket.resetAt = Date.now() / 1000 + retryAfterSec;
        this.buckets.set(routeKey, bucket);

        this.scheduleDrain(routeKey, retryAfterSec * 1000);
      }
    }

    // Drain queue if we have remaining capacity
    const currentBucket = this.buckets.get(routeKey);
    if (currentBucket && currentBucket.remaining > 0) {
      this.drainQueue(routeKey);
    }
  }

  /**
   * Handle a 429 response explicitly (convenience method).
   * Call this when a request returns HTTP 429.
   */
  handleRateLimitResponse(url: string, retryAfterMs: number, isGlobal: boolean): void {
    const routeKey = extractRouteKey(url);
    const retryAfterSec = retryAfterMs / 1000;

    if (isGlobal) {
      this.globalResetAt = Date.now() / 1000 + retryAfterSec;
      this.consecutiveGlobalHits++;

      if (this.enableLogging) {
        logger.error('Discord GLOBAL rate limit (429)', undefined, {
          event: 'discord_429_global',
          subsystem: 'discord',
          retryAfterMs,
          consecutiveHits: this.consecutiveGlobalHits,
        });
      }
    } else {
      const bucket = this.buckets.get(routeKey) ?? {
        remaining: 0,
        limit: 1,
        resetAt: 0,
      };
      bucket.remaining = 0;
      bucket.resetAt = Date.now() / 1000 + retryAfterSec;
      this.buckets.set(routeKey, bucket);

      if (this.enableLogging) {
        logger.warn('Discord route rate limit (429)', {
          event: 'discord_429_route',
          subsystem: 'discord',
          routeKey,
          retryAfterMs,
        });
      }
    }

    this.scheduleDrain(routeKey, retryAfterMs);
  }

  /**
   * Get a snapshot of the current rate limit state (for diagnostics).
   */
  getState(): {
    globalResetAt: number;
    consecutiveGlobalHits: number;
    buckets: Map<string, RateLimitBucket>;
    queueSizes: Map<string, number>;
  } {
    const queueSizes = new Map<string, number>();
    for (const [key, queue] of this.queues) {
      queueSizes.set(key, queue.length);
    }
    return {
      globalResetAt: this.globalResetAt,
      consecutiveGlobalHits: this.consecutiveGlobalHits,
      buckets: new Map(this.buckets),
      queueSizes,
    };
  }

  /**
   * Reset all state (useful for tests or reconnection).
   */
  reset(): void {
    this.buckets.clear();
    this.globalResetAt = 0;
    this.consecutiveGlobalHits = 0;
    for (const timer of this.drainTimers.values()) {
      clearTimeout(timer);
    }
    this.drainTimers.clear();
    // Reject all queued requests
    for (const [, queue] of this.queues) {
      for (const req of queue) {
        req.reject(new Error('Rate limiter reset'));
      }
    }
    this.queues.clear();
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private enqueueOrReject(routeKey: string, retryAfterMs: number): Promise<RateLimitedResult> {
    const queue = this.queues.get(routeKey) ?? [];

    if (queue.length >= this.maxQueueSize) {
      return Promise.resolve({
        allowed: false,
        retryAfterMs,
        reason: 'queue_full' as const,
      });
    }

    return new Promise<RateLimitedResult>((resolve, reject) => {
      queue.push({ resolve, reject, enqueuedAt: Date.now() });
      this.queues.set(routeKey, queue);

      // Ensure a drain is scheduled
      if (!this.drainTimers.has(routeKey)) {
        this.scheduleDrain(routeKey, retryAfterMs);
      }
    });
  }

  private scheduleDrain(routeKey: string, delayMs: number): void {
    // Clear any existing timer
    const existing = this.drainTimers.get(routeKey);
    if (existing) {
      clearTimeout(existing);
    }

    const clampedDelay = Math.min(delayMs, this.maxBackoffMs);
    const timer = setTimeout(() => {
      this.drainTimers.delete(routeKey);
      this.drainQueue(routeKey);
    }, clampedDelay);

    this.drainTimers.set(routeKey, timer);
  }

  private drainQueue(routeKey: string): void {
    const queue = this.queues.get(routeKey);
    if (!queue || queue.length === 0) return;

    const now = Date.now() / 1000;

    // Check global rate limit
    if (this.globalResetAt > now) {
      const retryAfterMs = Math.ceil((this.globalResetAt - now) * 1000);
      this.scheduleDrain(routeKey, retryAfterMs);
      return;
    }

    // Check per-route bucket
    const bucket = this.buckets.get(routeKey);
    if (bucket && bucket.remaining <= 0 && bucket.resetAt > now) {
      const retryAfterMs = Math.ceil((bucket.resetAt - now) * 1000);
      this.scheduleDrain(routeKey, retryAfterMs);
      return;
    }

    // Drain as many requests as the bucket allows
    let drainCount = bucket ? bucket.remaining : queue.length;
    drainCount = Math.min(drainCount, queue.length);

    for (let i = 0; i < drainCount; i++) {
      const req = queue.shift();
      if (req) {
        if (bucket) {
          bucket.remaining--;
        }
        req.resolve({ allowed: true });
      }
    }

    // Clean up empty queue
    if (queue.length === 0) {
      this.queues.delete(routeKey);
    }
  }
}
