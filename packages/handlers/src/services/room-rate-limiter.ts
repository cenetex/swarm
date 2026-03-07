/**
 * Room Rate Limiter
 *
 * Sliding-window rate limiter for shared room ingress. Enforces:
 *   - Per-room limit: max N messages per minute across all senders
 *   - Per-user limit: max M messages per minute per sender within a room
 *
 * State is in-memory (Lambda execution context). Does not need to survive
 * cold starts — a fresh Lambda gets a fresh window.
 */
import { logger } from '@swarm/core';

// =============================================================================
// CONFIGURATION
// =============================================================================

const WINDOW_MS = 60_000; // 1 minute sliding window

/** Max messages per room per minute. */
export function getRoomRateLimit(): number {
  const env = process.env.ROOM_RATE_LIMIT_PER_MIN;
  return env ? parseInt(env, 10) : 30;
}

/** Max messages per user per room per minute. */
export function getUserRateLimit(): number {
  const env = process.env.USER_RATE_LIMIT_PER_MIN;
  return env ? parseInt(env, 10) : 10;
}

// =============================================================================
// RATE LIMIT RESULT
// =============================================================================

export interface RateLimitResult {
  allowed: boolean;
  currentRate: number;
  limit: number;
  /** Which limit was hit, if any. */
  limitType?: 'room' | 'user';
}

// =============================================================================
// ROOM RATE LIMITER
// =============================================================================

/**
 * In-memory sliding-window rate limiter keyed by arbitrary string keys.
 *
 * Each key maps to an array of timestamps. On each check, expired entries
 * (older than WINDOW_MS) are pruned. If the remaining count is below the
 * limit, the timestamp is recorded and the request is allowed.
 */
export class RoomRateLimiter {
  private windows = new Map<string, number[]>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Periodic cleanup every 60s to avoid unbounded memory growth
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
    // Allow the timer to not keep the process alive
    if (this.cleanupTimer && typeof this.cleanupTimer === 'object' && 'unref' in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Check and record a message for the given key against the given limit.
   * Returns whether the message is allowed.
   */
  check(key: string, limit: number, now: number = Date.now()): { allowed: boolean; currentRate: number } {
    let timestamps = this.windows.get(key);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(key, timestamps);
    }

    // Prune expired entries (strictly older than the window)
    const cutoff = now - WINDOW_MS;
    // Find first index that is within the window
    let firstValid = 0;
    while (firstValid < timestamps.length && timestamps[firstValid] <= cutoff) {
      firstValid++;
    }
    if (firstValid > 0) {
      timestamps.splice(0, firstValid);
    }

    const currentRate = timestamps.length;

    if (currentRate >= limit) {
      return { allowed: false, currentRate };
    }

    timestamps.push(now);
    return { allowed: true, currentRate: currentRate + 1 };
  }

  /**
   * Check both room-level and user-level limits for a shared room message.
   */
  checkMessage(roomKey: string, userId: string, now: number = Date.now()): RateLimitResult {
    const roomLimit = getRoomRateLimit();
    const userLimit = getUserRateLimit();

    // Check room-level limit first
    const roomResult = this.check(`room:${roomKey}`, roomLimit, now);
    if (!roomResult.allowed) {
      return {
        allowed: false,
        currentRate: roomResult.currentRate,
        limit: roomLimit,
        limitType: 'room',
      };
    }

    // Check per-user limit
    const userResult = this.check(`user:${roomKey}:${userId}`, userLimit, now);
    if (!userResult.allowed) {
      // Roll back the room-level counter since the message won't be accepted
      const roomTimestamps = this.windows.get(`room:${roomKey}`);
      if (roomTimestamps && roomTimestamps.length > 0) {
        roomTimestamps.pop();
      }
      return {
        allowed: false,
        currentRate: userResult.currentRate,
        limit: userLimit,
        limitType: 'user',
      };
    }

    return {
      allowed: true,
      currentRate: roomResult.currentRate,
      limit: roomLimit,
    };
  }

  /** Remove all windows with no entries or only expired entries. */
  private cleanup(now: number = Date.now()): void {
    const cutoff = now - WINDOW_MS;
    for (const [key, timestamps] of this.windows) {
      // Remove expired entries
      let firstValid = 0;
      while (firstValid < timestamps.length && timestamps[firstValid] <= cutoff) {
        firstValid++;
      }
      if (firstValid >= timestamps.length) {
        this.windows.delete(key);
      } else if (firstValid > 0) {
        timestamps.splice(0, firstValid);
      }
    }
  }

  /** Stop the cleanup timer (for tests). */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /** Visible for testing: number of tracked keys. */
  get size(): number {
    return this.windows.size;
  }
}

// =============================================================================
// SINGLETON — shared across the Lambda execution context
// =============================================================================

let _instance: RoomRateLimiter | null = null;

export function getRateLimiter(): RoomRateLimiter {
  if (!_instance) {
    _instance = new RoomRateLimiter();
  }
  return _instance;
}

/** Test hook: replace the singleton. */
export function _setRateLimiter(limiter: RoomRateLimiter | null): void {
  if (_instance) {
    _instance.destroy();
  }
  _instance = limiter;
}

// =============================================================================
// LOGGING HELPER
// =============================================================================

export function logRateLimited(
  roomKey: string,
  messageId: string,
  senderId: string,
  result: RateLimitResult,
): void {
  logger.warn('Room ingress rate limited: message dropped', {
    event: 'room_ingress_rate_limited',
    subsystem: 'room-ingress',
    roomKey,
    messageId,
    senderId,
    limitType: result.limitType,
    currentRate: result.currentRate,
    limit: result.limit,
  });
}
