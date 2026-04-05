import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

process.env.INTERNAL_TEST_KEY = 'test-key';
process.env.ENVIRONMENT = 'staging';

vi.mock('../services/auto-issues.js', () => ({
  listIssues: vi.fn(() => Promise.resolve([])),
  updateIssueStatus: vi.fn(() => Promise.resolve()),
  recordError: vi.fn(() => Promise.resolve({ issueId: 'issue-1', isNew: true, occurrenceCount: 1 })),
  getIssue: vi.fn(() => Promise.resolve({ issue: null })),
}));

vi.mock('../auth/request-auth.js', () => ({
  authenticateRequest: vi.fn(() => {
    throw new Error('No authentication token provided');
  }),
  requireAdmin: vi.fn(() => true),
}));

vi.mock('@swarm/core', () => ({
  hasValidInternalTestKey: ({
    headers,
    internalTestKey,
    environment,
  }: {
    headers?: Record<string, string | undefined>;
    internalTestKey?: string;
    environment?: string;
  }) => {
    if (!internalTestKey || environment === 'production') {
      return false;
    }
    const value = Object.entries(headers || {}).find(
      ([name]) => name.toLowerCase() === 'x-internal-test-key'
    )?.[1];
    return value === internalTestKey;
  },
  logger: {
    setContext: vi.fn(() => {}),
    info: vi.fn(() => {}),
    warn: vi.fn(() => {}),
    error: vi.fn(() => {}),
    debug: vi.fn(() => {}),
  },
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

import { handler } from './issues.js';
import * as autoIssues from '../services/auto-issues.js';
import * as requestAuth from '../auth/request-auth.js';

// Get references to the mocked functions (cast instead of vi.mocked for bun compat)
const listIssuesMock = autoIssues.listIssues as unknown as ReturnType<typeof vi.fn>;
const updateIssueStatusMock = autoIssues.updateIssueStatus as unknown as ReturnType<typeof vi.fn>;
const authenticateRequestMock = requestAuth.authenticateRequest as unknown as ReturnType<typeof vi.fn>;

function createEvent(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: '/issues',
    rawQueryString: '',
    headers: {},
    queryStringParameters: {},
    requestContext: {
      accountId: '123456789012',
      apiId: 'api-id',
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: {
        method: 'GET',
        path: '/issues',
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

describe('issues handler auth and parsing hardening', () => {
  beforeEach(() => {
    process.env.ENVIRONMENT = 'staging';
    listIssuesMock.mockClear();
    updateIssueStatusMock.mockClear();
    authenticateRequestMock.mockClear();
  });

  it('accepts internal test key only in non-production (case-insensitive header)', async () => {
    const event = createEvent({
      headers: {
        'X-Internal-Test-Key': 'test-key',
      },
      requestContext: {
        ...createEvent().requestContext,
        http: {
          ...createEvent().requestContext.http,
          method: 'GET',
        },
      },
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(listIssuesMock).toHaveBeenCalled();
    expect(authenticateRequestMock).not.toHaveBeenCalled();
  });

  it('rejects internal test key bypass in production', async () => {
    process.env.ENVIRONMENT = 'production';

    const event = createEvent({
      headers: {
        'x-internal-test-key': 'test-key',
      },
      requestContext: {
        ...createEvent().requestContext,
        http: {
          ...createEvent().requestContext.http,
          method: 'GET',
        },
      },
    });

    const result = await handler(event);

    expect(result.statusCode).toBe(401);
    expect(authenticateRequestMock).toHaveBeenCalled();
  });

  it('returns 400 for malformed JSON on PATCH', async () => {
    const event = createEvent({
      rawPath: '/issues/issue-123',
      body: '{"status":',
      headers: {
        'x-internal-test-key': 'test-key',
      },
      requestContext: {
        ...createEvent().requestContext,
        http: {
          ...createEvent().requestContext.http,
          method: 'PATCH',
          path: '/issues/issue-123',
        },
      },
    });

    const result = await handler(event);
    const body = JSON.parse(result.body as string);

    expect(result.statusCode).toBe(400);
    expect(body.error).toBe('Invalid JSON body');
    expect(updateIssueStatusMock).not.toHaveBeenCalled();
  });
});
