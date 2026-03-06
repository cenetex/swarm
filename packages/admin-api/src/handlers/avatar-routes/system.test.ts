/**
 * Tests for avatar-routes/system.ts
 *
 * Routes:
 *   GET /system/status
 *   GET /integrations/models
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock tracking ──────────────────────────────────────────────────────────
let mockSystemStatus: unknown = { healthy: true };
let mockModelsResult: unknown = {};

vi.mock('../../services/observability.js', () => ({
  getSystemStatus: async () => mockSystemStatus,
}));

vi.mock('@swarm/core', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, setContext: () => {} },
}));

// ── Import handler AFTER mocks ─────────────────────────────────────────────
import { handleSystemRoutes } from './system.js';
import { makeCtx, parseBody } from './test-helpers.js';
import * as integrationsModule from '../../services/integrations.js';

beforeEach(() => {
  mockSystemStatus = { healthy: true };
  mockModelsResult = {};
  vi.spyOn(integrationsModule, 'getAvailableModelsForIntegration').mockImplementation(
    () => mockModelsResult as never
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /system/status', () => {
  it('returns system status for admin', async () => {
    const ctx = makeCtx({ method: 'GET', path: '/system/status', effectiveIsAdmin: true });
    const result = await handleSystemRoutes(ctx);
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(200);
    expect(parseBody(result!)).toEqual({ healthy: true });
  });

  it('returns 403 for non-admin', async () => {
    const ctx = makeCtx({ method: 'GET', path: '/system/status', effectiveIsAdmin: false });
    const result = await handleSystemRoutes(ctx);
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(403);
  });
});

describe('GET /integrations/models', () => {
  it('returns all integrations when no filter', async () => {
    const ctx = makeCtx({ method: 'GET', path: '/integrations/models' });
    const result = await handleSystemRoutes(ctx);
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(200);
    const body = parseBody(result!) as { integrations: Record<string, unknown> };
    expect(body.integrations).toBeDefined();
    expect(Object.keys(body.integrations)).toEqual(['replicate', 'openai', 'anthropic', 'openrouter']);
  });

  it('returns filtered integration', async () => {
    mockModelsResult = { chat: ['model-1'] };
    const ctx = makeCtx({
      method: 'GET',
      path: '/integrations/models',
      queryStringParameters: { integration: 'replicate' },
    });
    const result = await handleSystemRoutes(ctx);
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(200);
    const body = parseBody(result!) as { integration: string; modelsByCapability: unknown };
    expect(body.integration).toBe('replicate');
    expect(body.modelsByCapability).toEqual({ chat: ['model-1'] });
  });

  it('returns 400 for unknown integration', async () => {
    const ctx = makeCtx({
      method: 'GET',
      path: '/integrations/models',
      queryStringParameters: { integration: 'bad-provider' },
    });
    const result = await handleSystemRoutes(ctx);
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(400);
  });
});

describe('unmatched routes', () => {
  it('returns null for unknown paths', async () => {
    const ctx = makeCtx({ method: 'GET', path: '/something-else' });
    const result = await handleSystemRoutes(ctx);
    expect(result).toBeNull();
  });
});
