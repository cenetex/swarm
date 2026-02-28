import { describe, it, expect } from 'vitest';
import { validateReplicateApiKey } from './replicate.js';

describe('replicate api key validation', () => {
  it('rejects invalid key', async () => {
    const result = await validateReplicateApiKey('bad', {
      fetchFn: async () => new Response('{}', { status: 401 }),
    });

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid API key');
  });

  it('rejects when billing is disabled', async () => {
    const result = await validateReplicateApiKey('key', {
      fetchFn: async () => new Response(JSON.stringify({ type: 'free', billing_enabled: false }), { status: 200 }),
    });

    expect(result.valid).toBe(true);
    expect(result.billingEnabled).toBe(false);
    expect(result.warning).toContain('Billing');
  });

  it('accepts billed accounts', async () => {
    const result = await validateReplicateApiKey('key', {
      fetchFn: async () => new Response(JSON.stringify({ type: 'pro', billing_enabled: true }), { status: 200 }),
    });

    expect(result.valid).toBe(true);
    expect(result.accountType).toBe('pro');
  });

  it('handles rate limiting (429)', async () => {
    const result = await validateReplicateApiKey('key', {
      fetchFn: async () => new Response('rate limited', { status: 429 }),
    });

    expect(result.valid).toBe(false);
    expect(result.error).toContain('rate-limited');
  });

  it('extracts JSON error detail when present', async () => {
    const result = await validateReplicateApiKey('key', {
      fetchFn: async () => new Response(JSON.stringify({ detail: 'Something went wrong' }), { status: 500 }),
    });

    expect(result.valid).toBe(false);
    expect(result.error).toBe('Something went wrong');
  });
});
