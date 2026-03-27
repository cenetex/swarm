/**
 * Avatar Health Dashboard — summary table showing per-avatar health at a glance.
 *
 * Displays: avatar name, status, memory count, last active time, consolidation status.
 * Admin-only component.
 */
import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { getAvatarHealth } from '../api/health';
import type { AvatarHealthSummary, AvatarHealthResponse } from '../api/health';
import type { TFunction } from 'i18next';

function formatRelativeTime(timestamp: number, t: TFunction): string {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return t('healthDashboard.justNow');
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}${t('healthDashboard.minutesAgo')}`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}${t('healthDashboard.hoursAgo')}`;
  return `${Math.floor(diff / 86_400_000)}${t('healthDashboard.daysAgo')}`;
}

function consolidationBadge(status: AvatarHealthSummary['consolidationStatus'], t: TFunction) {
  switch (status) {
    case 'healthy':
      return <span className="px-2 py-0.5 text-xs rounded-full bg-green-500/20 text-green-400">{t('healthDashboard.healthy')}</span>;
    case 'needs_consolidation':
      return <span className="px-2 py-0.5 text-xs rounded-full bg-amber-500/20 text-amber-400">{t('healthDashboard.needsConsolidation')}</span>;
    case 'empty':
      return <span className="px-2 py-0.5 text-xs rounded-full bg-gray-500/20 text-gray-400">{t('healthDashboard.empty')}</span>;
    default:
      return <span className="px-2 py-0.5 text-xs rounded-full bg-gray-500/20 text-gray-400">{t('healthDashboard.unknown')}</span>;
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
  const { t } = useTranslation();
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
      setError(err instanceof Error ? err.message : t('healthDashboard.error'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchHealth();
  }, [fetchHealth]);

  if (loading && !data) {
    return (
      <div className="p-4 text-center text-[var(--color-text-secondary)]">
        {t('healthDashboard.loading')}
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
        {t('healthDashboard.noAvatars')}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--color-text)]">
          {t('healthDashboard.heading', { count: data.total })}
        </h2>
        <button
          onClick={() => fetchHealth()}
          disabled={loading}
          className="text-xs px-2 py-1 rounded bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:text-[var(--color-text)] disabled:opacity-50"
        >
          {loading ? t('healthDashboard.refreshing') : t('healthDashboard.refresh')}
        </button>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[var(--color-text-secondary)] border-b border-[var(--color-border)]">
              <th className="pb-2 pr-3 font-medium">{t('healthDashboard.headerAvatar')}</th>
              <th className="pb-2 pr-3 font-medium">{t('healthDashboard.headerStatus')}</th>
              <th className="pb-2 pr-3 font-medium text-right">{t('healthDashboard.headerMemories')}</th>
              <th className="pb-2 pr-3 font-medium">{t('healthDashboard.headerLastActive')}</th>
              <th className="pb-2 pr-3 font-medium">{t('healthDashboard.headerConsolidation')}</th>
              <th className="pb-2 font-medium text-right">{t('healthDashboard.headerErrors')}</th>
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
                  {formatRelativeTime(avatar.lastActiveAt, t)}
                </td>
                <td className="py-2 pr-3">{consolidationBadge(avatar.consolidationStatus, t)}</td>
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
            {t('healthDashboard.loadMore')}
          </button>
        </div>
      )}
    </div>
  );
}
