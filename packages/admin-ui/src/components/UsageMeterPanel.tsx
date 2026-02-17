/**
 * Usage Meter Panel
 *
 * Chat-first inline component displaying current usage vs entitlement limits,
 * energy status, and historical usage sparklines. Designed to be rendered
 * inside the chat message stream or sidebar, not as a standalone page.
 */
import { useState, useEffect, useCallback } from 'react';
import {
  getAvatarUsage,
  getAvatarUsageHistory,
  type UsageResponse,
  type UsageMeter,
  type DailyUsageSummary,
} from '../api/usage';

interface UsageMeterPanelProps {
  avatarId: string;
  compact?: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function meterPercent(meter: UsageMeter): number {
  if (meter.limit <= 0) return 0; // unlimited
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

// ── Mini Sparkline (pure SVG, no chart library) ────────────────────────────

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
      {/* dot on last point */}
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

// ── Single Meter Bar ───────────────────────────────────────────────────────

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

// ── Main Component ─────────────────────────────────────────────────────────

export function UsageMeterPanel({ avatarId, compact = false }: UsageMeterPanelProps) {
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [history, setHistory] = useState<DailyUsageSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [usageData, historyData] = await Promise.all([
        getAvatarUsage(avatarId),
        getAvatarUsageHistory(avatarId, 7),
      ]);
      setUsage(usageData);
      setHistory(historyData.history);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load usage data');
    } finally {
      setLoading(false);
    }
  }, [avatarId]);

  useEffect(() => {
    fetchData();
    // Refresh every 60 seconds
    const interval = setInterval(fetchData, 60_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  // ── Loading State ──────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="p-4 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-xl animate-pulse">
        <div className="h-3 bg-[var(--color-bg-secondary)] rounded w-20 mb-3"></div>
        <div className="space-y-2">
          <div className="h-2 bg-[var(--color-bg-secondary)] rounded w-full"></div>
          <div className="h-2 bg-[var(--color-bg-secondary)] rounded w-3/4"></div>
          <div className="h-2 bg-[var(--color-bg-secondary)] rounded w-5/6"></div>
        </div>
      </div>
    );
  }

  // ── Error State ────────────────────────────────────────────────────────

  if (error && !usage) {
    return (
      <div className="p-4 bg-red-900/20 border border-red-500/30 rounded-xl">
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

  if (!usage) return null;

  const { meters, energy } = usage;

  // Build sparkline data from history
  const msgSpark = history?.map((d) => d.messagesProcessed) ?? [];
  const mediaSpark = history?.map((d) => d.mediaCreditsUsed) ?? [];
  const voiceSpark = history?.map((d) => d.voiceMinutesUsed) ?? [];

  // ── Compact View ───────────────────────────────────────────────────────

  if (compact) {
    const msgPct = meters.messages.limit === -1 ? 0 : meterPercent(meters.messages);
    const mediaPct = meters.media.limit === -1 ? 0 : meterPercent(meters.media);
    const worstPct = Math.max(msgPct, mediaPct);

    return (
      <div className="flex items-center gap-2 text-sm">
        <span className="text-lg">
          {worstPct >= 90 ? '!!' : worstPct >= 70 ? '!' : ''}
        </span>
        <div className="flex-1 space-y-0.5">
          <div className="flex items-center gap-1">
            <div className="flex-1 h-1 bg-[var(--color-bg-tertiary)] rounded-full overflow-hidden">
              <div
                className={`h-full ${meters.messages.limit === -1 ? 'bg-brand-500' : meterColor(msgPct)} transition-all duration-300 rounded-full`}
                style={{ width: meters.messages.limit === -1 ? '100%' : `${msgPct}%` }}
              />
            </div>
            <span className="text-[var(--color-text-muted)] font-mono text-[10px] w-12 text-right">
              {meters.messages.used}/{meters.messages.limit === -1 ? 'inf' : meters.messages.limit}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <div className="flex-1 h-1 bg-[var(--color-bg-tertiary)] rounded-full overflow-hidden">
              <div
                className={`h-full ${meters.media.limit === -1 ? 'bg-brand-500' : meterColor(mediaPct)} transition-all duration-300 rounded-full`}
                style={{ width: meters.media.limit === -1 ? '100%' : `${mediaPct}%` }}
              />
            </div>
            <span className="text-[var(--color-text-muted)] font-mono text-[10px] w-12 text-right">
              {meters.media.used}/{meters.media.limit === -1 ? 'inf' : meters.media.limit}
            </span>
          </div>
        </div>
      </div>
    );
  }

  // ── Full View ──────────────────────────────────────────────────────────

  return (
    <div className="p-4 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-[var(--color-text-secondary)]">
            Daily Usage
          </span>
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded-full border font-medium uppercase ${planBadgeColor(usage.plan)}`}
          >
            {usage.plan}
          </span>
        </div>
        <div className="text-xs text-[var(--color-text-muted)] font-mono">
          {usage.date}
        </div>
      </div>

      {/* Main Meters */}
      <div className="space-y-2.5">
        <MeterBar meter={meters.messages} sparkData={msgSpark} />
        <MeterBar meter={meters.media} sparkData={mediaSpark} />
        <MeterBar meter={meters.voice} sparkData={voiceSpark} />
      </div>

      {/* Energy Summary (if available) */}
      {energy && (
        <div className="mt-3 flex items-center gap-2 text-xs bg-[var(--color-bg-secondary)] rounded-lg px-2.5 py-1.5">
          <span className="text-yellow-400">Energy</span>
          <div className="flex-1 h-1 bg-[var(--color-bg-tertiary)] rounded-full overflow-hidden">
            <div
              className="h-full bg-yellow-500 transition-all duration-300 rounded-full"
              style={{ width: `${energy.max > 0 ? (energy.current / energy.max) * 100 : 0}%` }}
            />
          </div>
          <span className="font-mono text-[var(--color-text-muted)]">
            {energy.current.toFixed(1)}/{energy.max}
          </span>
          {typeof energy.bankCredits === 'number' && energy.bankCredits > 0 && (
            <span className="text-blue-400 ml-1">+{energy.bankCredits} bank</span>
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
                    meters.messages.limit > 0 ? meters.messages.limit : 1,
                    1,
                  );
                  const barHeight = Math.max(
                    4,
                    (day.messagesProcessed / dayMax) * 40,
                  );
                  const dayLabel = day.date.slice(5); // MM-DD

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

          {/* Refresh button */}
          <div className="flex justify-end">
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
      )}

      {/* Error display */}
      {error && (
        <div className="mt-2 text-xs text-red-400">{error}</div>
      )}
    </div>
  );
}

export default UsageMeterPanel;
