/**
 * Plan & Usage Panel
 *
 * Unified inline component that merges plan/entitlement info with usage meters.
 * Designed to be rendered inside the chat header area (chat-first, not a modal).
 * Single fetch lifecycle with clear loading/error states.
 */
import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  getAvatarEffectiveLimits,
  setAvatarEntitlement,
  type EffectiveLimitsResponse,
  type PlanType,
} from '../api/entitlements';
import {
  getAvatarUsage,
  getAvatarUsageHistory,
  type UsageResponse,
  type UsageMeter,
  type DailyUsageSummary,
} from '../api/usage';

interface PlanUsagePanelProps {
  avatarId: string;
  avatarName: string;
  canEdit: boolean;
  onClose: () => void;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function meterPercent(meter: UsageMeter): number {
  if (meter.limit <= 0) return 0;
  return Math.min(100, (meter.used / meter.limit) * 100);
}

function meterColor(pct: number): string {
  if (pct >= 90) return 'bg-red-500';
  if (pct >= 70) return 'bg-yellow-500';
  return 'bg-green-500';
}

function meterTextColor(pct: number): string {
  if (pct >= 90) return 'text-red-400';
  if (pct >= 70) return 'text-yellow-400';
  return 'text-green-400';
}

function formatLimit(limit: number): string {
  if (limit === -1) return 'unlimited';
  return String(limit);
}

function formatLimitValue(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function planBadgeColor(plan: string): string {
  switch (plan) {
    case 'enterprise':
      return 'bg-purple-900/30 text-purple-300 border-purple-500/30';
    case 'pro':
      return 'bg-blue-900/30 text-blue-300 border-blue-500/30';
    default:
      return 'bg-gray-800/30 text-gray-300 border-gray-500/30';
  }
}

// ── Mini Sparkline ───────────────────────────────────────────────────────────

function Sparkline({
  data,
  color = '#22c55e',
  height = 32,
  width = 120,
}: {
  data: number[];
  color?: string;
  height?: number;
  width?: number;
}) {
  if (data.length < 2) return null;

  const max = Math.max(...data, 1);
  const step = width / (data.length - 1);
  const points = data
    .map((v, i) => `${i * step},${height - (v / max) * (height - 4)}`)
    .join(' ');

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="inline-block"
    >
      <polyline
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        points={points}
      />
      {data.length > 0 && (
        <circle
          cx={(data.length - 1) * step}
          cy={height - (data[data.length - 1] / max) * (height - 4)}
          r="2.5"
          fill={color}
        />
      )}
    </svg>
  );
}

// ── Meter Bar ────────────────────────────────────────────────────────────────

function MeterBar({
  meter,
  sparkData,
}: {
  meter: UsageMeter;
  sparkData?: number[];
}) {
  const isUnlimited = meter.limit === -1;
  const pct = isUnlimited ? 0 : meterPercent(meter);
  const barColor = isUnlimited ? 'bg-brand-500' : meterColor(pct);

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-[var(--color-text-secondary)] font-medium">
          {meter.label}
        </span>
        <div className="flex items-center gap-2">
          {sparkData && sparkData.length > 1 && (
            <Sparkline
              data={sparkData}
              color={isUnlimited ? '#6366f1' : pct >= 90 ? '#ef4444' : pct >= 70 ? '#eab308' : '#22c55e'}
              width={60}
              height={16}
            />
          )}
          <span className={`font-mono ${isUnlimited ? 'text-brand-400' : meterTextColor(pct)}`}>
            {meter.used}{isUnlimited ? '' : `/${formatLimit(meter.limit)}`}
          </span>
        </div>
      </div>
      <div className="h-1.5 bg-[var(--color-bg-secondary)] rounded-full overflow-hidden">
        <div
          className={`h-full ${barColor} transition-all duration-500 rounded-full`}
          style={{ width: isUnlimited ? '100%' : `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ── Main Component ───────────────────────────────────────────────────────────

export function PlanUsagePanel({ avatarId, avatarName, canEdit, onClose }: PlanUsagePanelProps) {
  // Plan/entitlement state
  const [effective, setEffective] = useState<EffectiveLimitsResponse | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<PlanType>('free');
  const [saving, setSaving] = useState(false);

  // Usage state
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [history, setHistory] = useState<DailyUsageSummary[] | null>(null);

  // Shared lifecycle
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [activeTab, setActiveTab] = useState<'usage' | 'limits'>('usage');

  // ── Fetch all data in parallel ──────────────────────────────────────────

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [limitsData, usageData, historyData] = await Promise.all([
        getAvatarEffectiveLimits(avatarId),
        getAvatarUsage(avatarId),
        getAvatarUsageHistory(avatarId, 7),
      ]);
      setEffective(limitsData);
      setSelectedPlan(limitsData.plan);
      setUsage(usageData);
      setHistory(historyData.history);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load plan & usage data');
    } finally {
      setLoading(false);
    }
  }, [avatarId]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // ── Plan save handler ───────────────────────────────────────────────────

  const handleSave = async () => {
    if (!canEdit) return;
    setSaving(true);
    setError(null);
    try {
      await setAvatarEntitlement(avatarId, { plan: selectedPlan });
      // Refresh all data after plan change
      const [limitsData, usageData] = await Promise.all([
        getAvatarEffectiveLimits(avatarId),
        getAvatarUsage(avatarId),
      ]);
      setEffective(limitsData);
      setUsage(usageData);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update plan');
    } finally {
      setSaving(false);
    }
  };

  // ── Derived data ────────────────────────────────────────────────────────

  const limitRows = useMemo(() => {
    const limits = effective?.limits || {};
    const keys = [
      'memoryEnabled',
      'memoryRetentionDays',
      'dailyMessageLimit',
      'dailyMediaCredits',
      'dailyVoiceMinutes',
      'maxToolCallsPerMessage',
      'autonomousPostsEnabled',
      'priorityProcessing',
    ];
    return keys
      .filter((k) => Object.prototype.hasOwnProperty.call(limits, k))
      .map((k) => ({ key: k, value: (limits as Record<string, unknown>)[k] }));
  }, [effective]);

  const msgSpark = history?.map((d) => d.messagesProcessed) ?? [];
  const mediaSpark = history?.map((d) => d.mediaCreditsUsed) ?? [];
  const voiceSpark = history?.map((d) => d.voiceMinutesUsed) ?? [];

  // ── Loading State ───────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="p-4 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-xl animate-pulse">
        <div className="flex items-center justify-between mb-3">
          <div className="h-4 bg-[var(--color-bg-secondary)] rounded w-32"></div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            aria-label="Close"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>
        <div className="space-y-2">
          <div className="h-2 bg-[var(--color-bg-secondary)] rounded w-full"></div>
          <div className="h-2 bg-[var(--color-bg-secondary)] rounded w-3/4"></div>
          <div className="h-2 bg-[var(--color-bg-secondary)] rounded w-5/6"></div>
        </div>
      </div>
    );
  }

  // ── Error State (no data at all) ────────────────────────────────────────

  if (error && !usage && !effective) {
    return (
      <div className="p-4 bg-red-900/20 border border-red-500/30 rounded-xl">
        <div className="flex items-center justify-between mb-2">
          <span className="text-red-300 text-sm font-medium">Plan & Usage</span>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-red-800/30 text-red-400 hover:text-red-300"
            aria-label="Close"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>
        <div className="text-red-300 text-sm">{error}</div>
        <button
          onClick={fetchData}
          className="mt-2 text-xs text-red-400 hover:text-red-300 underline"
        >
          Retry
        </button>
      </div>
    );
  }

  // ── Main Panel ──────────────────────────────────────────────────────────

  const plan = usage?.plan || effective?.plan || 'free';

  return (
    <div className="p-4 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div>
            <span className="text-sm font-medium text-[var(--color-text)]">
              Plan & Usage
            </span>
            <span className="text-xs text-[var(--color-text-muted)] ml-1.5">
              {avatarName}
            </span>
          </div>
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded-full border font-medium uppercase ${planBadgeColor(plan)}`}
          >
            {plan}
          </span>
          {effective?.source && (
            <span className="text-[10px] text-[var(--color-text-muted)]">
              {effective.source}{effective.entitlementStatus ? ` / ${effective.entitlementStatus}` : ''}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {usage?.date && (
            <span className="text-xs text-[var(--color-text-muted)] font-mono">
              {usage.date}
            </span>
          )}
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            aria-label="Close panel"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Inline error banner (partial data loaded) */}
      {error && (
        <div className="mb-3 p-2 rounded-lg bg-red-900/20 border border-red-500/30 text-red-400 text-xs">
          {error}
        </div>
      )}

      {/* Tab Switcher */}
      <div className="flex gap-1 mb-3 bg-[var(--color-bg-secondary)] rounded-lg p-0.5">
        <button
          onClick={() => setActiveTab('usage')}
          className={`flex-1 px-3 py-1 text-xs font-medium rounded-md transition-colors ${
            activeTab === 'usage'
              ? 'bg-[var(--color-bg-tertiary)] text-[var(--color-text)]'
              : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'
          }`}
        >
          Usage
        </button>
        <button
          onClick={() => setActiveTab('limits')}
          className={`flex-1 px-3 py-1 text-xs font-medium rounded-md transition-colors ${
            activeTab === 'limits'
              ? 'bg-[var(--color-bg-tertiary)] text-[var(--color-text)]'
              : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'
          }`}
        >
          Plan Limits
        </button>
      </div>

      {/* ── Usage Tab ────────────────────────────────────────────────────── */}
      {activeTab === 'usage' && usage && (
        <>
          {/* Main Meters */}
          <div className="space-y-2.5">
            <MeterBar meter={usage.meters.messages} sparkData={msgSpark} />
            <MeterBar meter={usage.meters.media} sparkData={mediaSpark} />
            <MeterBar meter={usage.meters.voice} sparkData={voiceSpark} />
          </div>

          {/* Energy */}
          {usage.energy && (
            <div className="mt-3 flex items-center gap-2 text-xs bg-[var(--color-bg-secondary)] rounded-lg px-2.5 py-1.5">
              <span className="text-yellow-400">Energy</span>
              <div className="flex-1 h-1 bg-[var(--color-bg-tertiary)] rounded-full overflow-hidden">
                <div
                  className="h-full bg-yellow-500 transition-all duration-300 rounded-full"
                  style={{ width: `${usage.energy.max > 0 ? (usage.energy.current / usage.energy.max) * 100 : 0}%` }}
                />
              </div>
              <span className="font-mono text-[var(--color-text-muted)]">
                {usage.energy.current.toFixed(1)}/{usage.energy.max}
              </span>
              {typeof usage.energy.bankCredits === 'number' && usage.energy.bankCredits > 0 && (
                <span className="text-blue-400 ml-1">+{usage.energy.bankCredits} bank</span>
              )}
            </div>
          )}

          {/* Details Toggle */}
          <button
            onClick={() => setShowDetails(!showDetails)}
            className="mt-3 text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-text)] flex items-center gap-1"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 20 20"
              fill="currentColor"
              className={`w-4 h-4 transition-transform ${showDetails ? 'rotate-180' : ''}`}
            >
              <path
                fillRule="evenodd"
                d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
                clipRule="evenodd"
              />
            </svg>
            {showDetails ? 'Hide Details' : 'Show Details'}
          </button>

          {/* Expanded Details */}
          {showDetails && (
            <div className="mt-3 border-t border-[var(--color-border)] pt-3 space-y-3">
              {/* 7-day history chart */}
              {history && history.length > 1 && (
                <div>
                  <div className="text-xs font-medium text-[var(--color-text-secondary)] mb-2">
                    7-Day History
                  </div>
                  <div className="grid grid-cols-7 gap-1">
                    {history.map((day) => {
                      const dayMax = Math.max(
                        usage.meters.messages.limit > 0 ? usage.meters.messages.limit : 1,
                        1,
                      );
                      const barHeight = Math.max(
                        4,
                        (day.messagesProcessed / dayMax) * 40,
                      );
                      const dayLabel = day.date.slice(5);
                      return (
                        <div key={day.date} className="flex flex-col items-center gap-1">
                          <div
                            className="w-full bg-brand-500/60 rounded-sm transition-all"
                            style={{ height: `${barHeight}px` }}
                            title={`${day.date}: ${day.messagesProcessed} msgs, ${day.mediaCreditsUsed} media`}
                          />
                          <span className="text-[9px] text-[var(--color-text-muted)]">
                            {dayLabel}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Tool Credit Breakdown */}
              {Object.keys(usage.toolCredits).length > 0 && (
                <div>
                  <div className="text-xs font-medium text-[var(--color-text-secondary)] mb-1.5">
                    Tool Credits
                  </div>
                  <div className="space-y-1">
                    {Object.entries(usage.toolCredits).map(([tool, credit]) => (
                      <div
                        key={tool}
                        className="flex items-center justify-between text-[11px] bg-[var(--color-bg-secondary)] rounded px-2 py-1"
                      >
                        <span className="text-[var(--color-text-secondary)] font-mono">
                          {tool}
                        </span>
                        <span className="text-[var(--color-text-muted)] font-mono">
                          {credit.remaining}/{credit.limit} credits
                          <span className="ml-2 text-[var(--color-text-muted)]">
                            ({credit.dailyRemaining}/{credit.dailyLimit} daily)
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {activeTab === 'usage' && !usage && (
        <div className="text-sm text-[var(--color-text-muted)] py-2">No usage data available.</div>
      )}

      {/* ── Limits Tab ───────────────────────────────────────────────────── */}
      {activeTab === 'limits' && (
        <>
          {/* Plan Selector (admin only) */}
          {canEdit && (
            <div className="flex items-center gap-2 mb-3">
              <select
                value={selectedPlan}
                onChange={(e) => setSelectedPlan(e.target.value as PlanType)}
                disabled={loading || saving}
                className="flex-1 px-3 py-1.5 text-sm rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] text-[var(--color-text)] focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-60"
              >
                <option value="free">free</option>
                <option value="pro">pro</option>
                <option value="enterprise">enterprise</option>
              </select>
              <button
                onClick={handleSave}
                disabled={loading || saving}
                className="px-3 py-1.5 text-sm rounded-lg bg-brand-600 hover:bg-brand-500 text-white font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          )}

          {/* Effective Limits Table */}
          {effective ? (
            <div className="space-y-1">
              {limitRows.length > 0 ? (
                limitRows.map((row) => (
                  <div key={row.key} className="flex items-center justify-between text-xs py-0.5">
                    <div className="text-[var(--color-text-secondary)]">{row.key}</div>
                    <div className="text-[var(--color-text)] font-mono">{formatLimitValue(row.value)}</div>
                  </div>
                ))
              ) : (
                <div className="text-sm text-[var(--color-text-muted)]">No limits returned.</div>
              )}
            </div>
          ) : (
            <div className="text-sm text-[var(--color-text-muted)] py-2">No plan data available.</div>
          )}

          {!canEdit && (
            <p className="text-xs text-[var(--color-text-muted)] mt-2">
              Plan editing is admin-only.
            </p>
          )}
        </>
      )}

      {/* Refresh button */}
      <div className="flex justify-end mt-3">
        <button
          onClick={fetchData}
          className="text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-text)] flex items-center gap-1"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 20 20"
            fill="currentColor"
            className="w-3.5 h-3.5"
          >
            <path
              fillRule="evenodd"
              d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H4.847a.75.75 0 00-.75.75v3.385a.75.75 0 001.5 0v-1.586l.18.18a7 7 0 0011.712-3.138.75.75 0 00-1.449-.391zm-10.624-2.85a5.5 5.5 0 019.201-2.465l.312.31H11.77a.75.75 0 000 1.5h3.385a.75.75 0 00.75-.75V3.784a.75.75 0 00-1.5 0v1.586l-.18-.18A7 7 0 003.514 8.328a.75.75 0 001.449.39l-.275.857z"
              clipRule="evenodd"
            />
          </svg>
          Refresh
        </button>
      </div>
    </div>
  );
}

export default PlanUsagePanel;
