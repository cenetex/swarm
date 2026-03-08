# GDPR Compliance Audit Report

> **Audit Date**: 2026-03-08
> **Auditor**: Platform Engineering (automated source code review)
> **Scope**: aws-swarm repository (`cenetex/aws-swarm`)
> **Methodology**: Static source code analysis, infrastructure-as-code review, documentation review
> **Status**: Draft -- findings pending operational verification

---

## Executive Summary

This audit evaluates the aws-swarm platform's compliance with the EU General Data Protection Regulation (GDPR). The platform is a multi-tenant AI avatar system operating on AWS serverless infrastructure, processing personal data including wallet addresses, email addresses, session metadata, chat messages, and AI-generated memories.

**Key findings:**

- **Data controller identified**: Cenetex Inc. is declared as the data controller in the privacy policy (`PrivacyPolicy.tsx`).
- **Consent mechanism**: A two-layer consent system is in place -- client-side banner with server-side DynamoDB persistence, policy versioning, and re-consent flow (PR #883, #884).
- **Data retention**: Comprehensive retention matrix with TTL enforcement across all DynamoDB tables, CloudWatch logs, SQS queues, and S3 buckets (`DATA-RETENTION-MATRIX.md`).
- **Data subject rights**: Manual DSAR procedures documented in `DATA-RETENTION-MATRIX.md` Section 5; automated DSAR endpoints (discover/export/erase) scoped in PR #885 but not yet merged to main.
- **Data minimization**: Structured logging avoids message content; PII redaction utility scoped in PR #886 but not yet merged to main.
- **Third-party processors**: Six categories of processors identified; no formal Data Processing Agreements (DPAs) documented.
- **International transfers**: Data processed in AWS us-east-1; third-party processors operate from US-based jurisdictions.

**Remediation status**: Four sub-issues (#878-#881) addressed via PRs #883-#886. At time of audit, these PRs are open and not yet merged to main. Findings below reflect the state of the `main` branch plus the intended remediation from those PRs.

---

## 1. Audit Scope & Methodology

### In Scope

- All packages: `core/`, `handlers/`, `admin-api/`, `admin-ui/`, `infra/`, `mcp-server/`, `profile-page/`
- Infrastructure-as-code: CDK constructs in `packages/infra/src/constructs/`
- Documentation: `docs/DATA-RETENTION-MATRIX.md`, `docs/TERMS-OF-USE.md`, `docs/SECURITY.md`
- Privacy policy: `packages/admin-ui/src/components/PrivacyPolicy.tsx`
- Consent system: `packages/admin-ui/src/store/consent.ts`, `packages/admin-api/src/services/consent.ts`
- Authentication: `packages/admin-api/src/services/accounts/auth-orchestrator.ts`
- Identity linking: `packages/core/src/services/identity-link.ts`
- Memory system: `packages/core/src/services/brain/memory-tiers.ts`
- Audit logging: `packages/admin-api/src/services/audit-log.ts`
- Auto-issue tracking: `packages/admin-api/src/services/auto-issues.ts`

### Out of Scope

- Runtime verification (no live system testing performed)
- Penetration testing
- Legal review of Terms of Use (marked as draft, pending legal counsel per `docs/TERMS-OF-USE.md`)
- Third-party vendor security assessments
- Operational procedures beyond what is documented in source code

### Methodology

Source code review of the repository at commit `8672aa8b` (main branch HEAD as of 2026-03-08), supplemented by review of open PRs #883-#886 for planned remediation. All findings are based on code inspection, not runtime behavior.

---

## 2. Data Inventory

| Data Class | Storage Location | Retention | Lawful Basis | GDPR Article | Status |
|---|---|---|---|---|---|
| **Wallet addresses** (Solana public keys) | DynamoDB `SwarmAdmin-{env}` (account/identity records) | Until account deletion | Legitimate interest (authentication) | Art. 6(1)(f) | Compliant |
| **Email addresses** (via Privy) | DynamoDB `SwarmAdmin-{env}` (account records) | Until account deletion | Consent | Art. 6(1)(a) | Compliant |
| **Session metadata** (IP, User-Agent, timestamps) | DynamoDB `SwarmAdmin-{env}` (session records) | 24 hours (TTL) | Legitimate interest (security) | Art. 6(1)(f) | Compliant |
| **Chat messages** (user-to-avatar) | DynamoDB `SwarmAdmin-{env}` (chat history) | 24 hours (configurable TTL) | Contract performance | Art. 6(1)(b) | Compliant |
| **AI memories** (ephemeral) | DynamoDB `swarm-state-{env}` | 1 day (TTL) | Contract performance | Art. 6(1)(b) | Compliant |
| **AI memories** (durable) | DynamoDB `swarm-state-{env}` | 90 days (TTL) | Contract performance | Art. 6(1)(b) | Compliant |
| **AI memories** (archival) | DynamoDB `swarm-state-{env}` | Unlimited (no TTL) | Consent | Art. 6(1)(a) | Partial -- no user-facing control to opt out of archival tier |
| **Avatar configuration** (persona, prompts) | DynamoDB `SwarmAdmin-{env}` | Until avatar deletion | Contract performance | Art. 6(1)(b) | Compliant |
| **Avatar secrets** (API keys, wallet keys) | AWS Secrets Manager (KMS encrypted) | Until avatar deletion | Contract performance | Art. 6(1)(b) | Compliant |
| **Audit events** | DynamoDB `SwarmAdmin-{env}` | 90 days (TTL) | Legitimate interest (compliance) | Art. 6(1)(f) | Partial -- target is 365 days per retention matrix |
| **Identity link audit events** | DynamoDB `swarm-state-{env}` | 365 days (TTL) | Legitimate interest (compliance) | Art. 6(1)(f) | Compliant |
| **Application logs** | CloudWatch | 14-30 days | Legitimate interest (operations) | Art. 6(1)(f) | Compliant |
| **API Gateway access logs** | CloudWatch | 30 days (prod) | Legitimate interest (security) | Art. 6(1)(f) | Compliant |
| **Channel state** | DynamoDB `swarm-state-{env}` | 90 days (TTL) | Contract performance | Art. 6(1)(b) | Compliant |
| **Activity records** | DynamoDB `swarm-state-{env}` | 24 hours (TTL) | Legitimate interest (rate limiting) | Art. 6(1)(f) | Compliant |
| **Consent records** | DynamoDB `SwarmAdmin-{env}` | No TTL (evidence) | Legal obligation | Art. 6(1)(c) | Compliant |
| **Media assets** | S3 `swarm-media-*` | 30 days (lifecycle), temp: 1 day | Contract performance | Art. 6(1)(b) | Compliant |
| **Auto-issue records** (error tracking) | DynamoDB `SwarmAdmin-{env}` | 30 days (TTL) | Legitimate interest (operations) | Art. 6(1)(f) | Partial -- may contain error context with user data |
| **NFT ownership data** | Not stored (queried live from Solana via Helius) | Not retained | Legitimate interest (access control) | Art. 6(1)(f) | Compliant |
| **Facts** (extracted conversation facts) | DynamoDB `swarm-state-{env}` | 90 days (TTL) | Contract performance | Art. 6(1)(b) | Compliant |

---

## 3. Lawful Basis & Consent

### 3.1 Consent Mechanism

**Frontend (PR #883):**
- `ConsentBanner.tsx` blocks app usage until consent is given.
- Displays a structured summary of data collection categories (wallet/identity, AI conversations, blockchain data, connected services, storage/retention).
- Links to full `PrivacyPolicy.tsx` with detailed disclosures.
- Policy version tracked in `CURRENT_POLICY_VERSION` constant (currently `1.2`).

**Backend (PR #884):**
- `packages/admin-api/src/services/consent.ts` persists consent records to DynamoDB.
- Schema: `pk: CONSENT#<userId>`, `sk: v<policyVersion>`.
- Records are long-lived (no TTL) to serve as compliance evidence.
- Supports: `recordConsent`, `getConsentStatus`, `listConsentRecords`, `revokeConsent`.
- Revocation sets `status: 'revoked'` with timestamp.

**Sync:**
- `packages/admin-ui/src/store/consent.ts` uses Zustand with localStorage persistence as a cache.
- `syncFromBackend()` is called after login to reconcile local state with server-side truth.
- If the backend cannot confirm consent, local state is cleared (conservative approach).

**Re-consent flow:**
- When `CURRENT_POLICY_VERSION` is bumped, `needsConsent()` returns true.
- The consent banner is re-displayed for all users.

| Requirement | Status | Notes |
|---|---|---|
| Freely given | Compliant | Users can review policy before accepting |
| Specific | Compliant | Policy enumerates specific data categories |
| Informed | Compliant | Detailed privacy policy with third-party disclosures |
| Unambiguous | Compliant | Explicit "I Understand & Accept" button |
| Withdrawable | Compliant | `revokeConsent` API and store method exist |
| Versioned & re-prompted | Compliant | Policy version tracking with re-consent on version bump |
| Server-side persistence | Compliant | DynamoDB consent records with no TTL |
| Granular (per-purpose) | Gap | Consent is all-or-nothing; no per-purpose granularity |

### 3.2 Assessment

- Compliant: The consent mechanism meets GDPR Article 7 requirements for demonstrating consent.
- Gap: Consent is currently a single accept/reject for all processing purposes. GDPR Article 6(1)(a) requires consent to be granular when processing serves multiple distinct purposes. The platform bundles AI processing, analytics, and third-party sharing under one consent. This is partially mitigated by the fact that most processing has alternative lawful bases (contract performance, legitimate interest).

---

## 4. Data Minimization

### 4.1 Logging Practices

**Current state (main branch):**
- Structured logging does not log message content -- only metadata (chat ID, message length). Confirmed in `docs/DATA-RETENTION-MATRIX.md` Section 5.3 and `docs/SECURITY.md` ("Sanitized Logging: Never logs message content or secrets").
- Auth orchestrator logs truncated identifiers only (`publicKey.slice(0, 8)`, `privyUserId.slice(0, 8)`).
- Auto-issue service normalizes error fingerprints by replacing UUIDs, IDs, timestamps, file paths, and avatar IDs with placeholders before hashing.

**Planned (PR #886):**
- PII redaction utility (`redact-pii.ts`) for systematic redaction in log output.
- Channel state content truncation to reduce stored data volume.
- Telegram webhook log cleanup.

| Control | Status | File |
|---|---|---|
| No message content in logs | Compliant | Platform-wide logging convention |
| Truncated identifiers in auth logs | Compliant | `auth-orchestrator.ts` |
| Error fingerprint normalization | Compliant | `auto-issues.ts` |
| PII redaction utility | Pending (PR #886) | `packages/core/src/utils/redact-pii.ts` |
| Channel state content truncation | Pending (PR #886) | `packages/core/src/services/state/` |
| Telegram log cleanup | Pending (PR #886) | `packages/handlers/` |

### 4.2 Data Collection Minimization

- Chat history limited to 100 messages per conversation with 24-hour TTL (`chat-history.ts`).
- AI context window limited to 20 recent messages sent to LLM providers (documented in privacy policy).
- Session records have 24-hour TTL.
- Activity records have 24-hour TTL.

### 4.3 Assessment

- Compliant on main branch for logging practices.
- PR #886 will add systematic PII redaction as an additional defense-in-depth measure.

---

## 5. Retention & Deletion

### 5.1 Retention Controls

All retention windows are documented in `docs/DATA-RETENTION-MATRIX.md` and enforced via DynamoDB TTL attributes, CloudWatch log group retention settings, S3 lifecycle rules, and SQS message retention periods.

**DynamoDB TTL enforcement:**
- 44 of 47 data stores are compliant with their policy targets.
- 1 store needs change: audit events (current: 90 days, target: 365 days).
- 2 stores have no automated control: Secrets Manager rotation (manual process).

**CloudWatch retention:**
- All log groups have explicit retention periods set in CDK constructs.
- Production: 14-30 days depending on log group type.
- Staging: 3 days (cost optimization).
- Validated by automated tests in `packages/infra/src/retention-policy.test.ts`.

**S3 lifecycle:**
- `temp/` prefix: 1-day expiry.
- General media: 30-day transition to Intelligent Tiering.
- CDN logs: 90-day expiry.

| Data Store | Target | Current | Status |
|---|---|---|---|
| DynamoDB operational data | Various (1h-90d) | TTL enforced | Compliant |
| DynamoDB audit events | 365 days | 90 days TTL | Needs change |
| Identity link audit events | 365 days | 365 days TTL | Compliant |
| CloudWatch logs (prod) | 14-30 days | Explicit retention | Compliant |
| S3 media | 30 days | Lifecycle rules | Compliant |
| S3 temp files | 1 day | Lifecycle rules | Compliant |
| SQS messages | 1-4 days | Queue retention | Compliant |
| SQS DLQs | 14 days | Queue retention | Compliant |
| Consent records | Indefinite | No TTL (evidence) | Compliant |
| Archival memories | Unlimited | No TTL | Partial -- no user opt-out |

### 5.2 Deletion Procedures

- Manual DSAR deletion runbook documented in `docs/DATA-RETENTION-MATRIX.md` Section 5.1.
- Avatar deletion runbook in Section 5.2 with per-data-store cleanup instructions.
- Automated DSAR endpoints (discover/export/erase) scoped in PR #885, not yet merged.

### 5.3 Assessment

- The retention framework is mature and well-documented.
- The gap on audit event TTL (90 days vs. 365-day target) is a known issue tracked in the retention matrix (R1).
- Archival memories have unlimited retention with no user-facing mechanism to request deletion of specific archival memories (only full account deletion or TTL expiry for non-archival tiers).

---

## 6. Data Subject Rights (DSAR)

### 6.1 Right of Access (Art. 15)

**Current state (main branch):**
- Privacy policy states users can request a copy of their data by emailing `privacy@cenetex.com`.
- No self-service data export endpoint exists on main branch.
- Manual export procedure documented in `DATA-RETENTION-MATRIX.md` Section 5.1 using AWS CLI queries.

**Planned (PR #885):**
- Automated discover/export endpoint for programmatic data retrieval.
- Response in machine-readable format.

| Requirement | Status | Notes |
|---|---|---|
| Users can request access | Partial | Email-only, no self-service |
| Data provided in portable format | Pending (PR #885) | Planned machine-readable export |
| Response within 30 days | Documented | Privacy policy states 30-day window |

### 6.2 Right to Erasure (Art. 17)

**Current state (main branch):**
- Privacy policy documents the right to request deletion.
- Manual deletion runbook exists in `DATA-RETENTION-MATRIX.md` Section 5.1.
- Most data auto-expires via TTL (24 hours to 90 days).
- Archival memories have no TTL and require manual deletion.
- Audit logs and consent records are retained post-erasure (legitimate interest / legal obligation basis).

**Planned (PR #885):**
- Automated erase endpoint.
- Audit trail of erasure requests.

| Requirement | Status | Notes |
|---|---|---|
| Users can request erasure | Partial | Email-only, manual process |
| Erasure completed within 30 days | Documented | Policy states 30-day window |
| Exceptions documented | Compliant | Audit logs retained for compliance |
| Audit trail of erasure requests | Pending (PR #885) | Planned audit logging |

### 6.3 Right to Data Portability (Art. 20)

- Privacy policy mentions the right to data portability in Section 7.
- No self-service export currently exists on main branch.
- PR #885 adds a machine-readable export endpoint.

### 6.4 Right to Rectification (Art. 16)

- Users can modify avatar configuration, persona, and profile through the admin chat interface.
- Account-level data (wallet address, email) is immutable by design (identity anchors).
- No formal rectification endpoint exists; users must contact `privacy@cenetex.com`.

### 6.5 Right to Withdraw Consent (Art. 7(3))

- `revokeConsent` method exists in both frontend store and backend service.
- Consent revocation sets `status: 'revoked'` with a timestamp.
- The privacy policy states withdrawal does not affect the lawfulness of prior processing.
- **Gap**: No documentation of what happens to data processing after consent withdrawal (i.e., does the platform stop processing, or does it continue under alternative lawful bases?).

### 6.6 Assessment

- DSAR capabilities are currently manual (email-based) with documented runbooks.
- PR #885 will add automated discover/export/erase endpoints, which would bring the platform to a substantially higher compliance level.
- The 30-day response window is documented but enforcement is operational (no automated tracking of request deadlines).

---

## 7. Security Controls

### 7.1 Encryption at Rest

| Resource | Encryption | Status |
|---|---|---|
| DynamoDB tables | AES-256 (AWS default encryption) | Compliant |
| S3 buckets | Server-side encryption (default) | Compliant |
| Secrets Manager | KMS encryption | Compliant |
| SQS queues | SQS-managed encryption (`SQS_MANAGED`) | Compliant |
| CloudWatch logs | AWS default encryption | Compliant |

### 7.2 Encryption in Transit

| Channel | Encryption | Status |
|---|---|---|
| API Gateway -> Client | TLS (HTTPS enforced) | Compliant |
| Lambda -> DynamoDB | TLS (AWS SDK default) | Compliant |
| Lambda -> Secrets Manager | TLS (AWS SDK default) | Compliant |
| CloudFront -> Client | TLS (HTTPS enforced) | Compliant |
| Lambda -> Third-party APIs | TLS (HTTPS) | Compliant |

### 7.3 Access Controls

| Control | Implementation | Status |
|---|---|---|
| Authentication | Solana wallet signature (Ed25519/SIWS) + Privy (email/social) | Compliant |
| Session management | DynamoDB-backed sessions with 24-hour TTL, HttpOnly/Secure/SameSite cookies | Compliant |
| Authorization | Admin wallet list, per-avatar partition-key isolation | Compliant |
| API Gateway auth | Lambda authorizer with session validation | Compliant |
| CORS | Origin-validated with explicit allowed origins list | Compliant |
| WAF | WAFv2 on CloudFront distributions (Admin UI, Profile Page, Media CDN) | Partial -- not on API Gateway HTTP API (unsupported by AWS) |
| Rate limiting | Platform-level rate limits per subscription tier | Compliant |
| Least privilege IAM | Lambda roles scoped to specific tables/resources | Compliant |
| DynamoDB data isolation | Partition-key isolation per avatar | Compliant |

### 7.4 Infrastructure Security

| Control | Implementation | Status |
|---|---|---|
| Point-in-time recovery | Enabled for DynamoDB in persistent environments | Compliant |
| Deletion protection | Enabled for DynamoDB in persistent environments | Compliant |
| Removal policy | `RETAIN` for persistent environments | Compliant |
| Dependency auditing | `pnpm audit --audit-level=high` in CI | Compliant |
| Security exception governance | Formal exception registry with weekly automated review | Compliant |
| Privileged access review | Quarterly recertification workflow | Compliant |

### 7.5 Assessment

- Security controls are well-implemented with defense-in-depth.
- The WAF gap on API Gateway HTTP API is an AWS platform limitation, not a configuration oversight.
- No evidence of customer-managed KMS keys (using AWS-managed keys) -- acceptable for current scale but may need review for enterprise customers.

---

## 8. Third-Party Processors

| Processor | Data Shared | Purpose | Location | DPA Status |
|---|---|---|---|---|
| **OpenRouter** (routes to Anthropic Claude, OpenAI GPT-4) | Conversation history (up to 20 messages), system prompts, avatar persona | AI response generation | USA | No formal DPA documented |
| **Privy** | Access tokens, linked account data, email addresses | Email/social authentication | USA | No formal DPA documented |
| **Helius** (Solana RPC) | Wallet public keys | NFT ownership verification | USA | No formal DPA documented |
| **Replicate** | AI model prompts | Image/video/audio generation | USA | No formal DPA documented |
| **AWS** | All backend data | Infrastructure (DynamoDB, Lambda, CloudWatch, S3, Secrets Manager, SQS) | us-east-1 (USA) | AWS DPA available (standard) |
| **Telegram / X/Twitter / Discord** | Message content, media (when user connects these platforms) | Channel integrations | USA/global | Platform-specific terms apply |
| **Stripe** (planned, not yet integrated) | Payment data, email | Billing (M2 milestone) | USA | Not yet applicable |

### Assessment

- GDPR Article 28 requires written contracts (DPAs) with all processors.
- AWS provides a standard DPA that covers their services.
- No formal DPAs are documented for OpenRouter, Privy, Helius, or Replicate.
- This is a significant compliance gap. Each processor should have a signed DPA or at minimum a documented assessment of their GDPR compliance posture.

---

## 9. International Transfers

### 9.1 Data Locations

| Component | Region | Transfer Mechanism |
|---|---|---|
| AWS infrastructure | us-east-1 (N. Virginia, USA) | Standard Contractual Clauses (AWS DPA) |
| OpenRouter | USA | None documented |
| Privy | USA | None documented |
| Helius | USA | None documented |
| Replicate | USA | None documented |

### 9.2 Assessment

- All data is processed in the United States.
- For EU data subjects, this constitutes an international transfer under GDPR Chapter V.
- AWS provides Standard Contractual Clauses (SCCs) as part of their DPA.
- No Transfer Impact Assessments (TIAs) have been conducted for other processors.
- **Gap**: The platform does not offer an EU-region deployment option. All personal data of EU users is transferred to the US.
- **Gap**: No documented SCCs or adequacy decisions for non-AWS processors.

---

## 10. Incident Response

### 10.1 Current State

| Requirement | GDPR Article | Status | Notes |
|---|---|---|---|
| Breach notification to supervisory authority (72 hours) | Art. 33 | Gap | No documented incident response procedure |
| Breach notification to data subjects | Art. 34 | Gap | No documented notification process |
| Breach detection | -- | Partial | CloudWatch alarms, DLQ monitoring, auto-issue tracking exist but not specifically for data breaches |
| Breach documentation | Art. 33(5) | Gap | No breach register or template |
| DPO appointment | Art. 37 | N/A | Not required unless processing at scale or processing special categories |

### 10.2 Assessment

- The platform has operational monitoring (CloudWatch dashboards, DLQ alarms, auto-issue tracking) but no formal GDPR-specific incident response procedure.
- No documented process for classifying a security incident as a personal data breach.
- No breach notification templates or contact details for relevant supervisory authorities.
- This is a significant compliance gap.

---

## 11. Remediation Tracker

| # | Finding | GDPR Article | Severity | Remediation | PR | Status |
|---|---|---|---|---|---|---|
| F1 | Privacy policy aligned with actual data practices | Art. 13, 14 | High | Updated PrivacyPolicy.tsx, ConsentBanner.tsx, TERMS-OF-USE.md | PR #883 | Resolved (pending merge) |
| F2 | Consent not persisted server-side | Art. 7(1) | High | DynamoDB consent records, API endpoints, frontend sync | PR #884 | Resolved (pending merge) |
| F3 | No automated DSAR workflow | Art. 15, 17, 20 | High | Discover/export/erase endpoints with audit trail | PR #885 | Resolved (pending merge) |
| F4 | PII redaction utility missing | Art. 5(1)(c) | Medium | redact-pii.ts, channel state truncation, log cleanup | PR #886 | Resolved (pending merge) |
| F5 | Audit event TTL too short (90d vs 365d target) | Art. 5(1)(e) | Medium | Extend `AUDIT_TTL_SECONDS` to 365 days | PR #886 | Resolved (pending merge) |
| F6 | No formal DPAs with third-party processors | Art. 28 | High | Requires legal/procurement action | -- | Open |
| F7 | No incident response procedure for data breaches | Art. 33, 34 | High | Requires process documentation | -- | Open |
| F8 | No Transfer Impact Assessments for US processors | Art. 46 | Medium | Requires legal assessment | -- | Open |
| F9 | No granular consent (all-or-nothing) | Art. 6(1)(a) | Low | Consider per-purpose consent toggles | -- | Open |
| F10 | Archival memories have unlimited retention with no user opt-out | Art. 17 | Medium | Add user-facing control to delete archival memories | -- | Open |
| F11 | No Data Protection Officer designated | Art. 37 | Low | Assess whether DPO appointment is required based on processing scale | -- | Open |
| F12 | Terms of Use not legally reviewed | Art. 13 | Medium | Engage legal counsel per `docs/TERMS-OF-USE.md` | -- | Open |
| F13 | No breach register or notification templates | Art. 33(5) | Medium | Create breach register and templates | -- | Open |
| F14 | Secrets Manager keys lack automated rotation | Art. 32 | Low | Add rotation schedule (90-day target in retention matrix R2) | -- | Open |
| F15 | Auto-issue error records may contain user context data | Art. 5(1)(c) | Low | Review `context` field in `auto-issues.ts` for PII | -- | Open |
| F16 | No EU-region deployment option | Art. 44-49 | Low | Consider EU deployment for compliance-sensitive customers | -- | Open |
| F17 | Privacy policy "Last updated" is dynamic (`new Date()`) | Art. 13 | Low | Use a fixed date matching the policy version | -- | Open |

---

## 12. Recommendations

Ordered by risk (highest first):

### P0 -- Critical (address before production launch with EU users)

1. **Execute DPAs with all third-party processors** (F6). Contact OpenRouter, Privy, Helius, and Replicate to obtain or negotiate Data Processing Agreements. AWS DPA should be formally accepted.

2. **Document an incident response procedure** (F7, F13). Create a data breach response runbook with: classification criteria, notification templates (supervisory authority + data subjects), responsible persons, 72-hour notification workflow, and breach register.

3. **Merge PRs #883-#886** (F1-F5). The remediation work is completed in code but not yet on the main branch. Until merged, the production system lacks server-side consent persistence, automated DSAR endpoints, and PII redaction.

### P1 -- High (address within 30 days)

4. **Conduct Transfer Impact Assessments** (F8). Document the legal basis for transferring EU personal data to US-based processors, referencing SCCs or other Article 46 mechanisms.

5. **Add user-facing archival memory controls** (F10). Allow users to view and request deletion of archival-tier memories through the admin chat interface.

6. **Engage legal counsel for Terms of Use** (F12). The Terms of Use are explicitly marked as draft and unreviewed. Several TBD fields remain (jurisdiction, contact info, effective date).

### P2 -- Medium (address within 90 days)

7. **Fix privacy policy "Last updated" date** (F17). Replace `new Date().toLocaleDateString()` with a static date that corresponds to the policy version.

8. **Review auto-issue context fields for PII** (F15). Audit the `context` parameter in `auto-issues.ts` `recordError()` calls to ensure no personal data leaks into error tracking records.

9. **Implement Secrets Manager rotation** (F14). Add automated rotation reminders or rotation Lambdas for the admin LLM API key and Replicate API key (90-day target per retention matrix R2).

### P3 -- Low (address within 180 days)

10. **Consider per-purpose consent** (F9). Evaluate whether the current all-or-nothing consent model is sufficient or whether granular consent toggles (e.g., separate consent for AI processing vs. analytics) are warranted.

11. **Assess DPO requirement** (F11). Determine whether the scale of personal data processing triggers the Article 37 requirement for a Data Protection Officer.

12. **Evaluate EU-region deployment** (F16). For enterprise customers or regulatory requirements, consider offering an EU-region (eu-west-1 or eu-central-1) deployment option.

---

## 13. Conclusion

The aws-swarm platform demonstrates a strong foundation for GDPR compliance. The data retention framework is mature and well-enforced through infrastructure-as-code with automated testing. The consent mechanism (once PRs #883-#884 are merged) provides a solid implementation of Article 7 requirements with server-side evidence persistence.

The primary compliance gaps are organizational rather than technical:

1. **Missing DPAs** with third-party processors (OpenRouter, Privy, Helius, Replicate).
2. **Missing incident response procedures** for data breach notification.
3. **Missing Transfer Impact Assessments** for international data transfers.
4. **Pending legal review** of Terms of Use.

These gaps require legal and procurement action rather than engineering work. The technical remediation tracked in PRs #883-#886 addresses the most significant code-level gaps and should be prioritized for merge.

---

**Appendix: Referenced Files**

| File | Purpose |
|---|---|
| `docs/DATA-RETENTION-MATRIX.md` | Retention windows, deletion runbooks |
| `docs/TERMS-OF-USE.md` | Legal terms (draft) |
| `docs/SECURITY.md` | Security policy, dependency auditing, exception governance |
| `packages/admin-ui/src/components/PrivacyPolicy.tsx` | Privacy policy (user-facing) |
| `packages/admin-ui/src/components/ConsentBanner.tsx` | Consent collection UI |
| `packages/admin-ui/src/store/consent.ts` | Client-side consent state management |
| `packages/admin-api/src/services/consent.ts` | Server-side consent persistence |
| `packages/admin-api/src/services/audit-log.ts` | Audit event recording (90-day TTL) |
| `packages/admin-api/src/services/chat-history.ts` | Chat history with 24-hour TTL |
| `packages/admin-api/src/services/auto-issues.ts` | Error tracking with fingerprint normalization |
| `packages/admin-api/src/services/accounts/auth-orchestrator.ts` | Authentication (wallet + Privy) |
| `packages/core/src/services/identity-link.ts` | Cross-platform identity linking with consent audit trail |
| `packages/core/src/services/brain/memory-tiers.ts` | Memory tier policies (ephemeral/durable/archival) |
| `packages/infra/src/constructs/admin-api.ts` | CDK construct (DynamoDB, SQS, IAM, encryption) |
| `packages/infra/src/retention-policy.test.ts` | Automated retention policy validation |
