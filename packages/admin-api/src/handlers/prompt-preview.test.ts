import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// Set ALLOWED_ORIGINS so getCorsHeaders emits CORS headers
process.env.ALLOWED_ORIGINS = 'https://swarm.rati.chat,https://localhost:5173';

vi.mock('../auth/request-auth.js', () => ({
  authenticateRequest: vi.fn(() =>
    Promise.resolve({ email: 'test@test.com', isAdmin: true })
  ),
}));

vi.mock('../services/avatars.js', () => ({
  getAvatar: vi.fn(),
}));

vi.mock('../services/mcp-config.js', () => ({
  getEnabledToolsets: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../services/mcp-adapter.js', () => ({
  createMCPServices: vi.fn(() => ({})),
}));

vi.mock('@swarm/mcp-server', () => ({
  ToolRegistry: vi.fn(() => ({
    getForPlatform: vi.fn(() => []),
  })),
  registerAllTools: vi.fn(),
}));

import { handler } from './prompt-preview.js';
import * as avatars from '../services/avatars.js';
import * as requestAuth from '../auth/request-auth.js';

const getAvatarMock = avatars.getAvatar as unknown as ReturnType<typeof vi.fn>;
const authenticateRequestMock = requestAuth.authenticateRequest as unknown as ReturnType<typeof vi.fn>;

function createEvent(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: '/prompt-preview',
    rawQueryString: '',
    headers: {
      origin: 'https://swarm.rati.chat',
      'content-type': 'application/json',
    },
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-id',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: {
        method: 'POST',
        path: '/prompt-preview',
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
    body: JSON.stringify({ avatarId: 'test-avatar' }),
    isBase64Encoded: false,
    ...overrides,
  } as APIGatewayProxyEventV2;
}

/**
 * Asserts that a response includes the standard CORS headers
 * from getCorsHeaders (origin-based, with Vary and security headers).
 */
function expectCorsHeaders(headers: Record<string, string | number | boolean> | undefined) {
  expect(headers).toBeDefined();
  expect(headers!['Access-Control-Allow-Origin']).toBe('https://swarm.rati.chat');
  expect(headers!['Vary']).toBe('Origin');
  expect(headers!['X-Content-Type-Options']).toBe('nosniff');
}

/**
 * Asserts that a response does NOT contain the invalid wildcard + credentials combo.
 */
function expectNoWildcardCredentialCombo(headers: Record<string, string | number | boolean> | undefined) {
  if (headers?.['Access-Control-Allow-Origin'] === '*') {
    // If origin is wildcard, credentials must not be true
    expect(headers['Access-Control-Allow-Credentials']).not.toBe('true');
  }
}

describe('prompt-preview handler CORS consistency', () => {
  beforeEach(() => {
    getAvatarMock.mockReset();
    authenticateRequestMock.mockReset();
    authenticateRequestMock.mockResolvedValue({ email: 'test@test.com', isAdmin: true });
  });

  it('returns CORS headers on OPTIONS preflight', async () => {
    const event = createEvent({
      requestContext: {
        ...createEvent().requestContext,
        http: {
          ...createEvent().requestContext.http,
          method: 'OPTIONS',
        },
      },
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(204);
    const headers = result.headers as Record<string, string>;
    expectCorsHeaders(headers);
    expectNoWildcardCredentialCombo(headers);
  });

  it('returns CORS headers on successful 200 response', async () => {
    getAvatarMock.mockResolvedValue({
      avatarId: 'test-avatar',
      name: 'Test Avatar',
      description: 'A test avatar',
      persona: 'You are test.',
      platforms: {},
    });

    const result = await handler(createEvent());

    expect(result.statusCode).toBe(200);
    const headers = result.headers as Record<string, string>;
    expectCorsHeaders(headers);
    expectNoWildcardCredentialCombo(headers);
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('returns CORS headers on 404 avatar not found', async () => {
    getAvatarMock.mockResolvedValue(null);

    const result = await handler(createEvent());

    expect(result.statusCode).toBe(404);
    const headers = result.headers as Record<string, string>;
    expectCorsHeaders(headers);
    expectNoWildcardCredentialCombo(headers);
  });

  it('returns CORS headers on auth error', async () => {
    const { AuthError } = await import('../auth/errors.js');
    authenticateRequestMock.mockRejectedValue(
      new AuthError('Unauthorized', 401)
    );

    const result = await handler(createEvent());

    expect(result.statusCode).toBe(401);
    const headers = result.headers as Record<string, string>;
    expectCorsHeaders(headers);
    expectNoWildcardCredentialCombo(headers);
  });

  it('returns CORS headers on validation error (missing body)', async () => {
    const event = createEvent({ body: undefined });

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    const headers = result.headers as Record<string, string>;
    expectCorsHeaders(headers);
    expectNoWildcardCredentialCombo(headers);
  });

  it('returns CORS headers on validation error (malformed JSON)', async () => {
    const event = createEvent({ body: '{invalid json' });

    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    const headers = result.headers as Record<string, string>;
    expectCorsHeaders(headers);
    expectNoWildcardCredentialCombo(headers);
  });

  it('returns CORS headers on 500 internal error', async () => {
    // Make authenticateRequest succeed but getAvatar throw an unexpected error
    getAvatarMock.mockRejectedValue(new Error('DynamoDB timeout'));

    const result = await handler(createEvent());

    expect(result.statusCode).toBe(500);
    const headers = result.headers as Record<string, string>;
    expectCorsHeaders(headers);
    expectNoWildcardCredentialCombo(headers);

    const body = JSON.parse(result.body as string);
    expect(body.error).toBe('Internal server error');
  });

  it('never uses wildcard origin with credentials: true', async () => {
    // Override ALLOWED_ORIGINS to empty to test no-origin-match scenario
    const origOrigins = process.env.ALLOWED_ORIGINS;
    process.env.ALLOWED_ORIGINS = '';

    getAvatarMock.mockResolvedValue({
      avatarId: 'test-avatar',
      name: 'Test Avatar',
      description: 'test',
      persona: 'test',
      platforms: {},
    });

    const result = await handler(createEvent());
    const headers = result.headers as Record<string, string>;

    // When no origins are configured, getCorsHeaders returns {} — no CORS headers at all.
    // This is safe; no wildcard + credentials combo.
    expectNoWildcardCredentialCombo(headers);

    process.env.ALLOWED_ORIGINS = origOrigins;
  });
});
