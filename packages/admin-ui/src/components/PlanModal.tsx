import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  getAvatarEffectiveLimits,
  setAvatarEntitlement,
  type EffectiveLimitsResponse,
  type PlanType,
} from '../api/entitlements';

interface PlanModalProps {
  avatarId: string;
  avatarName: string;
  isOpen: boolean;
  canEdit: boolean;
  onClose: () => void;
}

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

function formatValue(value: unknown, t: TranslateFn): string {
  if (value === null || value === undefined) return t('upgrade.notAvailable');
  if (typeof value === 'boolean') return value ? t('upgrade.yes') : t('upgrade.no');
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function getLimitLabel(key: string, t: TranslateFn): string {
  switch (key) {
    case 'memoryEnabled':
      return t('upgrade.limitLabels.memoryEnabled');
    case 'memoryRetentionDays':
      return t('upgrade.limitLabels.memoryRetentionDays');
    case 'dailyMessageLimit':
      return t('upgrade.limitLabels.dailyMessageLimit');
    case 'dailyMediaCredits':
      return t('upgrade.limitLabels.dailyMediaCredits');
    case 'dailyVoiceMinutes':
      return t('upgrade.limitLabels.dailyVoiceMinutes');
    case 'maxToolCallsPerMessage':
      return t('upgrade.limitLabels.maxToolCallsPerMessage');
    case 'autonomousPostsEnabled':
      return t('upgrade.limitLabels.autonomousPostsEnabled');
    case 'priorityProcessing':
      return t('upgrade.limitLabels.priorityProcessing');
    default:
      return key;
  }
}

export function PlanModal({ avatarId, avatarName, isOpen, canEdit, onClose }: PlanModalProps) {
  const { t } = useTranslation();
  const [effective, setEffective] = useState<EffectiveLimitsResponse | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<PlanType>('free');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      .map((k) => ({ key: k, label: getLimitLabel(k, t), value: (limits as Record<string, unknown>)[k] }));
  }, [effective, t]);

  useEffect(() => {
    if (!isOpen) return;
    let mounted = true;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await getAvatarEffectiveLimits(avatarId);
        if (!mounted) return;
        setEffective(data);
        setSelectedPlan(data.plan);
      } catch (err) {
        if (!mounted) return;
        setError(err instanceof Error ? err.message : t('upgrade.errors.loadPlan'));
      } finally {
        if (mounted) setLoading(false);
      }
    };

    load();
    return () => {
      mounted = false;
    };
  }, [avatarId, isOpen, t]);

  const handleSave = async () => {
    if (!canEdit) return;

    setSaving(true);
    setError(null);
    try {
      await setAvatarEntitlement(avatarId, { plan: selectedPlan });
      const refreshed = await getAvatarEffectiveLimits(avatarId);
      setEffective(refreshed);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('upgrade.errors.updatePlan'));
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-[var(--color-bg-secondary)] border border-[var(--color-border)] rounded-xl shadow-xl max-w-lg w-full mx-4">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
          <div>
            <h2 className="text-lg font-semibold text-[var(--color-text)]">{t('upgrade.planModalTitle')}</h2>
            <div className="text-xs text-[var(--color-text-muted)] mt-0.5">
              {avatarName} • {avatarId}
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            aria-label={t('common.close')}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>

        <div className="p-4 space-y-4">
          {error && (
            <div className="p-3 rounded-lg bg-red-900/20 border border-red-500/30 text-red-400 text-sm">
              {error}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-[var(--color-text)] mb-1">{t('upgrade.planLabel')}</label>
              <select
                value={selectedPlan}
                onChange={(e) => setSelectedPlan(e.target.value as PlanType)}
                disabled={!canEdit || loading || saving}
                className="w-full px-3 py-2 rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)] text-[var(--color-text)] focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-60"
              >
                <option value="free">{t('upgrade.planOptions.free')}</option>
                <option value="pro">{t('upgrade.planOptions.pro')}</option>
                <option value="team">{t('upgrade.planOptions.team')}</option>
                <option value="enterprise">{t('upgrade.planOptions.enterprise')}</option>
              </select>
              {!canEdit && (
                <p className="text-xs text-[var(--color-text-muted)] mt-1">
                  {t('upgrade.adminOnly')}
                </p>
              )}
            </div>

            <div className="sm:col-span-1 flex items-end">
              <button
                onClick={handleSave}
                disabled={!canEdit || loading || saving}
                className="w-full px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 text-white font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? t('common.loading') : t('common.save')}
              </button>
            </div>
          </div>

          <div className="p-3 rounded-lg bg-[var(--color-bg-tertiary)] border border-[var(--color-border)]">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium text-[var(--color-text)]">{t('upgrade.effective')}</div>
              <div className="text-xs text-[var(--color-text-muted)]">
                {effective ? `${effective.source}${effective.entitlementStatus ? ` • ${effective.entitlementStatus}` : ''}` : ''}
              </div>
            </div>

            {loading ? (
              <div className="text-sm text-[var(--color-text-muted)] mt-2">{t('common.loading')}</div>
            ) : effective ? (
              <div className="mt-2 space-y-1">
                {limitRows.length > 0 ? (
                  limitRows.map((row) => (
                    <div key={row.key} className="flex items-center justify-between text-sm">
                      <div className="text-[var(--color-text-secondary)]">{row.label}</div>
                      <div className="text-[var(--color-text)] font-mono">{formatValue(row.value, t)}</div>
                    </div>
                  ))
                ) : (
                  <div className="text-sm text-[var(--color-text-muted)]">{t('upgrade.noLimitsReturned')}</div>
                )}
              </div>
            ) : (
              <div className="text-sm text-[var(--color-text-muted)] mt-2">{t('upgrade.noData')}</div>
            )}
          </div>

          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-[var(--color-text-secondary)] hover:text-[var(--color-text)] hover:bg-[var(--color-bg-tertiary)] transition-colors"
            >
              {t('common.close')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
