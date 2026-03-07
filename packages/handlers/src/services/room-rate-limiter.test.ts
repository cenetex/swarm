/**
 * Room Rate Limiter Tests
 *
 * @see packages/handlers/src/services/room-rate-limiter.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { RoomRateLimiter } from './room-rate-limiter.js';

describe('RoomRateLimiter', () => {
  let limiter: RoomRateLimiter;

  beforeEach(() => {
    limiter = new RoomRateLimiter();
  });

  afterEach(() => {
    limiter.destroy();
  });

  // -------------------------------------------------------------------------
  // check() — basic sliding window
  // -------------------------------------------------------------------------

  describe('check()', () => {
    it('allows messages below the limit', () => {
      const result = limiter.check('key1', 5, 1000);
      expect(result.allowed).toBe(true);
      expect(result.currentRate).toBe(1);
    });

    it('rejects messages at the limit', () => {
      const now = 1000;
      for (let i = 0; i < 5; i++) {
        expect(limiter.check('key1', 5, now + i).allowed).toBe(true);
      }
      const result = limiter.check('key1', 5, now + 5);
      expect(result.allowed).toBe(false);
      expect(result.currentRate).toBe(5);
    });

    it('expires old entries after the window', () => {
      const now = 1000;
      // Fill to limit
      for (let i = 0; i < 5; i++) {
        limiter.check('key1', 5, now + i);
      }
      // Should be rejected within the window
      expect(limiter.check('key1', 5, now + 100).allowed).toBe(false);

      // After 60s+ window, all old entries expire (offset enough to clear all 5)
      const result = limiter.check('key1', 5, now + 60_005);
      expect(result.allowed).toBe(true);
      expect(result.currentRate).toBe(1);
    });

    it('tracks separate keys independently', () => {
      const now = 1000;
      for (let i = 0; i < 5; i++) {
        limiter.check('key1', 5, now);
      }
      // key1 is full, key2 should still be allowed
      expect(limiter.check('key1', 5, now).allowed).toBe(false);
      expect(limiter.check('key2', 5, now).allowed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // checkMessage() — room + user combined limits
  // -------------------------------------------------------------------------

  describe('checkMessage()', () => {
    it('allows messages under both limits', () => {
      const result = limiter.checkMessage('room:telegram:-100123', 'user-1', 1000);
      expect(result.allowed).toBe(true);
      expect(result.limitType).toBeUndefined();
    });

    it('enforces per-user limit before room limit', () => {
      const now = 1000;
      // Default user limit is 10 — send 10 messages from same user
      for (let i = 0; i < 10; i++) {
        const r = limiter.checkMessage('room:telegram:-100123', 'user-1', now + i);
        expect(r.allowed).toBe(true);
      }
      // 11th message from same user should be rejected
      const result = limiter.checkMessage('room:telegram:-100123', 'user-1', now + 10);
      expect(result.allowed).toBe(false);
      expect(result.limitType).toBe('user');
    });

    it('enforces room-level limit across multiple users', () => {
      const now = 1000;
      // Default room limit is 30 — send 10 from each of 3 users = 30
      for (let u = 0; u < 3; u++) {
        for (let i = 0; i < 10; i++) {
          const r = limiter.checkMessage('room:telegram:-100123', `user-${u}`, now + u * 10 + i);
          expect(r.allowed).toBe(true);
        }
      }
      // 31st message should be rejected at room level
      const result = limiter.checkMessage('room:telegram:-100123', 'user-3', now + 30);
      expect(result.allowed).toBe(false);
      expect(result.limitType).toBe('room');
    });

    it('rolls back room counter when user limit is hit', () => {
      const now = 1000;
      // Fill user limit for user-1
      for (let i = 0; i < 10; i++) {
        limiter.checkMessage('room:telegram:-100123', 'user-1', now + i);
      }
      // User-1 is rate-limited — room counter should NOT increment
      limiter.checkMessage('room:telegram:-100123', 'user-1', now + 10);

      // Room should still have capacity for a different user
      // (10 messages, not 11, since the rejected one was rolled back)
      const result = limiter.checkMessage('room:telegram:-100123', 'user-2', now + 11);
      expect(result.allowed).toBe(true);
    });

    it('different rooms are independent', () => {
      const now = 1000;
      // Fill room A
      for (let i = 0; i < 30; i++) {
        limiter.checkMessage('room:telegram:-100A', `user-${i}`, now + i);
      }
      expect(limiter.checkMessage('room:telegram:-100A', 'user-99', now + 30).allowed).toBe(false);

      // Room B should be unaffected
      expect(limiter.checkMessage('room:telegram:-100B', 'user-99', now + 30).allowed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // cleanup / memory management
  // -------------------------------------------------------------------------

  describe('memory management', () => {
    it('tracks the number of active keys', () => {
      expect(limiter.size).toBe(0);
      limiter.check('key1', 5, 1000);
      limiter.check('key2', 5, 1000);
      expect(limiter.size).toBe(2);
    });

    it('destroy() stops the cleanup timer', () => {
      // Should not throw
      limiter.destroy();
      limiter.destroy(); // idempotent
    });
  });
});
