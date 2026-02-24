/**
 * Tests for funnel-report service.
 *
 * Verifies weekly funnel report generation, conversion rate calculation,
 * failure breakdown, and markdown formatting.
 */
import { describe, it, expect } from 'vitest';
import {
  generateFunnelReportWith,
  formatFunnelReport,
} from './funnel-report.js';
import type { FunnelEventsDeps } from './funnel-events.js';
import type { FunnelReport } from './funnel-report.js';

// ── Mock data builder ───────────────────────────────────────────────────────

function makeFunnelEvent(
  stage: string,
  userId: string,
  timestamp: number,
  opts?: { avatarId?: string; failureReason?: string },
) {
  return {
    id: `funnel-${stage}-${userId}-${timestamp}`,
    stage,
    timestamp,
    userId,
    avatarId: opts?.avatarId,
    metadata: {},
    failureReason: opts?.failureReason,
    // GSI fields
    gsi1pk: `FUNNEL_STAGE#${stage}`,
    gsi1sk: timestamp,
    pk: `FUNNEL#${userId}`,
    sk: `STAGE#${stage}#${timestamp}#funnel-${stage}-${userId}-${timestamp}`,
  };
}

// ── DynamoDB mock that returns per-stage events ─────────────────────────────

function makeMockDeps(
  stageEvents: Record<string, ReturnType<typeof makeFunnelEvent>[]>,
): FunnelEventsDeps {
  const send = async (cmd: unknown) => {
    const command = cmd as { input?: Record<string, unknown>; constructor?: { name?: string } };
    const name = command?.constructor?.name;

    if (name === 'QueryCommand') {
      const input = command.input as Record<string, unknown>;
      const exprValues = input.ExpressionAttributeValues as Record<string, unknown>;

      // GSI query: match on gsi1pk to identify the stage
      const gsi1pk = exprValues?.[':gsi1pk'] as string | undefined;
      if (gsi1pk) {
        const stage = gsi1pk.replace('FUNNEL_STAGE#', '');
        return { Items: stageEvents[stage] || [] };
      }

      return { Items: [] };
    }

    return {};
  };

  return {
    dynamoClient: { send } as unknown as FunnelEventsDeps['dynamoClient'],
    tableName: 'test-admin',
  };
}

// =========================================================================
// generateFunnelReportWith
// =========================================================================
describe('generateFunnelReportWith', () => {
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

  it('generates a report with stage metrics', async () => {
    const deps = makeMockDeps({
      F0: [makeFunnelEvent('F0', 'user-a', now - 1000)],
      F1: [
        makeFunnelEvent('F1', 'user-a', now - 900),
        makeFunnelEvent('F1', 'user-b', now - 800),
      ],
      F2: [makeFunnelEvent('F2', 'user-a', now - 700, { avatarId: 'av-1' })],
    });

    const report = await generateFunnelReportWith(deps, {
      since: weekAgo,
      until: now,
    });

    expect(report.stages.length).toBe(7); // F0-F6
    expect(report.stages[0].stage).toBe('F0');
    expect(report.stages[0].count).toBe(1);
    expect(report.stages[0].uniqueUsers).toBe(1);
    expect(report.stages[1].stage).toBe('F1');
    expect(report.stages[1].count).toBe(2);
    expect(report.stages[1].uniqueUsers).toBe(2);
    expect(report.stages[2].stage).toBe('F2');
    expect(report.stages[2].count).toBe(1);
    expect(report.stages[2].uniqueUsers).toBe(1);
  });

  it('calculates conversion rates', async () => {
    const deps = makeMockDeps({
      F1: [
        makeFunnelEvent('F1', 'user-a', now - 900),
        makeFunnelEvent('F1', 'user-b', now - 800),
        makeFunnelEvent('F1', 'user-c', now - 700),
        makeFunnelEvent('F1', 'user-d', now - 600),
        makeFunnelEvent('F1', 'user-e', now - 500),
      ],
      F2: [
        makeFunnelEvent('F2', 'user-a', now - 400, { avatarId: 'av-1' }),
        makeFunnelEvent('F2', 'user-b', now - 300, { avatarId: 'av-2' }),
        makeFunnelEvent('F2', 'user-c', now - 200, { avatarId: 'av-3' }),
      ],
    });

    const report = await generateFunnelReportWith(deps, {
      since: weekAgo,
      until: now,
    });

    // F1->F2 conversion: 3 unique users out of 5 = 60%
    const f1f2 = report.conversions.find(
      (c) => c.from === 'F1' && c.to === 'F2',
    );
    expect(f1f2).toBeDefined();
    expect(f1f2!.conversionRate).toBe(0.6);
    expect(f1f2!.target).toBe(0.6);
    expect(f1f2!.meetsTarget).toBe(true);
  });

  it('marks conversions below target', async () => {
    const deps = makeMockDeps({
      F1: [
        makeFunnelEvent('F1', 'user-a', now - 900),
        makeFunnelEvent('F1', 'user-b', now - 800),
        makeFunnelEvent('F1', 'user-c', now - 700),
        makeFunnelEvent('F1', 'user-d', now - 600),
        makeFunnelEvent('F1', 'user-e', now - 500),
      ],
      F2: [
        makeFunnelEvent('F2', 'user-a', now - 400, { avatarId: 'av-1' }),
        makeFunnelEvent('F2', 'user-b', now - 300, { avatarId: 'av-2' }),
      ],
    });

    const report = await generateFunnelReportWith(deps, {
      since: weekAgo,
      until: now,
    });

    // F1->F2 conversion: 2/5 = 40%, target is 60%
    const f1f2 = report.conversions.find(
      (c) => c.from === 'F1' && c.to === 'F2',
    );
    expect(f1f2!.conversionRate).toBe(0.4);
    expect(f1f2!.meetsTarget).toBe(false);
  });

  it('handles zero-count stages gracefully', async () => {
    const deps = makeMockDeps({}); // No events at all

    const report = await generateFunnelReportWith(deps, {
      since: weekAgo,
      until: now,
    });

    expect(report.stages.length).toBe(7);
    for (const s of report.stages) {
      expect(s.count).toBe(0);
      expect(s.uniqueUsers).toBe(0);
    }

    for (const c of report.conversions) {
      expect(c.conversionRate).toBe(0);
    }
  });

  it('builds failure breakdowns', async () => {
    const deps = makeMockDeps({
      F3: [
        makeFunnelEvent('F3', 'user-a', now - 500, {
          avatarId: 'av-1',
          failureReason: 'llm_timeout',
        }),
        makeFunnelEvent('F3', 'user-b', now - 400, {
          avatarId: 'av-2',
          failureReason: 'llm_timeout',
        }),
        makeFunnelEvent('F3', 'user-c', now - 300, {
          avatarId: 'av-3',
          failureReason: 'no_bot_token',
        }),
        makeFunnelEvent('F3', 'user-d', now - 200, { avatarId: 'av-4' }), // success
      ],
    });

    const report = await generateFunnelReportWith(deps, {
      since: weekAgo,
      until: now,
    });

    expect(report.failures.length).toBe(1);
    const f3Failures = report.failures[0];
    expect(f3Failures.stage).toBe('F3');
    expect(f3Failures.reasons.length).toBe(2);
    // Sorted by count descending
    expect(f3Failures.reasons[0].reason).toBe('llm_timeout');
    expect(f3Failures.reasons[0].count).toBe(2);
    expect(f3Failures.reasons[1].reason).toBe('no_bot_token');
    expect(f3Failures.reasons[1].count).toBe(1);
  });

  it('includes period timestamps and generatedAt', async () => {
    const deps = makeMockDeps({});

    const report = await generateFunnelReportWith(deps, {
      since: weekAgo,
      until: now,
    });

    expect(report.periodStart).toBe(weekAgo);
    expect(report.periodEnd).toBe(now);
    expect(report.generatedAt).toBeGreaterThan(0);
  });
});

// =========================================================================
// formatFunnelReport
// =========================================================================
describe('formatFunnelReport', () => {
  it('formats a report as markdown', () => {
    const report: FunnelReport = {
      periodStart: new Date('2026-02-16').getTime(),
      periodEnd: new Date('2026-02-23').getTime(),
      stages: [
        { stage: 'F0', label: 'Qualified visitor/session', count: 100, uniqueUsers: 80 },
        { stage: 'F1', label: 'Authenticated account', count: 60, uniqueUsers: 50 },
        { stage: 'F2', label: 'Avatar created', count: 35, uniqueUsers: 30 },
        { stage: 'F3', label: 'First live response delivered', count: 22, uniqueUsers: 20 },
        { stage: 'F4', label: 'Day-7 active avatar', count: 8, uniqueUsers: 7 },
        { stage: 'F5', label: 'Paid conversion', count: 1, uniqueUsers: 1 },
        { stage: 'F6', label: 'Expansion event', count: 0, uniqueUsers: 0 },
      ],
      conversions: [
        { from: 'F0', to: 'F1', fromCount: 80, toCount: 50, conversionRate: 0.625, meetsTarget: true },
        { from: 'F1', to: 'F2', fromCount: 50, toCount: 30, conversionRate: 0.6, target: 0.6, meetsTarget: true },
        { from: 'F2', to: 'F3', fromCount: 30, toCount: 20, conversionRate: 0.6667, target: 0.7, meetsTarget: false },
        { from: 'F3', to: 'F4', fromCount: 20, toCount: 7, conversionRate: 0.35, target: 0.35, meetsTarget: true },
        { from: 'F4', to: 'F5', fromCount: 7, toCount: 1, conversionRate: 0.1429, target: 0.1, meetsTarget: true },
        { from: 'F5', to: 'F6', fromCount: 1, toCount: 0, conversionRate: 0, meetsTarget: true },
      ],
      failures: [
        {
          stage: 'F3',
          reasons: [
            { reason: 'llm_timeout', count: 3, percentage: 60 },
            { reason: 'no_bot_token', count: 2, percentage: 40 },
          ],
        },
      ],
      generatedAt: Date.now(),
    };

    const md = formatFunnelReport(report);

    expect(md).toContain('Weekly Funnel Report');
    expect(md).toContain('2026-02-16');
    expect(md).toContain('2026-02-23');
    expect(md).toContain('Stage Metrics');
    expect(md).toContain('Conversion Rates');
    expect(md).toContain('Failure Reasons');
    expect(md).toContain('BELOW TARGET');
    expect(md).toContain('llm_timeout');
    expect(md).toContain('no_bot_token');
  });

  it('omits failure section when no failures', () => {
    const report: FunnelReport = {
      periodStart: Date.now() - 604800000,
      periodEnd: Date.now(),
      stages: [
        { stage: 'F0', label: 'Qualified visitor/session', count: 0, uniqueUsers: 0 },
        { stage: 'F1', label: 'Authenticated account', count: 0, uniqueUsers: 0 },
        { stage: 'F2', label: 'Avatar created', count: 0, uniqueUsers: 0 },
        { stage: 'F3', label: 'First live response delivered', count: 0, uniqueUsers: 0 },
        { stage: 'F4', label: 'Day-7 active avatar', count: 0, uniqueUsers: 0 },
        { stage: 'F5', label: 'Paid conversion', count: 0, uniqueUsers: 0 },
        { stage: 'F6', label: 'Expansion event', count: 0, uniqueUsers: 0 },
      ],
      conversions: [],
      failures: [],
      generatedAt: Date.now(),
    };

    const md = formatFunnelReport(report);

    expect(md).not.toContain('Failure Reasons');
  });
});
