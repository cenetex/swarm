/**
 * Tests for /avatars/{id}/tools and /avatars/{id}/operating-principles-override endpoints
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleToolsRoutes } from './tools.js';
import type { RouteContext } from './types.js';
import * as avatarService from '../../services/avatars.js';
import * as auditLogService from '../../services/audit-log.js';

vi.mock('../../services/avatars.js');
vi.mock('../../services/audit-log.js');
vi.mock('../../services/mcp-adapter.js');

const mockAvatarService = vi.mocked(avatarService);
const mockAuditLogService = vi.mocked(auditLogService);

function buildContext(overrides?: Partial<RouteContext>): RouteContext {
  return {
    method: 'GET',
    path: '/avatars/test-avatar/tools',
    corsHeaders: { 'Access-Control-Allow-Origin': '*' },
    session: { email: 'test@example.com', userId: 'user-1', isAdmin: true, accessToken: 'tok' },
    event: {
      requestContext: { http: { method: 'GET' } },
      headers: {},
      body: null,
    } as any,
    walletAddress: null,
    accountId: undefined,
    effectiveIsAdmin: true,
    ...overrides,
  };
}

describe('Tools Routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /avatars/{id}/tools', () => {
    it('returns 404 when avatar not found', async () => {
      mockAvatarService.getAvatar.mockResolvedValue(null);

      const ctx = buildContext({ path: '/avatars/nonexistent/tools' });
      const result = await handleToolsRoutes(ctx);

      expect(result?.statusCode).toBe(404);
    });

    it('returns tool list with enabled state from platform', async () => {
      mockAvatarService.getAvatar.mockResolvedValue({
        avatarId: 'test-avatar',
        name: 'Test',
        platforms: { twitter: { enabled: true } },
      } as any);

      const ctx = buildContext({ path: '/avatars/test-avatar/tools' });
      const result = await handleToolsRoutes(ctx);

      expect(result?.statusCode).toBe(200);
      const body = JSON.parse(result?.body || '{}');
      expect(body.available).toBeDefined();
      expect(Array.isArray(body.available)).toBe(true);
    });

    it('includes source information for each tool', async () => {
      mockAvatarService.getAvatar.mockResolvedValue({
        avatarId: 'test-avatar',
        name: 'Test',
        platforms: {},
      } as any);

      const ctx = buildContext({ path: '/avatars/test-avatar/tools' });
      const result = await handleToolsRoutes(ctx);

      expect(result?.statusCode).toBe(200);
      const body = JSON.parse(result?.body || '{}');
      expect(body.state).toBeDefined();
      expect(Array.isArray(body.state)).toBe(true);
      if (body.state.length > 0) {
        expect(body.state[0]).toHaveProperty('source');
        expect(['platform', 'preference', 'core']).toContain(body.state[0].source);
      }
    });
  });

  describe('PATCH /avatars/{id}/tools', () => {
    it('returns 400 when trying to disable a core tool', async () => {
      mockAvatarService.getAvatar.mockResolvedValue({
        avatarId: 'test-avatar',
        name: 'Test',
      } as any);

      const ctx = buildContext({
        method: 'PATCH',
        path: '/avatars/test-avatar/tools',
        event: {
          body: JSON.stringify({ disable: ['request_secret'] }),
        } as any,
      });

      const result = await handleToolsRoutes(ctx);

      expect(result?.statusCode).toBe(400);
      const body = JSON.parse(result?.body || '{}');
      expect(body.error).toContain('Cannot disable core tools');
    });

    it('updates tool preferences without error', async () => {
      mockAvatarService.getAvatar.mockResolvedValue({
        avatarId: 'test-avatar',
        name: 'Test',
      } as any);

      mockAvatarService.updateAvatar.mockResolvedValue({
        avatarId: 'test-avatar',
        toolPreferences: { disabled: ['twitter_post'] },
      } as any);

      const ctx = buildContext({
        method: 'PATCH',
        path: '/avatars/test-avatar/tools',
        event: {
          body: JSON.stringify({ disable: ['twitter_post'] }),
        } as any,
      });

      const result = await handleToolsRoutes(ctx);

      expect(result?.statusCode).toBe(200);
      expect(mockAvatarService.updateAvatar).toHaveBeenCalled();
      expect(mockAuditLogService.recordAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          avatarId: 'test-avatar',
          eventType: 'tools_updated',
        })
      );
    });

    it('records audit event on tool preference change', async () => {
      mockAvatarService.getAvatar.mockResolvedValue({
        avatarId: 'test-avatar',
        toolPreferences: { disabled: ['twitter_post'] },
      } as any);

      mockAvatarService.updateAvatar.mockResolvedValue({
        avatarId: 'test-avatar',
        toolPreferences: { disabled: ['twitter_post', 'twitter_reply'] },
      } as any);

      const ctx = buildContext({
        method: 'PATCH',
        path: '/avatars/test-avatar/tools',
        event: {
          body: JSON.stringify({ disable: ['twitter_post', 'twitter_reply'] }),
        } as any,
      });

      await handleToolsRoutes(ctx);

      expect(mockAuditLogService.recordAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'tools_updated',
          details: expect.objectContaining({
            disabledTools: ['twitter_post', 'twitter_reply'],
          }),
        })
      );
    });
  });

  describe('PUT /avatars/{id}/operating-principles-override', () => {
    it('returns 400 when kind is missing', async () => {
      mockAvatarService.getAvatar.mockResolvedValue({
        avatarId: 'test-avatar',
      } as any);

      const ctx = buildContext({
        method: 'PUT',
        path: '/avatars/test-avatar/operating-principles-override',
        event: {
          body: JSON.stringify({ text: 'Some principles' }),
        } as any,
      });

      const result = await handleToolsRoutes(ctx);

      expect(result?.statusCode).toBe(400);
    });

    it('returns 400 when inline without text', async () => {
      mockAvatarService.getAvatar.mockResolvedValue({
        avatarId: 'test-avatar',
      } as any);

      const ctx = buildContext({
        method: 'PUT',
        path: '/avatars/test-avatar/operating-principles-override',
        event: {
          body: JSON.stringify({ kind: 'inline' }),
        } as any,
      });

      const result = await handleToolsRoutes(ctx);

      expect(result?.statusCode).toBe(400);
    });

    it('returns 400 when url without url field', async () => {
      mockAvatarService.getAvatar.mockResolvedValue({
        avatarId: 'test-avatar',
      } as any);

      const ctx = buildContext({
        method: 'PUT',
        path: '/avatars/test-avatar/operating-principles-override',
        event: {
          body: JSON.stringify({ kind: 'url' }),
        } as any,
      });

      const result = await handleToolsRoutes(ctx);

      expect(result?.statusCode).toBe(400);
    });

    it('sets inline override successfully', async () => {
      mockAvatarService.getAvatar.mockResolvedValue({
        avatarId: 'test-avatar',
      } as any);

      mockAvatarService.updateAvatar.mockResolvedValue({
        avatarId: 'test-avatar',
        operatingPrinciplesOverride: { kind: 'inline', text: 'New principles' },
      } as any);

      const ctx = buildContext({
        method: 'PUT',
        path: '/avatars/test-avatar/operating-principles-override',
        event: {
          body: JSON.stringify({ kind: 'inline', text: 'New principles' }),
        } as any,
      });

      const result = await handleToolsRoutes(ctx);

      expect(result?.statusCode).toBe(200);
      expect(mockAvatarService.updateAvatar).toHaveBeenCalledWith(
        'test-avatar',
        expect.objectContaining({
          operatingPrinciplesOverride: expect.objectContaining({
            kind: 'inline',
            text: 'New principles',
          }),
        }),
        expect.anything()
      );
    });

    it('sets URL override with cache TTL', async () => {
      mockAvatarService.getAvatar.mockResolvedValue({
        avatarId: 'test-avatar',
      } as any);

      mockAvatarService.updateAvatar.mockResolvedValue({
        avatarId: 'test-avatar',
        operatingPrinciplesOverride: {
          kind: 'url',
          url: 'https://example.com/principles',
          cacheTtlSec: 600,
        },
      } as any);

      const ctx = buildContext({
        method: 'PUT',
        path: '/avatars/test-avatar/operating-principles-override',
        event: {
          body: JSON.stringify({
            kind: 'url',
            url: 'https://example.com/principles',
            cacheTtlSec: 600,
          }),
        } as any,
      });

      const result = await handleToolsRoutes(ctx);

      expect(result?.statusCode).toBe(200);
      expect(mockAvatarService.updateAvatar).toHaveBeenCalledWith(
        'test-avatar',
        expect.objectContaining({
          operatingPrinciplesOverride: expect.objectContaining({
            kind: 'url',
            url: 'https://example.com/principles',
            cacheTtlSec: 600,
          }),
        }),
        expect.anything()
      );
    });

    it('records audit event for override update', async () => {
      mockAvatarService.getAvatar.mockResolvedValue({
        avatarId: 'test-avatar',
        operatingPrinciplesOverride: { kind: 'inline', text: 'Old' },
      } as any);

      mockAvatarService.updateAvatar.mockResolvedValue({
        avatarId: 'test-avatar',
        operatingPrinciplesOverride: { kind: 'inline', text: 'New' },
      } as any);

      const ctx = buildContext({
        method: 'PUT',
        path: '/avatars/test-avatar/operating-principles-override',
        event: {
          body: JSON.stringify({ kind: 'inline', text: 'New' }),
        } as any,
      });

      await handleToolsRoutes(ctx);

      expect(mockAuditLogService.recordAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'operating_principles_override_updated',
        })
      );
    });
  });

  describe('DELETE /avatars/{id}/operating-principles-override', () => {
    it('returns 404 when no override set', async () => {
      mockAvatarService.getAvatar.mockResolvedValue({
        avatarId: 'test-avatar',
      } as any);

      const ctx = buildContext({
        method: 'DELETE',
        path: '/avatars/test-avatar/operating-principles-override',
      });

      const result = await handleToolsRoutes(ctx);

      expect(result?.statusCode).toBe(404);
    });

    it('deletes override successfully', async () => {
      mockAvatarService.getAvatar.mockResolvedValue({
        avatarId: 'test-avatar',
        operatingPrinciplesOverride: { kind: 'inline', text: 'Principles' },
      } as any);

      mockAvatarService.updateAvatar.mockResolvedValue({
        avatarId: 'test-avatar',
      } as any);

      const ctx = buildContext({
        method: 'DELETE',
        path: '/avatars/test-avatar/operating-principles-override',
      });

      const result = await handleToolsRoutes(ctx);

      expect(result?.statusCode).toBe(204);
      expect(mockAvatarService.updateAvatar).toHaveBeenCalledWith(
        'test-avatar',
        expect.objectContaining({
          operatingPrinciplesOverride: undefined,
        }),
        expect.anything()
      );
    });

    it('records audit event on delete', async () => {
      mockAvatarService.getAvatar.mockResolvedValue({
        avatarId: 'test-avatar',
        operatingPrinciplesOverride: { kind: 'inline', text: 'Principles' },
      } as any);

      mockAvatarService.updateAvatar.mockResolvedValue({
        avatarId: 'test-avatar',
      } as any);

      const ctx = buildContext({
        method: 'DELETE',
        path: '/avatars/test-avatar/operating-principles-override',
      });

      await handleToolsRoutes(ctx);

      expect(mockAuditLogService.recordAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'operating_principles_override_deleted',
        })
      );
    });
  });

  describe('Authorization', () => {
    it('requires admin or owner access to GET tools', async () => {
      mockAvatarService.getAvatar.mockResolvedValue({
        avatarId: 'test-avatar',
        creatorWallet: '0xOther',
      } as any);

      const ctx = buildContext({
        path: '/avatars/test-avatar/tools',
        effectiveIsAdmin: false,
        walletAddress: '0xMe',
      });

      const result = await handleToolsRoutes(ctx);

      expect(result?.statusCode).toBe(403);
    });

    it('allows admin access regardless of ownership', async () => {
      mockAvatarService.getAvatar.mockResolvedValue({
        avatarId: 'test-avatar',
        creatorWallet: '0xOther',
        platforms: {},
      } as any);

      const ctx = buildContext({
        path: '/avatars/test-avatar/tools',
        effectiveIsAdmin: true,
        walletAddress: '0xMe',
      });

      const result = await handleToolsRoutes(ctx);

      expect(result?.statusCode).toBe(200);
    });
  });
});
