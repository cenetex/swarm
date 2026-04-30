/**
 * Tests for safe-fetch utility
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { safeFetch } from './safe-fetch';

// Mock fetch globally
const originalFetch = global.fetch;

describe('safeFetch', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('successful responses', () => {
    it('returns parsed JSON on 2xx response', async () => {
      const mockData = { id: '123', name: 'test' };
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockData,
      });

      const result = await safeFetch<typeof mockData>('/api/test');

      expect(result).toEqual({ ok: true, data: mockData });
      expect(global.fetch).toHaveBeenCalledWith('/api/test', {
        signal: expect.any(AbortSignal),
      });
    });

    it('respects custom timeout option', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      });

      await safeFetch('/api/test', { timeout: 5_000 });

      expect(global.fetch).toHaveBeenCalledWith(
        '/api/test',
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        }),
      );
    });

    it('preserves fetch options like method and headers', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
      });

      await safeFetch('/api/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ foo: 'bar' }),
      });

      expect(global.fetch).toHaveBeenCalledWith(
        '/api/test',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ foo: 'bar' }),
        }),
      );
    });
  });

  describe('error responses (4xx/5xx)', () => {
    it('returns error for non-2xx response with error in body', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ error: 'Avatar not found' }),
      });

      const result = await safeFetch('/api/avatars/invalid');

      expect(result).toEqual({ ok: false, error: 'Avatar not found' });
    });

    it('returns HTTP status for non-2xx response without error field', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ message: 'Internal server error' }),
      });

      const result = await safeFetch('/api/avatars');

      expect(result).toEqual({ ok: false, error: 'HTTP 500' });
    });
  });

  describe('malformed responses', () => {
    it('returns error when response JSON parsing fails', async () => {
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token <');
        },
      });

      const result = await safeFetch('/api/test');

      expect(result).toEqual({
        ok: false,
        error: expect.stringContaining('Unexpected response format'),
      });
    });

    it('logs error to console when JSON parsing fails', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token <');
        },
      });

      await safeFetch('/api/test');

      expect(consoleErrorSpy).toHaveBeenCalled();
      expect(consoleErrorSpy.mock.calls[0][0]).toContain('[safeFetch]');
      consoleErrorSpy.mockRestore();
    });
  });

  describe('network errors', () => {
    it('returns error on network failure', async () => {
      (global.fetch as any).mockRejectedValueOnce(
        new TypeError('Failed to fetch'),
      );

      const result = await safeFetch('/api/test');

      expect(result).toEqual({
        ok: false,
        error: expect.stringContaining('Network error'),
      });
    });

    it('returns error on timeout', async () => {
      const abortError = new DOMException('The operation was aborted.', 'AbortError');
      (global.fetch as any).mockRejectedValueOnce(abortError);

      const result = await safeFetch('/api/test', { timeout: 100 });

      expect(result).toEqual({
        ok: false,
        error: expect.stringContaining('timed out'),
      });
    });

    it('logs network errors to console', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      (global.fetch as any).mockRejectedValueOnce(
        new TypeError('Failed to fetch'),
      );

      await safeFetch('/api/test');

      expect(consoleErrorSpy).toHaveBeenCalled();
      expect(consoleErrorSpy.mock.calls[0][0]).toContain('[safeFetch]');
      consoleErrorSpy.mockRestore();
    });
  });

  describe('type safety', () => {
    it('type-checks generic parameter', async () => {
      interface ApiResponse {
        id: string;
        name: string;
        count: number;
      }

      (global.fetch as any).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: '123',
          name: 'test',
          count: 42,
        } as ApiResponse),
      });

      const result = await safeFetch<ApiResponse>('/api/test');

      if (result.ok) {
        // These should not cause TypeScript errors
        const { id, name, count } = result.data;
        expect(typeof id).toBe('string');
        expect(typeof name).toBe('string');
        expect(typeof count).toBe('number');
      }
    });
  });
});
