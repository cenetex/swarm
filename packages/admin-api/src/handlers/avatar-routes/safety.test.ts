/**
 * Tests for avatar-routes/safety.ts
 *
 * Routes:
 *   POST /avatars/{id}/anomaly/reset
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let getAvatarResult: unknown = null;
let resetAnomalyError: Error | null = null;

vi.mock('../../services/avatars.js', () => ({
  getAvatar: async () => getAvatarResult,
}));

vi.mock('../../services/anomaly-detector.js', () => ({
  resetAnomalyState: async () => {
    if (resetAnomalyError) throw resetAnomalyError;
  },
}));

vi.mock('@swarm/core', () => ({
  ...RealSwarmCore,
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, setContext: () => {} },
}));

import { handleSafetyRoutes } from './safety.js';
import { makeCtx, parseBody, MOCK_AVATAR } from './test-helpers.js';

import * as RealSwarmCore from '../../../../core/src/index.js';

beforeEach(() => {
  getAvatarResult = null;
  resetAnomalyError = null;
});

describe('POST /avatars/{id}/anomaly/reset', () => {
  it('resets anomaly state for admin', async () => {
    getAvatarResult = MOCK_AVATAR;
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars/avatar-1/anomaly/reset',
      effectiveIsAdmin: true,
    });
    const result = await handleSafetyRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    const body = parseBody(result!) as Record<string, unknown>;
    expect(body.success).toBe(true);
    expect(body.avatarId).toBe('avatar-1');
  });

  it('resets anomaly state for avatar owner', async () => {
    getAvatarResult = { ...MOCK_AVATAR, creatorWallet: 'wallet-1' };
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars/avatar-1/anomaly/reset',
      walletAddress: 'wallet-1',
    });
    const result = await handleSafetyRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    const body = parseBody(result!) as Record<string, unknown>;
    expect(body.success).toBe(true);
  });

  it('returns 403 when not owner or admin', async () => {
    getAvatarResult = { ...MOCK_AVATAR, creatorWallet: 'wallet-1' };
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars/avatar-1/anomaly/reset',
      walletAddress: 'wallet-2',
    });
    const result = await handleSafetyRoutes(ctx);
    expect(result!.statusCode).toBe(403);
  });

  it('returns 404 when avatar not found', async () => {
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars/avatar-1/anomaly/reset',
      effectiveIsAdmin: true,
    });
    const result = await handleSafetyRoutes(ctx);
    expect(result!.statusCode).toBe(404);
  });

  it('returns 500 on reset error', async () => {
    getAvatarResult = MOCK_AVATAR;
    resetAnomalyError = new Error('DynamoDB error');
    const ctx = makeCtx({
      method: 'POST',
      path: '/avatars/avatar-1/anomaly/reset',
      effectiveIsAdmin: true,
    });
    const result = await handleSafetyRoutes(ctx);
    expect(result!.statusCode).toBe(500);
    const body = parseBody(result!) as Record<string, unknown>;
    expect(body.error).toBe('Failed to reset anomaly state');
  });

  it('returns null for non-matching routes', async () => {
    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars/avatar-1/anomaly/reset',
      effectiveIsAdmin: true,
    });
    const result = await handleSafetyRoutes(ctx);
    expect(result).toBeNull();
  });
});
