/**
 * Discord Rate Limiter Tests
 *
 * Tests for DiscordRateLimiter, extractRouteKey, and rate limit bucket management.
 *
 * @see packages/core/src/platforms/discord-rate-limiter.ts
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { DiscordRateLimiter, extractRouteKey } from './discord-rate-limiter.js';

// ---------------------------------------------------------------------------
// extractRouteKey
// ---------------------------------------------------------------------------

describe('extractRouteKey', () => {
  it('should extract route for channel messages endpoint', () => {
    const key = extractRouteKey('https://discord.com/api/v10/channels/123456/messages');
    expect(key).toBe('channels/123456/messages');
  });

  it('should replace message ID with placeholder', () => {
    const key = extractRouteKey('https://discord.com/api/v10/channels/123456/messages/789012');
    expect(key).toBe('channels/123456/messages/:id');
  });

  it('should preserve channel ID as major parameter', () => {
    const key1 = extractRouteKey('https://discord.com/api/v10/channels/111/messages');
    const key2 = extractRouteKey('https://discord.com/api/v10/channels/222/messages');
    expect(key1).not.toBe(key2);
    expect(key1).toContain('111');
    expect(key2).toContain('222');
  });

  it('should preserve guild ID as major parameter', () => {
    const key = extractRouteKey('https://discord.com/api/v10/guilds/999/members');
    expect(key).toContain('999');
  });

  it('should handle webhook URLs', () => {
    const key = extractRouteKey('https://discord.com/api/v10/webhooks/123/abc-token');
    expect(key).toBe('webhooks/123/abc-token');
  });

  it('should handle webhook URLs with message ID suffix', () => {
    const key = extractRouteKey('https://discord.com/api/v10/webhooks/123/abc-token/messages/@original');
    expect(key).toBe('webhooks/123/abc-token/messages/:id');
  });

  it('should handle reaction endpoints', () => {
    const key = extractRouteKey(
      'https://discord.com/api/v10/channels/123/messages/456/reactions/%F0%9F%91%8D/@me'
    );
    expect(key).toContain('channels/123');
  });

  it('should handle typing endpoint', () => {
    const key = extractRouteKey('https://discord.com/api/v10/channels/123/typing');
    expect(key).toBe('channels/123/typing');
  });

  it('should handle interaction callback endpoint', () => {
    const key = extractRouteKey(
      'https://discord.com/api/v10/interactions/111/token-abc/callback'
    );
    expect(key).toContain('interactions');
  });

  it('should handle invalid URL by returning raw string', () => {
    const key = extractRouteKey('not-a-url');
    expect(key).toBe('not-a-url');
  });

  it('should strip API version prefix', () => {
    const key = extractRouteKey('https://discord.com/api/v10/channels/123/messages');
    expect(key).not.toContain('api/v10');
  });

  it('should produce same key for different API versions', () => {
    const key9 = extractRouteKey('https://discord.com/api/v9/channels/123/messages');
    const key10 = extractRouteKey('https://discord.com/api/v10/channels/123/messages');
    expect(key9).toBe(key10);
  });
});

// ---------------------------------------------------------------------------
// DiscordRateLimiter
// ---------------------------------------------------------------------------

describe('DiscordRateLimiter', () => {
  let limiter: DiscordRateLimiter;

  beforeEach(() => {
    limiter = new DiscordRateLimiter({ enableLogging: false });
  });

  // =========================================================================
  // acquire() - basic behavior
  // =========================================================================
  describe('acquire', () => {
    it('should allow requests when no rate limit is active', async () => {
      const result = await limiter.acquire('https://discord.com/api/v10/channels/123/messages');
      expect(result.allowed).toBe(true);
    });

    it('should allow multiple requests to different routes', async () => {
      const r1 = await limiter.acquire('https://discord.com/api/v10/channels/111/messages');
      const r2 = await limiter.acquire('https://discord.com/api/v10/channels/222/messages');
      expect(r1.allowed).toBe(true);
      expect(r2.allowed).toBe(true);
    });

    it('should decrement remaining count on acquire', async () => {
      const url = 'https://discord.com/api/v10/channels/123/messages';

      // Set up a bucket with 2 remaining
      limiter.updateFromResponse(url, {
        'X-RateLimit-Remaining': '2',
        'X-RateLimit-Limit': '5',
        'X-RateLimit-Reset-After': '5',
        'X-RateLimit-Bucket': 'bucket-1',
      });

      await limiter.acquire(url);
      const state = limiter.getState();
      const bucket = state.buckets.get(extractRouteKey(url));
      // After updateFromResponse sets remaining=2 and acquire decrements, remaining should be 1
      expect(bucket!.remaining).toBe(1);
    });
  });

  // =========================================================================
  // updateFromResponse
  // =========================================================================
  describe('updateFromResponse', () => {
    it('should update bucket from response headers', () => {
      const url = 'https://discord.com/api/v10/channels/123/messages';
      limiter.updateFromResponse(url, {
        'X-RateLimit-Remaining': '4',
        'X-RateLimit-Limit': '5',
        'X-RateLimit-Reset-After': '3.5',
        'X-RateLimit-Bucket': 'test-bucket',
      });

      const state = limiter.getState();
      const routeKey = extractRouteKey(url);
      const bucket = state.buckets.get(routeKey);

      expect(bucket).toBeDefined();
      expect(bucket!.remaining).toBe(4);
      expect(bucket!.limit).toBe(5);
      expect(bucket!.bucketId).toBe('test-bucket');
    });

    it('should handle Headers object', () => {
      const url = 'https://discord.com/api/v10/channels/123/messages';
      const headers = new Headers();
      headers.set('X-RateLimit-Remaining', '3');
      headers.set('X-RateLimit-Limit', '5');
      headers.set('X-RateLimit-Reset-After', '2.0');
      headers.set('X-RateLimit-Bucket', 'bucket-2');

      limiter.updateFromResponse(url, headers);

      const state = limiter.getState();
      const routeKey = extractRouteKey(url);
      const bucket = state.buckets.get(routeKey);

      expect(bucket).toBeDefined();
      expect(bucket!.remaining).toBe(3);
      expect(bucket!.limit).toBe(5);
    });

    it('should not create a bucket when headers are missing', () => {
      const url = 'https://discord.com/api/v10/channels/123/messages';
      limiter.updateFromResponse(url, {});

      const state = limiter.getState();
      const routeKey = extractRouteKey(url);
      expect(state.buckets.has(routeKey)).toBe(false);
    });

    it('should handle global rate limit header', () => {
      const url = 'https://discord.com/api/v10/channels/123/messages';
      limiter.updateFromResponse(url, {
        'X-RateLimit-Global': 'true',
        'Retry-After': '5',
      });

      const state = limiter.getState();
      expect(state.globalResetAt).toBeGreaterThan(Date.now() / 1000);
      expect(state.consecutiveGlobalHits).toBe(1);
    });

    it('should increment consecutiveGlobalHits on repeated global limits', () => {
      const url = 'https://discord.com/api/v10/channels/123/messages';

      limiter.updateFromResponse(url, {
        'X-RateLimit-Global': 'true',
        'Retry-After': '5',
      });
      limiter.updateFromResponse(url, {
        'X-RateLimit-Global': 'true',
        'Retry-After': '5',
      });

      const state = limiter.getState();
      expect(state.consecutiveGlobalHits).toBe(2);
    });

    it('should reset consecutiveGlobalHits on non-global response', () => {
      const url = 'https://discord.com/api/v10/channels/123/messages';

      limiter.updateFromResponse(url, {
        'X-RateLimit-Global': 'true',
        'Retry-After': '5',
      });

      expect(limiter.getState().consecutiveGlobalHits).toBe(1);

      limiter.updateFromResponse(url, {
        'X-RateLimit-Remaining': '5',
        'X-RateLimit-Limit': '5',
        'X-RateLimit-Reset-After': '1',
      });

      expect(limiter.getState().consecutiveGlobalHits).toBe(0);
    });
  });

  // =========================================================================
  // handleRateLimitResponse (429)
  // =========================================================================
  describe('handleRateLimitResponse', () => {
    it('should set route bucket on per-route 429', () => {
      const url = 'https://discord.com/api/v10/channels/123/messages';
      limiter.handleRateLimitResponse(url, 3000, false);

      const state = limiter.getState();
      const routeKey = extractRouteKey(url);
      const bucket = state.buckets.get(routeKey);

      expect(bucket).toBeDefined();
      expect(bucket!.remaining).toBe(0);
    });

    it('should set global reset on global 429', () => {
      const url = 'https://discord.com/api/v10/channels/123/messages';
      limiter.handleRateLimitResponse(url, 5000, true);

      const state = limiter.getState();
      expect(state.globalResetAt).toBeGreaterThan(Date.now() / 1000);
      expect(state.consecutiveGlobalHits).toBe(1);
    });
  });

  // =========================================================================
  // Queueing behavior
  // =========================================================================
  describe('queueing', () => {
    it('should reject when queue is full', async () => {
      const smallLimiter = new DiscordRateLimiter({
        maxQueueSize: 2,
        enableLogging: false,
      });

      const url = 'https://discord.com/api/v10/channels/123/messages';

      // Rate-limit the route
      smallLimiter.handleRateLimitResponse(url, 60_000, false);

      // First two requests should be queued
      const p1 = smallLimiter.acquire(url);
      const p2 = smallLimiter.acquire(url);

      // Third should be rejected immediately
      const result = await smallLimiter.acquire(url);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('queue_full');
      expect(result.retryAfterMs).toBeGreaterThan(0);

      // Clean up
      smallLimiter.reset();

      // Await the queued promises to avoid unhandled rejections
      try { await p1; } catch { /* expected */ }
      try { await p2; } catch { /* expected */ }
    });

    it('should block request when route is rate-limited', async () => {
      const url = 'https://discord.com/api/v10/channels/123/messages';

      // Set bucket to 0 remaining with short reset
      limiter.updateFromResponse(url, {
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Limit': '5',
        'X-RateLimit-Reset-After': '0.1',
        'X-RateLimit-Bucket': 'bucket-block',
      });

      // This acquire should be enqueued, then drained after ~100ms
      const resultPromise = limiter.acquire(url);

      // After the bucket resets (~100ms), update with new capacity to trigger drain
      await new Promise(resolve => setTimeout(resolve, 150));
      limiter.updateFromResponse(url, {
        'X-RateLimit-Remaining': '5',
        'X-RateLimit-Limit': '5',
        'X-RateLimit-Reset-After': '5',
        'X-RateLimit-Bucket': 'bucket-block',
      });

      const result = await resultPromise;
      expect(result.allowed).toBe(true);
    });

    it('should block request when global rate limit is active', async () => {
      const url = 'https://discord.com/api/v10/channels/123/messages';

      // Set very short global limit
      limiter.handleRateLimitResponse(url, 100, true);

      const resultPromise = limiter.acquire(url);

      // Wait for global limit to expire, then trigger drain via a normal response
      await new Promise(resolve => setTimeout(resolve, 150));
      limiter.updateFromResponse(url, {
        'X-RateLimit-Remaining': '5',
        'X-RateLimit-Limit': '5',
        'X-RateLimit-Reset-After': '5',
      });

      const result = await resultPromise;
      expect(result.allowed).toBe(true);
    });
  });

  // =========================================================================
  // getState
  // =========================================================================
  describe('getState', () => {
    it('should return initial empty state', () => {
      const state = limiter.getState();
      expect(state.globalResetAt).toBe(0);
      expect(state.consecutiveGlobalHits).toBe(0);
      expect(state.buckets.size).toBe(0);
      expect(state.queueSizes.size).toBe(0);
    });

    it('should reflect queue sizes', () => {
      const url = 'https://discord.com/api/v10/channels/123/messages';
      limiter.handleRateLimitResponse(url, 60_000, false);

      // Queue a couple of requests
      const p1 = limiter.acquire(url);
      const p2 = limiter.acquire(url);

      const state = limiter.getState();
      const routeKey = extractRouteKey(url);
      expect(state.queueSizes.get(routeKey)).toBe(2);

      // Clean up
      limiter.reset();
      // Await to suppress unhandled rejections
      Promise.allSettled([p1, p2]);
    });
  });

  // =========================================================================
  // reset
  // =========================================================================
  describe('reset', () => {
    it('should clear all state', () => {
      const url = 'https://discord.com/api/v10/channels/123/messages';
      limiter.updateFromResponse(url, {
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Limit': '5',
        'X-RateLimit-Reset-After': '60',
      });

      limiter.reset();

      const state = limiter.getState();
      expect(state.globalResetAt).toBe(0);
      expect(state.consecutiveGlobalHits).toBe(0);
      expect(state.buckets.size).toBe(0);
      expect(state.queueSizes.size).toBe(0);
    });

    it('should reject queued requests on reset', async () => {
      const url = 'https://discord.com/api/v10/channels/123/messages';
      limiter.handleRateLimitResponse(url, 60_000, false);

      const promise = limiter.acquire(url);

      limiter.reset();

      try {
        await promise;
        // Should not reach here
        expect(true).toBe(false);
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe('Rate limiter reset');
      }
    });
  });
});
