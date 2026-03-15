/**
 * Funnel Event Emitter Helpers
 *
 * Fire-and-forget helpers for emitting GTM funnel events at key
 * checkpoints in the user journey. Each helper wraps recordFunnelEvent
 * and catches errors so it never blocks the main flow.
 *
 * Checkpoints:
 *   emitAuthEvent        (F1) — called after successful authentication
 *   emitAvatarCreated    (F2) — called after avatar creation
 *   emitFirstLiveResponse(F3) — called after first live response delivered
 *   emitRetention        (F4) — called when day-7 activity detected
 *   emitConversion       (F5) — called on paid plan conversion
 *   emitExpansion        (F6) — called on expansion (2+ avatars or team use)
 */
import { recordFunnelEvent, type FunnelStage } from './funnel-events.js';
import { logger } from '@swarm/core';

/**
 * Safely emit a funnel event, logging errors but never throwing.
 */
async function safeEmit(
  stage: FunnelStage,
  userId: string,
  avatarId?: string,
  metadata?: Record<string, unknown>,
  failureReason?: string,
): Promise<void> {
  try {
    await recordFunnelEvent({
      stage,
      userId,
      avatarId,
      metadata,
      failureReason,
    });
  } catch (err) {
    // Fire-and-forget: log but never fail the caller
    logger.error('Funnel event emit failed', {
      subsystem: 'funnel',
      event: 'emit_failed',
      stage,
      userId,
      avatarId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * F1: Authenticated account
 */
export function emitAuthEvent(
  userId: string,
  metadata?: Record<string, unknown>,
): void {
  void safeEmit('F1', userId, undefined, {
    ...metadata,
  });
}

/**
 * F2: Avatar created
 */
export function emitAvatarCreated(
  userId: string,
  avatarId: string,
  metadata?: Record<string, unknown>,
): void {
  void safeEmit('F2', userId, avatarId, {
    ...metadata,
  });
}

/**
 * F2 failure: Avatar creation failed
 * Records a funnel event with a failure reason for KPI diagnosis.
 */
export function emitAvatarCreationFailed(
  userId: string,
  failureReason: string,
  metadata?: Record<string, unknown>,
): void {
  void safeEmit('F2', userId, undefined, metadata, failureReason);
}

/**
 * F3: First live response delivered
 */
export function emitFirstLiveResponse(
  userId: string,
  avatarId: string,
  metadata?: Record<string, unknown>,
): void {
  void safeEmit('F3', userId, avatarId, {
    ...metadata,
  });
}

/**
 * F3 failure: First live response failed
 * Records a funnel event with a failure reason for KPI diagnosis.
 */
export function emitFirstLiveResponseFailed(
  userId: string,
  avatarId: string,
  failureReason: string,
  metadata?: Record<string, unknown>,
): void {
  void safeEmit('F3', userId, avatarId, metadata, failureReason);
}

/**
 * F4: Day-7 retention
 */
export function emitRetention(
  userId: string,
  avatarId: string,
  metadata?: Record<string, unknown>,
): void {
  void safeEmit('F4', userId, avatarId, metadata);
}

/**
 * F5: Paid conversion
 */
export function emitConversion(
  userId: string,
  avatarId: string,
  metadata?: Record<string, unknown>,
): void {
  void safeEmit('F5', userId, avatarId, metadata);
}

/**
 * F6: Expansion event (2+ active avatars or team usage)
 */
export function emitExpansion(
  userId: string,
  metadata?: Record<string, unknown>,
): void {
  void safeEmit('F6', userId, undefined, metadata);
}

// ============================================================================
// Sales Funnel Event Helpers (upgrade prompts, contact clicks, churn)
// ============================================================================

/**
 * Track when an upgrade prompt is shown to a user.
 * Logged as F5 metadata with action='upgrade_prompt_shown'.
 */
export function emitUpgradePromptShown(
  userId: string,
  avatarId: string,
  metadata: {
    currentTier: string;
    targetTier: string;
    triggerType: string;
    clicked?: boolean;
  },
): void {
  void safeEmit('F5', userId, avatarId, {
    action: 'upgrade_prompt_shown',
    ...metadata,
  });
}

/**
 * Track when a user clicks the upgrade prompt (conversion intent).
 */
export function emitUpgradePromptClicked(
  userId: string,
  avatarId: string,
  metadata: {
    currentTier: string;
    targetTier: string;
    triggerType: string;
  },
): void {
  void safeEmit('F5', userId, avatarId, {
    action: 'upgrade_prompt_clicked',
    ...metadata,
  });
}

/**
 * Track when a user clicks "Talk to Us" for Team tier.
 */
export function emitTeamContactClicked(
  userId: string,
  metadata: {
    currentTier: string;
    avatarCount?: number;
    serverInfo?: string;
    usageStats?: Record<string, unknown>;
  },
): void {
  void safeEmit('F5', userId, undefined, {
    action: 'team_contact_clicked',
    ...metadata,
  });
}

/**
 * Track churn — log the tier at time of cancellation.
 */
export function emitChurn(
  userId: string,
  avatarId: string,
  metadata: {
    cancelledTier: string;
    reason?: string;
    daysOnPlan?: number;
  },
): void {
  void safeEmit('F5', userId, avatarId, {
    action: 'churn',
    ...metadata,
  });
}
