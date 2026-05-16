/**
 * Twitter OAuth Handler Tests
 *
 * Tests for the OAuth 1.0a handler routes using dependency injection.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { handler, type TwitterOAuthHandlerDeps } from './twitter-oauth.js';
import type { UserSession, AvatarRecord } from '../types.js';

// Helper to create a mock API Gateway event
function createEvent(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: '/oauth/twitter/start',
    rawQueryString: '',
    headers: {},
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-id',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: {
        method: 'GET',
        path: '/oauth/twitter/start',
        protocol: 'HTTP/1.1',
        sourceIp: '127.0.0.1',
        userAgent: 'test',
      },
      requestId: 'request-id',
      routeKey: '$default',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 1704067200000,
    },
    isBase64Encoded: false,
    ...overrides,
  } as APIGatewayProxyEventV2;
}

// Helper to create test session
function createTestSession(overrides: Partial<UserSession> = {}): UserSession {
  return {
    email: 'test@example.com',
    userId: 'user-123',
    isAdmin: true,
    accessToken: 'test-access-token',
    ...overrides,
  };
}

// Helper to create a non-admin session with wallet
// Note: For wallet auth, userId contains the wallet address
function createNonAdminSession(walletAddress: string): UserSession {
  return {
    email: 'user@example.com',
    userId: walletAddress, // userId is the wallet address for wallet-authenticated sessions
    isAdmin: false,
    accessToken: 'test-access-token',
  };
}

// Helper to create a mock avatar record
function createMockAvatar(avatarId: string, overrides: Partial<AvatarRecord> = {}): AvatarRecord {
  return {
    pk: `AVATAR#${avatarId}`,
    sk: 'CONFIG',
    avatarId,
    name: 'Test Avatar',
    status: 'active',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    createdBy: 'test@example.com',
    creatorWallet: 'creator-wallet-123',
    ...overrides,
  };
}

describe('Twitter OAuth Handler', () => {
  let mockDeps: TwitterOAuthHandlerDeps;
  let mockIsConfigured: ReturnType<typeof vi.fn>;
  let mockProbeOAuthStart: ReturnType<typeof vi.fn>;
  let mockStartOAuthFlow: ReturnType<typeof vi.fn>;
  let mockCompleteOAuthFlow: ReturnType<typeof vi.fn>;
  let mockGetConnectionStatus: ReturnType<typeof vi.fn>;
  let mockDisconnectTwitter: ReturnType<typeof vi.fn>;
  let mockGetAvatar: ReturnType<typeof vi.fn>;
  let mockUpdateAvatar: ReturnType<typeof vi.fn>;
  let mockAssertAvatarOwnership: ReturnType<typeof vi.fn>;
  let mockAuthenticateRequest: ReturnType<typeof vi.fn>;
  let mockRequireAdmin: ReturnType<typeof vi.fn>;
  let mockGetWalletAddress: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Create fresh mocks for each test
    mockIsConfigured = vi.fn(() => Promise.resolve(true));
    mockProbeOAuthStart = vi.fn(() => Promise.resolve());
    mockStartOAuthFlow = vi.fn(() =>
      Promise.resolve({
        authorizationUrl: 'https://twitter.com/oauth/authorize?oauth_token=test-token',
        oauthToken: 'test-token',
      })
    );
    mockCompleteOAuthFlow = vi.fn(() =>
      Promise.resolve({
        success: true,
        avatarId: 'test-avatar',
        username: 'testuser',
        userId: '12345',
      })
    );
    mockGetConnectionStatus = vi.fn(() =>
      Promise.resolve({
        connected: true,
        username: 'testuser',
        userId: '12345',
        connectedAt: Date.now(),
      })
    );
    mockDisconnectTwitter = vi.fn(() => Promise.resolve());
    mockGetAvatar = vi.fn(() => Promise.resolve(createMockAvatar('test-avatar')));
    mockUpdateAvatar = vi.fn(() => Promise.resolve(createMockAvatar('test-avatar')));
    mockAssertAvatarOwnership = vi.fn(async (avatarId: string, walletAddress: string) => {
      const avatar = await mockGetAvatar(avatarId);
      if (!avatar || avatar.creatorWallet !== walletAddress) {
        const error = new Error('not owner') as Error & { code: string };
        error.code = 'not_owner';
        throw error;
      }
      return avatar;
    });
    mockAuthenticateRequest = vi.fn(() => Promise.resolve(createTestSession()));
    mockRequireAdmin = vi.fn(() => true);
    mockGetWalletAddress = vi.fn(() => Promise.resolve('admin-wallet-123'));

    mockDeps = {
      twitterOAuth: {
        isConfigured: mockIsConfigured as unknown as TwitterOAuthHandlerDeps['twitterOAuth']['isConfigured'],
        probeOAuthStart: mockProbeOAuthStart as unknown as TwitterOAuthHandlerDeps['twitterOAuth']['probeOAuthStart'],
        startOAuthFlow: mockStartOAuthFlow as unknown as TwitterOAuthHandlerDeps['twitterOAuth']['startOAuthFlow'],
        completeOAuthFlow: mockCompleteOAuthFlow as unknown as TwitterOAuthHandlerDeps['twitterOAuth']['completeOAuthFlow'],
        getConnectionStatus: mockGetConnectionStatus as unknown as TwitterOAuthHandlerDeps['twitterOAuth']['getConnectionStatus'],
        disconnectTwitter: mockDisconnectTwitter as unknown as TwitterOAuthHandlerDeps['twitterOAuth']['disconnectTwitter'],
      },
      avatarService: {
        getAvatar: mockGetAvatar as unknown as TwitterOAuthHandlerDeps['avatarService']['getAvatar'],
        updateAvatar: mockUpdateAvatar as unknown as TwitterOAuthHandlerDeps['avatarService']['updateAvatar'],
        assertAvatarOwnership: mockAssertAvatarOwnership as unknown as TwitterOAuthHandlerDeps['avatarService']['assertAvatarOwnership'],
      },
      auth: {
        authenticateRequest: mockAuthenticateRequest as unknown as TwitterOAuthHandlerDeps['auth']['authenticateRequest'],
        requireAdmin: mockRequireAdmin as unknown as TwitterOAuthHandlerDeps['auth']['requireAdmin'],
        getWalletAddress: mockGetWalletAddress as unknown as TwitterOAuthHandlerDeps['auth']['getWalletAddress'],
      },
    };
  });

  describe('OPTIONS - CORS preflight', () => {
    it('returns 204 for OPTIONS requests', async () => {
      const event = createEvent({
        requestContext: {
          ...createEvent().requestContext,
          http: { ...createEvent().requestContext.http, method: 'OPTIONS' },
        },
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(204);
    });
  });

  describe('GET /oauth/twitter/start', () => {
    it('returns 400 when avatarId is missing', async () => {
      const event = createEvent({
        rawPath: '/oauth/twitter/start',
        queryStringParameters: {},
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(400);
      const body = JSON.parse(result.body as string);
      expect(body.error).toContain('avatarId');
    });

    it('returns 404 when avatar does not exist', async () => {
      mockGetAvatar.mockImplementation(() => Promise.resolve(null));

      const event = createEvent({
        rawPath: '/oauth/twitter/start',
        queryStringParameters: { avatarId: 'nonexistent' },
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(404);
      const body = JSON.parse(result.body as string);
      expect(body.error).toBe('Avatar not found');
    });

    it('returns 503 when Twitter OAuth is not configured', async () => {
      mockIsConfigured.mockImplementation(() => Promise.resolve(false));

      const event = createEvent({
        rawPath: '/oauth/twitter/start',
        queryStringParameters: { avatarId: 'test-avatar' },
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(503);
      const body = JSON.parse(result.body as string);
      expect(body.error).toBe('Twitter OAuth not configured');
    });

    it('returns authorization URL on success', async () => {
      const event = createEvent({
        rawPath: '/oauth/twitter/start',
        queryStringParameters: { avatarId: 'test-avatar' },
      });

      const result = await handler(event, mockDeps);

      // Returns 302 redirect to Twitter OAuth
      expect(result.statusCode).toBe(302);
      expect(result.headers?.Location).toContain('twitter.com');
      expect(mockStartOAuthFlow).toHaveBeenCalledWith('test-avatar');
      expect(mockAuthenticateRequest).toHaveBeenCalled();
    });

    it('supports /api prefix (CloudFront) for start route', async () => {
      const event = createEvent({
        rawPath: '/api/oauth/twitter/start',
        queryStringParameters: { avatarId: 'test-avatar' },
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(302);
      expect(result.headers?.Location).toContain('twitter.com');
      expect(mockStartOAuthFlow).toHaveBeenCalledWith('test-avatar');
      expect(mockAuthenticateRequest).toHaveBeenCalled();
    });

    it('returns 503 with message when Twitter rejects request token (e.g., 403)', async () => {
      mockStartOAuthFlow.mockImplementation(() => {
        throw new Error('Request failed with code 403');
      });

      const event = createEvent({
        rawPath: '/api/oauth/twitter/start',
        queryStringParameters: { avatarId: 'test-avatar' },
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(503);
      const body = JSON.parse(result.body as string);
      expect(body.error).toBe('Twitter OAuth start failed');
      expect(String(body.message)).toContain('403');
    });

    it('allows avatar creator (non-admin) to start OAuth', async () => {
      const creatorWallet = 'creator-wallet-abc';
      mockAuthenticateRequest.mockImplementation(() => Promise.resolve(createNonAdminSession(creatorWallet)));
      mockRequireAdmin.mockImplementation(() => false);
      mockGetWalletAddress.mockImplementation(() => Promise.resolve(creatorWallet));
      mockGetAvatar.mockImplementation(() => Promise.resolve(createMockAvatar('test-avatar', { creatorWallet })));

      const event = createEvent({
        rawPath: '/oauth/twitter/start',
        queryStringParameters: { avatarId: 'test-avatar' },
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(302);
      expect(result.headers?.Location).toContain('twitter.com');
    });

    it('returns 403 for non-creator wallet (non-admin)', async () => {
      const inhabitantWallet = 'inhabitant-wallet-xyz';
      mockAuthenticateRequest.mockImplementation(() => Promise.resolve(createNonAdminSession(inhabitantWallet)));
      mockRequireAdmin.mockImplementation(() => false);
      mockGetWalletAddress.mockImplementation(() => Promise.resolve(inhabitantWallet));
      mockGetAvatar.mockImplementation(() => Promise.resolve(createMockAvatar('test-avatar', { inhabitantWallet })));

      const event = createEvent({
        rawPath: '/oauth/twitter/start',
        queryStringParameters: { avatarId: 'test-avatar' },
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(403);
    });

    it('returns 403 when non-owner tries to start OAuth', async () => {
      mockAuthenticateRequest.mockImplementation(() => Promise.resolve(createNonAdminSession('other-wallet')));
      mockRequireAdmin.mockImplementation(() => false);
      mockGetWalletAddress.mockImplementation(() => Promise.resolve('other-wallet'));
      mockGetAvatar.mockImplementation(() => Promise.resolve(createMockAvatar('test-avatar', {
        creatorWallet: 'creator-wallet',
        inhabitantWallet: 'inhabitant-wallet',
      })));

      const event = createEvent({
        rawPath: '/oauth/twitter/start',
        queryStringParameters: { avatarId: 'test-avatar' },
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(403);
      const body = JSON.parse(result.body as string);
      expect(body.error).toContain('avatar owner');
    });
  });

  describe('GET /oauth/twitter/callback', () => {
    it('redirects with error when user denies authorization', async () => {
      const event = createEvent({
        rawPath: '/oauth/twitter/callback',
        queryStringParameters: { denied: 'true' },
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(302);
      expect(result.headers?.Location).toContain('twitter_error=denied');
    });

    it('redirects with error when oauth params missing', async () => {
      const event = createEvent({
        rawPath: '/oauth/twitter/callback',
        queryStringParameters: {},
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(302);
      expect(result.headers?.Location).toContain('twitter_error=missing_params');
    });

    it('completes OAuth flow and redirects on success', async () => {
      const event = createEvent({
        rawPath: '/oauth/twitter/callback',
        queryStringParameters: {
          oauth_token: 'test-token',
          oauth_verifier: 'test-verifier',
        },
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(302);
      expect(result.headers?.Location).toContain('twitter_connected=testuser');
      expect(mockCompleteOAuthFlow).toHaveBeenCalledWith(
        'test-token',
        'test-verifier',
        expect.objectContaining({ email: 'oauth-callback@system' })
      );
    });

    it('supports /api prefix (CloudFront) for callback without requiring auth', async () => {
      const event = createEvent({
        rawPath: '/api/oauth/twitter/callback',
        queryStringParameters: {
          oauth_token: 'test-token',
          oauth_verifier: 'test-verifier',
        },
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(302);
      expect(result.headers?.Location).toContain('twitter_connected=testuser');
      expect(mockAuthenticateRequest).not.toHaveBeenCalled();
    });

    it('updates avatar config after successful OAuth', async () => {
      const event = createEvent({
        rawPath: '/oauth/twitter/callback',
        queryStringParameters: {
          oauth_token: 'test-token',
          oauth_verifier: 'test-verifier',
        },
      });

      await handler(event, mockDeps);

      expect(mockUpdateAvatar).toHaveBeenCalledWith(
        'test-avatar',
        expect.objectContaining({
          platforms: {
            twitter: {
              enabled: true,
              username: 'testuser',
            },
          },
        }),
        expect.any(Object)
      );
    });

    it('redirects with error when OAuth completion fails', async () => {
      mockCompleteOAuthFlow.mockImplementation(() =>
        Promise.resolve({
          success: false,
          avatarId: 'test-avatar',
          error: 'Token expired',
        })
      );

      const event = createEvent({
        rawPath: '/oauth/twitter/callback',
        queryStringParameters: {
          oauth_token: 'expired-token',
          oauth_verifier: 'verifier',
        },
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(302);
      expect(result.headers?.Location).toContain('twitter_error=Token');
    });
  });

  describe('GET /oauth/twitter/health', () => {
    it('requires authentication', async () => {
      const event = createEvent({
        rawPath: '/oauth/twitter/health',
      });

      const result = await handler(event, mockDeps);

      expect(mockAuthenticateRequest).toHaveBeenCalled();
      expect(result.statusCode).toBe(200);
    });

    it('returns 503 when not configured', async () => {
      mockIsConfigured.mockImplementation(() => Promise.resolve(false));

      const event = createEvent({
        rawPath: '/oauth/twitter/health',
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(503);
      const body = JSON.parse(result.body as string);
      expect(body.configured).toBe(false);
      expect(body.ok).toBe(false);
    });

    it('returns 200 when configured (no live probe)', async () => {
      const event = createEvent({
        rawPath: '/oauth/twitter/health',
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body as string);
      expect(body.configured).toBe(true);
      expect(body.live).toBe(false);
      expect(body.ok).toBe(true);
      expect(mockProbeOAuthStart).not.toHaveBeenCalled();
    });

    it('returns 200 when live probe succeeds', async () => {
      const event = createEvent({
        rawPath: '/oauth/twitter/health',
        queryStringParameters: { live: '1' },
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body as string);
      expect(body.ok).toBe(true);
      expect(body.probeOk).toBe(true);
      expect(mockProbeOAuthStart).toHaveBeenCalled();
    });

    it('returns 503 when live probe fails', async () => {
      mockProbeOAuthStart.mockImplementation(() => Promise.reject(new Error('Request failed with code 403')));

      const event = createEvent({
        rawPath: '/oauth/twitter/health',
        queryStringParameters: { live: 'true' },
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(503);
      const body = JSON.parse(result.body as string);
      expect(body.ok).toBe(false);
      expect(String(body.probeError)).toContain('403');
    });

    it('supports /api prefix (CloudFront)', async () => {
      const event = createEvent({
        rawPath: '/api/oauth/twitter/health',
        queryStringParameters: { live: '1' },
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(200);
      expect(mockProbeOAuthStart).toHaveBeenCalled();
    });
  });

  describe('GET /oauth/twitter/status/{avatarId}', () => {
    it('requires authentication', async () => {
      mockRequireAdmin.mockImplementation(() => false);

      const event = createEvent({
        rawPath: '/oauth/twitter/status/test-avatar',
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(403);
    });

    it('returns connection status', async () => {
      const event = createEvent({
        rawPath: '/oauth/twitter/status/test-avatar',
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body as string);
      expect(body.connected).toBe(true);
      expect(body.username).toBe('testuser');
      expect(mockGetConnectionStatus).toHaveBeenCalledWith('test-avatar');
    });

    it('returns not connected status', async () => {
      mockGetConnectionStatus.mockImplementation(() =>
        Promise.resolve({ connected: false })
      );

      const event = createEvent({
        rawPath: '/oauth/twitter/status/disconnected-avatar',
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body as string);
      expect(body.connected).toBe(false);
    });

    it('allows avatar creator (non-admin) to view status', async () => {
      const creatorWallet = 'creator-wallet-abc';
      mockAuthenticateRequest.mockImplementation(() => Promise.resolve(createNonAdminSession(creatorWallet)));
      mockRequireAdmin.mockImplementation(() => false);
      mockGetWalletAddress.mockImplementation(() => Promise.resolve(creatorWallet));
      mockGetAvatar.mockImplementation(() => Promise.resolve(createMockAvatar('test-avatar', { creatorWallet })));

      const event = createEvent({
        rawPath: '/oauth/twitter/status/test-avatar',
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body as string);
      expect(body.connected).toBe(true);
    });

    it('returns 403 when non-owner tries to view status', async () => {
      mockAuthenticateRequest.mockImplementation(() => Promise.resolve(createNonAdminSession('other-wallet')));
      mockRequireAdmin.mockImplementation(() => false);
      mockGetWalletAddress.mockImplementation(() => Promise.resolve('other-wallet'));
      mockGetAvatar.mockImplementation(() => Promise.resolve(createMockAvatar('test-avatar', {
        creatorWallet: 'creator-wallet',
        inhabitantWallet: 'inhabitant-wallet',
      })));

      const event = createEvent({
        rawPath: '/oauth/twitter/status/test-avatar',
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(403);
      const body = JSON.parse(result.body as string);
      expect(body.error).toContain('avatar owner');
    });

    it('returns 404 when avatar not found for status', async () => {
      mockGetAvatar.mockImplementation(() => Promise.resolve(null));

      const event = createEvent({
        rawPath: '/oauth/twitter/status/nonexistent',
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(404);
      const body = JSON.parse(result.body as string);
      expect(body.error).toBe('Avatar not found');
    });
  });

  describe('DELETE /oauth/twitter/{avatarId}', () => {
    it('requires authentication', async () => {
      mockRequireAdmin.mockImplementation(() => false);

      const event = createEvent({
        rawPath: '/oauth/twitter/test-avatar',
        requestContext: {
          ...createEvent().requestContext,
          http: { ...createEvent().requestContext.http, method: 'DELETE' },
        },
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(403);
    });

    it('disconnects Twitter and updates avatar', async () => {
      const event = createEvent({
        rawPath: '/oauth/twitter/test-avatar',
        requestContext: {
          ...createEvent().requestContext,
          http: { ...createEvent().requestContext.http, method: 'DELETE' },
        },
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body as string);
      expect(body.success).toBe(true);
      expect(mockDisconnectTwitter).toHaveBeenCalled();
      expect(mockUpdateAvatar).toHaveBeenCalledWith(
        'test-avatar',
        expect.objectContaining({
          platforms: {
            twitter: {
              enabled: false,
              username: undefined,
            },
          },
        }),
        expect.any(Object)
      );
    });

    it('allows avatar creator (non-admin) to disconnect', async () => {
      const creatorWallet = 'creator-wallet-abc';
      mockAuthenticateRequest.mockImplementation(() => Promise.resolve(createNonAdminSession(creatorWallet)));
      mockRequireAdmin.mockImplementation(() => false);
      mockGetWalletAddress.mockImplementation(() => Promise.resolve(creatorWallet));
      mockGetAvatar.mockImplementation(() => Promise.resolve(createMockAvatar('test-avatar', { creatorWallet })));

      const event = createEvent({
        rawPath: '/oauth/twitter/test-avatar',
        requestContext: {
          ...createEvent().requestContext,
          http: { ...createEvent().requestContext.http, method: 'DELETE' },
        },
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(200);
      const body = JSON.parse(result.body as string);
      expect(body.success).toBe(true);
    });

    it('returns 403 when non-owner tries to disconnect', async () => {
      mockAuthenticateRequest.mockImplementation(() => Promise.resolve(createNonAdminSession('other-wallet')));
      mockRequireAdmin.mockImplementation(() => false);
      mockGetWalletAddress.mockImplementation(() => Promise.resolve('other-wallet'));
      mockGetAvatar.mockImplementation(() => Promise.resolve(createMockAvatar('test-avatar', {
        creatorWallet: 'creator-wallet',
        inhabitantWallet: 'inhabitant-wallet',
      })));

      const event = createEvent({
        rawPath: '/oauth/twitter/test-avatar',
        requestContext: {
          ...createEvent().requestContext,
          http: { ...createEvent().requestContext.http, method: 'DELETE' },
        },
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(403);
      const body = JSON.parse(result.body as string);
      expect(body.error).toContain('avatar owner');
    });

    it('returns 404 when avatar not found for disconnect', async () => {
      mockGetAvatar.mockImplementation(() => Promise.resolve(null));

      const event = createEvent({
        rawPath: '/oauth/twitter/nonexistent',
        requestContext: {
          ...createEvent().requestContext,
          http: { ...createEvent().requestContext.http, method: 'DELETE' },
        },
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(404);
      const body = JSON.parse(result.body as string);
      expect(body.error).toBe('Avatar not found');
    });
  });

  describe('Unknown routes', () => {
    it('returns 404 for unknown GET routes', async () => {
      const event = createEvent({
        rawPath: '/oauth/twitter/unknown/route',
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(404);
    });
  });

  describe('Error handling', () => {
    it('returns 500 on unexpected errors', async () => {
      mockAuthenticateRequest.mockImplementation(() => {
        throw new Error('Unexpected error');
      });

      const event = createEvent({
        rawPath: '/oauth/twitter/status/test-avatar',
      });

      const result = await handler(event, mockDeps);

      expect(result.statusCode).toBe(500);
      const body = JSON.parse(result.body as string);
      expect(body.error).toBe('Internal server error');
    });
  });
});
