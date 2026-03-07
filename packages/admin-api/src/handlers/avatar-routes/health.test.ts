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
