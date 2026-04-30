/**
 * Avatar Safety Routes Tests
 * Tests for anomaly reset endpoint
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleSafetyRoutes } from './safety.js';
import * as avatarService from '../../services/avatars.js';
import type { RouteContext } from './types.js';

vi.mock('../../services/avatars.js');

const mockAvatarService = vi.mocked(avatarService);

function makeContext(overrides?: Partial<RouteContext>): RouteContext {
  return {
    event: {
      requestContext: { http: { method: 'POST' } },
      body: '{}',
    } as any,
    method: 'POST',
    path: '/avatars/test-avatar/anomaly/reset',
    corsHeaders: {},
    session: { email: 'test@example.com', aud: '' },
    walletAddress: null,
    accountId: undefined,
    effectiveIsAdmin: true,
    ...overrides,
  };
}

describe('Safety Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /avatars/{id}/anomaly/reset', () => {
    it('should return 404 for non-matching paths', async () => {
      const ctx = makeContext({ path: '/avatars/avatar1/someother/path' });
      const result = await handleSafetyRoutes(ctx);
      expect(result).toBeNull();
    });

    it('should require owner or admin access', async () => {
      mockAvatarService.getAvatar.mockResolvedValue(null);

      const ctx = makeContext({
        effectiveIsAdmin: false,
        walletAddress: null,
        session: { email: 'user@example.com', aud: '' },
      });

      const result = await handleSafetyRoutes(ctx);

      expect(result?.statusCode).toBe(403 || 404);
    });

    it('should reset anomaly state for avatar', async () => {
      mockAvatarService.getAvatar.mockResolvedValue({
        avatarId: 'test-avatar',
        name: 'Test',
      } as any);

      const ctx = makeContext({
        event: {
          requestContext: { http: { method: 'POST' } },
          body: '{}',
        } as any,
      });

      const result = await handleSafetyRoutes(ctx);

      expect(result?.statusCode).toBe(200);
      const body = JSON.parse(result?.body || '{}');
      expect(body.success).toBe(true);
    });

    it('should support channel-specific reset', async () => {
      mockAvatarService.getAvatar.mockResolvedValue({
        avatarId: 'test-avatar',
        name: 'Test',
      } as any);

      const ctx = makeContext({
        event: {
          requestContext: { http: { method: 'POST' } },
          body: JSON.stringify({ channelId: 'channel123' }),
        } as any,
      });

      const result = await handleSafetyRoutes(ctx);

      expect(result?.statusCode).toBe(200);
      const body = JSON.parse(result?.body || '{}');
      expect(body.channelId).toBe('channel123');
    });

    it('should handle admin reset without owner check', async () => {
      mockAvatarService.getAvatar.mockResolvedValue({
        avatarId: 'test-avatar',
        name: 'Test',
      } as any);

      const ctx = makeContext({
        effectiveIsAdmin: true,
        event: {
          requestContext: { http: { method: 'POST' } },
          body: '{}',
        } as any,
      });

      const result = await handleSafetyRoutes(ctx);

      expect(result?.statusCode).toBe(200);
    });
  });
});
