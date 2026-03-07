/**
 * Avatar Health Dashboard — summary table showing per-avatar health at a glance.
 *
 * Displays: avatar name, status, memory count, last active time, consolidation status.
 * Admin-only component.
 */
import { useState, useEffect, useCallback } from 'react';
import { getAvatarHealth } from '../api/health';
import type { AvatarHealthSummary, AvatarHealthResponse } from '../api/health';

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function consolidationBadge(status: AvatarHealthSummary['consolidationStatus']) {
  switch (status) {
    case 'healthy':
      return <span className="px-2 py-0.5 text-xs rounded-full bg-green-500/20 text-green-400">Healthy</span>;
    case 'needs_consolidation':
      return <span className="px-2 py-0.5 text-xs rounded-full bg-amber-500/20 text-amber-400">Needs Consolidation</span>;
    case 'empty':
      return <span className="px-2 py-0.5 text-xs rounded-full bg-gray-500/20 text-gray-400">Empty</span>;
    default:
      return <span className="px-2 py-0.5 text-xs rounded-full bg-gray-500/20 text-gray-400">Unknown</span>;
  }
}

function statusBadge(status: string) {
  const colors: Record<string, string> = {
    active: 'bg-green-500/20 text-green-400',
    draft: 'bg-gray-500/20 text-gray-400',
    paused: 'bg-amber-500/20 text-amber-400',
    deleted: 'bg-red-500/20 text-red-400',
  };
  const cls = colors[status] || 'bg-gray-500/20 text-gray-400';
  return <span className={`px-2 py-0.5 text-xs rounded-full ${cls}`}>{status}</span>;
}

interface HealthDashboardProps {
  onSelectAvatar?: (avatarId: string) => void;
}

export function HealthDashboard({ onSelectAvatar }: HealthDashboardProps) {
  const [data, setData] = useState<AvatarHealthResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchHealth = useCallback(async (cursor?: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await getAvatarHealth(20, cursor);
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load health data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHealth();
  }, [fetchHealth]);

  if (loading && !data) {
    return (
      <div className="p-4 text-center text-[var(--color-text-secondary)]">
        Loading health data...
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="p-4 text-center text-red-400">
        {error}
      </div>
    );
  }

  if (!data || data.avatars.length === 0) {
    return (
      <div className="p-4 text-center text-[var(--color-text-secondary)]">
        No avatars found.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--color-text)]">
          Avatar Health ({data.total})
        </h2>
        <button
          onClick={() => fetchHealth()}
          disabled={loading}
          className="text-xs px-2 py-1 rounded bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] disabled:opacity-50"
        >
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[var(--color-text-secondary)] border-b border-[var(--color-border)]">
              <th className="pb-2 pr-3 font-medium">Avatar</th>
              <th className="pb-2 pr-3 font-medium">Status</th>
              <th className="pb-2 pr-3 font-medium text-right">Memories</th>
              <th className="pb-2 pr-3 font-medium">Last Active</th>
              <th className="pb-2 pr-3 font-medium">Consolidation</th>
              <th className="pb-2 font-medium text-right">Errors (24h)</th>
            </tr>
          </thead>
          <tbody>
            {data.avatars.map((avatar) => (
              <tr
                key={avatar.avatarId}
                className="border-b border-[var(--color-border)] hover:bg-[var(--color-bg-secondary)] cursor-pointer"
                onClick={() => onSelectAvatar?.(avatar.avatarId)}
              >
                <td className="py-2 pr-3 font-medium text-[var(--color-text)]">
                  {avatar.name}
                </td>
                <td className="py-2 pr-3">{statusBadge(avatar.status)}</td>
                <td className="py-2 pr-3 text-right text-[var(--color-text)]">
                  <span title={`Immediate: ${avatar.memoryCounts.immediate}, Recent: ${avatar.memoryCounts.recent}, Core: ${avatar.memoryCounts.core}`}>
                    {avatar.memoryCounts.total}
                  </span>
                </td>
                <td className="py-2 pr-3 text-[var(--color-text-secondary)]">
                  {formatRelativeTime(avatar.lastActiveAt)}
                </td>
                <td className="py-2 pr-3">{consolidationBadge(avatar.consolidationStatus)}</td>
                <td className="py-2 text-right">
                  {avatar.errorCount > 0 ? (
                    <span className="px-2 py-0.5 rounded-full bg-red-500/20 text-red-400">
                      {avatar.errorCount}
                    </span>
                  ) : (
                    <span className="text-[var(--color-text-secondary)]">0</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {data.cursor && (
        <div className="flex justify-center pt-2">
          <button
            onClick={() => fetchHealth(data.cursor)}
            disabled={loading}
            className="text-xs px-3 py-1 rounded bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] disabled:opacity-50"
          >
            Load more
          </button>
        </div>
      )}
    </div>
  );
}
