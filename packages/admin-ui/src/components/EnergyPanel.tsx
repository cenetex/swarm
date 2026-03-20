/**
 * Energy Panel Component
 * Displays avatar energy status with dynamic refill rate based on $RATI token holdings.
 */
import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import * as avatarApi from '../api/avatars';
import type { EnergyStatus, EnergyEvent } from '../api/avatars';

interface EnergyPanelProps {
  avatarId: string;
  isAdmin?: boolean;
  compact?: boolean;
}

/**
 * Format duration in human-readable format
 */
type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

function formatDuration(ms: number, t: TranslateFn): string {
  if (ms <= 0) return t('energy.now');
  
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  
  if (hours > 0) {
    return t('energy.durationHoursMinutes', { hours, minutes });
  }
  return t('energy.durationMinutes', { minutes });
}

/**
 * Format token balance for display
 */
function formatTokenBalance(balance: number): string {
  if (balance >= 1_000_000) {
    return `${(balance / 1_000_000).toFixed(2)}M`;
  }
  if (balance >= 1_000) {
    return `${(balance / 1_000).toFixed(1)}K`;
  }
  return balance.toFixed(0);
}

/**
 * Format relative time
 */
function formatRelativeTime(timestamp: number, t: TranslateFn): string {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return t('energy.justNow');
  if (diff < 3600_000) return t('energy.minutesAgo', { minutes: Math.floor(diff / 60_000) });
  if (diff < 86400_000) return t('energy.hoursAgo', { hours: Math.floor(diff / 3600_000) });
  return t('energy.daysAgo', { days: Math.floor(diff / 86400_000) });
}

export function EnergyPanel({ avatarId, isAdmin = false, compact = false }: EnergyPanelProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<EnergyStatus | null>(null);
  const [history, setHistory] = useState<EnergyEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [burnBusy, setBurnBusy] = useState(false);
  const [burnMessage, setBurnMessage] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [adminAction, setAdminAction] = useState<'set' | 'add' | null>(null);
  const [adminValue, setAdminValue] = useState('');
  const [actionBusy, setActionBusy] = useState(false);

  const fetchStatus = useCallback(async () => {
    try {
      const data = await avatarApi.getEnergyStatus(avatarId);
      setStatus(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : t('energy.loadStatusFailed'));
    } finally {
      setLoading(false);
    }
  }, [avatarId, t]);

  const fetchHistory = useCallback(async () => {
    try {
      const data = await avatarApi.getEnergyHistory(avatarId, 10);
      setHistory(data.events);
    } catch (e) {
      console.error('Failed to load energy history', e);
    }
  }, [avatarId, t]);

  const handleBurn = useCallback(async () => {
    setBurnBusy(true);
    setBurnMessage(null);
    try {
      await avatarApi.burnDepositedTokensForEnergy(avatarId);
      setBurnMessage(t('energy.burnComplete'));
      await fetchStatus();
      if (showHistory) {
        await fetchHistory();
      }
    } catch (e) {
      setBurnMessage(e instanceof Error ? e.message : t('energy.burnFailed'));
    } finally {
      setBurnBusy(false);
    }
  }, [avatarId, fetchHistory, fetchStatus, showHistory, t]);

  useEffect(() => {
    fetchStatus();
    // Auto-refresh every 30 seconds
    const interval = setInterval(fetchStatus, 30_000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  useEffect(() => {
    if (showHistory) {
      fetchHistory();
    }
  }, [showHistory, fetchHistory]);

  const handleAdminAction = async () => {
    if (!adminAction || !adminValue) return;
    
    setActionBusy(true);
    try {
      const value = parseFloat(adminValue);
      if (isNaN(value) || value < 0) {
        throw new Error(t('energy.invalidValue'));
      }

      if (adminAction === 'set') {
        await avatarApi.setEnergy(avatarId, value);
      } else {
        await avatarApi.addEnergy(avatarId, value);
      }
      
      await fetchStatus();
      setAdminAction(null);
      setAdminValue('');
    } catch (e) {
      setError(e instanceof Error ? e.message : t('energy.actionFailed'));
    } finally {
      setActionBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="p-4 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-xl animate-pulse">
        <div className="h-4 bg-[var(--color-bg-secondary)] rounded w-24 mb-2"></div>
        <div className="h-6 bg-[var(--color-bg-secondary)] rounded w-full"></div>
      </div>
    );
  }

  if (error && !status) {
    return (
      <div className="p-4 bg-red-900/20 border border-red-500/30 rounded-xl">
        <div className="text-red-300 text-sm">{error}</div>
        <button 
          onClick={fetchStatus}
          className="mt-2 text-xs text-red-400 hover:text-red-300 underline"
        >
          {t('common.retry')}
        </button>
      </div>
    );
  }

  if (!status) return null;

  const energyPercent = (status.currentEnergy / status.maxEnergy) * 100;
  const hasBonus = status.bonusRefillPerHour > 0;

  // Determine energy bar color based on level
  let barColor = 'bg-green-500';
  if (energyPercent <= 20) {
    barColor = 'bg-red-500';
  } else if (energyPercent <= 50) {
    barColor = 'bg-yellow-500';
  }

  // Compact view for sidebar
  if (compact) {
    return (
      <div className="flex items-center gap-2 text-sm">
        <span className="text-lg">⚡</span>
        <div className="flex-1 h-2 bg-[var(--color-bg-tertiary)] rounded-full overflow-hidden">
          <div 
            className={`h-full ${barColor} transition-all duration-300`}
            style={{ width: `${energyPercent}%` }}
          />
        </div>
        <span className="text-[var(--color-text-secondary)] font-mono text-xs">
          {status.currentEnergy.toFixed(1)}/{status.maxEnergy}
        </span>
      </div>
    );
  }

  return (
    <div className="p-4 bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] rounded-xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-xl">⚡</span>
          <span className="text-sm font-medium text-[var(--color-text-secondary)]">{t('energy.title')}</span>
        </div>
        <div className="flex gap-1">
          <button
            onClick={handleBurn}
            disabled={burnBusy}
            className="px-2 py-1 text-xs rounded transition-colors bg-[var(--color-bg-secondary)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text)] disabled:opacity-50"
            title={t('energy.burnDepositsTitle')}
          >
            {burnBusy ? t('energy.burning') : t('energy.burnDeposits')}
          </button>

          {isAdmin && (
            <>
              <button
                onClick={() => setAdminAction(adminAction === 'set' ? null : 'set')}
                className={`px-2 py-1 text-xs rounded transition-colors ${
                  adminAction === 'set'
                    ? 'bg-brand-500 text-white'
                    : 'bg-[var(--color-bg-secondary)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text)]'
                }`}
                >
                {t('energy.set')}
              </button>
              <button
                onClick={() => setAdminAction(adminAction === 'add' ? null : 'add')}
                className={`px-2 py-1 text-xs rounded transition-colors ${
                  adminAction === 'add'
                    ? 'bg-brand-500 text-white'
                    : 'bg-[var(--color-bg-secondary)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text)]'
                }`}
                >
                {t('energy.add')}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Admin Action Input */}
      {adminAction && (
        <div className="mb-3 flex items-center gap-2">
          <input
            type="number"
            value={adminValue}
            onChange={(e) => setAdminValue(e.target.value)}
            placeholder={adminAction === 'set' ? t('energy.setToPlaceholder') : t('energy.addAmountPlaceholder')}
            min="0"
            max={adminAction === 'set' ? status.maxEnergy : undefined}
            step="0.1"
            className="flex-1 px-3 py-1.5 text-sm bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-lg text-[var(--color-text)]"
          />
          <button
            onClick={handleAdminAction}
            disabled={actionBusy || !adminValue}
            className="px-3 py-1.5 text-sm bg-brand-500 text-white rounded-lg hover:bg-brand-600 disabled:opacity-50"
          >
            {actionBusy ? t('common.loading') : t('energy.apply')}
          </button>
        </div>
      )}

      {/* Energy Bar */}
      <div className="relative mb-2">
        <div className="h-4 bg-[var(--color-bg-secondary)] rounded-full overflow-hidden">
          <div 
            className={`h-full ${barColor} transition-all duration-500`}
            style={{ width: `${energyPercent}%` }}
          />
        </div>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-xs font-mono text-white drop-shadow-md">
            {status.currentEnergy.toFixed(1)} / {status.maxEnergy}
          </span>
        </div>
      </div>

      {/* Refill Rate */}
      <div className="flex items-center justify-between text-xs text-[var(--color-text-tertiary)] mb-2">
        <div className="flex items-center gap-1">
          <span>{t('energy.refill')}</span>
          <span className="font-mono text-[var(--color-text-secondary)]">
            +{status.refillPerHour.toFixed(1)}/hr
          </span>
          {hasBonus && (
            <span className="text-green-400 ml-1">
              {t('energy.bonusRefill', { base: status.baseRefillPerHour, bonus: status.bonusRefillPerHour.toFixed(1) })}
            </span>
          )}
        </div>
      </div>

      {/* Token Balance & Bonus Info */}
      {status.ownerTokenBalance > 0 ? (
        <div className="flex items-center gap-2 text-xs bg-green-900/20 text-green-300 px-2 py-1 rounded-lg mb-2">
          <span>💎</span>
          <span>
            {t('energy.tokenBonus', { balance: formatTokenBalance(status.ownerTokenBalance), bonus: status.bonusRefillPerHour.toFixed(1) })}
          </span>
        </div>
      ) : (
        <div className="text-xs text-[var(--color-text-muted)] mb-2">
          💡 {t('energy.holdTokens')}
        </div>
      )}

      {typeof status.bankCredits === 'number' && (
        <div className="flex items-center gap-2 text-xs bg-blue-900/20 text-blue-300 px-2 py-1 rounded-lg mb-2">
          <span>🏦</span>
          <span>
            {t('energy.bankCredits')} {status.bankCredits}
          </span>
        </div>
      )}

      {/* Time Estimates */}
      <div className="flex justify-between text-xs text-[var(--color-text-muted)]">
        {status.currentEnergy < status.maxEnergy ? (
          <>
            <span>
              {t('energy.nextCharge')}: {status.timeToNextEnergy ? formatDuration(status.timeToNextEnergy, t) : t('energy.calculating')}
            </span>
            <span>
              {t('energy.full')} {status.timeToFull ? formatDuration(status.timeToFull, t) : t('energy.calculating')}
            </span>
          </>
        ) : (
          <span className="text-green-400">✓ {t('energy.fullyCharged')}</span>
        )}
      </div>

      {/* Error Display */}
      {error && (
        <div className="mt-2 text-xs text-red-400">{error}</div>
      )}

      {burnMessage && (
        <div className="mt-2 text-xs text-[var(--color-text-tertiary)]">{burnMessage}</div>
      )}

      {/* History Toggle */}
      <button
        onClick={() => setShowHistory(!showHistory)}
        className="mt-3 text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-text)] flex items-center gap-1"
      >
        <svg 
          xmlns="http://www.w3.org/2000/svg" 
          viewBox="0 0 20 20" 
          fill="currentColor" 
          className={`w-4 h-4 transition-transform ${showHistory ? 'rotate-180' : ''}`}
        >
          <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
        </svg>
        {showHistory ? t('energy.hideHistory') : t('energy.showHistory')}
      </button>

      {/* History List */}
      {showHistory && (
        <div className="mt-3 space-y-2 border-t border-[var(--color-border)] pt-3">
          {history.length === 0 ? (
            <div className="text-xs text-[var(--color-text-muted)] text-center py-2">
              {t('energy.noRecentEvents')}
            </div>
          ) : (
            history.map((event) => (
              <div 
                key={event.eventId}
                className="flex items-center justify-between text-xs bg-[var(--color-bg-secondary)] rounded-lg px-2 py-1.5"
              >
                <div className="flex items-center gap-2">
                  <span>
                    {event.eventType === 'consume' && '🔋'}
                    {event.eventType === 'refill' && '⚡'}
                    {event.eventType === 'set' && '⚙️'}
                    {event.eventType === 'add' && '➕'}
                  </span>
                  <span className="text-[var(--color-text-secondary)]">
                    {event.operation || event.eventType}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[var(--color-text-muted)]">
                    {event.energyBefore.toFixed(1)} → {event.energyAfter.toFixed(1)}
                  </span>
                  <span className="text-[var(--color-text-muted)]">
                    {formatRelativeTime(event.timestamp, t)}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export default EnergyPanel;
