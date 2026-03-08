/**
 * Cross-Platform Consent Guard
 *
 * Provides a `checkCrossPlatformConsent()` guard that handlers must call before
 * performing any cross-platform memory merge. If no active IdentityLink exists
 * for the combination of canonical userId + target platform, the merge is
 * blocked and a structured warning event is emitted.
 *
 * Revocation semantics
 * --------------------
 * When consent is revoked via `revokeConsentAndPurge()`:
 *
 * 1. **Immediate forward block**: All future cross-platform data reuse is
 *    blocked. `checkCrossPlatformConsent()` returns `allowed: false` for any
 *    revoked or missing link.
 *
 * 2. **Previously mirrored data purge**: Cross-platform memories tagged with
 *    `sourcePlatform` are deleted. Memories without this tag are assumed to be
 *    single-platform and are retained.
 *
 * 3. **Retention exceptions** (documented with lawful basis):
 *    - Audit log events (immutable, metadata-only, 365-day TTL)
 *    - Channel state buffers (truncated, self-expiring 90-day TTL)
 *    - CloudWatch logs (retained per log-group policy, not selectively purgeable)
 *
 * 4. **Re-grant after revocation**: Consent can be re-granted, but previously
 *    purged data is NOT recovered. The new consent period starts fresh with
 *    `consentGrantedAt` reset to the re-grant timestamp.
 *
 * Design principles
 * -----------------
 * - Default-deny: absence of a link === no consent.
 * - Structured events only — no PII in log output.
 * - Purge on revocation: cross-platform merged data is deleted when feasible.
 * - Retention exceptions documented with explicit lawful basis per GDPR Art. 17(3).
 */
import { logger } from '@swarm/core';
import type { Platform, ConsentRevocationResult } from '@swarm/core';
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

// ---------------------------------------------------------------------------
// Revocation with purge
// ---------------------------------------------------------------------------

/**
 * Revoke cross-platform consent and purge previously mirrored data.
 *
 * This is the primary entry point for consent revocation. It:
 * 1. Immediately blocks all future cross-platform data reuse (forward block)
 * 2. Purges cross-platform memories tagged with the source platform
 * 3. Documents retention exceptions with lawful basis
 * 4. Logs the full revocation + purge lifecycle in the audit trail
 *
 * After revocation, if consent is re-granted, the user starts fresh.
 * Previously purged data is NOT recovered.
 *
 * @param userId         - Canonical (platform-agnostic) user ID
 * @param targetPlatform - Platform whose consent is being revoked
 * @param platformUserId - User's ID on that platform
 * @param service        - Optional pre-built service (useful for testing)
 */
export async function revokeConsentAndPurge(
  userId: string,
  targetPlatform: Platform,
  platformUserId: string,
  service?: IdentityLinkService,
): Promise<ConsentRevocationResult> {
  const tableName = process.env.STATE_TABLE;
  if (!tableName) {
    logger.error('cross_platform_consent_revoke: failed — missing STATE_TABLE env', {
      userId,
      platform: targetPlatform,
      reason: 'missing_state_table_env',
    });
    return {
      revokedLink: null,
      memoriesPurged: 0,
      retentionExceptions: [],
      revokedAt: new Date().toISOString(),
    };
  }

  const svc = service ?? createIdentityLinkService(tableName);

  try {
    const result = await svc.revokeAndPurge(userId, targetPlatform, platformUserId);

    logger.info('cross_platform_consent_revoke: completed', {
      userId,
      platform: targetPlatform,
      memoriesPurged: result.memoriesPurged,
      retentionExceptions: result.retentionExceptions.length,
    });

    return result;
  } catch (err) {
    logger.error('cross_platform_consent_revoke: failed — service error', {
      userId,
      platform: targetPlatform,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      revokedLink: null,
      memoriesPurged: 0,
      retentionExceptions: [],
      revokedAt: new Date().toISOString(),
    };
  }
}
