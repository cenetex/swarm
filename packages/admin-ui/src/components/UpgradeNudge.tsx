/**
 * Upgrade Nudge — inline card shown when a free-tier limit is hit.
 *
 * Renders inside the chat message list (chat-first, no modals).
 * Offers "Upgrade to Pro" via Stripe checkout and an invite-code
 * fallback. Nudges are deduplicated per limit type per session via
 * the `shownNudges` set managed by the parent.
 */
import { useState } from 'react';
import { createCheckoutSession, redeemInviteCode } from '../api/billing';
import type { LimitErrorInfo } from '../api/chat';

interface UpgradeNudgeProps {
  avatarId: string;
  limitInfo: LimitErrorInfo;
}

const LIMIT_LABELS: Record<string, { title: string; description: string }> = {
  messages: {
    title: 'Daily message limit reached',
    description: 'Free accounts can send up to 50 messages per day.',
  },
  media: {
    title: 'Daily media limit reached',
    description: 'Free accounts get 5 media credits per day.',
  },
  voice: {
    title: 'Daily voice limit reached',
    description: 'Free accounts get 2 minutes of voice per day.',
  },
  tools: {
    title: 'Tool call limit reached',
    description: 'Free accounts can use up to 3 tool calls per message.',
  },
};

export function UpgradeNudge({ avatarId, limitInfo }: UpgradeNudgeProps) {
  const [upgrading, setUpgrading] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteCode, setInviteCode] = useState('');
  const [redeeming, setRedeeming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const label = LIMIT_LABELS[limitInfo.limitType] ?? {
    title: 'Usage limit reached',
    description: 'You have reached your plan limit.',
  };

  const handleUpgrade = async () => {
    setUpgrading(true);
    setError(null);
    try {
      const { url } = await createCheckoutSession(avatarId, 'pro');
      window.location.href = url;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Checkout failed');
      setUpgrading(false);
    }
  };

  const handleRedeem = async () => {
    const trimmed = inviteCode.trim().toUpperCase();
    if (!trimmed) return;
    setRedeeming(true);
    setError(null);
    try {
      const result = await redeemInviteCode(trimmed, avatarId);
      setSuccess(result.message);
      setInviteCode('');
      setShowInvite(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to redeem code');
    } finally {
      setRedeeming(false);
    }
  };

  if (success) {
    return (
      <div className="mx-4 my-2 p-3 rounded-xl bg-green-900/20 border border-green-500/30 text-sm text-green-300">
        {success}
      </div>
    );
  }

  return (
    <div className="mx-4 my-2 p-4 rounded-xl bg-[var(--color-bg-tertiary)] border border-blue-500/30 space-y-3">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-8 h-8 rounded-lg bg-blue-900/40 flex items-center justify-center">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 text-blue-400">
            <path fillRule="evenodd" d="M10 2a.75.75 0 01.75.75v.258a33.186 33.186 0 016.668.83.75.75 0 01-.336 1.461 31.28 31.28 0 00-1.103-.232l1.702 7.545a.75.75 0 01-.387.832A4.981 4.981 0 0115 14c-.825 0-1.606-.2-2.294-.556a.75.75 0 01-.387-.832l1.77-7.849a31.743 31.743 0 00-3.339-.254v11.505a20.01 20.01 0 013.78.501.75.75 0 11-.339 1.462A18.558 18.558 0 0010 17.5a18.558 18.558 0 00-4.191.477.75.75 0 01-.339-1.462 20.01 20.01 0 013.78-.501V4.509c-1.129.026-2.243.112-3.34.254l1.771 7.85a.75.75 0 01-.387.83A4.981 4.981 0 015 14a4.981 4.981 0 01-2.294-.556.75.75 0 01-.387-.832L4.02 5.067c-.374.06-.745.127-1.113.2a.75.75 0 11-.298-1.47 33.186 33.186 0 016.641-.822V2.75A.75.75 0 0110 2zM5 12.216l-1.395-6.19A30.056 30.056 0 005 5.705a30.18 30.18 0 001.395.322L5 12.216zm10 0l-1.395-6.19c.467-.07.93-.15 1.395-.239.464.09.928.17 1.395.24L15 12.215z" clipRule="evenodd" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-[var(--color-text)]">
            {label.title}
          </div>
          <div className="text-xs text-[var(--color-text-muted)] mt-0.5">
            {label.description} Upgrade for higher limits, memory, and multi-platform support.
          </div>
        </div>
      </div>

      {/* Usage indicator */}
      <div className="flex items-center gap-2 text-xs">
        <div className="flex-1 h-1.5 bg-[var(--color-bg-secondary)] rounded-full overflow-hidden">
          <div className="h-full bg-red-500 rounded-full" style={{ width: '100%' }} />
        </div>
        <span className="font-mono text-red-400">
          {limitInfo.current}/{limitInfo.limit}
        </span>
      </div>

      {/* Error banner */}
      {error && (
        <div className="p-2 rounded-lg bg-red-900/20 border border-red-500/30 text-red-400 text-xs">
          {error}
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2">
        <button
          onClick={handleUpgrade}
          disabled={upgrading}
          className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-medium transition-colors disabled:opacity-50"
        >
          {upgrading ? 'Loading...' : 'Upgrade to Pro — $9/mo'}
        </button>
        {!showInvite && (
          <button
            onClick={() => setShowInvite(true)}
            className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] underline underline-offset-2"
          >
            Have an invite code?
          </button>
        )}
      </div>

      {/* Invite code input */}
      {showInvite && (
        <div className="flex gap-2">
          <input
            type="text"
            value={inviteCode}
            onChange={(e) => setInviteCode(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === 'Enter' && handleRedeem()}
            placeholder="DP-XXXX-XXXX"
            disabled={redeeming}
            className="flex-1 px-2 py-1.5 text-xs rounded-lg bg-[var(--color-bg-secondary)] border border-[var(--color-border)] text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] font-mono focus:outline-none focus:border-brand-500 disabled:opacity-50"
            autoFocus
          />
          <button
            onClick={handleRedeem}
            disabled={redeeming || !inviteCode.trim()}
            className="px-3 py-1.5 text-xs rounded-lg bg-brand-600 hover:bg-brand-500 text-white font-medium transition-colors disabled:opacity-50"
          >
            {redeeming ? 'Redeeming...' : 'Redeem'}
          </button>
          <button
            onClick={() => { setShowInvite(false); setInviteCode(''); }}
            disabled={redeeming}
            className="px-2 py-1.5 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          >
            &times;
          </button>
        </div>
      )}

      {/* Pro benefits summary */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[10px] text-[var(--color-text-muted)] pt-1 border-t border-[var(--color-border)]">
        <span>500 msgs/day</span>
        <span>30-day memory</span>
        <span>50 media credits</span>
        <span>3 platforms</span>
      </div>
    </div>
  );
}

export default UpgradeNudge;
