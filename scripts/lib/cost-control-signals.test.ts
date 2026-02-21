/**
 * Unit tests for cost-control signal evaluation logic.
 *
 * These cover the pure functions extracted from generate-cost-activity-report.mjs:
 * - computePercentChange
 * - daysInUtcMonth
 * - formatSignedUsd / formatSignedPercent
 * - buildCostPerMessageSeries
 * - evaluateCostControlSignals (all 4 signals x TRIGGERED/CLEAR/UNAVAILABLE)
 */
import { describe, it, expect } from 'vitest';
import {
  COST_CONTROL_THRESHOLDS,
  SIGNAL_STATUS,
  formatUsd,
  formatSignedUsd,
  formatSignedPercent,
  computePercentChange,
  daysInUtcMonth,
  buildCostPerMessageSeries,
  evaluateCostControlSignals,
} from './cost-control-signals.mjs';

// ---------------------------------------------------------------------------
// Helper factories
// ---------------------------------------------------------------------------

function makeUsage(days: Array<{ date: string; messagesProcessed: number; estimatedUsageCostUsd?: number }>) {
  return { days };
}

function makeAwsCost(
  daily: Array<{ date: string; amount: number }>,
  overrides: Record<string, unknown> = {},
) {
  return {
    ok: true,
    totalUsd: daily.reduce((s, d) => s + d.amount, 0),
    daily,
    services: [],
    source: 'aws-cost-explorer',
    ...overrides,
  };
}

function makeAwsCostError(error = 'AccessDenied') {
  return { ok: false, error, source: 'aws-cost-explorer' };
}

// ---------------------------------------------------------------------------
// computePercentChange
// ---------------------------------------------------------------------------

describe('computePercentChange', () => {
  it('returns correct percent for positive change', () => {
    expect(computePercentChange(130, 100)).toBe(30);
  });

  it('returns correct percent for negative change', () => {
    expect(computePercentChange(80, 100)).toBe(-20);
  });

  it('returns null when previousValue is zero', () => {
    expect(computePercentChange(50, 0)).toBeNull();
  });

  it('returns null when previousValue is negative', () => {
    expect(computePercentChange(50, -10)).toBeNull();
  });

  it('returns null for NaN input', () => {
    expect(computePercentChange(NaN, 100)).toBeNull();
  });

  it('returns 0 when values are equal', () => {
    expect(computePercentChange(100, 100)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// daysInUtcMonth
// ---------------------------------------------------------------------------

describe('daysInUtcMonth', () => {
  it('returns 28 for Feb 2025 (non-leap)', () => {
    expect(daysInUtcMonth('2025-02-15')).toBe(28);
  });

  it('returns 29 for Feb 2024 (leap)', () => {
    expect(daysInUtcMonth('2024-02-01')).toBe(29);
  });

  it('returns 31 for January', () => {
    expect(daysInUtcMonth('2026-01-10')).toBe(31);
  });

  it('returns 30 for April', () => {
    expect(daysInUtcMonth('2026-04-20')).toBe(30);
  });

  it('returns null for empty string', () => {
    expect(daysInUtcMonth('')).toBeNull();
  });

  it('returns null for invalid month', () => {
    expect(daysInUtcMonth('2026-13-01')).toBeNull();
  });

  it('returns null for month 0', () => {
    expect(daysInUtcMonth('2026-00-01')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatSignedUsd
// ---------------------------------------------------------------------------

describe('formatSignedUsd', () => {
  it('returns +$X.XX for positive values', () => {
    expect(formatSignedUsd(15)).toBe('+$15.00');
  });

  it('returns -$X.XX for negative values', () => {
    expect(formatSignedUsd(-7.5)).toBe('-$7.50');
  });

  it('returns $0.00 for zero', () => {
    expect(formatSignedUsd(0)).toBe('$0.00');
  });

  it('returns n/a for NaN', () => {
    expect(formatSignedUsd(NaN)).toBe('n/a');
  });

  it('returns n/a for Infinity', () => {
    expect(formatSignedUsd(Infinity)).toBe('n/a');
  });
});

// ---------------------------------------------------------------------------
// formatSignedPercent
// ---------------------------------------------------------------------------

describe('formatSignedPercent', () => {
  it('returns +X.X% for positive values', () => {
    expect(formatSignedPercent(30.5)).toBe('+30.5%');
  });

  it('returns -X.X% for negative values', () => {
    expect(formatSignedPercent(-12.3)).toBe('-12.3%');
  });

  it('returns 0.0% for zero', () => {
    expect(formatSignedPercent(0)).toBe('0.0%');
  });

  it('returns n/a for NaN', () => {
    expect(formatSignedPercent(NaN)).toBe('n/a');
  });
});

// ---------------------------------------------------------------------------
// buildCostPerMessageSeries
// ---------------------------------------------------------------------------

describe('buildCostPerMessageSeries', () => {
  it('uses AWS daily cost when available', () => {
    const usage = makeUsage([
      { date: '2026-02-18', messagesProcessed: 100 },
      { date: '2026-02-19', messagesProcessed: 200 },
    ]);
    const awsCost = makeAwsCost([
      { date: '2026-02-18', amount: 10 },
      { date: '2026-02-19', amount: 20 },
    ]);

    const series = buildCostPerMessageSeries(usage.days, awsCost);

    expect(series).toHaveLength(2);
    expect(series[0].source).toBe('aws-unblended-cost');
    expect(series[0].costPerMessageUsd).toBeCloseTo(0.1); // $10 / 100 msgs
    expect(series[1].costPerMessageUsd).toBeCloseTo(0.1); // $20 / 200 msgs
  });

  it('falls back to estimated usage cost when AWS cost is unavailable', () => {
    const usage = makeUsage([
      { date: '2026-02-18', messagesProcessed: 100, estimatedUsageCostUsd: 5 },
      { date: '2026-02-19', messagesProcessed: 200, estimatedUsageCostUsd: 8 },
    ]);
    const awsCost = makeAwsCostError();

    const series = buildCostPerMessageSeries(usage.days, awsCost);

    expect(series).toHaveLength(2);
    expect(series[0].source).toBe('estimated-usage-cost');
    expect(series[0].costPerMessageUsd).toBeCloseTo(0.05); // $5 / 100
  });

  it('skips days with zero messages', () => {
    const usage = makeUsage([
      { date: '2026-02-18', messagesProcessed: 0 },
      { date: '2026-02-19', messagesProcessed: 100, estimatedUsageCostUsd: 5 },
    ]);
    const awsCost = makeAwsCostError();

    const series = buildCostPerMessageSeries(usage.days, awsCost);
    expect(series).toHaveLength(1);
    expect(series[0].date).toBe('2026-02-19');
  });

  it('returns empty array for no valid days', () => {
    const usage = makeUsage([]);
    const series = buildCostPerMessageSeries(usage.days, makeAwsCostError());
    expect(series).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// evaluateCostControlSignals: awsCostJump
// ---------------------------------------------------------------------------

describe('evaluateCostControlSignals - awsCostJump', () => {
  it('is UNAVAILABLE when AWS cost is not ok', () => {
    const signals = evaluateCostControlSignals({
      usage: makeUsage([]),
      awsCost: makeAwsCostError(),
      monthlyBudgetUsd: null,
    });
    expect(signals.awsCostJump.status).toBe(SIGNAL_STATUS.UNAVAILABLE);
    expect(signals.awsCostJump.observed).toContain('unavailable');
  });

  it('is UNAVAILABLE when fewer than 2 daily buckets', () => {
    const signals = evaluateCostControlSignals({
      usage: makeUsage([{ date: '2026-02-19', messagesProcessed: 10 }]),
      awsCost: makeAwsCost([{ date: '2026-02-19', amount: 50 }]),
      monthlyBudgetUsd: null,
    });
    expect(signals.awsCostJump.status).toBe(SIGNAL_STATUS.UNAVAILABLE);
    expect(signals.awsCostJump.observed).toContain('fewer than 2');
  });

  it('is TRIGGERED when cost jumps >= 30% and >= $15 absolute', () => {
    const signals = evaluateCostControlSignals({
      usage: makeUsage([
        { date: '2026-02-18', messagesProcessed: 100 },
        { date: '2026-02-19', messagesProcessed: 100 },
      ]),
      awsCost: makeAwsCost([
        { date: '2026-02-18', amount: 50 },
        { date: '2026-02-19', amount: 80 }, // +60%, +$30
      ]),
      monthlyBudgetUsd: null,
    });
    expect(signals.awsCostJump.status).toBe(SIGNAL_STATUS.TRIGGERED);
    expect(signals.awsCostJump.details).toBeDefined();
    expect(signals.awsCostJump.details.deltaPercent).toBe(60);
    expect(signals.awsCostJump.details.deltaUsd).toBe(30);
  });

  it('is CLEAR when percent is high but absolute is below threshold', () => {
    // +100% but only +$5 absolute (below $15 threshold)
    const signals = evaluateCostControlSignals({
      usage: makeUsage([
        { date: '2026-02-18', messagesProcessed: 10 },
        { date: '2026-02-19', messagesProcessed: 10 },
      ]),
      awsCost: makeAwsCost([
        { date: '2026-02-18', amount: 5 },
        { date: '2026-02-19', amount: 10 }, // +100%, +$5
      ]),
      monthlyBudgetUsd: null,
    });
    expect(signals.awsCostJump.status).toBe(SIGNAL_STATUS.CLEAR);
  });

  it('is CLEAR when absolute is high but percent is below threshold', () => {
    // +$20 but only +20% (below 30%)
    const signals = evaluateCostControlSignals({
      usage: makeUsage([
        { date: '2026-02-18', messagesProcessed: 100 },
        { date: '2026-02-19', messagesProcessed: 100 },
      ]),
      awsCost: makeAwsCost([
        { date: '2026-02-18', amount: 100 },
        { date: '2026-02-19', amount: 120 }, // +20%, +$20
      ]),
      monthlyBudgetUsd: null,
    });
    expect(signals.awsCostJump.status).toBe(SIGNAL_STATUS.CLEAR);
  });

  it('is CLEAR when cost decreases', () => {
    const signals = evaluateCostControlSignals({
      usage: makeUsage([
        { date: '2026-02-18', messagesProcessed: 100 },
        { date: '2026-02-19', messagesProcessed: 100 },
      ]),
      awsCost: makeAwsCost([
        { date: '2026-02-18', amount: 80 },
        { date: '2026-02-19', amount: 50 },
      ]),
      monthlyBudgetUsd: null,
    });
    expect(signals.awsCostJump.status).toBe(SIGNAL_STATUS.CLEAR);
  });

  it('is UNAVAILABLE when previous daily cost is zero', () => {
    const signals = evaluateCostControlSignals({
      usage: makeUsage([
        { date: '2026-02-18', messagesProcessed: 100 },
        { date: '2026-02-19', messagesProcessed: 100 },
      ]),
      awsCost: makeAwsCost([
        { date: '2026-02-18', amount: 0 },
        { date: '2026-02-19', amount: 50 },
      ]),
      monthlyBudgetUsd: null,
    });
    expect(signals.awsCostJump.status).toBe(SIGNAL_STATUS.UNAVAILABLE);
    expect(signals.awsCostJump.observed).toContain('previous daily cost is zero');
  });
});

// ---------------------------------------------------------------------------
// evaluateCostControlSignals: costPerMessageJump
// ---------------------------------------------------------------------------

describe('evaluateCostControlSignals - costPerMessageJump', () => {
  it('is UNAVAILABLE when insufficient history', () => {
    const signals = evaluateCostControlSignals({
      usage: makeUsage([{ date: '2026-02-19', messagesProcessed: 10 }]),
      awsCost: makeAwsCost([{ date: '2026-02-19', amount: 5 }]),
      monthlyBudgetUsd: null,
    });
    expect(signals.costPerMessageJump.status).toBe(SIGNAL_STATUS.UNAVAILABLE);
  });

  it('is TRIGGERED when cost per message doubles', () => {
    const signals = evaluateCostControlSignals({
      usage: makeUsage([
        { date: '2026-02-18', messagesProcessed: 100 },
        { date: '2026-02-19', messagesProcessed: 100 },
      ]),
      awsCost: makeAwsCost([
        { date: '2026-02-18', amount: 10 },  // $0.10/msg baseline
        { date: '2026-02-19', amount: 25 },   // $0.25/msg = 2.5x
      ]),
      monthlyBudgetUsd: null,
    });
    expect(signals.costPerMessageJump.status).toBe(SIGNAL_STATUS.TRIGGERED);
    expect(signals.costPerMessageJump.details.multiplier).toBeCloseTo(2.5);
  });

  it('is CLEAR when cost per message is stable', () => {
    const signals = evaluateCostControlSignals({
      usage: makeUsage([
        { date: '2026-02-18', messagesProcessed: 100 },
        { date: '2026-02-19', messagesProcessed: 100 },
      ]),
      awsCost: makeAwsCost([
        { date: '2026-02-18', amount: 10 },
        { date: '2026-02-19', amount: 12 }, // 1.2x -- below 2x threshold
      ]),
      monthlyBudgetUsd: null,
    });
    expect(signals.costPerMessageJump.status).toBe(SIGNAL_STATUS.CLEAR);
  });

  it('is TRIGGERED at exactly 2x multiplier', () => {
    const signals = evaluateCostControlSignals({
      usage: makeUsage([
        { date: '2026-02-18', messagesProcessed: 100 },
        { date: '2026-02-19', messagesProcessed: 100 },
      ]),
      awsCost: makeAwsCost([
        { date: '2026-02-18', amount: 10 },
        { date: '2026-02-19', amount: 20 }, // exactly 2x
      ]),
      monthlyBudgetUsd: null,
    });
    expect(signals.costPerMessageJump.status).toBe(SIGNAL_STATUS.TRIGGERED);
    expect(signals.costPerMessageJump.details.multiplier).toBeCloseTo(2.0);
  });

  it('uses multi-day baseline average', () => {
    // 3-day baseline where avg cost per msg is $0.10, then spike to $0.25
    const signals = evaluateCostControlSignals({
      usage: makeUsage([
        { date: '2026-02-16', messagesProcessed: 100 },
        { date: '2026-02-17', messagesProcessed: 100 },
        { date: '2026-02-18', messagesProcessed: 100 },
        { date: '2026-02-19', messagesProcessed: 100 },
      ]),
      awsCost: makeAwsCost([
        { date: '2026-02-16', amount: 8 },
        { date: '2026-02-17', amount: 10 },
        { date: '2026-02-18', amount: 12 },
        { date: '2026-02-19', amount: 25 }, // spike
      ]),
      monthlyBudgetUsd: null,
    });
    // baseline avg = (0.08 + 0.10 + 0.12) / 3 = 0.10
    // current = 0.25, multiplier = 2.5x => TRIGGERED
    expect(signals.costPerMessageJump.status).toBe(SIGNAL_STATUS.TRIGGERED);
    expect(signals.costPerMessageJump.details.multiplier).toBeCloseTo(2.5);
  });
});

// ---------------------------------------------------------------------------
// evaluateCostControlSignals: spendRiseActivityFlat
// ---------------------------------------------------------------------------

describe('evaluateCostControlSignals - spendRiseActivityFlat', () => {
  it('is UNAVAILABLE when AWS cost is not ok', () => {
    const signals = evaluateCostControlSignals({
      usage: makeUsage([
        { date: '2026-02-18', messagesProcessed: 100 },
        { date: '2026-02-19', messagesProcessed: 100 },
      ]),
      awsCost: makeAwsCostError(),
      monthlyBudgetUsd: null,
    });
    expect(signals.spendRiseActivityFlat.status).toBe(SIGNAL_STATUS.UNAVAILABLE);
  });

  it('is TRIGGERED when cost rises >= 25% but messages stay within +/-10%', () => {
    const signals = evaluateCostControlSignals({
      usage: makeUsage([
        { date: '2026-02-18', messagesProcessed: 100 },
        { date: '2026-02-19', messagesProcessed: 105 }, // +5%, within 10%
      ]),
      awsCost: makeAwsCost([
        { date: '2026-02-18', amount: 40 },
        { date: '2026-02-19', amount: 60 }, // +50%
      ]),
      monthlyBudgetUsd: null,
    });
    expect(signals.spendRiseActivityFlat.status).toBe(SIGNAL_STATUS.TRIGGERED);
  });

  it('is CLEAR when both cost and activity rise', () => {
    const signals = evaluateCostControlSignals({
      usage: makeUsage([
        { date: '2026-02-18', messagesProcessed: 100 },
        { date: '2026-02-19', messagesProcessed: 200 }, // +100%, outside +/-10%
      ]),
      awsCost: makeAwsCost([
        { date: '2026-02-18', amount: 40 },
        { date: '2026-02-19', amount: 60 }, // +50%
      ]),
      monthlyBudgetUsd: null,
    });
    expect(signals.spendRiseActivityFlat.status).toBe(SIGNAL_STATUS.CLEAR);
  });

  it('is CLEAR when cost does not rise enough', () => {
    const signals = evaluateCostControlSignals({
      usage: makeUsage([
        { date: '2026-02-18', messagesProcessed: 100 },
        { date: '2026-02-19', messagesProcessed: 100 },
      ]),
      awsCost: makeAwsCost([
        { date: '2026-02-18', amount: 40 },
        { date: '2026-02-19', amount: 48 }, // +20%, below 25% threshold
      ]),
      monthlyBudgetUsd: null,
    });
    expect(signals.spendRiseActivityFlat.status).toBe(SIGNAL_STATUS.CLEAR);
  });

  it('is UNAVAILABLE when previous messages are zero', () => {
    const signals = evaluateCostControlSignals({
      usage: makeUsage([
        { date: '2026-02-18', messagesProcessed: 0 },
        { date: '2026-02-19', messagesProcessed: 100 },
      ]),
      awsCost: makeAwsCost([
        { date: '2026-02-18', amount: 40 },
        { date: '2026-02-19', amount: 60 },
      ]),
      monthlyBudgetUsd: null,
    });
    expect(signals.spendRiseActivityFlat.status).toBe(SIGNAL_STATUS.UNAVAILABLE);
    expect(signals.spendRiseActivityFlat.observed).toContain('previous daily messages are zero');
  });
});

// ---------------------------------------------------------------------------
// evaluateCostControlSignals: projectedMonthEndSpendBreach
// ---------------------------------------------------------------------------

describe('evaluateCostControlSignals - projectedMonthEndSpendBreach', () => {
  it('is UNAVAILABLE when MONTHLY_BUDGET_USD is not set', () => {
    const signals = evaluateCostControlSignals({
      usage: makeUsage([{ date: '2026-02-19', messagesProcessed: 100 }]),
      awsCost: makeAwsCost([{ date: '2026-02-19', amount: 50 }]),
      monthlyBudgetUsd: null,
    });
    expect(signals.projectedMonthEndSpendBreach.status).toBe(SIGNAL_STATUS.UNAVAILABLE);
    expect(signals.projectedMonthEndSpendBreach.observed).toContain('MONTHLY_BUDGET_USD not set');
  });

  it('is UNAVAILABLE when AWS cost is not ok', () => {
    const signals = evaluateCostControlSignals({
      usage: makeUsage([]),
      awsCost: makeAwsCostError(),
      monthlyBudgetUsd: 400,
    });
    expect(signals.projectedMonthEndSpendBreach.status).toBe(SIGNAL_STATUS.UNAVAILABLE);
  });

  it('is TRIGGERED when projected spend exceeds budget by >= 20%', () => {
    // 7 days at $20/day = avg $20/day. Feb has 28 days => forecast $560.
    // Budget $400. $560 is 40% over $400. Threshold = budget * 1.2 = $480. $560 >= $480 => TRIGGERED.
    const daily = [];
    for (let i = 1; i <= 7; i++) {
      daily.push({ date: `2026-02-${String(i).padStart(2, '0')}`, amount: 20 });
    }
    const usage = makeUsage(daily.map((d) => ({ date: d.date, messagesProcessed: 50 })));

    const signals = evaluateCostControlSignals({
      usage,
      awsCost: makeAwsCost(daily),
      monthlyBudgetUsd: 400,
    });
    expect(signals.projectedMonthEndSpendBreach.status).toBe(SIGNAL_STATUS.TRIGGERED);
    expect(signals.projectedMonthEndSpendBreach.details.forecastMonthEndUsd).toBeCloseTo(20 * 28);
    expect(signals.projectedMonthEndSpendBreach.details.budgetUsd).toBe(400);
  });

  it('is CLEAR when projected spend is within budget', () => {
    // 7 days at $10/day. Feb has 28 days => forecast $280.
    // Budget $400. $280 < $480 (budget * 1.2) => CLEAR.
    const daily = [];
    for (let i = 1; i <= 7; i++) {
      daily.push({ date: `2026-02-${String(i).padStart(2, '0')}`, amount: 10 });
    }
    const usage = makeUsage(daily.map((d) => ({ date: d.date, messagesProcessed: 50 })));

    const signals = evaluateCostControlSignals({
      usage,
      awsCost: makeAwsCost(daily),
      monthlyBudgetUsd: 400,
    });
    expect(signals.projectedMonthEndSpendBreach.status).toBe(SIGNAL_STATUS.CLEAR);
  });

  it('handles month with 31 days correctly', () => {
    // 3 days at $20/day in March (31 days). Forecast = $620.
    // Budget $500. $620 >= $600 (500 * 1.2) => TRIGGERED.
    const daily = [
      { date: '2026-03-01', amount: 20 },
      { date: '2026-03-02', amount: 20 },
      { date: '2026-03-03', amount: 20 },
    ];
    const usage = makeUsage(daily.map((d) => ({ date: d.date, messagesProcessed: 50 })));

    const signals = evaluateCostControlSignals({
      usage,
      awsCost: makeAwsCost(daily),
      monthlyBudgetUsd: 500,
    });
    expect(signals.projectedMonthEndSpendBreach.status).toBe(SIGNAL_STATUS.TRIGGERED);
    expect(signals.projectedMonthEndSpendBreach.details.forecastMonthEndUsd).toBeCloseTo(20 * 31);
  });
});

// ---------------------------------------------------------------------------
// evaluateCostControlSignals: triggered aggregation
// ---------------------------------------------------------------------------

describe('evaluateCostControlSignals - triggered aggregation', () => {
  it('counts multiple triggered signals', () => {
    // Big cost jump + cost/message spike + spend rise with flat activity
    const signals = evaluateCostControlSignals({
      usage: makeUsage([
        { date: '2026-02-18', messagesProcessed: 100 },
        { date: '2026-02-19', messagesProcessed: 102 }, // ~flat
      ]),
      awsCost: makeAwsCost([
        { date: '2026-02-18', amount: 30 },
        { date: '2026-02-19', amount: 80 }, // +167%, +$50
      ]),
      monthlyBudgetUsd: null,
    });
    expect(signals.triggeredCount).toBeGreaterThanOrEqual(2);
    expect(signals.triggered).toContain('awsCostJump');
    expect(signals.triggered).toContain('spendRiseActivityFlat');
  });

  it('returns triggeredCount 0 and empty triggered array when all clear', () => {
    const signals = evaluateCostControlSignals({
      usage: makeUsage([
        { date: '2026-02-18', messagesProcessed: 100 },
        { date: '2026-02-19', messagesProcessed: 100 },
      ]),
      awsCost: makeAwsCost([
        { date: '2026-02-18', amount: 50 },
        { date: '2026-02-19', amount: 52 }, // +4%, +$2 -- both below thresholds
      ]),
      monthlyBudgetUsd: null,
    });
    expect(signals.triggeredCount).toBe(0);
    expect(signals.triggered).toEqual([]);
  });

  it('includes thresholds in the output', () => {
    const signals = evaluateCostControlSignals({
      usage: makeUsage([]),
      awsCost: makeAwsCostError(),
      monthlyBudgetUsd: null,
    });
    expect(signals.thresholds).toBeDefined();
    expect(signals.thresholds.awsCostJumpPercent).toBe(COST_CONTROL_THRESHOLDS.awsCostJumpPercent);
    expect(signals.thresholds.projectedMonthEndBreachPercent).toBe(COST_CONTROL_THRESHOLDS.projectedMonthEndBreachPercent);
  });
});

// ---------------------------------------------------------------------------
// formatUsd (basic sanity)
// ---------------------------------------------------------------------------

describe('formatUsd', () => {
  it('formats positive value', () => {
    expect(formatUsd(123.456)).toBe('$123.46');
  });

  it('formats zero', () => {
    expect(formatUsd(0)).toBe('$0.00');
  });
});
