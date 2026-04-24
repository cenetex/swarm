/**
 * Tests for resolveSystemPrompt — aws-swarm#1522.
 *
 * Uses direct save-and-restore of `globalThis.fetch` rather than `spyOn`
 * so the tests remain clean under bun's shared-process mode, where another
 * file's unrestored spy could otherwise bleed across into call-count
 * assertions here (see aws-swarm#1311 — mock pollution under bun).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { resolveSystemPrompt, clearSystemPromptOverrideCache } from './system-prompt-resolver.js';
import type { ProcessorAvatarConfig } from './types.js';

function avatar(overrides: Partial<ProcessorAvatarConfig> = {}): ProcessorAvatarConfig {
  return {
    avatarId: 'test-avatar',
    name: 'Test',
    persona: 'You are a test avatar.',
    enabledCategories: [],
    ...overrides,
  };
}

// Reusable fetch stub: captures calls, returns a scripted Response.
function stubFetch(impl: (url: string) => Response | Promise<Response>): {
  restore: () => void;
  calls: string[];
} {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    return impl(url);
  }) as typeof globalThis.fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

describe('resolveSystemPrompt', () => {
  beforeEach(() => {
    clearSystemPromptOverrideCache();
  });

  it('returns the assembled prompt when no override is set', async () => {
    const out = await resolveSystemPrompt(avatar());
    expect(out).toContain('Persona');
    expect(out).toContain('You are a test avatar.');
  });

  it('returns inline override verbatim and skips the template stack', async () => {
    const out = await resolveSystemPrompt(
      avatar({ systemPromptOverride: { kind: 'inline', text: 'MINIMAL PROMPT.' } })
    );
    expect(out).toBe('MINIMAL PROMPT.');
    expect(out).not.toContain('Persona');
    expect(out).not.toContain('Capabilities');
  });

  it('falls through to template when inline override is whitespace-only', async () => {
    const out = await resolveSystemPrompt(
      avatar({ systemPromptOverride: { kind: 'inline', text: '   \n\n  ' } })
    );
    expect(out).toContain('Persona');
  });

  describe('url variant', () => {
    let stub: ReturnType<typeof stubFetch> | null = null;

    afterEach(() => {
      stub?.restore();
      stub = null;
    });

    it('fetches the URL body and returns it verbatim', async () => {
      stub = stubFetch(() => new Response('URL PROMPT BODY', { status: 200 }));
      const out = await resolveSystemPrompt(
        avatar({ systemPromptOverride: { kind: 'url', url: 'https://example.com/prompt.md' } })
      );
      expect(out).toBe('URL PROMPT BODY');
      expect(stub.calls).toEqual(['https://example.com/prompt.md']);
    });

    it('caches the fetched body across calls within the TTL', async () => {
      stub = stubFetch(() => new Response('CACHED BODY', { status: 200 }));
      const cfg = avatar({
        systemPromptOverride: { kind: 'url', url: 'https://example.com/a.md', cacheTtlSec: 60 },
      });
      const first = await resolveSystemPrompt(cfg);
      const second = await resolveSystemPrompt(cfg);
      expect(first).toBe('CACHED BODY');
      expect(second).toBe('CACHED BODY');
      expect(stub.calls.length).toBe(1);
    });

    it('falls back to the template when the fetch returns a non-2xx', async () => {
      stub = stubFetch(() => new Response('oops', { status: 500 }));
      const out = await resolveSystemPrompt(
        avatar({ systemPromptOverride: { kind: 'url', url: 'https://example.com/bad.md' } })
      );
      expect(out).toContain('Persona');
      expect(out).toContain('You are a test avatar.');
    });

    it('falls back to the template when the fetch throws', async () => {
      stub = stubFetch(() => {
        throw new Error('network exploded');
      });
      const out = await resolveSystemPrompt(
        avatar({ systemPromptOverride: { kind: 'url', url: 'https://example.com/down.md' } })
      );
      expect(out).toContain('Persona');
    });

    it('truncates responses larger than the size cap', async () => {
      const huge = 'A'.repeat(600 * 1024); // 600 KiB > 512 KiB cap
      stub = stubFetch(() => new Response(huge, { status: 200 }));
      const out = await resolveSystemPrompt(
        avatar({ systemPromptOverride: { kind: 'url', url: 'https://example.com/huge.md' } })
      );
      expect(out.length).toBe(512 * 1024);
      expect(out[0]).toBe('A');
    });
  });
});
