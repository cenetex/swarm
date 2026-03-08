# Cross-Platform Consent Revocation Semantics

This document describes how consent revocation works for cross-platform identity links, what data is purged, what is retained, and how re-grants are handled.

## Overview

When a user revokes cross-platform consent (i.e., they no longer want their data shared between platforms), the system performs the following actions:

1. **Immediate forward block** -- All future cross-platform data reuse is blocked
2. **Previously mirrored data purge** -- Cross-platform memories are deleted where feasible
3. **Audit trail** -- The full revocation lifecycle is logged
4. **Retention exceptions** -- Stores where retroactive purge is not technically feasible are documented with explicit lawful basis

## Entry Points

- **`revokeConsentAndPurge()`** in `packages/handlers/src/services/cross-platform-consent.ts` -- handler-level function that orchestrates the full revocation flow
- **`IdentityLinkService.revokeAndPurge()`** in `packages/core/src/services/identity-link.ts` -- core service method that performs the revocation and purge

## What Happens on Revocation

### 1. Forward Block (Immediate)

The identity link status is set to `revoked` and `consentRevokedAt` is recorded. After this point, `checkCrossPlatformConsent()` returns `allowed: false` for the revoked link. No further cross-platform memory merges will occur.

### 2. Memory Purge

Cross-platform memories are identified by the `sourcePlatform` attribute on `MEMORY#` records. When consent is revoked for a specific platform:

- Memories with `sourcePlatform` matching the revoked platform are **deleted**
- Memories without a `sourcePlatform` tag are assumed to be single-platform and are **retained**
- The scan covers up to 20 pages of 100 records each (2,000 records max)

### 3. Retention Exceptions

The following stores cannot be retroactively purged. Each exception is documented with its lawful basis:

| Store | Why Not Purged | Lawful Basis |
|-------|----------------|--------------|
| **Audit log** | Append-only, immutable. Contains only metadata (actorId, eventType, timestamps) -- no message content or PII. | GDPR Art. 17(3)(e) -- establishment, exercise, or defence of legal claims |
| **Channel state buffers** | Truncated message snippets (max 200 chars) with 90-day TTL. Messages are not individually attributable to cross-platform sources. | GDPR Art. 17(3)(e) -- legitimate interest in service operation; self-expiring with TTL |
| **CloudWatch logs** | Structured log events may reference userId/platform combinations. Cannot be selectively purged by user. | GDPR Art. 17(3)(e) -- security and incident investigation; time-limited retention |

Each retention exception is recorded as a `purge_limitation_documented` audit event so the exception is part of the permanent compliance record.

### 4. Audit Trail

The following audit events are emitted during revocation:

| Event | When |
|-------|------|
| `link_revoked` | Identity link status changed to revoked |
| `purge_started` | Memory purge scan initiated |
| `purge_limitation_documented` | For each retention exception (one per store) |
| `purge_completed` | Memory purge finished, includes count |

## Re-Grant After Revocation

When consent is revoked and later re-granted:

- The identity link is reactivated with a **new** `consentGrantedAt` timestamp
- A `link_regrant` audit event is emitted (distinct from `link_created`)
- Previously purged data is **NOT recovered** -- the user starts fresh
- The audit trail preserves the full history: grant -> revoke -> purge -> re-grant

## DynamoDB Schema

### Identity Link Records

```
pk: USER#<userId>
sk: IDENTITY_LINK#<platform>#<platformUserId>

Attributes:
  status: 'active' | 'revoked'
  consentGrantedAt: ISO-8601
  consentRevokedAt: ISO-8601 (when revoked)
  linkedAt: ISO-8601
```

### Cross-Platform Memory Records (Purgeable)

```
pk: MEMORY#<avatarId>
sk: <tier>#<timestamp>#<memoryId>

Attributes:
  userId: string
  sourcePlatform: Platform  <-- tag that enables selective purge
```

### Audit Events

```
pk: AUDIT
sk: IDENTITY_LINK#<occurredAt>#<userId>#<action>
TTL: 365 days
```

## Implementation Files

- Types: `packages/core/src/types/identity-link.ts`
- Service: `packages/core/src/services/identity-link.ts`
- Handler guard: `packages/handlers/src/services/cross-platform-consent.ts`
- Tests: `packages/handlers/src/services/cross-platform-consent.test.ts`
