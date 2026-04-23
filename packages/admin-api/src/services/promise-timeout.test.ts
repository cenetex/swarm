/**
 * Promise Timeout Utility Tests
 *
 * Tests for promiseAllWithTimeout and promiseAllSettledWithTimeout covering:
 * 1. All promises resolve before timeout
 * 2. Some promises timeout (partial results)
 * 3. All promises timeout
 * 4. Error propagation vs timeout
 * 5. Mixed scenarios (resolve + reject + timeout)
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  promiseAllWithTimeout,
  promiseAllSettledWithTimeout,
  DEFAULT_TIMEOUT_MS,
} from './promise-timeout.js';

// Helper: create a promise that resolves after a delay
function delayed<T>(value: T, ms: number): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

// Helper: create a promise that rejects after a delay
function delayedReject(error: Error, ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(error), ms));
}

describe('Promise Timeout Utilities', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // promiseAllSettledWithTimeout
  // ==========================================================================
  describe('promiseAllSettledWithTimeout', () => {
    it('should resolve all promises that complete before timeout', async () => {
      const results = await promiseAllSettledWithTimeout(
        [
          delayed('a', 10),
          delayed('b', 20),
          delayed('c', 30),
        ],
        500,
      );

      expect(results).toEqual([
        { status: 'fulfilled', value: 'a' },
        { status: 'fulfilled', value: 'b' },
        { status: 'fulfilled', value: 'c' },
      ]);
    });

    it('should report timed_out for promises that exceed timeout', async () => {
      const results = await promiseAllSettledWithTimeout(
        [
          delayed('fast', 10),
          delayed('slow', 500), // will timeout
        ],
        100,
        'test-timeout',
      );

      expect(results[0]).toEqual({ status: 'fulfilled', value: 'fast' });
      expect(results[1]).toEqual({ status: 'timed_out', index: 1 });
    });

    it('should report all as timed_out when all exceed timeout', async () => {
      const results = await promiseAllSettledWithTimeout(
        [
          delayed('a', 500),
          delayed('b', 600),
          delayed('c', 700),
        ],
        50,
      );

      expect(results).toEqual([
        { status: 'timed_out', index: 0 },
        { status: 'timed_out', index: 1 },
        { status: 'timed_out', index: 2 },
      ]);
    });

    it('should report rejected for promises that throw errors', async () => {
      const error = new Error('test error');
      const results = await promiseAllSettledWithTimeout(
        [
          delayed('ok', 10),
          delayedReject(error, 10),
        ],
        500,
      );

      expect(results[0]).toEqual({ status: 'fulfilled', value: 'ok' });
      expect(results[1]).toEqual({ status: 'rejected', reason: error, index: 1 });
    });

    it('should handle mixed results (fulfilled, rejected, timed_out)', async () => {
      const error = new Error('failed');
      const results = await promiseAllSettledWithTimeout(
        [
          delayed('ok', 10),          // will resolve
          delayedReject(error, 10),    // will reject
          delayed('slow', 500),        // will timeout
        ],
        100,
      );

      expect(results[0]).toEqual({ status: 'fulfilled', value: 'ok' });
      expect(results[1]).toEqual({ status: 'rejected', reason: error, index: 1 });
      expect(results[2]).toEqual({ status: 'timed_out', index: 2 });
    });

    it('should handle empty promise array', async () => {
      const results = await promiseAllSettledWithTimeout([], 100);
      expect(results).toEqual([]);
    });

    it('should log warnings for timed out promises', async () => {
      // Migrated 2026-04-22 (issue #1363): the timeout warning now flows through
      // createSystemLogger('promise-timeout'), which writes its CloudWatch
      // transport via console.log (NOT console.warn). The log level is still
      // WARN; only the transport sink changed.
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await promiseAllSettledWithTimeout(
        [delayed('slow', 500)],
        50,
        'test-label',
      );

      const timeoutCall = logSpy.mock.calls.find((call) => {
        try {
          const parsed = JSON.parse(call[0]);
          return parsed.event === 'promise_timeout';
        } catch {
          return false;
        }
      });
      expect(timeoutCall).toBeDefined();
      const parsed = JSON.parse(timeoutCall![0]);
      expect(parsed.event).toBe('promise_timeout');
      expect(parsed.level).toBe('WARN');
      expect(parsed.label).toBe('test-label');
      expect(parsed.index).toBe(0);
      expect(parsed.timeoutMs).toBe(50);
    });

    it('should distinguish between error before timeout and timeout', async () => {
      const error = new Error('immediate fail');

      const results = await promiseAllSettledWithTimeout(
        [
          Promise.reject(error),       // rejects immediately
          delayed('slow', 500),        // will timeout
        ],
        100,
      );

      expect(results[0].status).toBe('rejected');
      expect(results[1].status).toBe('timed_out');
    });
  });

  // ==========================================================================
  // promiseAllWithTimeout
  // ==========================================================================
  describe('promiseAllWithTimeout', () => {
    it('should return all values when all promises resolve before timeout', async () => {
      const results = await promiseAllWithTimeout(
        [
          delayed(1, 10),
          delayed(2, 20),
          delayed(3, 30),
        ],
        500,
      );

      expect(results).toEqual([1, 2, 3]);
    });

    it('should throw on timeout with descriptive message', async () => {
      await expect(
        promiseAllWithTimeout(
          [
            delayed('fast', 10),
            delayed('slow', 500),
          ],
          100,
          'dynamo-query',
        ),
      ).rejects.toThrow('Promise at index 1 timed out after 100ms [dynamo-query]');
    });

    it('should throw the original error when a promise rejects', async () => {
      const error = new Error('DynamoDB connection failed');

      await expect(
        promiseAllWithTimeout(
          [
            delayed('ok', 10),
            delayedReject(error, 10),
          ],
          500,
        ),
      ).rejects.toThrow('DynamoDB connection failed');
    });

    it('should throw timeout error before rejection if timeout happens first', async () => {
      // A promise that would reject but only after a long delay
      const slowReject = delayedReject(new Error('slow error'), 500);

      await expect(
        promiseAllWithTimeout(
          [
            delayed('fast', 10),
            slowReject,
          ],
          100,
        ),
      ).rejects.toThrow(/timed out/);
    });

    it('should throw on all timeouts', async () => {
      await expect(
        promiseAllWithTimeout(
          [
            delayed('a', 500),
            delayed('b', 600),
          ],
          50,
        ),
      ).rejects.toThrow(/timed out/);
    });

    it('should handle empty promise array', async () => {
      const results = await promiseAllWithTimeout([], 100);
      expect(results).toEqual([]);
    });

    it('should preserve result order matching input promise order', async () => {
      // Second promise resolves faster but should still be at index 1
      const results = await promiseAllWithTimeout(
        [
          delayed('first', 50),
          delayed('second', 10),
          delayed('third', 30),
        ],
        500,
      );

      expect(results).toEqual(['first', 'second', 'third']);
    });

    it('should handle non-Error rejections', async () => {
      const nonErrorPromise = Promise.reject('string error');

      await expect(
        promiseAllWithTimeout([nonErrorPromise], 500),
      ).rejects.toThrow('string error');
    });
  });

  // ==========================================================================
  // Default timeout constant
  // ==========================================================================
  describe('DEFAULT_TIMEOUT_MS', () => {
    it('should be 10 seconds', () => {
      expect(DEFAULT_TIMEOUT_MS).toBe(10_000);
    });
  });
});
