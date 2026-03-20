/**
 * Plan & Usage Panel
 *
 * Unified inline component that merges plan/entitlement info with usage meters.
 * Designed to be rendered inside the chat header area (chat-first, not a modal).
 * Single fetch lifecycle with clear loading/error states.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
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
import { createCheckoutSession, createPortalSession, redeemInviteCode } from '../api/billing';

interface PlanUsagePanelProps {
  avatarId: string;
  avatarName: string;
  canEdit: boolean;
  onClose: () => void;
  /** Pre-filled invite code (e.g., from ?invite=DP-XXXX-XXXX query param) */
  initialInviteCode?: string;
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

type TranslateFn = (key: string, options?: Record<string, unknown>) => string;

function formatLimit(limit: number, t: TranslateFn): string {
  if (limit === -1) return t('upgrade.unlimited');
  return String(limit);
}

function formatLimitValue(value: unknown, t: TranslateFn): string {
  if (value === null || value === undefined) return t('upgrade.notAvailable');
  if (typeof value === 'boolean') return value ? t('upgrade.yes') : t('upgrade.no');
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function getPlanLabel(plan: PlanType | string, t: TranslateFn): string {
  switch (plan) {
    case 'free':
      return t('upgrade.plans.free');
    case 'pro':
      return t('upgrade.plans.pro');
    case 'team':
      return t('upgrade.plans.team');
    case 'enterprise':
      return t('upgrade.plans.enterprise');
    default:
      return plan;
  }
}

function getPlanOptionLabel(plan: PlanType | string, t: TranslateFn): string {
  switch (plan) {
    case 'free':
      return t('upgrade.planOptions.free');
    case 'pro':
      return t('upgrade.planOptions.pro');
    case 'team':
      return t('upgrade.planOptions.team');
    case 'enterprise':
      return t('upgrade.planOptions.enterprise');
    default:
      return plan;
  }
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

function planBadgeColor(plan: string): string {
  switch (plan) {
    case 'team':
      return 'bg-purple-500/15 text-purple-600 border-purple-500/30';
    case 'enterprise':
      return 'bg-purple-500/15 text-purple-600 border-purple-500/30';
    case 'pro':
      return 'bg-blue-500/15 text-blue-600 border-blue-500/30';
    default:
      return 'bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] border-[var(--color-border)]';
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
  t,
}: {
  meter: UsageMeter;
  sparkData?: number[];
  t: TranslateFn;
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
            {meter.used}{isUnlimited ? '' : `/${formatLimit(meter.limit, t)}`}
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

export function PlanUsagePanel({ avatarId, avatarName, canEdit, onClose, initialInviteCode }: PlanUsagePanelProps) {
  const { t } = useTranslation();
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

  // Billing state
  const [upgrading, setUpgrading] = useState(false);
  const [billingError, setBillingError] = useState<string | null>(null);
  const [showUpgradeOptions, setShowUpgradeOptions] = useState(false);

  // Invite code state
  const [showInviteInput, setShowInviteInput] = useState(false);
  const [inviteCode, setInviteCode] = useState('');
  const [redeemingInvite, setRedeemingInvite] = useState(false);
  const [inviteSuccess, setInviteSuccess] = useState<string | null>(null);

  // ── Fetch all data in parallel (stale-while-revalidate) ────────────────

  const hasFetchedRef = useRef(false);

  const fetchData = useCallback(async () => {
    // Only show loading spinner on first load — subsequent fetches are background refreshes
    if (!hasFetchedRef.current) setLoading(true);
    setError(null);
    try {
      const [limitsResult, usageResult, historyResult] = await Promise.allSettled([
        getAvatarEffectiveLimits(avatarId),
        getAvatarUsage(avatarId),
        getAvatarUsageHistory(avatarId, 7),
      ]);

      // Collect errors from failed requests
      const errors: string[] = [];

      if (limitsResult.status === 'fulfilled') {
        setEffective(limitsResult.value);
        setSelectedPlan(limitsResult.value.plan);
      } else {
      errors.push(
          t('upgrade.errors.planLimits', {
            message: limitsResult.reason instanceof Error ? limitsResult.reason.message : t('upgrade.unavailable'),
          }),
      );
      }

      if (usageResult.status === 'fulfilled') {
        setUsage(usageResult.value);
      } else {
        errors.push(
          t('upgrade.errors.usageData', {
            message: usageResult.reason instanceof Error ? usageResult.reason.message : t('upgrade.unavailable'),
          }),
        );
      }

      if (historyResult.status === 'fulfilled') {
        setHistory(historyResult.value.history);
      } else {
        // History failure is non-critical; skip silently
      }

      if (errors.length > 0) {
        setError(errors.join('; '));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('upgrade.errors.loadPlanUsage'));
    } finally {
      setLoading(false);
      hasFetchedRef.current = true;
    }
  }, [avatarId, t]);

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
      setError(e instanceof Error ? e.message : t('upgrade.errors.updatePlan'));
    } finally {
      setSaving(false);
    }
  };

  // ── Billing handlers ───────────────────────────────────────────────────

  const handleUpgrade = async (targetPlan: 'pro') => {
    setUpgrading(true);
    setBillingError(null);
    try {
      const { url } = await createCheckoutSession(avatarId, targetPlan);
      window.location.href = url;
    } catch (e) {
      setBillingError(e instanceof Error ? e.message : t('upgrade.errors.checkoutFailed'));
      setUpgrading(false);
    }
  };

  const handleManageBilling = async () => {
    setUpgrading(true);
    setBillingError(null);
    try {
      const { url } = await createPortalSession(avatarId);
      window.location.href = url;
    } catch (e) {
      setBillingError(e instanceof Error ? e.message : t('upgrade.errors.billingPortalFailed'));
      setUpgrading(false);
    }
  };

  // ── Invite code handler ────────────────────────────────────────────────

  // Auto-open invite input if initialInviteCode is provided
  useEffect(() => {
    if (initialInviteCode) {
      setShowInviteInput(true);
      setInviteCode(initialInviteCode);
    }
  }, [initialInviteCode]);

  const handleRedeemInvite = async () => {
    const trimmed = inviteCode.trim().toUpperCase();
    if (!trimmed) return;
    setRedeemingInvite(true);
    setBillingError(null);
    setInviteSuccess(null);
    try {
      const result = await redeemInviteCode(trimmed, avatarId);
      setInviteSuccess(result.message);
      setInviteCode('');
      setShowInviteInput(false);
      // Refresh plan data to reflect the upgrade
      const [limitsData, usageData] = await Promise.all([
        getAvatarEffectiveLimits(avatarId),
        getAvatarUsage(avatarId),
      ]);
      setEffective(limitsData);
      setSelectedPlan(limitsData.plan);
      setUsage(usageData);
    } catch (e) {
      setBillingError(e instanceof Error ? e.message : t('upgrade.errors.redeemInviteFailed'));
    } finally {
      setRedeemingInvite(false);
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
      .map((k) => ({ key: k, label: getLimitLabel(k, t), value: (limits as Record<string, unknown>)[k] }));
  }, [effective, t]);

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
            aria-label={t('common.close')}
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
          <span className="text-red-300 text-sm font-medium">{t('upgrade.title')}</span>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-red-800/30 text-red-400 hover:text-red-300"
            aria-label={t('common.close')}
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
          {t('common.retry')}
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
              {t('upgrade.title')}
            </span>
            <span className="text-xs text-[var(--color-text-muted)] ml-1.5">
              {avatarName}
            </span>
          </div>
          <span
            className={`text-[10px] px-1.5 py-0.5 rounded-full border font-medium uppercase ${planBadgeColor(plan)}`}
          >
            {getPlanLabel(plan, t)}
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
            aria-label={t('common.close')}
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
              <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Billing error banner */}
      {billingError && (
        <div className="mb-3 p-2 rounded-lg bg-red-900/20 border border-red-500/30 text-red-400 text-xs flex items-center justify-between">
          <span>{billingError}</span>
          <button onClick={() => setBillingError(null)} className="text-red-400 hover:text-red-300 ml-2">&times;</button>
        </div>
      )}

      {/* Billing success banner (from redirect) */}
      {typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('billing') === 'success' && (
        <div className="mb-3 p-2 rounded-lg bg-green-900/20 border border-green-500/30 text-green-400 text-xs">
          {t('upgrade.subscriptionActivated')}
        </div>
      )}

      {/* Upgrade / Manage Billing */}
      {!canEdit && (
        <div className="mb-3">
          {plan === 'free' ? (
            <div className="space-y-2">
              {!showUpgradeOptions ? (
                <button
                  onClick={() => setShowUpgradeOptions(true)}
                  disabled={upgrading}
                  className="w-full px-3 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors disabled:opacity-50"
                >
                  {t('upgrade.upgradePlan')}
                </button>
              ) : (
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => handleUpgrade('pro')}
                      disabled={upgrading}
                      className="px-3 py-3 rounded-lg bg-blue-500/15 border border-blue-500/30 hover:border-blue-500/50 text-left transition-colors disabled:opacity-50"
                    >
                      <div className="text-sm font-semibold text-blue-600">{getPlanLabel('pro', t)}</div>
                      <div className="text-lg font-bold text-[var(--color-text)]">{t('upgrade.creatorMonthlyPrice')}</div>
                      <div className="text-[10px] text-[var(--color-text-secondary)] mt-1 space-y-0.5">
                        <div>{t('upgrade.planCardBullets.pro.messages')}</div>
                        <div>{t('upgrade.planCardBullets.pro.mediaCredits')}</div>
                        <div>{t('upgrade.planCardBullets.pro.memory')}</div>
                        <div>{t('upgrade.planCardBullets.pro.platforms')}</div>
                      </div>
                    </button>
                    <a
                      href="mailto:sales@rati.chat?subject=CosyWorld%20Team%20Plan"
                      className="px-3 py-3 rounded-lg bg-purple-500/15 border border-purple-500/30 hover:border-purple-500/50 text-left transition-colors block"
                    >
                      <div className="text-sm font-semibold text-purple-600">{getPlanLabel('team', t)}</div>
                      <div className="text-lg font-bold text-[var(--color-text)]">{t('upgrade.teamMonthlyPrice')}</div>
                      <div className="text-[10px] text-[var(--color-text-secondary)] mt-1 space-y-0.5">
                        <div>{t('upgrade.planCardBullets.team.unlimitedBots')}</div>
                        <div>{t('upgrade.planCardBullets.team.sharedMemory')}</div>
                        <div>{t('upgrade.planCardBullets.team.adminDashboard')}</div>
                        <div>{t('upgrade.planCardBullets.team.priorityAccess')}</div>
                      </div>
                    </a>
                  </div>
                  <button
                    onClick={() => setShowUpgradeOptions(false)}
                    className="w-full text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                  >
                    {t('common.cancel')}
                  </button>
                </div>
              )}
            </div>
          ) : plan === 'pro' || plan === 'enterprise' ? (
            <div className="flex gap-2">
              <a
                href="mailto:sales@rati.chat?subject=CosyWorld%20Team%20Plan"
                className="flex-1 px-3 py-1.5 text-xs rounded-lg bg-purple-500/15 border border-purple-500/30 hover:border-purple-500/50 text-purple-600 font-medium transition-colors text-center"
              >
                {t('upgrade.talkToUsAboutTeam')}
              </a>
              <button
                onClick={handleManageBilling}
                disabled={upgrading}
                className="px-3 py-1.5 text-xs rounded-lg border border-[var(--color-border)] hover:border-[var(--color-text-muted)] text-[var(--color-text-secondary)] transition-colors disabled:opacity-50"
              >
                {upgrading ? t('common.loading') : t('upgrade.manageBilling')}
              </button>
            </div>
          ) : (
            <button
              onClick={handleManageBilling}
              disabled={upgrading}
              className="w-full px-3 py-1.5 text-xs rounded-lg border border-[var(--color-border)] hover:border-[var(--color-text-muted)] text-[var(--color-text-secondary)] transition-colors disabled:opacity-50"
            >
              {upgrading ? t('common.loading') : t('upgrade.manageBilling')}
            </button>
          )}
        </div>
      )}

      {/* Invite code success banner */}
      {inviteSuccess && (
        <div className="mb-3 p-2 rounded-lg bg-green-900/20 border border-green-500/30 text-green-400 text-xs flex items-center justify-between">
          <span>{inviteSuccess}</span>
          <button onClick={() => setInviteSuccess(null)} className="text-green-400 hover:text-green-300 ml-2">&times;</button>
        </div>
      )}

      {/* Invite code input */}
      {!canEdit && (
        <div className="mb-3">
          {!showInviteInput ? (
            <button
              onClick={() => setShowInviteInput(true)}
              className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] underline underline-offset-2"
            >
              {t('upgrade.haveInviteCode')}
            </button>
          ) : (
            <div className="flex gap-2">
              <input
                type="text"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === 'Enter' && handleRedeemInvite()}
                placeholder={t('upgrade.invitePlaceholder')}
                disabled={redeemingInvite}
                className="flex-1 px-2 py-1.5 text-xs rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] font-mono focus:outline-none focus:border-brand-500 disabled:opacity-50"
                autoFocus
              />
              <button
                onClick={handleRedeemInvite}
                disabled={redeemingInvite || !inviteCode.trim()}
                className="px-3 py-1.5 text-xs rounded-lg bg-brand-600 hover:bg-brand-500 text-white font-medium transition-colors disabled:opacity-50"
              >
                {redeemingInvite ? t('upgrade.redeeming') : t('upgrade.redeem')}
              </button>
              <button
                onClick={() => { setShowInviteInput(false); setInviteCode(''); }}
                disabled={redeemingInvite}
                className="px-2 py-1.5 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
              >
                &times;
              </button>
            </div>
          )}
        </div>
      )}

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
          {t('upgrade.tabs.usage')}
          </button>
          <button
            onClick={() => setActiveTab('limits')}
            className={`flex-1 px-3 py-1 text-xs font-medium rounded-md transition-colors ${
              activeTab === 'limits'
                ? 'bg-[var(--color-bg-tertiary)] text-[var(--color-text)]'
                : 'text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]'
            }`}
          >
          {t('upgrade.tabs.limits')}
          </button>
        </div>

      {/* ── Usage Tab ────────────────────────────────────────────────────── */}
      {activeTab === 'usage' && usage && (
        <>
          {/* Main Meters */}
          <div className="space-y-2.5">
            <MeterBar meter={usage.meters.messages} sparkData={msgSpark} t={t} />
            <MeterBar meter={usage.meters.media} sparkData={mediaSpark} t={t} />
            <MeterBar meter={usage.meters.voice} sparkData={voiceSpark} t={t} />
          </div>

          {/* Energy */}
          {usage.energy && (
            <div className="mt-3 flex items-center gap-2 text-xs bg-[var(--color-bg-secondary)] rounded-lg px-2.5 py-1.5">
              <span className="text-yellow-400">{t('energy.title')}</span>
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
                <span className="text-blue-400 ml-1">
                  {t('energy.bankCreditsSummary', { credits: usage.energy.bankCredits })}
                </span>
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
            {showDetails ? t('upgrade.hideDetails') : t('upgrade.showDetails')}
          </button>

          {/* Expanded Details */}
          {showDetails && (
            <div className="mt-3 border-t border-[var(--color-border)] pt-3 space-y-3">
              {/* 7-day history chart */}
              {history && history.length > 1 && (
                <div>
                  <div className="text-xs font-medium text-[var(--color-text-secondary)] mb-2">
                    {t('upgrade.history7Day')}
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
                            title={t('upgrade.historyTooltip', {
                              date: day.date,
                              messages: day.messagesProcessed,
                              media: day.mediaCreditsUsed,
                            })}
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
                {t('upgrade.toolCredits')}
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
                          {credit.remaining}/{credit.limit} {t('upgrade.credits')}
                          <span className="ml-2 text-[var(--color-text-muted)]">
                            ({credit.dailyRemaining}/{credit.dailyLimit} {t('upgrade.daily')})
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
        <div className="text-sm text-[var(--color-text-muted)] py-2">{t('upgrade.noUsageData')}</div>
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
                <option value="free">{getPlanOptionLabel('free', t)}</option>
                <option value="pro">{getPlanOptionLabel('pro', t)}</option>
                <option value="team">{getPlanOptionLabel('team', t)}</option>
                <option value="enterprise">{getPlanOptionLabel('enterprise', t)}</option>
              </select>
              <button
                onClick={handleSave}
                disabled={loading || saving}
                className="px-3 py-1.5 text-sm rounded-lg bg-brand-600 hover:bg-brand-500 text-white font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {saving ? t('common.loading') : t('common.save')}
              </button>
            </div>
          )}

          {/* Effective Limits Table */}
          {effective ? (
            <div className="space-y-1">
              {limitRows.length > 0 ? (
                  limitRows.map((row) => (
                    <div key={row.key} className="flex items-center justify-between text-xs py-0.5">
                    <div className="text-[var(--color-text-secondary)]">{row.label}</div>
                    <div className="text-[var(--color-text)] font-mono">{formatLimitValue(row.value, t)}</div>
                    </div>
                  ))
                ) : (
                <div className="text-sm text-[var(--color-text-muted)]">{t('upgrade.noLimitsReturned')}</div>
              )}
            </div>
          ) : (
            <div className="text-sm text-[var(--color-text-muted)] py-2">{t('upgrade.noPlanData')}</div>
          )}

          {!canEdit && (
            <p className="text-xs text-[var(--color-text-muted)] mt-2">
              {t('upgrade.adminOnly')}
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
          {t('upgrade.refresh')}
        </button>
      </div>
    </div>
  );
}

export default PlanUsagePanel;
