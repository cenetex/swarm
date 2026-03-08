# GDPR Compliance Audit — v2 (Post-Remediation)

> Date: 2026-03-08
> Reviewer: Codex engineering audit (refresh)
> Related issues: #888, #875 (original), #883, #884, #885, #886 (remediation)
> Scope: repository code and documentation review only
> Caveat: this is an engineering compliance assessment, not legal advice

## Executive Summary

This is a refresh of the [original GDPR audit](./GDPR-COMPLIANCE-AUDIT.md) conducted on 2026-03-08 against issue #875. Four remediation PRs have since merged to main:

| PR | Issue | Scope |
|----|-------|-------|
| #883 | #878 | Privacy disclosures aligned with actual retention controls |
| #884 | #879 | Server-side consent persistence |
| #885 | #880 | DSAR export and erasure workflow |
| #886 | #881 | Data minimization and PII log redaction |

**Updated assessment: Partial compliance with major gaps closed.** The platform now has a defensible position on notice accuracy, consent evidence, data subject rights, and log minimization. Remaining gaps are primarily governance artifacts (DPA, DPIA, RoPA) and operational verification items that cannot be confirmed from code alone.

## Risk Rating Comparison

| Area | Previous | Current | Change |
|------|----------|---------|--------|
| Transparency and notice accuracy | High | **Low** | Privacy policy now itemizes retention by data class with correct TTLs |
| Lawful basis and consent evidence | High | **Low** | Server-side immutable consent records in DynamoDB |
| Data minimization and retention | High | **Medium** | PII redaction in all loggers; channel state truncated to 200 chars; archival memory still indefinite |
| Data subject rights | High | **Medium** | DSAR workflow covers chat, identity, memory, issues; S3 media and CloudWatch not yet included |
| Security of processing | Medium | **Medium** | No change — baseline controls solid, WAF placement needs operational verification |
| Logging and observability | Medium | **Low** | Central `redactPii()` utility applied to core Logger and StructuredLogger |
| Processor and transfer governance | Medium | **Medium** | Third-party processor table added to privacy policy; no DPA/SCC/DPIA artifacts in repo |
| Accountability and auditability | Medium | **Low** | Audit log TTL extended to 365 days; DSAR erasure creates audit trail; consent records are immutable |

## Remediation Details

### 1. Privacy Disclosures (#883) — CLOSED

**What changed:**
- `packages/admin-ui/src/components/PrivacyPolicy.tsx` — replaced simplified retention language with a data-class-based table matching actual TTL values:
  - Chat messages: 24-hour TTL
  - Ephemeral memory: 1 day
  - Durable memory: 90 days
  - Archival memory: unlimited
  - Audit logs: 365 days (configurable via `AUDIT_TTL_DAYS`)
  - Canonical memories: 30 days
  - Content store: 90/7/30 days (posted/rejected/pending)
- Added third-party processor disclosure table (OpenRouter, Replicate, Privy, Helius, Solana RPC, Telegram, Discord, Twitter, AWS)
- Added explicit "We do not sell your data" and "We do not use conversations to train our own AI models" statements
- `packages/admin-ui/src/components/ConsentBanner.tsx` updated to reference server-side consent
- `docs/TERMS-OF-USE.md` updated (still marked DRAFT pending legal review)

**Residual gap:** Terms of Use still marked DRAFT. Should be finalized with legal counsel before treating as binding.

### 2. Server-Side Consent Persistence (#884) — CLOSED

**What changed:**
- `packages/admin-api/src/services/consent.ts` — DynamoDB consent records (`pk: CONSENT#<userId>`, `sk: v<version>`) with `acceptedAt`, `status`, `revokedAt` fields. No TTL — records are intentionally long-lived for GDPR Article 7(1) evidence.
- `packages/admin-api/src/handlers/consent.ts` — REST endpoints: `POST /consent` (record acceptance), `GET /consent` (check status), `POST /consent/revoke` (revoke with timestamp)
- `packages/admin-ui/src/api/consent.ts` — client-side sync; localStorage remains as cache, server is source of truth
- Test coverage: 291 test assertions in `consent.test.ts`

**Residual gap:** None for this specific control. Consent evidence chain is now complete.

### 3. DSAR Export & Erasure (#885) — CLOSED

**What changed:**
- `packages/admin-api/src/services/dsar.ts` — three operations:
  - `inventory(userId)` — counts data by class (chat, identity, memory, issues)
  - `export(userId)` — structured JSON export of all user data
  - `erase(userId, { dryRun })` — deletion with preview mode and audit trail
- `packages/admin-api/src/handlers/dsar.ts` — REST endpoints: `GET /dsar/inventory`, `POST /dsar/export`, `POST /dsar/erase`
- `docs/DSAR-WORKFLOW.md` — architecture, API reference, data coverage, and documented limitations
- Test coverage: 347 test assertions in `dsar.test.ts`
- Retention exceptions documented: audit events retained for accountability (GDPR Article 5(2)); erasure request itself recorded as audit event

**Residual gaps:**
- S3 media assets not covered by DSAR erasure (relies on S3 lifecycle rules)
- CloudWatch logs not auto-deleted (message content intentionally not logged, but cannot be verified from code)
- Memory scan uses table scan filtered by `userId` — no GSI. Performance concern for large datasets.

### 4. Data Minimization & Log Redaction (#886) — CLOSED

**What changed:**
- `packages/core/src/utils/redact-pii.ts` — central redaction utility with pattern matching for emails, wallet addresses, bearer tokens, API keys, IPv4 addresses, and sensitive field names (email, phone, password, token, apikey, secret, wallet_address, private_key)
- Integrated into `packages/core/src/utils/logger.ts` and `packages/admin-api/src/services/structured-logger.ts`
- `packages/core/src/services/state/channel-state.ts` — message content truncated to 200 characters in runtime state buffer
- `packages/handlers/src/telegram/telegram-webhook-shared.ts` — DM allowlist logs demoted from INFO to DEBUG (sender userId/username no longer logged in production)
- `packages/admin-api/src/services/audit-log.ts` — TTL extended from 90 days to 365 days (configurable)
- Test coverage: 22+ tests in `redact-pii.test.ts`

**Residual gap:** No enforcement test proving message content is never serialized to CloudWatch. Redaction is applied at the logger level but a developer could bypass it with `console.log`.

## Remaining Gaps

### Priority 1 — Should address before next major release

| # | Gap | GDPR Article | Severity | Notes |
|---|-----|-------------|----------|-------|
| G1 | **Processor governance artifacts missing** | Art. 28 | Medium | No DPA, SCC, or subprocessor list in repo. Third-party disclosure exists in privacy policy but binding contracts are not evidenced. May exist outside repo. |
| G2 | **Cross-platform consent revocation semantics** | Art. 17 | Medium | Identity-link revocation is "forward-only" — stops future merges but does not purge previously merged data (`packages/handlers/src/services/cross-platform-consent.ts:11-14`). Requires product decision. |
| G3 | **S3 media assets not in DSAR erasure** | Art. 17 | Medium | DSAR covers DynamoDB but not S3 objects. Lifecycle rules handle expiry but not on-demand erasure. |

### Priority 2 — Address within 60 days

| # | Gap | GDPR Article | Severity | Notes |
|---|-----|-------------|----------|-------|
| G4 | **WAF placement verification** | Art. 32 | Medium | Privacy policy claims WAF v2 protection; CDK notes HTTP API v2 cannot attach WAF directly (`packages/infra/src/constructs/admin-api.ts:748-750`). Needs operational verification. |
| G5 | **Secrets rotation policy** | Art. 32 | Medium | API keys in Secrets Manager have no automated rotation. Manual 90-day target documented but not enforced. |
| G6 | **DPIA / RoPA / legitimate-interest assessment** | Art. 30, 35 | Medium | No formal records of processing activity or data protection impact assessment in repo. May exist in compliance team's documentation. |
| G7 | **Terms of Use finalization** | Art. 13 | Low | Still marked DRAFT. Should be reviewed by legal counsel. |

### Priority 3 — Nice to have

| # | Gap | Notes |
|---|-----|-------|
| G8 | Memory DSAR GSI | Add `userId` GSI to MEMORY partition for faster DSAR inventory on large datasets |
| G9 | Browser storage minimization | Auth state in localStorage stores identity mappings; could reduce to session token only |
| G10 | Privacy policy versioning | Currently embedded in React component; could be versioned markdown rendered at build time |

## Operational Verification Checklist

These items cannot be confirmed from repository code and require live environment inspection:

- [ ] WAF is attached to production CloudFront distribution or API Gateway stage
- [ ] CloudWatch log groups do not contain unredacted message content
- [ ] DynamoDB tables have encryption at rest enabled (presumed via AWS default but not explicit in CDK)
- [ ] Consent endpoint is reachable and records are written correctly in production
- [ ] DSAR export returns complete data for a test user
- [ ] DSAR erasure deletes expected records and creates audit trail
- [ ] Third-party DPAs exist with OpenRouter, Replicate, Privy (may be held outside repo)

## Conclusion

The four remediation PRs (#883, #884, #885, #886) have closed the most critical gaps identified in the original audit. The platform now has:

- **Accurate privacy notices** aligned with actual retention behavior
- **Server-side consent evidence** with immutable DynamoDB records
- **DSAR workflow** covering the primary data stores (chat, identity, memory, issues)
- **Central PII redaction** applied to all logging infrastructure
- **Extended audit trail** (365-day retention) for accountability

The remaining gaps are primarily governance artifacts (DPA, DPIA, RoPA) that typically live outside the codebase, product decisions (cross-platform revocation semantics), and operational verification items. No P0 findings remain.

**Updated overall assessment: Partial compliance with defensible controls in place. Remaining work is governance documentation and operational verification.**
