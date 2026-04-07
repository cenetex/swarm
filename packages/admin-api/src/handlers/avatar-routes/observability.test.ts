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
  createSqsOffloadServiceFromEnv: () => null,
  createCircuitBreaker: () => ({ canExecute: () => true, recordSuccess: () => {}, recordFailure: () => {}, state: () => 'closed' }),
  LLMError: class LLMError extends Error { constructor(message: string) { super(message); this.name = 'LLMError'; } },
  SwarmErrorCode: {
    UNKNOWN: 'UNKNOWN',
    PLATFORM_NOT_INITIALIZED: 'PLATFORM_NOT_INITIALIZED',
    PLATFORM_RATE_LIMITED: 'PLATFORM_RATE_LIMITED',
    PLATFORM_API_ERROR: 'PLATFORM_API_ERROR',
    PLATFORM_WEBHOOK_ERROR: 'PLATFORM_WEBHOOK_ERROR',
    PLATFORM_MEDIA_UPLOAD_ERROR: 'PLATFORM_MEDIA_UPLOAD_ERROR',
    PLATFORM_UNSUPPORTED_MEDIA: 'PLATFORM_UNSUPPORTED_MEDIA',
    LLM_MISSING_API_KEY: 'LLM_MISSING_API_KEY',
    LLM_CIRCUIT_OPEN: 'LLM_CIRCUIT_OPEN',
    LLM_API_ERROR: 'LLM_API_ERROR',
    LLM_EMPTY_RESPONSE: 'LLM_EMPTY_RESPONSE',
    LLM_TIMEOUT: 'LLM_TIMEOUT',
    CONFIG_NOT_FOUND: 'CONFIG_NOT_FOUND',
    CONFIG_VALIDATION_ERROR: 'CONFIG_VALIDATION_ERROR',
    CONFIG_MISSING_SECRET: 'CONFIG_MISSING_SECRET',
    STATE_READ_ERROR: 'STATE_READ_ERROR',
    STATE_WRITE_ERROR: 'STATE_WRITE_ERROR',
    MEDIA_GENERATION_ERROR: 'MEDIA_GENERATION_ERROR',
    MEDIA_FETCH_ERROR: 'MEDIA_FETCH_ERROR',
    MEDIA_LIMIT_REACHED: 'MEDIA_LIMIT_REACHED',
    AUTH_INVALID_TOKEN: 'AUTH_INVALID_TOKEN',
    AUTH_FORBIDDEN: 'AUTH_FORBIDDEN',
    AUTH_ACCESS_DENIED: 'AUTH_ACCESS_DENIED',
    QUEUE_SEND_ERROR: 'QUEUE_SEND_ERROR',
    QUEUE_PARSE_ERROR: 'QUEUE_PARSE_ERROR',
    NETWORK_FETCH_ERROR: 'NETWORK_FETCH_ERROR',
    NETWORK_TIMEOUT: 'NETWORK_TIMEOUT',
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
