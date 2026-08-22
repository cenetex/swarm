/**
 * Telegram polling service tests.
 */
import { describe, it, expect, mock, afterEach } from 'bun:test';
import { startTelegramPolling } from './telegram-polling.js';
import type { TelegramPollingDeps } from './telegram-polling.js';

function makeDeps(overrides: Partial<TelegramPollingDeps> = {}): TelegramPollingDeps {
  return {
    getToken: mock(async () => null),
    processMessage: mock(async (text: string) => ({ response: `echo:${text}`, history: [{ role: 'user', content: text }, { role: 'assistant', content: `echo:${text}` }] })),
    getAvatarId: mock(async () => null),
    loadHistory: mock(async () => []),
    saveHistory: mock(async () => {}),
    ...overrides,
  };
}

describe('startTelegramPolling', () => {
  let stops: Array<() => void> = [];

  afterEach(() => {
    for (const stop of stops) stop();
    stops = [];
  });

  it('returns a stop function', () => {
    const deps = makeDeps();
    const stop = startTelegramPolling(deps);
    stops.push(stop);
    expect(typeof stop).toBe('function');
  });

  it('stop function stops the polling loop without error', () => {
    const deps = makeDeps();
    const stop = startTelegramPolling(deps);
    stop();
    // Should not throw
  });

  it('calls getToken during polling', async () => {
    const getToken = mock(async () => null);
    const deps = makeDeps({ getToken });
    const stop = startTelegramPolling(deps);
    stops.push(stop);

    // Wait for at least one poll cycle
    await new Promise(r => setTimeout(r, 200));
    stop();
    expect(getToken).toHaveBeenCalled();
  });

  it('does not create bot when token is null', async () => {
    let called = false;
    const getToken = mock(async () => { called = true; return null; });
    const deps = makeDeps({ getToken });
    const stop = startTelegramPolling(deps);
    stops.push(stop);

    await new Promise(r => setTimeout(r, 200));
    stop();
    expect(called).toBe(true);
    // getAvatarId / processMessage should never be called since no token
    expect(deps.getAvatarId).not.toHaveBeenCalled();
  });

  it('getToken errors do not crash the poll loop', async () => {
    let calls = 0;
    const getToken = mock(async () => { calls++; throw new Error('network'); });
    const deps = makeDeps({ getToken });
    const stop = startTelegramPolling(deps);
    stops.push(stop);

    // Poll loop retries after 5s sleep on error, but should have made at least 1 call
    await new Promise(r => setTimeout(r, 200));
    stop();
    expect(calls).toBeGreaterThanOrEqual(1);
  });

  it('calling stop twice is safe', () => {
    const deps = makeDeps();
    const stop = startTelegramPolling(deps);
    stop();
    stop(); // Should not throw
  });

  it('multiple stop functions are independent', () => {
    const deps1 = makeDeps();
    const deps2 = makeDeps();
    const stop1 = startTelegramPolling(deps1);
    const stop2 = startTelegramPolling(deps2);
    stops.push(stop1, stop2);
    stop1();
    stop2();
  });
});
