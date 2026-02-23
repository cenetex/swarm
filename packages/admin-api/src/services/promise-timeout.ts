/* eslint-disable no-console -- TODO: migrate to structured logger */
/**
 * Promise.all with timeout protection
 *
 * Wraps each promise in a race against a timeout to prevent cascading hangs
 * when individual operations (e.g. DynamoDB queries) stall indefinitely.
 *
 * @module promise-timeout
 */

/** Default timeout for DynamoDB operations (10 seconds) */
export const DEFAULT_TIMEOUT_MS = 10_000;

/** Sentinel symbol to identify timeout results in settled outcomes */
const TIMEOUT_SENTINEL = Symbol('PROMISE_TIMEOUT');

/** Result of a promise that completed (either resolved or rejected) */
export interface SettledFulfilled<T> {
  status: 'fulfilled';
  value: T;
}

/** Result of a promise that timed out */
export interface SettledTimedOut {
  status: 'timed_out';
  index: number;
}

/** Result of a promise that rejected with an error */
export interface SettledRejected {
  status: 'rejected';
  reason: unknown;
  index: number;
}

export type SettledResult<T> = SettledFulfilled<T> | SettledTimedOut | SettledRejected;

/**
 * Race a single promise against a timeout.
 * Returns a sentinel value on timeout instead of rejecting.
 * Clears the timer when the promise settles early to avoid leaking timers.
 */
function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | typeof TIMEOUT_SENTINEL> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
      timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), timeoutMs);
    }),
  ]);
}

/**
 * Execute promises in parallel with per-promise timeout and settled semantics.
 *
 * Unlike Promise.allSettled, this also catches timeouts and reports them
 * as a distinct status. Useful when partial results are acceptable and
 * individual hangs should not block the entire group.
 *
 * @param promises - Array of promises to execute
 * @param timeoutMs - Timeout per individual promise (default: 10s)
 * @param label - Optional label for structured log messages
 * @returns Array of settled results with status for each promise
 */
export async function promiseAllSettledWithTimeout<T>(
  promises: Promise<T>[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  label?: string,
): Promise<SettledResult<T>[]> {
  const results = await Promise.all(
    promises.map(async (promise, index) => {
      try {
        const result = await raceWithTimeout(promise, timeoutMs);
        if (result === TIMEOUT_SENTINEL) {
          console.warn(JSON.stringify({
            level: 'warn',
            event: 'promise_timeout',
            label: label ?? 'unknown',
            index,
            timeoutMs,
          }));
          return { status: 'timed_out', index } as SettledTimedOut;
        }
        return { status: 'fulfilled', value: result as T } as SettledFulfilled<T>;
      } catch (reason) {
        return { status: 'rejected', reason, index } as SettledRejected;
      }
    }),
  );
  return results;
}

/**
 * Execute promises in parallel with per-promise timeout protection.
 *
 * All promises must resolve successfully (within the timeout) or the call
 * throws. Use this when partial results are NOT acceptable.
 *
 * Supports both homogeneous arrays (`Promise<T>[]`) and heterogeneous
 * tuples (`[Promise<A>, Promise<B>]`) — the return type mirrors the input
 * shape so destructured results are correctly typed.
 *
 * @param promises - Array or tuple of promises to execute
 * @param timeoutMs - Timeout per individual promise (default: 10s)
 * @param label - Optional label for structured log messages
 * @returns Array/tuple of resolved values (same order as input)
 * @throws Error if any promise times out or rejects
 */
export async function promiseAllWithTimeout<T extends readonly unknown[]>(
  promises: readonly [...{ [K in keyof T]: Promise<T[K]> }],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  label?: string,
): Promise<[...T]> {
  const settled = await promiseAllSettledWithTimeout(
    promises as Promise<unknown>[],
    timeoutMs,
    label,
  );

  const values: unknown[] = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      values.push(result.value);
    } else if (result.status === 'timed_out') {
      throw new Error(
        `Promise at index ${result.index} timed out after ${timeoutMs}ms` +
        (label ? ` [${label}]` : ''),
      );
    } else {
      throw result.reason instanceof Error
        ? result.reason
        : new Error(String(result.reason));
    }
  }
  return values as [...T];
}
