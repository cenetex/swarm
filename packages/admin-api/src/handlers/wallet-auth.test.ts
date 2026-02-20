/**
 * Wallet Auth Handler Tests
 *
 * Coverage for:
 * - /auth/me session reporting
 * - /auth/link/wallet/challenge auth boundary + input validation
 * - /auth/link/wallet/verify auth boundary + input validation
 * - Routing (OPTIONS preflight, 404)
 *
 * Note: wallet-link business logic (challenge creation, signature verify,
 * conflict detection) is covered in wallet-link.test.ts at the service level.
 * These handler tests deliberately exercise only the HTTP/auth layer to
 * avoid vi.mock of wallet-link.js which is process-global in bun and would
 * leak into the service tests.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

const mockGetSessionWithUser = vi.fn();
const mockGetGateStatus = vi.fn();
const mockGetAccountGateStatus = vi.fn();
const mockGetOrCreateAccountForWallet = vi.fn();
const mockGetAccountSummary = vi.fn();

const { handleWalletAuth } = await import('./wallet-auth.js');

const prevSessionCookieName = process.env.SESSION_COOKIE_NAME;
process.env.SESSION_COOKIE_NAME = 'swarm_session';

// -------------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------------

function createEvent(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: '/auth/me',
    rawQueryString: '',
    headers: {
      origin: 'http://localhost:5173',
    },
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-id',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: {
        method: 'GET',
        path: '/auth/me',
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
    cookies: ['swarm_session=test-session-token'],
    ...overrides,
  } as APIGatewayProxyEventV2;
}

function linkChallengeEvent(body: object, cookieOverride?: string[]): APIGatewayProxyEventV2 {
  const event = createEvent({
    rawPath: '/auth/link/wallet/challenge',
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-id',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: {
        method: 'POST',
        path: '/auth/link/wallet/challenge',
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
    body: JSON.stringify(body),
  });
  if (cookieOverride !== undefined) {
    event.cookies = cookieOverride;
  }
  return event;
}

function linkVerifyEvent(body: object, cookieOverride?: string[]): APIGatewayProxyEventV2 {
  const event = createEvent({
    rawPath: '/auth/link/wallet/verify',
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-id',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: {
        method: 'POST',
        path: '/auth/link/wallet/verify',
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
    body: JSON.stringify(body),
  });
  if (cookieOverride !== undefined) {
    event.cookies = cookieOverride;
  }
  return event;
}

function makeDeps() {
  return {
    walletAuth: { getSessionWithUser: mockGetSessionWithUser as any },
    nftGate: { getGateStatus: mockGetGateStatus as any },
    accountGate: { getAccountGateStatus: mockGetAccountGateStatus as any },
    accounts: {
      getOrCreateAccountForWallet: mockGetOrCreateAccountForWallet as any,
      getAccountSummary: mockGetAccountSummary as any,
    },
  };
}

// Restore for other tests (best-effort)
process.on('exit', () => {
  if (prevSessionCookieName === undefined) {
    delete process.env.SESSION_COOKIE_NAME;
  } else {
    process.env.SESSION_COOKIE_NAME = prevSessionCookieName;
  }
});

// =========================================================================
// Tests
// =========================================================================

describe('Wallet Auth Handler', () => {
  beforeEach(() => {
    mockGetSessionWithUser.mockReset();
    mockGetGateStatus.mockReset();
    mockGetAccountGateStatus.mockReset();
    mockGetOrCreateAccountForWallet.mockReset();
    mockGetAccountSummary.mockReset();
  });

  // -----------------------------------------------------------------------
  // GET /auth/me
  // -----------------------------------------------------------------------

  describe('GET /auth/me', () => {
    it('returns authenticated user details', async () => {
      mockGetSessionWithUser.mockImplementation(async () => ({
        walletAddress: 'wallet-1',
        sessionToken: 'test-session-token',
        user: {
          pk: 'USER#wallet-1',
          sk: 'PROFILE',
          walletAddress: 'wallet-1',
          displayName: 'Tester',
          avatarUrl: 'https://example.com/u.png',
          createdAt: 1,
          lastSeenAt: 1,
          sessionCount: 1,
        },
      }));

      mockGetGateStatus.mockImplementation(async () => ({
        nftsHeld: 0,
        avatarsCreated: 0,
        availableSlots: 0,
        canCreate: false,
        canAbandon: false,
      }));

      const res = (await handleWalletAuth(createEvent(), {
        walletAuth: { getSessionWithUser: mockGetSessionWithUser as any },
        nftGate: { getGateStatus: mockGetGateStatus as any },
      })) as any;

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body as string);

      expect(body.authenticated).toBe(true);
      expect(body.user.walletAddress).toBe('wallet-1');
      expect(body.user.displayName).toBe('Tester');
      expect(body.user.avatarUrl).toBe('https://example.com/u.png');
    });

    it('omits optional profile fields when unavailable', async () => {
      mockGetSessionWithUser.mockImplementation(async () => ({
        walletAddress: 'wallet-1',
        sessionToken: 'test-session-token',
        user: {
          pk: 'USER#wallet-1',
          sk: 'PROFILE',
          walletAddress: 'wallet-1',
          displayName: 'Tester',
          createdAt: 1,
          lastSeenAt: 1,
          sessionCount: 1,
        },
      }));

      mockGetGateStatus.mockImplementation(async () => ({
        nftsHeld: 0,
        avatarsCreated: 0,
        availableSlots: 0,
        canCreate: false,
        canAbandon: false,
      }));

      const res = (await handleWalletAuth(createEvent(), {
        walletAuth: { getSessionWithUser: mockGetSessionWithUser as any },
        nftGate: { getGateStatus: mockGetGateStatus as any },
      })) as any;

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body as string);

      expect(body.authenticated).toBe(true);
      expect(body.user.displayName).toBe('Tester');
      expect(body.user.avatarUrl).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // POST /auth/link/wallet/challenge — auth boundary + validation
  // -----------------------------------------------------------------------

  describe('POST /auth/link/wallet/challenge', () => {
    it('returns 401 when not authenticated (no session cookie)', async () => {
      const event = linkChallengeEvent(
        { walletAddress: 'SoLWaLLeTaDdReSS1234567890abcdef12' },
        []  // empty cookies
      );

      const res = await handleWalletAuth(event, makeDeps()) as any;
      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Not authenticated');
    });

    it('returns 401 when session has expired', async () => {
      mockGetSessionWithUser.mockImplementation(async () => null);

      const event = linkChallengeEvent({ walletAddress: 'SoLWaLLeTaDdReSS1234567890abcdef12' });
      const res = await handleWalletAuth(event, makeDeps()) as any;
      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Session expired');
    });

    it('returns 400 for missing walletAddress', async () => {
      mockGetSessionWithUser.mockImplementation(async () => ({
        walletAddress: 'wallet-1',
        sessionToken: 'test-session-token',
        accountId: 'acct-1',
        user: { walletAddress: 'wallet-1' },
      }));
      mockGetOrCreateAccountForWallet.mockImplementation(async () => 'acct-1');

      const event = linkChallengeEvent({});
      const res = await handleWalletAuth(event, makeDeps()) as any;
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Invalid request');
    });

    it('returns 400 for walletAddress that is too short', async () => {
      mockGetSessionWithUser.mockImplementation(async () => ({
        walletAddress: 'wallet-1',
        sessionToken: 'test-session-token',
        accountId: 'acct-1',
        user: { walletAddress: 'wallet-1' },
      }));
      mockGetOrCreateAccountForWallet.mockImplementation(async () => 'acct-1');

      const event = linkChallengeEvent({ walletAddress: 'short' });
      const res = await handleWalletAuth(event, makeDeps()) as any;
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Invalid request');
    });
  });

  // -----------------------------------------------------------------------
  // POST /auth/link/wallet/verify — auth boundary + validation
  // -----------------------------------------------------------------------

  describe('POST /auth/link/wallet/verify', () => {
    it('returns 401 when not authenticated (no session cookie)', async () => {
      const event = linkVerifyEvent(
        {
          walletAddress: 'SoLWaLLeTaDdReSS1234567890abcdef12',
          nonce: 'nonce-abc-123456789012345678901234567890',
          signature: 'QmFzZTU4U2lnbmF0dXJlVGhhdElzQXRMZWFzdDY0Q2hhcnNMb25nRm9yVmFsaWRhdGlvbjEyMzQ1Njc4OQ==',
        },
        []  // empty cookies
      );

      const res = await handleWalletAuth(event, makeDeps()) as any;
      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Not authenticated');
    });

    it('returns 401 when session has expired', async () => {
      mockGetSessionWithUser.mockImplementation(async () => null);

      const event = linkVerifyEvent({
        walletAddress: 'SoLWaLLeTaDdReSS1234567890abcdef12',
        nonce: 'nonce-abc-123456789012345678901234567890',
        signature: 'QmFzZTU4U2lnbmF0dXJlVGhhdElzQXRMZWFzdDY0Q2hhcnNMb25nRm9yVmFsaWRhdGlvbjEyMzQ1Njc4OQ==',
      });
      const res = await handleWalletAuth(event, makeDeps()) as any;
      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Session expired');
    });

    it('returns 400 for missing nonce and signature', async () => {
      mockGetSessionWithUser.mockImplementation(async () => ({
        walletAddress: 'wallet-1',
        sessionToken: 'test-session-token',
        accountId: 'acct-1',
        user: { walletAddress: 'wallet-1' },
      }));
      mockGetOrCreateAccountForWallet.mockImplementation(async () => 'acct-1');

      const event = linkVerifyEvent({
        walletAddress: 'SoLWaLLeTaDdReSS1234567890abcdef12',
        // missing nonce and signature
      });
      const res = await handleWalletAuth(event, makeDeps()) as any;
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBe('Invalid request');
    });

    it('returns 400 for empty nonce', async () => {
      mockGetSessionWithUser.mockImplementation(async () => ({
        walletAddress: 'wallet-1',
        sessionToken: 'test-session-token',
        accountId: 'acct-1',
        user: { walletAddress: 'wallet-1' },
      }));
      mockGetOrCreateAccountForWallet.mockImplementation(async () => 'acct-1');

      const event = linkVerifyEvent({
        walletAddress: 'SoLWaLLeTaDdReSS1234567890abcdef12',
        nonce: '',
        signature: 'QmFzZTU4U2lnbmF0dXJlVGhhdElzQXRMZWFzdDY0Q2hhcnNMb25nRm9yVmFsaWRhdGlvbjEyMzQ1Njc4OQ==',
      });
      const res = await handleWalletAuth(event, makeDeps()) as any;
      expect(res.statusCode).toBe(400);
    });
  });

  // -----------------------------------------------------------------------
  // Routing: OPTIONS preflight and 404
  // -----------------------------------------------------------------------

  describe('routing', () => {
    it('returns 204 on OPTIONS preflight for link wallet challenge', async () => {
      const event = createEvent({
        rawPath: '/auth/link/wallet/challenge',
        requestContext: {
          accountId: '123456789012',
          apiId: 'api-id',
          domainName: 'api.example.com',
          domainPrefix: 'api',
          http: {
            method: 'OPTIONS',
            path: '/auth/link/wallet/challenge',
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
      });

      const res = await handleWalletAuth(event, makeDeps()) as any;
      expect(res.statusCode).toBe(204);
    });

    it('returns 204 on OPTIONS preflight for link wallet verify', async () => {
      const event = createEvent({
        rawPath: '/auth/link/wallet/verify',
        requestContext: {
          accountId: '123456789012',
          apiId: 'api-id',
          domainName: 'api.example.com',
          domainPrefix: 'api',
          http: {
            method: 'OPTIONS',
            path: '/auth/link/wallet/verify',
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
      });

      const res = await handleWalletAuth(event, makeDeps()) as any;
      expect(res.statusCode).toBe(204);
    });

    it('returns 404 for unknown auth route', async () => {
      const event = createEvent({
        rawPath: '/auth/unknown',
        requestContext: {
          accountId: '123456789012',
          apiId: 'api-id',
          domainName: 'api.example.com',
          domainPrefix: 'api',
          http: {
            method: 'POST',
            path: '/auth/unknown',
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
      });

      const res = await handleWalletAuth(event, makeDeps()) as any;
      expect(res.statusCode).toBe(404);
    });
  });
});
