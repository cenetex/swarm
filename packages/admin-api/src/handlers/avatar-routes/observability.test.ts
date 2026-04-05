/**
 * Tests for avatar-routes/observability.ts
 *
 * Routes:
 *   GET   /avatars/{id}/logs
 *   GET   /avatars/{id}/activity
 *   GET   /avatars/{id}/issues
 *   GET   /avatars/{id}/events
 *   GET   /avatars/{id}/events/counts
 *   PATCH /avatars/{id}/events/{eventId}
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock state ─────────────────────────────────────────────────────────────
let getAvatarResult: unknown = null;
let queryLogsResult: unknown = { events: [], logGroups: [] };
let listAvatarLogsResult: unknown = { logs: [], hasMore: false };
let activityResult: unknown = { events: [] };
let issuesResult: unknown[] = [];
let eventsResult: unknown[] = [];
let eventCountsResult: unknown = { total: 0 };
const updateIssueCalls: unknown[][] = [];

vi.mock('../../services/avatars.js', () => ({
  getAvatar: async () => getAvatarResult,
}));

vi.mock('../../services/logs.js', () => ({
  queryAvatarLogs: async () => queryLogsResult,
}));

vi.mock('../../services/avatar-observability.js', () => ({
  listAvatarLogs: async () => listAvatarLogsResult,
  listAvatarEvents: async () => eventsResult,
  getAvatarEventCounts: async () => eventCountsResult,
  updateIssueStatus: async (...args: unknown[]) => { updateIssueCalls.push(args); },
}));

vi.mock('../../services/observability.js', () => ({
  getAvatarActivity: async () => activityResult,
}));

vi.mock('../../services/auto-issues.js', () => ({
  listAvatarIssues: async () => issuesResult,
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

import { handleObservabilityRoutes } from './observability.js';
import { makeCtx, parseBody } from './test-helpers.js';

beforeEach(() => {
  getAvatarResult = null;
  queryLogsResult = { events: [], logGroups: [] };
  listAvatarLogsResult = { logs: [], hasMore: false };
  activityResult = { events: [] };
  issuesResult = [];
  eventsResult = [];
  eventCountsResult = { total: 0 };
  updateIssueCalls.length = 0;
});

describe('GET /avatars/{id}/logs', () => {
  it('returns CloudWatch logs for admin', async () => {
    queryLogsResult = { events: [{ message: 'test' }], logGroups: ['/aws/lambda/test'] };
    const ctx = makeCtx({ method: 'GET', path: '/avatars/avatar-1/logs', effectiveIsAdmin: true });
    const result = await handleObservabilityRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    const body = parseBody(result!) as { source: string };
    expect(body.source).toBe('cloudwatch');
  });

  it('returns DynamoDB logs with fast=true', async () => {
    listAvatarLogsResult = { logs: [{ message: 'fast' }], hasMore: false };
    const ctx = makeCtx({
      method: 'GET',
      path: '/avatars/avatar-1/logs',
      effectiveIsAdmin: true,
      queryStringParameters: { fast: 'true' },
    });
    const result = await handleObservabilityRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    const body = parseBody(result!) as { source: string };
    expect(body.source).toBe('dynamodb');
  });

  it('non-admin gets 403', async () => {
    const ctx = makeCtx({ method: 'GET', path: '/avatars/avatar-1/logs', effectiveIsAdmin: false });
    const result = await handleObservabilityRoutes(ctx);
    expect(result!.statusCode).toBe(403);
  });
});

describe('GET /avatars/{id}/activity', () => {
  it('returns activity for admin', async () => {
    activityResult = { events: [{ type: 'message' }] };
    const ctx = makeCtx({ method: 'GET', path: '/avatars/avatar-1/activity', effectiveIsAdmin: true });
    const result = await handleObservabilityRoutes(ctx);
    expect(result!.statusCode).toBe(200);
  });
});

describe('GET /avatars/{id}/events/counts', () => {
  it('returns event counts for admin', async () => {
    eventCountsResult = { total: 5, issues: 3, feedback: 2 };
    const ctx = makeCtx({ method: 'GET', path: '/avatars/avatar-1/events/counts', effectiveIsAdmin: true });
    const result = await handleObservabilityRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    const body = parseBody(result!) as { total: number };
    expect(body.total).toBe(5);
  });
});

describe('PATCH /avatars/{id}/events/{eventId}', () => {
  it('updates event status', async () => {
    const ctx = makeCtx({
      method: 'PATCH',
      path: '/avatars/avatar-1/events/evt-1',
      body: JSON.stringify({ status: 'resolved' }),
      effectiveIsAdmin: true,
    });
    const result = await handleObservabilityRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    expect(updateIssueCalls).toHaveLength(1);
  });

  it('rejects invalid status', async () => {
    const ctx = makeCtx({
      method: 'PATCH',
      path: '/avatars/avatar-1/events/evt-1',
      body: JSON.stringify({ status: 'invalid' }),
      effectiveIsAdmin: true,
    });
    const result = await handleObservabilityRoutes(ctx);
    expect(result!.statusCode).toBe(400);
  });
});

describe('GET /avatars/{id}/events', () => {
  it('returns events for admin', async () => {
    eventsResult = [{ id: 'e1', type: 'issue' }];
    const ctx = makeCtx({ method: 'GET', path: '/avatars/avatar-1/events', effectiveIsAdmin: true });
    const result = await handleObservabilityRoutes(ctx);
    expect(result!.statusCode).toBe(200);
    const body = parseBody(result!) as { events: unknown[]; count: number };
    expect(body.count).toBe(1);
  });
});

describe('unmatched routes', () => {
  it('returns null', async () => {
    const ctx = makeCtx({ method: 'GET', path: '/unknown' });
    expect(await handleObservabilityRoutes(ctx)).toBeNull();
  });
});
