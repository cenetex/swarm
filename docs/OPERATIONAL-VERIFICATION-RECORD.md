# Operational Verification Record

> **Date**: 2026-03-08
> **Reviewer**: Engineering (code-level verification)
> **Scope**: Repository code inspection only; no live environment access
> **Purpose**: Buyer diligence — verify privacy and security controls from source code
> **Related**: [GDPR-COMPLIANCE-AUDIT-v2.md](./GDPR-COMPLIANCE-AUDIT-v2.md) | [SECURITY.md](./SECURITY.md) | [DATA-RETENTION-MATRIX.md](./DATA-RETENTION-MATRIX.md)

---

## Control Verification Summary

| # | Control | Status | Details |
|---|---------|--------|---------|
| C1 | WAF / edge protection | PARTIAL | WAF on CloudFront CDN; HTTP API v2 limitation documented |
| C2 | Log redaction (PII) | PASS | All three integration points confirmed |
| C3 | DynamoDB encryption | PASS (default) | AWS default encryption at rest; no explicit CDK override needed |
| C4 | S3 encryption | PASS | Explicit `S3_MANAGED` encryption in CDK |
| C5 | Consent endpoint | PASS | Full CRUD with immutable evidence chain |
| C6 | DSAR export / erasure | PASS | Six data classes covered with audit trail |
| C7 | Third-party DPA status | PARTIAL | 2 of 5 processors covered; 3 pending execution |
| C8 | Session security | PASS | HttpOnly, Secure, SameSite=Lax, 24h expiry |
| C9 | Audit trail | PASS | 365-day TTL, configurable, immutable records |
| C10 | PII minimization | PASS | Channel state truncation, log demotion confirmed |

---

## Detailed Control Evidence

### C1: WAF / Edge Protection

| Field | Value |
|-------|-------|
| **Status** | PARTIAL |
| **Evidence source** | `packages/infra/src/constructs/shared.ts:279-285`, `packages/infra/src/constructs/admin-api.ts:753-755` |

**Evidence notes:**

- CloudFront CDN distribution has WAF v2 WebACL attached via `createManagedWebAcl()` when `enableWaf=true` (default). See `shared.ts` lines 279-285.
- The Admin API uses an HTTP API (API Gateway v2). CDK code explicitly documents that WAFv2 WebACL association is **not supported** for HTTP API v2: `admin-api.ts` line 753: `"NOTE: WAFv2 WebACL association is not supported for API Gateway HTTP APIs (v2)."` The code notes WAF protection must be applied at a different layer (e.g., CloudFront or ALB in front of the API).
- **NOT VERIFIED -- requires production inspection**: Whether a CloudFront distribution or other WAF-capable layer sits in front of the Admin API in production.

### C2: Log Redaction (PII)

| Field | Value |
|-------|-------|
| **Status** | PASS |
| **Evidence source** | `packages/core/src/utils/redact-pii.ts`, `packages/core/src/utils/logger.ts:7,78`, `packages/admin-api/src/services/structured-logger.ts:16,49`, `packages/admin-api/src/services/avatar-observability.ts:30,174-177,245-248` |

**Evidence notes:**

- Central `redactPii` module (`packages/core/src/utils/redact-pii.ts`) provides `redactString()`, `redactData()`, `redactLogData()`, and `truncateContent()` functions.
- Patterns redacted: email addresses, Solana wallet addresses, Ethereum addresses, Bearer/Bot tokens, API key patterns, IPv4 addresses (excluding localhost/link-local). Sensitive key names (email, phone, password, token, apikey, secret, wallet_address, private_key, etc.) are fully replaced with `[REDACTED]`.
- **Integration point 1 -- Core Logger**: `packages/core/src/utils/logger.ts` imports `redactLogData` (line 7) and applies it to the `data` parameter before JSON serialization (line 78).
- **Integration point 2 -- Structured Logger**: `packages/admin-api/src/services/structured-logger.ts` imports `redactLogData` from `@swarm/core` (line 16) and applies it before both console output and DynamoDB observability writes (line 49).
- **Integration point 3 -- Avatar Observability**: `packages/admin-api/src/services/avatar-observability.ts` imports both `redactLogData` and `redactString` from `@swarm/core` (line 30). Applies `redactString` to message content and `redactLogData` to data bags at the DynamoDB write boundary for both `recordLog` (lines 174-177) and `recordLogBatch` (lines 245-248). Also redacts issue titles, descriptions, user messages, and feedback text at write time (lines 565-569, 613).
- 22+ test assertions in `redact-pii.test.ts`.
- **Residual risk**: A developer bypassing the logger with raw `console.log` would skip redaction. No compile-time enforcement exists.

### C3: DynamoDB Encryption

| Field | Value |
|-------|-------|
| **Status** | PASS (default) |
| **Evidence source** | `packages/infra/src/constructs/shared.ts:138-174` |

**Evidence notes:**

- CDK `dynamodb.Table` constructs in `shared.ts` do not explicitly set an `encryption` property.
- AWS DynamoDB encrypts all tables at rest by default using AWS-owned keys (AES-256). This is automatic and cannot be disabled. See [AWS documentation](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/EncryptionAtRest.html).
- Point-in-time recovery is enabled for persistent environments (`prod`, `production`, `staging`) via `pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true }`.
- Deletion protection is enabled for persistent environments.
- **NOT VERIFIED -- requires production inspection**: Whether tables use AWS-owned keys (default) or customer-managed KMS keys.

### C4: S3 Encryption

| Field | Value |
|-------|-------|
| **Status** | PASS |
| **Evidence source** | `packages/infra/src/constructs/shared.ts:182-216,256-267` |

**Evidence notes:**

- Media bucket: `encryption: s3.BucketEncryption.S3_MANAGED` (line 189). Server-side encryption with Amazon S3-managed keys (SSE-S3, AES-256).
- `blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL` (line 190).
- `enforceSSL: true` (line 191) -- rejects non-HTTPS requests.
- CDN log bucket (persistent environments): `encryption: s3.BucketEncryption.S3_MANAGED` (line 259), `blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL` (line 260), `enforceSSL: true` (line 261).
- Lifecycle rules: `temp/` prefix expires after 1 day; general objects transition to Intelligent Tiering at 30 days; CDN logs expire at 90 days.

### C5: Consent Endpoint

| Field | Value |
|-------|-------|
| **Status** | PASS |
| **Evidence source** | `packages/admin-api/src/services/consent.ts`, `packages/admin-api/src/handlers/consent.ts` |

**Evidence notes:**

- **Service layer** (`consent.ts`): Full consent lifecycle -- `recordConsent()`, `getConsentStatus()`, `listConsentRecords()`, `revokeConsent()`.
- **Handler layer** (`consent.ts` handler): REST endpoints `POST /consent` (record acceptance), `GET /consent` (check status), `POST /consent/revoke` (revoke with timestamp).
- **Key schema** (v2, account-bound): `pk: CONSENT#ACCOUNT#<accountId>`, `sk: v<policyVersion>`. Fields: `userId`, `accountId`, `policyVersion`, `noticeHash` (SHA-256 of privacy notice text), `acceptedAt`, `status`, `revokedAt`.
- Legacy schema (v1, wallet-scoped): `pk: CONSENT#<walletAddress>`, `sk: v<policyVersion>`. Dual-lookup supported for migration.
- Records are intentionally long-lived (no TTL) to serve as GDPR Article 7(1) evidence.
- `noticeHash` field captures a SHA-256 digest of the notice text shown, proving which version was displayed.
- 291 test assertions in `consent.test.ts`.

### C6: DSAR Export / Erasure

| Field | Value |
|-------|-------|
| **Status** | PASS |
| **Evidence source** | `packages/admin-api/src/services/dsar.ts`, `packages/admin-api/src/handlers/dsar.ts`, `docs/DSAR-WORKFLOW.md` |

**Evidence notes:**

- Three operations: `discoverUserData()` (inventory), `exportUserData()` (structured JSON export), `eraseUserData()` (deletion with dry-run support).
- **Data classes covered** (6 total):
  1. Account profile (`ACCOUNT#<accountId> / PROFILE`)
  2. Linked identities (`ACCOUNT#<accountId> / IDENTITY#*`) plus reverse-index records
  3. Admin chat history (`CHAT#<email> / AVATAR#<id>|GLOBAL`)
  4. Avatar memories (`MEMORY#<avatarId>` filtered by userId)
  5. Auto-issues (`ISSUE#<issueId>` filtered by avatarId)
  6. Audit log (`AUDIT#<avatarId> / EVENT#` -- retained, not deleted)
- **Retention exceptions**: Audit events retained for compliance (365-day TTL, immutable). Consent records retained to prove lawful processing basis. Erasure request itself recorded as an immutable audit event.
- **Erasure audit trail**: `eraseUserData()` records an `avatar_deleted` audit event with `dsar_erasure` action detail, capturing counts of deleted vs retained records.
- 347 test assertions in `dsar.test.ts`.
- **Known limitations**: S3 media assets not covered (rely on lifecycle rules). CloudWatch logs not auto-deleted (message content not logged). Memory scan uses table scan without GSI.

### C7: Third-Party DPA Status

| Field | Value |
|-------|-------|
| **Status** | PARTIAL |
| **Evidence source** | `docs/SUBPROCESSOR-REGISTER.md` |

**Evidence notes:**

- **Executed / covered by standard terms** (2): AWS (GDPR DPA incorporated into service terms), Stripe (DPA at stripe.com/legal/dpa).
- **Not yet executed** (3): OpenRouter, Replicate, Privy. These are the highest-priority gaps per the GDPR audit (gap G1).
- **N/A -- not processor relationships** (5): Telegram, Discord, X (platform APIs, independent controllers), Helius, Solana RPC (public blockchain data only).
- Subprocessor register includes quarterly review cadence (next due 2026-06-08), contact for executed agreement copies (privacy@cenetex.com), and notes that binding legal documents are maintained outside the repository by the legal team.

### C8: Session Security

| Field | Value |
|-------|-------|
| **Status** | PASS |
| **Evidence source** | `packages/admin-api/src/auth/session-cookie.ts:29-34,57-61`, `packages/admin-api/src/auth/session-cookie.test.ts:71-75` |

**Evidence notes:**

- Cookie options defined at `session-cookie.ts` lines 29-34:
  - `httpOnly: true` -- prevents JavaScript access (XSS mitigation)
  - `secure: true` -- cookie only sent over HTTPS
  - `sameSite: 'Lax'` -- CSRF mitigation (cookies sent on top-level navigations but not cross-origin POST)
  - `path: '/'`
  - `maxAgeSeconds: 24 * 60 * 60` (24-hour expiry)
- Cookie header construction at lines 57-61 includes `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, and `Max-Age`.
- Test assertions verify all security attributes are present (test file lines 71-75).
- Session tokens stored in DynamoDB with 24-hour TTL (self-expire).

### C9: Audit Trail

| Field | Value |
|-------|-------|
| **Status** | PASS |
| **Evidence source** | `packages/admin-api/src/services/audit-log.ts:26-29,131-133` |

**Evidence notes:**

- Audit TTL configurable via `AUDIT_TTL_DAYS` environment variable, defaulting to 365 days (`audit-log.ts` lines 26-29).
- TTL applied at write time: `ttl: Math.floor(now / 1000) + AUDIT_TTL_SECONDS` (line 133).
- Audit events contain only metadata (actorId, eventType, timestamp) -- no message content or user PII (documented in code comment at lines 24-25).
- DSAR erasure creates an immutable audit event recording what was deleted vs retained.
- Events are queryable by avatarId and by event type (via GSI1).

### C10: PII Minimization

| Field | Value |
|-------|-------|
| **Status** | PASS |
| **Evidence source** | `packages/core/src/services/state/channel-state.ts:187-189`, `packages/handlers/src/telegram/telegram-webhook-shared.ts:397-401` |

**Evidence notes:**

- **Channel state truncation**: Message content in DynamoDB channel state buffers (`recentMessages`) truncated to 200 characters at write time via `truncateContent(message.content, 200)` (`channel-state.ts` line 189). Full content available only in CloudWatch logs (bounded retention).
- **Log demotion**: DM allowlist check logs demoted from INFO to DEBUG level (`telegram-webhook-shared.ts` lines 397-399). Comment: `"Debug-level only: contains user identifiers for troubleshooting DM access. Demoted from INFO to avoid retaining PII in production CloudWatch logs."` Production runs at INFO level, so these identifiers are no longer retained.
- **Channel state buffers** have a 90-day TTL; truncation to 200 characters limits PII exposure during that window.

---

## Verification Limitations

This verification record is based on **source code inspection only**. The following limitations apply:

1. **No live environment access**: Controls that require runtime inspection (CloudWatch log content, actual DynamoDB encryption keys, WAF attachment to production resources, network traffic analysis) could not be verified. These are marked "NOT VERIFIED -- requires production inspection" in the relevant controls.

2. **Code-level only**: The presence of code implementing a control does not guarantee it is deployed and active in production. Deployment verification requires access to the production AWS account.

3. **Governance artifacts**: DPA execution status is documented in the subprocessor register but the actual signed agreements are maintained outside the repository by the legal team.

4. **Test coverage as evidence**: Test assertions (291 for consent, 347 for DSAR, 22+ for PII redaction) demonstrate intended behavior but do not substitute for integration or penetration testing.

5. **Developer bypass risk**: PII redaction is applied at the logger level. Direct `console.log` calls bypass redaction. No compile-time enforcement mechanism exists.

---

## Items Requiring Live Environment Verification

The following items from the GDPR Compliance Audit v2 operational checklist cannot be confirmed from code alone:

- [ ] WAF is attached to production CloudFront distribution(s)
- [ ] WAF or equivalent protection is active in front of the Admin API
- [ ] CloudWatch log groups do not contain unredacted message content
- [ ] DynamoDB tables have encryption at rest enabled (presumed via AWS default)
- [ ] Consent endpoint is reachable and records are written correctly in production
- [ ] DSAR export returns complete data for a test user
- [ ] DSAR erasure deletes expected records and creates audit trail
- [ ] Third-party DPAs exist with OpenRouter, Replicate, Privy (may be held outside repo)
- [ ] Secrets Manager rotation is enforced on a 90-day cycle

---

*Generated: 2026-03-08 | Code-level verification against commit history up to main branch HEAD*
