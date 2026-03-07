/**
 * Cross-Platform Consent Guard
 *
 * Provides a `checkCrossPlatformConsent()` guard that handlers must call before
 * performing any cross-platform memory merge. If no active IdentityLink exists
 * for the combination of canonical userId + target platform, the merge is
 * blocked and a structured warning event is emitted.
 *
 * Design principles
 * -----------------
 * - Default-deny: absence of a link === no consent.
 * - Structured events only — no PII in log output.
 * - Forward-only revocation: existing data is never purged, only future merges
 *   are blocked.
 */
import { logger } from '@swarm/core';
import type { Platform } from '@swarm/core';
import {
  createIdentityLinkService,
  type IdentityLinkService,
} from '@swarm/core';

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface ConsentCheckResult {
  /** Whether a cross-platform memory merge is permitted. */
  allowed: boolean;
  /** Reason for the decision (for audit/structured logging, not user-facing). */
  reason: 'consent_active' | 'no_active_link' | 'link_revoked' | 'error';
}

// ---------------------------------------------------------------------------
// Guard function
// ---------------------------------------------------------------------------

/**
 * Check whether cross-platform memory merging is permitted between a canonical
 * userId and a specific platform identity.
 *
 * Emits a structured warning event when consent is missing or revoked so that
 * the decision can be monitored via CloudWatch Logs Insights.
 *
 * @param userId         - Canonical (platform-agnostic) user ID
 * @param targetPlatform - Platform whose memory would be merged in
 * @param platformUserId - User's ID on that platform
 * @param service        - Optional pre-built service (useful for testing)
 */
export async function checkCrossPlatformConsent(
  userId: string,
  targetPlatform: Platform,
  platformUserId: string,
  service?: IdentityLinkService,
): Promise<ConsentCheckResult> {
  const tableName = process.env.STATE_TABLE;
  if (!tableName) {
    logger.warn('cross_platform_consent_check: denied — missing STATE_TABLE env', {
      userId,
      platform: targetPlatform,
      reason: 'missing_state_table_env',
    });
    return { allowed: false, reason: 'error' };
  }

  const svc = service ?? createIdentityLinkService(tableName);

  let hasConsent: boolean;
  try {
    hasConsent = await svc.hasConsent(userId, targetPlatform, platformUserId);
  } catch (err) {
    logger.error('cross_platform_consent_check: denied — service error', {
      userId,
      platform: targetPlatform,
      reason: 'service_error',
      error: err instanceof Error ? err.message : String(err),
    });
    return { allowed: false, reason: 'error' };
  }

  if (hasConsent) {
    logger.info('cross_platform_consent_check: allowed', {
      userId,
      platform: targetPlatform,
    });
    return { allowed: true, reason: 'consent_active' };
  }

  // Default-deny path: emit a structured warning (not an error — this is an
  // expected guard path, not a system failure).
  logger.warn('cross_platform_consent_check: denied — no active link', {
    userId,
    platform: targetPlatform,
    reason: 'no_active_link',
  });
  return { allowed: false, reason: 'no_active_link' };
}
