/**
 * Pure functions for evaluating cost-control signals from report data.
 *
 * Extracted from generate-cost-activity-report.mjs so they can be unit-tested
 * independently of AWS SDK / DynamoDB / Cost Explorer I/O.
 */

export const COST_CONTROL_THRESHOLDS = Object.freeze({
  awsCostJumpPercent: 30,
  awsCostJumpAbsUsd: 15,
  costPerMessageMultiplier: 2,
  costVsActivityCostRisePercent: 25,
  costVsActivityMessageFlatPercent: 10,
  projectedMonthEndBreachPercent: 20,
  costPerMessageBaselineDays: 7,
});

export const SIGNAL_STATUS = Object.freeze({
  TRIGGERED: 'TRIGGERED',
  CLEAR: 'CLEAR',
  UNAVAILABLE: 'UNAVAILABLE',
});

export function formatUsd(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatSignedUsd(value) {
  if (!Number.isFinite(value)) return 'n/a';
  const abs = formatUsd(Math.abs(value));
  if (value > 0) return `+${abs}`;
  if (value < 0) return `-${abs}`;
  return abs;
}

export function formatSignedPercent(value, digits = 1) {
  if (!Number.isFinite(value)) return 'n/a';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}%`;
}

export function computePercentChange(currentValue, previousValue) {
  if (!Number.isFinite(currentValue) || !Number.isFinite(previousValue) || previousValue <= 0) {
    return null;
  }
  return ((currentValue - previousValue) / previousValue) * 100;
}

export function daysInUtcMonth(isoDate) {
  const [yearRaw, monthRaw] = String(isoDate || '').split('-');
  const year = Number.parseInt(yearRaw || '', 10);
  const month = Number.parseInt(monthRaw || '', 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
    return null;
  }
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function buildCostPerMessageSeries(usageDays, awsCost) {
  const awsByDate = awsCost?.ok
    ? new Map((awsCost.daily || []).map((day) => [day.date, Number(day.amount || 0)]))
    : null;
  const source = awsByDate ? 'aws-unblended-cost' : 'estimated-usage-cost';

  return usageDays
    .map((day) => {
      const messages = Number(day.messagesProcessed || 0);
      if (!Number.isFinite(messages) || messages <= 0) return null;

      let costUsd;
      if (awsByDate) {
        if (!awsByDate.has(day.date)) return null;
        costUsd = awsByDate.get(day.date);
      } else {
        costUsd = Number(day.estimatedUsageCostUsd || 0);
      }

      if (!Number.isFinite(costUsd)) return null;

      return {
        date: day.date,
        source,
        costUsd,
        messages,
        costPerMessageUsd: costUsd / messages,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function evaluateCostControlSignals({ usage, awsCost, monthlyBudgetUsd }) {
  const usageByDate = new Map(usage.days.map((day) => [day.date, day]));
  const awsDaily = awsCost?.ok
    ? [...(awsCost.daily || [])]
      .map((day) => ({ date: day.date, amount: Number(day.amount || 0) }))
      .sort((a, b) => a.date.localeCompare(b.date))
    : [];

  const signals = {
    thresholds: {
      awsCostJumpPercent: COST_CONTROL_THRESHOLDS.awsCostJumpPercent,
      awsCostJumpAbsUsd: COST_CONTROL_THRESHOLDS.awsCostJumpAbsUsd,
      costPerMessageMultiplier: COST_CONTROL_THRESHOLDS.costPerMessageMultiplier,
      costVsActivityCostRisePercent: COST_CONTROL_THRESHOLDS.costVsActivityCostRisePercent,
      costVsActivityMessageFlatPercent: COST_CONTROL_THRESHOLDS.costVsActivityMessageFlatPercent,
      projectedMonthEndBreachPercent: COST_CONTROL_THRESHOLDS.projectedMonthEndBreachPercent,
      costPerMessageBaselineDays: COST_CONTROL_THRESHOLDS.costPerMessageBaselineDays,
    },
    monthlyBudgetUsd,
    awsCostJump: {
      id: 'awsCostJump',
      name: 'AWS unblended cost jump',
      severity: 'P2',
      status: SIGNAL_STATUS.UNAVAILABLE,
      threshold: `>= ${COST_CONTROL_THRESHOLDS.awsCostJumpPercent}% day-over-day and >= ${formatUsd(COST_CONTROL_THRESHOLDS.awsCostJumpAbsUsd)} absolute increase`,
      observed: `unavailable (${awsCost?.error || 'AWS cost not requested'})`,
      reason: awsCost?.error || 'AWS cost not requested',
    },
    costPerMessageJump: {
      id: 'costPerMessageJump',
      name: 'Cost per message jump',
      severity: 'P2',
      status: SIGNAL_STATUS.UNAVAILABLE,
      threshold: `>= ${COST_CONTROL_THRESHOLDS.costPerMessageMultiplier.toFixed(1)}x versus prior up to ${COST_CONTROL_THRESHOLDS.costPerMessageBaselineDays} days`,
      observed: 'unavailable (insufficient cost/message history)',
      reason: 'Insufficient cost/message history',
    },
    spendRiseActivityFlat: {
      id: 'spendRiseActivityFlat',
      name: 'Spend rises while activity is flat',
      severity: 'P2',
      status: SIGNAL_STATUS.UNAVAILABLE,
      threshold: `cost >= ${COST_CONTROL_THRESHOLDS.costVsActivityCostRisePercent}% and messages within +/-${COST_CONTROL_THRESHOLDS.costVsActivityMessageFlatPercent}% day-over-day`,
      observed: `unavailable (${awsCost?.error || 'AWS cost not requested'})`,
      reason: awsCost?.error || 'AWS cost not requested',
    },
    projectedMonthEndSpendBreach: {
      id: 'projectedMonthEndSpendBreach',
      name: 'Projected month-end spend breach',
      severity: 'P1',
      status: SIGNAL_STATUS.UNAVAILABLE,
      threshold: `forecast >= budget by ${COST_CONTROL_THRESHOLDS.projectedMonthEndBreachPercent}%`,
      observed: monthlyBudgetUsd
        ? `unavailable (${awsCost?.error || 'AWS cost not requested'})`
        : 'unavailable (MONTHLY_BUDGET_USD not set)',
      reason: monthlyBudgetUsd
        ? (awsCost?.error || 'AWS cost not requested')
        : 'MONTHLY_BUDGET_USD not set',
    },
    triggered: [],
    triggeredCount: 0,
  };

  const latestAwsDay = awsDaily.at(-1);
  const previousAwsDay = awsDaily.at(-2);

  if (awsCost?.ok) {
    if (!latestAwsDay || !previousAwsDay) {
      signals.awsCostJump.observed = 'unavailable (fewer than 2 AWS daily buckets)';
      signals.awsCostJump.reason = 'Fewer than 2 AWS daily buckets';
    } else {
      const deltaUsd = latestAwsDay.amount - previousAwsDay.amount;
      const deltaPercent = computePercentChange(latestAwsDay.amount, previousAwsDay.amount);
      if (deltaPercent === null) {
        signals.awsCostJump.observed = 'unavailable (previous daily cost is zero)';
        signals.awsCostJump.reason = 'Previous daily cost is zero';
      } else {
        const triggered = (
          deltaPercent >= COST_CONTROL_THRESHOLDS.awsCostJumpPercent
          && deltaUsd >= COST_CONTROL_THRESHOLDS.awsCostJumpAbsUsd
        );
        signals.awsCostJump.status = triggered ? SIGNAL_STATUS.TRIGGERED : SIGNAL_STATUS.CLEAR;
        signals.awsCostJump.observed = `${formatUsd(previousAwsDay.amount)} -> ${formatUsd(latestAwsDay.amount)} (${formatSignedUsd(deltaUsd)}, ${formatSignedPercent(deltaPercent)})`;
        signals.awsCostJump.details = {
          previousDate: previousAwsDay.date,
          date: latestAwsDay.date,
          previousUsd: previousAwsDay.amount,
          currentUsd: latestAwsDay.amount,
          deltaUsd,
          deltaPercent,
        };
        delete signals.awsCostJump.reason;
      }
    }
  }

  const costPerMessageSeries = buildCostPerMessageSeries(usage.days, awsCost);
  if (costPerMessageSeries.length >= 2) {
    const current = costPerMessageSeries.at(-1);
    const baseline = costPerMessageSeries.slice(
      Math.max(0, costPerMessageSeries.length - 1 - COST_CONTROL_THRESHOLDS.costPerMessageBaselineDays),
      costPerMessageSeries.length - 1,
    );
    if (baseline.length > 0) {
      const baselineAvg = baseline.reduce((sum, day) => sum + day.costPerMessageUsd, 0) / baseline.length;
      if (baselineAvg > 0) {
        const multiplier = current.costPerMessageUsd / baselineAvg;
        const triggered = multiplier >= COST_CONTROL_THRESHOLDS.costPerMessageMultiplier;
        signals.costPerMessageJump.status = triggered ? SIGNAL_STATUS.TRIGGERED : SIGNAL_STATUS.CLEAR;
        signals.costPerMessageJump.observed = `${formatUsd(current.costPerMessageUsd)}/msg vs ${formatUsd(baselineAvg)}/msg (${multiplier.toFixed(2)}x, ${current.source})`;
        signals.costPerMessageJump.details = {
          date: current.date,
          source: current.source,
          currentCostPerMessageUsd: current.costPerMessageUsd,
          baselineCostPerMessageUsd: baselineAvg,
          multiplier,
          baselineStartDate: baseline[0].date,
          baselineEndDate: baseline.at(-1).date,
          baselineDays: baseline.length,
        };
        delete signals.costPerMessageJump.reason;
      } else {
        signals.costPerMessageJump.observed = 'unavailable (baseline cost per message is zero)';
        signals.costPerMessageJump.reason = 'Baseline cost per message is zero';
      }
    }
  }

  if (awsCost?.ok) {
    if (!latestAwsDay || !previousAwsDay) {
      signals.spendRiseActivityFlat.observed = 'unavailable (fewer than 2 AWS daily buckets)';
      signals.spendRiseActivityFlat.reason = 'Fewer than 2 AWS daily buckets';
    } else {
      const previousMessages = Number(usageByDate.get(previousAwsDay.date)?.messagesProcessed || 0);
      const currentMessages = Number(usageByDate.get(latestAwsDay.date)?.messagesProcessed || 0);
      const costDeltaPercent = computePercentChange(latestAwsDay.amount, previousAwsDay.amount);
      const messagesDeltaPercent = computePercentChange(currentMessages, previousMessages);

      if (costDeltaPercent === null) {
        signals.spendRiseActivityFlat.observed = 'unavailable (previous daily cost is zero)';
        signals.spendRiseActivityFlat.reason = 'Previous daily cost is zero';
      } else if (messagesDeltaPercent === null) {
        signals.spendRiseActivityFlat.observed = 'unavailable (previous daily messages are zero)';
        signals.spendRiseActivityFlat.reason = 'Previous daily messages are zero';
      } else {
        const triggered = (
          costDeltaPercent >= COST_CONTROL_THRESHOLDS.costVsActivityCostRisePercent
          && Math.abs(messagesDeltaPercent) <= COST_CONTROL_THRESHOLDS.costVsActivityMessageFlatPercent
        );
        signals.spendRiseActivityFlat.status = triggered ? SIGNAL_STATUS.TRIGGERED : SIGNAL_STATUS.CLEAR;
        signals.spendRiseActivityFlat.observed = `cost ${formatSignedPercent(costDeltaPercent)}; messages ${formatSignedPercent(messagesDeltaPercent)}`;
        signals.spendRiseActivityFlat.details = {
          previousDate: previousAwsDay.date,
          date: latestAwsDay.date,
          previousCostUsd: previousAwsDay.amount,
          currentCostUsd: latestAwsDay.amount,
          costDeltaPercent,
          previousMessages,
          currentMessages,
          messagesDeltaPercent,
        };
        delete signals.spendRiseActivityFlat.reason;
      }
    }
  }

  if (!monthlyBudgetUsd || monthlyBudgetUsd <= 0) {
    signals.projectedMonthEndSpendBreach.observed = 'unavailable (MONTHLY_BUDGET_USD not set)';
    signals.projectedMonthEndSpendBreach.reason = 'MONTHLY_BUDGET_USD not set';
  } else if (!awsCost?.ok) {
    signals.projectedMonthEndSpendBreach.observed = `unavailable (${awsCost?.error || 'AWS cost not requested'})`;
    signals.projectedMonthEndSpendBreach.reason = awsCost?.error || 'AWS cost not requested';
  } else if (awsDaily.length === 0) {
    signals.projectedMonthEndSpendBreach.observed = 'unavailable (no AWS daily buckets)';
    signals.projectedMonthEndSpendBreach.reason = 'No AWS daily buckets';
  } else {
    const latestDate = latestAwsDay?.date;
    const monthDays = daysInUtcMonth(latestDate);
    if (!monthDays) {
      signals.projectedMonthEndSpendBreach.observed = 'unavailable (could not infer month days)';
      signals.projectedMonthEndSpendBreach.reason = 'Could not infer month days';
    } else {
      const totalWindowCost = awsDaily.reduce((sum, day) => sum + day.amount, 0);
      const averageDailyCost = totalWindowCost / awsDaily.length;
      const forecastMonthEndUsd = averageDailyCost * monthDays;
      const projectedOverBudgetPercent = computePercentChange(forecastMonthEndUsd, monthlyBudgetUsd);
      const triggered = forecastMonthEndUsd >= (
        monthlyBudgetUsd * (1 + (COST_CONTROL_THRESHOLDS.projectedMonthEndBreachPercent / 100))
      );

      signals.projectedMonthEndSpendBreach.status = triggered ? SIGNAL_STATUS.TRIGGERED : SIGNAL_STATUS.CLEAR;
      signals.projectedMonthEndSpendBreach.observed = `${formatUsd(forecastMonthEndUsd)} forecast vs ${formatUsd(monthlyBudgetUsd)} budget (${formatSignedPercent(projectedOverBudgetPercent)})`;
      signals.projectedMonthEndSpendBreach.details = {
        basedOnLatestDate: latestDate,
        windowDaysUsed: awsDaily.length,
        averageDailyCostUsd: averageDailyCost,
        forecastMonthEndUsd,
        budgetUsd: monthlyBudgetUsd,
        projectedOverBudgetPercent,
      };
      delete signals.projectedMonthEndSpendBreach.reason;
    }
  }

  const signalKeys = [
    'awsCostJump',
    'costPerMessageJump',
    'spendRiseActivityFlat',
    'projectedMonthEndSpendBreach',
  ];

  signals.triggered = signalKeys.filter((key) => signals[key].status === SIGNAL_STATUS.TRIGGERED);
  signals.triggeredCount = signals.triggered.length;

  return signals;
}
