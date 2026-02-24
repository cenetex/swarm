/**
 * GTM Funnel Report Utility
 *
 * Generates weekly funnel conversion reports from recorded funnel events.
 * Calculates stage-to-stage conversion rates, identifies failure reasons,
 * and produces structured output for KPI review.
 *
 * KPI targets (from GTM-STRATEGY-M2.md):
 *   F1->F2 conversion >= 60%
 *   F2->F3 conversion >= 70%
 *   F3->F4 retention  >= 35%
 *   F4->F5 conversion >= 10%
 *   Median F2->F3 time <= 10 minutes
 */
import {
  type FunnelStage,
  type FunnelEvent,
  FUNNEL_STAGE_LABELS,
  listFunnelEventsByStageWith,
  type FunnelEventsDeps,
} from './funnel-events.js';
import { getDynamoClient } from './dynamo-client.js';

// ============================================================================
// Types
// ============================================================================

export interface StageMetrics {
  stage: FunnelStage;
  label: string;
  count: number;
  uniqueUsers: number;
}

export interface ConversionStep {
  from: FunnelStage;
  to: FunnelStage;
  fromCount: number;
  toCount: number;
  conversionRate: number; // 0-1
  target?: number; // 0-1, from GTM strategy
  meetsTarget: boolean;
}

export interface FailureBreakdown {
  stage: FunnelStage;
  reasons: Array<{ reason: string; count: number; percentage: number }>;
}

export interface FunnelReport {
  periodStart: number; // timestamp ms
  periodEnd: number;
  stages: StageMetrics[];
  conversions: ConversionStep[];
  failures: FailureBreakdown[];
  generatedAt: number;
}

// M2 conversion targets from GTM-STRATEGY-M2.md
const CONVERSION_TARGETS: Partial<Record<string, number>> = {
  'F1->F2': 0.60,
  'F2->F3': 0.70,
  'F3->F4': 0.35,
  'F4->F5': 0.10,
};

const ORDERED_STAGES: FunnelStage[] = ['F0', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6'];

// ============================================================================
// Default production deps
// ============================================================================

let _defaultDeps: FunnelEventsDeps | null = null;

function getDefaultDeps(): FunnelEventsDeps {
  if (!_defaultDeps) {
    _defaultDeps = {
      dynamoClient: getDynamoClient(),
      tableName: process.env.ADMIN_TABLE || 'swarm-admin',
    };
  }
  return _defaultDeps;
}

// ============================================================================
// Report generation
// ============================================================================

/**
 * Generate a weekly funnel report.
 *
 * @param options.since - Start of the reporting window (default: 7 days ago)
 * @param options.until - End of the reporting window (default: now)
 * @param options.deps - Injectable dependencies for testing
 */
export async function generateFunnelReportWith(
  deps: FunnelEventsDeps,
  options: { since?: number; until?: number } = {},
): Promise<FunnelReport> {
  const now = Date.now();
  const periodEnd = options.until ?? now;
  const periodStart = options.since ?? periodEnd - 7 * 24 * 60 * 60 * 1000;

  // Fetch events for each stage in parallel
  const stageEventsMap = new Map<FunnelStage, FunnelEvent[]>();

  const results = await Promise.all(
    ORDERED_STAGES.map(async (stage) => {
      const events = await listFunnelEventsByStageWith(deps, stage, {
        since: periodStart,
        limit: 5000,
      });
      // Filter events within the reporting window
      const filtered = events.filter(
        (e) => e.timestamp >= periodStart && e.timestamp <= periodEnd,
      );
      return { stage, events: filtered };
    }),
  );

  for (const { stage, events } of results) {
    stageEventsMap.set(stage, events);
  }

  // Build stage metrics
  const stages: StageMetrics[] = ORDERED_STAGES.map((stage) => {
    const events = stageEventsMap.get(stage) || [];
    const uniqueUsers = new Set(events.map((e) => e.userId));
    return {
      stage,
      label: FUNNEL_STAGE_LABELS[stage],
      count: events.length,
      uniqueUsers: uniqueUsers.size,
    };
  });

  // Build conversion steps
  const conversions: ConversionStep[] = [];
  for (let i = 0; i < ORDERED_STAGES.length - 1; i++) {
    const from = ORDERED_STAGES[i];
    const to = ORDERED_STAGES[i + 1];
    const fromMetrics = stages[i];
    const toMetrics = stages[i + 1];
    const key = `${from}->${to}`;
    const target = CONVERSION_TARGETS[key];

    const rate =
      fromMetrics.uniqueUsers > 0
        ? toMetrics.uniqueUsers / fromMetrics.uniqueUsers
        : 0;

    conversions.push({
      from,
      to,
      fromCount: fromMetrics.uniqueUsers,
      toCount: toMetrics.uniqueUsers,
      conversionRate: Math.round(rate * 10000) / 10000, // 4 decimal places
      target,
      meetsTarget: target !== undefined ? rate >= target : true,
    });
  }

  // Build failure breakdowns (stages with failureReason)
  const failures: FailureBreakdown[] = [];
  for (const stage of ORDERED_STAGES) {
    const events = stageEventsMap.get(stage) || [];
    const failedEvents = events.filter((e) => e.failureReason);

    if (failedEvents.length === 0) continue;

    const reasonCounts = new Map<string, number>();
    for (const e of failedEvents) {
      const reason = e.failureReason!;
      reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
    }

    const reasons = Array.from(reasonCounts.entries())
      .map(([reason, count]) => ({
        reason,
        count,
        percentage:
          Math.round((count / failedEvents.length) * 10000) / 100,
      }))
      .sort((a, b) => b.count - a.count);

    failures.push({ stage, reasons });
  }

  return {
    periodStart,
    periodEnd,
    stages,
    conversions,
    failures,
    generatedAt: Date.now(),
  };
}

/**
 * Generate a weekly funnel report using default production deps.
 */
export async function generateFunnelReport(
  options?: { since?: number; until?: number },
): Promise<FunnelReport> {
  return generateFunnelReportWith(getDefaultDeps(), options);
}

/**
 * Format a funnel report as a human-readable markdown string.
 * Suitable for display in admin chat or weekly review output.
 */
export function formatFunnelReport(report: FunnelReport): string {
  const lines: string[] = [];

  const startDate = new Date(report.periodStart).toISOString().split('T')[0];
  const endDate = new Date(report.periodEnd).toISOString().split('T')[0];

  lines.push(`## Weekly Funnel Report (${startDate} to ${endDate})`);
  lines.push('');

  // Stage summary table
  lines.push('### Stage Metrics');
  lines.push('');
  lines.push('| Stage | Label | Events | Unique Users |');
  lines.push('|-------|-------|--------|--------------|');
  for (const s of report.stages) {
    lines.push(
      `| ${s.stage} | ${s.label} | ${s.count} | ${s.uniqueUsers} |`,
    );
  }
  lines.push('');

  // Conversion rates
  lines.push('### Conversion Rates');
  lines.push('');
  lines.push('| Step | From | To | Rate | Target | Status |');
  lines.push('|------|------|----|------|--------|--------|');
  for (const c of report.conversions) {
    const pct = (c.conversionRate * 100).toFixed(1) + '%';
    const targetStr = c.target !== undefined
      ? (c.target * 100).toFixed(0) + '%'
      : '-';
    const status = c.target !== undefined
      ? (c.meetsTarget ? 'OK' : 'BELOW TARGET')
      : '-';
    lines.push(
      `| ${c.from}->${c.to} | ${c.fromCount} | ${c.toCount} | ${pct} | ${targetStr} | ${status} |`,
    );
  }
  lines.push('');

  // Failure reasons
  if (report.failures.length > 0) {
    lines.push('### Failure Reasons');
    lines.push('');
    for (const f of report.failures) {
      lines.push(
        `#### ${f.stage} (${FUNNEL_STAGE_LABELS[f.stage]})`,
      );
      lines.push('');
      for (const r of f.reasons) {
        lines.push(`- ${r.reason}: ${r.count} (${r.percentage}%)`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}
