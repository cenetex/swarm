/**
 * Tests for avatar-routes/health.ts
 *
 * Routes:
 *   GET /avatars/health — paginated health summary (admin only)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock state ─────────────────────────────────────────────────────────────
let healthResult: unknown = { avatars: [], total: 0 };

vi.mock('../../services/avatar-health.js', () => ({
  getAvatarHealthSummaries: async (_limit: number, _cursor?: string) => {
    return healthResult;
  },
}));

vi.mock('@swarm/core', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, setContext: () => {} },
  // Transitive exports needed when handlers import services that depend on @swarm/core
  createSqsOffloadServiceFromEnv: () => null,
  createGallerySaver: () => ({ save: () => Promise.resolve() }),
  LLMError: class LLMError extends Error { code: string; constructor(msg: string, opts?: any) { super(msg); this.code = opts?.code ?? ''; } },
  SwarmErrorCode: {
    UNKNOWN: 'UNKNOWN',
    PLATFORM_ADAPTER_NOT_FOUND: 'PLATFORM_ADAPTER_NOT_FOUND',
    PLATFORM_CONFIG_INVALID: 'PLATFORM_CONFIG_INVALID',
    PLATFORM_AUTH_FAILED: 'PLATFORM_AUTH_FAILED',
    PLATFORM_CONNECTION_FAILED: 'PLATFORM_CONNECTION_FAILED',
    PLATFORM_RATE_LIMITED: 'PLATFORM_RATE_LIMITED',
    PLATFORM_API_ERROR: 'PLATFORM_API_ERROR',
    PLATFORM_WEBHOOK_INVALID: 'PLATFORM_WEBHOOK_INVALID',
    LLM_MISSING_API_KEY: 'LLM_MISSING_API_KEY',
    LLM_CIRCUIT_OPEN: 'LLM_CIRCUIT_OPEN',
    LLM_API_ERROR: 'LLM_API_ERROR',
    LLM_EMPTY_RESPONSE: 'LLM_EMPTY_RESPONSE',
    LLM_INVALID_SCHEMA: 'LLM_INVALID_SCHEMA',
    CONFIG_MISSING_REQUIRED_FIELD: 'CONFIG_MISSING_REQUIRED_FIELD',
    CONFIG_INVALID_ENUM_VALUE: 'CONFIG_INVALID_ENUM_VALUE',
    CONFIG_NESTED_OBJECT_INVALID: 'CONFIG_NESTED_OBJECT_INVALID',
    STATE_SERIALIZATION_FAILED: 'STATE_SERIALIZATION_FAILED',
    STATE_DESERIALIZATION_FAILED: 'STATE_DESERIALIZATION_FAILED',
    MEDIA_PROVIDER_ERROR: 'MEDIA_PROVIDER_ERROR',
    MEDIA_UPLOAD_FAILED: 'MEDIA_UPLOAD_FAILED',
    MEDIA_DOWNLOAD_FAILED: 'MEDIA_DOWNLOAD_FAILED',
    AUTH_INVALID_TOKEN: 'AUTH_INVALID_TOKEN',
    AUTH_EXPIRED_TOKEN: 'AUTH_EXPIRED_TOKEN',
    AUTH_INSUFFICIENT_PERMISSIONS: 'AUTH_INSUFFICIENT_PERMISSIONS',
    QUEUE_SEND_FAILED: 'QUEUE_SEND_FAILED',
    QUEUE_RECEIVE_FAILED: 'QUEUE_RECEIVE_FAILED',
    NETWORK_TIMEOUT: 'NETWORK_TIMEOUT',
    NETWORK_CONNECTION_ERROR: 'NETWORK_CONNECTION_ERROR',
  },
}));

import { handleHealthRoutes } from './health.js';
import { makeCtx, parseBody } from './test-helpers.js';

beforeEach(() => {
  healthResult = { avatars: [], total: 0 };
});

describe('GET /avatars/health', () => {
  it('returns 403 for non-admin', async () => {
    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars/health',
      effectiveIsAdmin: false,
    });
    const result = await handleHealthRoutes(ctx);
    expect(result!.statusCode).toBe(403);
  });

  it('returns empty health summaries for admin', async () => {
    healthResult = { avatars: [], total: 0 };
    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars/health',
      effectiveIsAdmin: true,
    });
    const result = await handleHealthRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    const body = parseBody(result!) as { avatars: unknown[]; total: number };
    expect(body.total).toBe(0);
    expect(body.avatars).toEqual([]);
  });

  it('returns health summaries with avatar data', async () => {
    healthResult = {
      avatars: [
        {
          avatarId: 'avatar-1',
          name: 'Test Avatar',
          status: 'active',
          memoryCounts: { immediate: 3, recent: 10, core: 5, total: 18 },
          lastActiveAt: 1700000000000,
          consolidationStatus: 'healthy',
          errorCount: 0,
        },
      ],
      total: 1,
    };

    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars/health',
      effectiveIsAdmin: true,
    });
    const result = await handleHealthRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    const body = parseBody(result!) as { avatars: Array<{ avatarId: string; memoryCounts: { total: number } }>; total: number };
    expect(body.total).toBe(1);
    expect(body.avatars[0].avatarId).toBe('avatar-1');
    expect(body.avatars[0].memoryCounts.total).toBe(18);
  });

  it('passes pagination params through', async () => {
    healthResult = {
      avatars: [],
      total: 50,
      cursor: Buffer.from('20').toString('base64'),
    };

    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars/health',
      effectiveIsAdmin: true,
      queryStringParameters: { limit: '10', cursor: Buffer.from('10').toString('base64') },
    });
    const result = await handleHealthRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    const body = parseBody(result!) as { total: number; cursor?: string };
    expect(body.total).toBe(50);
    expect(body.cursor).toBeDefined();
  });

  it('returns null for non-matching routes', async () => {
    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars/something-else',
      effectiveIsAdmin: true,
    });
    const result = await handleHealthRoutes(ctx);
    expect(result).toBeNull();
  });

  it('returns null for non-GET methods', async () => {
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars/health',
      effectiveIsAdmin: true,
    });
    const result = await handleHealthRoutes(ctx);
    expect(result).toBeNull();
  });
});
