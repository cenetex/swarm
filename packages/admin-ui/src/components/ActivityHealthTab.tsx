/**
 * Activity / Health tab — aggregator for the workspace right-pane (#1639).
 *
 * Composes UsageMeterPanel and EnergyPanel into one scrollable view.
 * Replaces the `planUsagePanelOpen` inline panel and the
 * scattered admin-only EnergyPanel / UsageMeter mounts that previously
 * lived in different parts of the chat surface.
 *
 * `ActivationChecklist` intentionally stays inline at the top of the
 * transcript — it's a chat-first onboarding nudge, not a status surface.
 * `HealthDashboard` is system-wide and out of scope for this avatar tab.
 */
import { lazy, Suspense } from 'react';
import { useActiveAvatar } from '../store';
import { useAuth } from '../store/auth';

// Lazy-load heavy children — keeps the Activity tab cheap to mount.
const UsageMeterPanel = lazy(() => import('./UsageMeterPanel').then(m => ({ default: m.UsageMeterPanel })));
const EnergyPanel = lazy(() => import('./EnergyPanel').then(m => ({ default: m.EnergyPanel })));

interface ActivityHealthTabProps {
  /** Workspace close callback retained for the workspace tab contract. */
  onClose: () => void;
  /** Pre-filled invite code retained for the workspace tab contract. */
  initialInviteCode?: string;
}

export function ActivityHealthTab({ onClose: _onClose, initialInviteCode: _initialInviteCode }: ActivityHealthTabProps) {
  const activeAvatar = useActiveAvatar();
  const { account } = useAuth();
  const canEdit = account?.role === 'admin';
  const isAdmin = canEdit;

  if (!activeAvatar) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-[var(--color-text-muted)]">
        No avatar selected.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 -mx-1">
      {/* Usage Meter — concise per-meter view */}
      <section className="space-y-2">
        <h3 className="px-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-tertiary)]">
          Usage Detail
        </h3>
        <Suspense fallback={null}>
          <UsageMeterPanel avatarId={activeAvatar.id} />
        </Suspense>
      </section>

      {/* Energy — avatar resource state */}
      <section className="space-y-2">
        <h3 className="px-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-tertiary)]">
          Energy
        </h3>
        <Suspense fallback={null}>
          <EnergyPanel avatarId={activeAvatar.id} isAdmin={isAdmin} />
        </Suspense>
      </section>
    </div>
  );
}
