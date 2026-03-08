/**
 * Identity Link Types
 *
 * Canonical model for cross-platform identity linking and consent tracking.
 * Default-deny: no cross-platform memory merge unless an active IdentityLink exists.
 */

import type { Platform } from './platform.js';

// =============================================================================
// IDENTITY LINK MODEL
// =============================================================================

/**
 * Status of an identity link between a canonical user and a platform identity.
 * - 'active'  — consent granted; cross-platform merges are permitted
 * - 'revoked' — consent was withdrawn; no further merges after revokedAt
 */
export type IdentityLinkStatus = 'active' | 'revoked';

/**
 * Represents an explicit link between a canonical userId and a platform-specific
 * identity. Each link carries its own consent timestamps so that the full audit
 * history is preserved even after revocation.
 */
export interface IdentityLink {
  /** Canonical user ID (platform-agnostic primary key). */
  userId: string;
  /** Platform this link targets (telegram, discord, twitter, …). */
  platform: Platform;
  /** The user's ID on the target platform. */
  platformUserId: string;
  /** ISO-8601 timestamp when the link was created. */
  linkedAt: string;
  /** ISO-8601 timestamp when consent was explicitly granted. */
  consentGrantedAt: string;
  /** ISO-8601 timestamp when consent was revoked (undefined while active). */
  consentRevokedAt?: string;
  /** Current link status. */
  status: IdentityLinkStatus;
}

// =============================================================================
// AUDIT EVENT MODEL
// =============================================================================

/**
 * Structured audit event emitted for every identity-link lifecycle action and
 * cross-platform merge decision. No PII is included — only IDs and decisions.
 */
export type IdentityLinkAuditAction =
  | 'link_created'
  | 'link_revoked'
  | 'link_regrant'
  | 'merge_allowed'
  | 'merge_denied'
  | 'consent_checked'
  | 'purge_started'
  | 'purge_completed'
  | 'purge_limitation_documented';

export interface IdentityLinkAuditEvent {
  /** Audit event type. */
  action: IdentityLinkAuditAction;
  /** Canonical user ID involved in the event. */
  userId: string;
  /** Platform involved (when applicable). */
  platform?: Platform;
  /** Platform-specific user ID involved (when applicable). */
  platformUserId?: string;
  /** ISO-8601 timestamp of the event. */
  occurredAt: string;
  /** Human-readable reason for denials or additional context. */
  reason?: string;
}

// =============================================================================
// SERVICE INTERFACE
// =============================================================================

export interface IdentityLinkService {
  /**
   * Create an active identity link between a canonical userId and a platform
   * identity. Idempotent — calling again on an existing active link is a no-op.
   * If a previously revoked link exists it is reactivated.
   */
  linkIdentity(userId: string, platform: Platform, platformUserId: string): Promise<IdentityLink>;

  /**
   * Revoke an existing identity link. Future cross-platform merges involving
   * this link will be denied immediately. Forward-only — past merges are not
   * reversed.
   *
   * @returns The updated link, or null if no link existed.
   */
  revokeLink(userId: string, platform: Platform, platformUserId: string): Promise<IdentityLink | null>;

  /**
   * Return all identity links for a canonical userId (any status).
   */
  getLinkedIdentities(userId: string): Promise<IdentityLink[]>;

  /**
   * Check whether an active (non-revoked) consent link exists between the
   * canonical user and the given platform identity.
   */
  hasConsent(userId: string, platform: Platform, platformUserId: string): Promise<boolean>;

  /**
   * Emit a structured audit event. Implementations must not include PII.
   */
  auditLog(event: IdentityLinkAuditEvent): Promise<void>;

  /**
   * Revoke consent and purge previously mirrored cross-platform data.
   *
   * This performs three operations atomically:
   * 1. Revokes the identity link (forward block)
   * 2. Purges cross-platform memories tagged with the source platform
   * 3. Logs all purge actions in the audit trail
   *
   * @returns A summary of the revocation and purge actions taken.
   */
  revokeAndPurge(
    userId: string,
    platform: Platform,
    platformUserId: string,
  ): Promise<ConsentRevocationResult>;
}

// =============================================================================
// CONSENT REVOCATION RESULT
// =============================================================================

/**
 * Result of a consent revocation with purge operation.
 */
export interface ConsentRevocationResult {
  /** The revoked identity link (null if no link existed). */
  revokedLink: IdentityLink | null;
  /** Number of cross-platform memories purged. */
  memoriesPurged: number;
  /** Data stores where retroactive purge was not technically feasible. */
  retentionExceptions: Array<{
    store: string;
    reason: string;
    lawfulBasis: string;
  }>;
  /** ISO-8601 timestamp of the revocation. */
  revokedAt: string;
}
