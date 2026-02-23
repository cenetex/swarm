import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSystemStatus, type SystemStatusDeps } from './observability.js';

const ALL_QUEUE_ENV_KEYS = [
  'SYSTEM_SHARED_MESSAGE_QUEUE_URL',
  'SYSTEM_SHARED_RESPONSE_QUEUE_URL',
  'SYSTEM_SHARED_MEDIA_QUEUE_URL',
  'SYSTEM_SHARED_POST_QUEUE_URL',
  'SYSTEM_SHARED_DLQ_URL',
  'SYSTEM_SHARED_SCHEDULER_DLQ_URL',
  'SYSTEM_ADMIN_RESPONSE_QUEUE_URL',
  'SYSTEM_ADMIN_CHAT_QUEUE_URL',
  'SYSTEM_ADMIN_DREAM_QUEUE_URL',
  'SYSTEM_ADMIN_RESPONSE_DLQ_URL',
  'SYSTEM_ADMIN_CHAT_DLQ_URL',
  'SYSTEM_ADMIN_DREAM_DLQ_URL',
  'SYSTEM_ADMIN_CONSOLIDATION_DLQ_URL',
] as const;

const ALL_QUEUE_RESULT_KEYS = [
  'sharedMessageQueue',
  'sharedResponseQueue',
  'sharedMediaQueue',
  'sharedPostQueue',
  'sharedDlq',
  'sharedSchedulerDlq',
  'adminResponseQueue',
  'adminChatQueue',
  'adminDreamQueue',
  'adminResponseDlq',
  'adminChatDlq',
  'adminDreamDlq',
  'adminConsolidationDlq',
] as const;

const ORIGINAL_ENV = { ...process.env };

function makeDeps(overrides: Partial<SystemStatusDeps> = {}): Partial<SystemStatusDeps> {
  return {
    countLogsByLevel: (vi.fn(async (level: string) => (
      level === 'ERROR'
        ? { count: 7, truncated: false }
        : { count: 11, truncated: false }
    )) as unknown as SystemStatusDeps['countLogsByLevel']),
    listIssues: (vi.fn(async () => ([
      { severity: 'low' },
      { severity: 'high' },
      { severity: 'critical' },
    ])) as unknown as SystemStatusDeps['listIssues']),
    getToolStatusStructured: (vi.fn(async () => undefined) as unknown as SystemStatusDeps['getToolStatusStructured']),
    getEnergyStatus: (vi.fn(async () => undefined) as unknown as SystemStatusDeps['getEnergyStatus']),
    ...overrides,
  };
}

describe('observability.getSystemStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of ALL_QUEUE_ENV_KEYS) {
      delete process.env[key];
    }
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('reports all shared/admin queues and explicit unsupported rate-limit metadata', async () => {
    for (const key of ALL_QUEUE_ENV_KEYS) {
      process.env[key] = `https://sqs.us-east-1.amazonaws.com/123456789012/${key}`;
    }

    const getQueueDepth = vi.fn(async () => ({
      depth: 3,
      inFlight: 2,
      unavailable: false as const,
    }));
    const deps = makeDeps({
      getQueueDepth: getQueueDepth as unknown as SystemStatusDeps['getQueueDepth'],
    });

    const result = await getSystemStatus({ since: 1 }, deps);

    expect(result.errors).toMatchObject({
      errorCount: 7,
      warnCount: 11,
      truncated: false,
      exactness: 'exact',
    });
    expect(result.autoIssues).toMatchObject({
      openTotal: 3,
      bySeverity: {
        low: 1,
        medium: 0,
        high: 1,
        critical: 1,
      },
    });

    for (const key of ALL_QUEUE_RESULT_KEYS) {
      const queue = result.queues[key];
      expect(queue).toBeDefined();
      expect(queue).toMatchObject({ depth: 3, inFlight: 2, unavailable: false });
    }

    expect(result.queues.postQueue).toEqual(result.queues.sharedPostQueue);
    expect(result.rateLimit).toEqual({
      supported: false,
      available: null,
      source: null,
      reason: 'global_rate_limit_telemetry_not_instrumented',
    });
    expect(getQueueDepth).toHaveBeenCalledTimes(ALL_QUEUE_ENV_KEYS.length);
  });

  it('marks queue counts as truncated when backing log counts are truncated', async () => {
    const deps = makeDeps({
      countLogsByLevel: (vi.fn(async (level: string) => (
        level === 'ERROR'
          ? { count: 4, truncated: true }
          : { count: 9, truncated: false }
      )) as unknown as SystemStatusDeps['countLogsByLevel']),
    });

    const result = await getSystemStatus({}, deps);

    expect(result.errors.truncated).toBe(true);
    expect(result.errors.exactness).toBe('truncated');
    expect(result.queues.sharedMessageQueue).toEqual({
      unavailable: true,
      reason: 'not_configured',
    });
    expect(result.queues.postQueue).toEqual({
      unavailable: true,
      reason: 'not_configured',
    });
  });

  it('marks configured queues as query_failed when queue depth lookup fails', async () => {
    process.env.SYSTEM_SHARED_MESSAGE_QUEUE_URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/shared-message';
    const getQueueDepth = vi.fn(async (queueUrl?: string) => (
      queueUrl
        ? { unavailable: true as const, reason: 'query_failed' as const }
        : { unavailable: true as const, reason: 'not_configured' as const }
    ));
    const deps = makeDeps({
      getQueueDepth: getQueueDepth as unknown as SystemStatusDeps['getQueueDepth'],
    });

    const result = await getSystemStatus({}, deps);

    expect(result.queues.sharedMessageQueue).toEqual({
      unavailable: true,
      reason: 'query_failed',
    });
    expect(getQueueDepth).toHaveBeenCalledTimes(ALL_QUEUE_ENV_KEYS.length);
  });
});
