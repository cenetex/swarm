/**
 * Tests for submitToolResult — the API-layer contract that
 * ChatPanel.handleToolSubmit relies on to surface backend failures
 * as ToolSubmitResult.
 *
 * The ToolSubmitResult contract (types.ts) requires that prompt
 * components receive `{ ok: false, error }` on failure instead of
 * silent success. That only works if submitToolResult throws with
 * a readable `.message` on server error, which handleToolSubmit
 * catches and converts. This test pins that contract.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';

import { sendChatMessage, submitToolResult } from './chat';

describe('sendChatMessage', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('sends one replay-safe request id with hosted chat work', async () => {
    let requestBody: Record<string, unknown> = {};
    globalThis.fetch = vi.fn(async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ response: 'Hello', history: [] });
    }) as typeof fetch;

    await sendChatMessage('Hi', [], { id: 'avatar-1', name: 'Ada' });

    expect(requestBody.message).toBe('Hi');
    expect(requestBody.requestId).toMatch(/^request_[A-Za-z0-9_-]+$/);
  });

  it('polls an accepted hosted chat job and returns its completed answer', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/jobs/job-1')) {
        return Response.json({
          jobId: 'job-1',
          type: 'chat',
          status: 'completed',
          prompt: '',
          createdAt: 1,
          updatedAt: 2,
          response: 'Stored answer',
          history: [
            { role: 'user', content: 'Hi' },
            { role: 'assistant', content: 'Stored answer' },
          ],
        });
      }
      return Response.json({ jobId: 'job-1' }, { status: 202 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await sendChatMessage('Hi', [], { id: 'avatar-1', name: 'Ada' });

    expect(result.response).toBe('Stored answer');
    expect(result.history).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('submitToolResult', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns the resumed chat response on 200 with JSON body', async () => {
    globalThis.fetch = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ response: 'ok', history: [] }),
      } as unknown as Response;
    }) as typeof fetch;

    const result = await submitToolResult('avatar-1', 'tc-1', { configured: true });
    expect(result).toEqual({ response: 'ok', history: [] });
  });

  it('throws with server error.error string when response is not ok', async () => {
    globalThis.fetch = vi.fn(async () => {
      return {
        ok: false,
        status: 409,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ error: 'Unknown or expired toolCallId: tc-1' }),
      } as unknown as Response;
    }) as typeof fetch;

    await expect(
      submitToolResult('avatar-1', 'tc-1', {}),
    ).rejects.toThrow('Unknown or expired toolCallId: tc-1');
  });

  it('throws with "Request failed" fallback when server returns non-JSON error body', async () => {
    globalThis.fetch = vi.fn(async () => {
      return {
        ok: false,
        status: 500,
        headers: new Headers({ 'content-type': 'text/html' }),
        json: async () => {
          throw new Error('invalid json');
        },
      } as unknown as Response;
    }) as typeof fetch;

    // The API layer's catch returns `{ error: 'Request failed' }` when
    // json() throws, which then becomes the thrown message. Either way
    // handleToolSubmit surfaces a readable string to the user.
    await expect(
      submitToolResult('avatar-1', 'tc-1', {}),
    ).rejects.toThrow('Request failed');
  });

  it('throws an actionable error when server returns 200 with non-JSON content-type', async () => {
    // This is the "CloudFront intercepted with HTML" case — server says
    // "ok" but the body is garbage. handleToolSubmit converts this to
    // { ok: false, error } via the returned Error's message.
    globalThis.fetch = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/html' }),
        json: async () => ({}),
      } as unknown as Response;
    }) as typeof fetch;

    await expect(
      submitToolResult('avatar-1', 'tc-1', {}),
    ).rejects.toThrow(/Unexpected server response/);
  });

  it('produces an Error (not a raw reject value) so .message is always readable', async () => {
    globalThis.fetch = vi.fn(async () => {
      return {
        ok: false,
        status: 404,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({}),
      } as unknown as Response;
    }) as typeof fetch;

    let caught: unknown;
    try {
      await submitToolResult('avatar-1', 'tc-1', {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/HTTP 404/);
  });
});
