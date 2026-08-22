/**
 * Shared test helpers for avatar-route domain handler tests.
 *
 * Provides a factory for RouteContext objects and common mock patterns.
 * Import this in each domain test file.
 */
import type { HttpRequest } from "@swarm/core";
import type { RouteContext } from './types.js';

export const DEFAULT_SESSION = {
  email: 'admin@test.com',
  userId: 'user-1',
  isAdmin: true,
  accessToken: 'tok',
};

export const CORS_HEADERS = { 'Access-Control-Allow-Origin': '*' };

export const MOCK_AVATAR = {
  avatarId: 'avatar-1',
  name: 'Test Avatar',
  status: 'draft' as const,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  createdBy: 'admin@test.com',
  creatorWallet: 'wallet-1',
  inhabitantWallet: null as string | null,
  platforms: {} as Record<string, unknown>,
};

/**
 * Build a minimal RouteContext for testing a domain handler directly.
 */
export function makeCtx(overrides: Partial<RouteContext> & {
  method?: string;
  path?: string;
  body?: string;
  queryStringParameters?: Record<string, string>;
} = {}): RouteContext {
  const method = overrides.method ?? 'GET';
  const path = overrides.path ?? '/avatars';

  const event: HttpRequest = {
    version: '2.0',
    routeKey: `${method} ${path}`,
    rawPath: path,
    rawQueryString: '',
    headers: { origin: 'https://test.com' },
    queryStringParameters: overrides.queryStringParameters || undefined,
    requestContext: {
      accountId: '123',
      apiId: 'api',
      domainName: 'api.test.com',
      domainPrefix: 'api',
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-1',
      routeKey: '$default',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: Date.now(),
    },
    isBase64Encoded: false,
    body: overrides.body ?? undefined,
  } as unknown as HttpRequest;

  return {
    event: overrides.event ?? event,
    method,
    path,
    corsHeaders: overrides.corsHeaders ?? CORS_HEADERS,
    session: overrides.session ?? DEFAULT_SESSION,
    walletAddress: overrides.walletAddress ?? null,
    accountId: overrides.accountId ?? undefined,
    effectiveIsAdmin: overrides.effectiveIsAdmin ?? true,
    assertAvatarOwnership: overrides.assertAvatarOwnership,
  };
}

export function parseBody(result: { body?: string }): unknown {
  return result.body ? JSON.parse(result.body) : undefined;
}
