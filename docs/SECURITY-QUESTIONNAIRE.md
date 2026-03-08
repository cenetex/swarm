# Security Questionnaire Response Kit

> Last updated: 2026-03-08
> Owner: Cenetex Inc.
> Contact: privacy@cenetex.com

Pre-filled responses to common buyer security questionnaire questions. Each answer references the canonical source document for verification.

---

## Hosting and Infrastructure

**Q: Who is your hosting provider?**
A: Amazon Web Services (AWS). All infrastructure runs on managed serverless services (Lambda, DynamoDB, S3, SQS, CloudFront). No self-managed servers.
Source: [SUBPROCESSOR-REGISTER.md](./SUBPROCESSOR-REGISTER.md), [DATA-RETENTION-MATRIX.md](./DATA-RETENTION-MATRIX.md)

**Q: What regions is data hosted in?**
A: US regions: us-east-1 and us-west-2. EU-region deployment is under evaluation but not yet implemented.
Source: [TRANSFER-IMPACT-ASSESSMENT.md](./TRANSFER-IMPACT-ASSESSMENT.md) Section 1

**Q: Do you use a multi-tenant architecture?**
A: Yes. The platform is multi-tenant with data isolation enforced through DynamoDB partition key schemas. Each avatar's data is keyed under its own partition (e.g., `AVATAR#{id}`, `MEMORY#{avatarId}`).
Source: [DSAR-WORKFLOW.md](./DSAR-WORKFLOW.md) Section 1

---

## Encryption

**Q: Is data encrypted at rest?**
A: Yes. DynamoDB and S3 use AWS-managed encryption via KMS (AES-256). DynamoDB encryption at rest is enabled by AWS default. Secrets are stored in AWS Secrets Manager with KMS encryption.
Source: [SECURITY.md](./SECURITY.md) (Security Best Practices), [TRANSFER-IMPACT-ASSESSMENT.md](./TRANSFER-IMPACT-ASSESSMENT.md) Section 3.2

**Q: Is data encrypted in transit?**
A: Yes. All API calls (internal and to third-party processors) use TLS 1.2 or higher. CloudFront enforces HTTPS for all CDN traffic.
Source: [TRANSFER-IMPACT-ASSESSMENT.md](./TRANSFER-IMPACT-ASSESSMENT.md) Section 3.2

**Q: How are secrets and API keys managed?**
A: Secrets are stored in AWS Secrets Manager with KMS encryption. No secrets are committed to source code. Automated rotation is not yet implemented; a 90-day manual rotation target is documented but not enforced.
Source: [SECURITY.md](./SECURITY.md) (Code Security), [DATA-RETENTION-MATRIX.md](./DATA-RETENTION-MATRIX.md) Section 2.6

---

## Authentication and Access Control

**Q: What authentication methods are supported?**
A: End users authenticate via Solana wallet signature or Privy (email/social login). NFT ownership is verified on-chain for feature gating. Administrative access uses Cloudflare Access.
Source: [SECURITY.md](./SECURITY.md) (Infrastructure Security), [ACCOUNTABILITY-CHECKLIST.md](./ACCOUNTABILITY-CHECKLIST.md) Section 1.2

**Q: How is administrative access controlled?**
A: Cloudflare Access for admin authentication (zero-trust model). Lambda execution roles follow the principle of least privilege. Privileged identities (GitHub admins, deployment roles, admin wallets) are recertified quarterly.
Source: [SECURITY.md](./SECURITY.md) (Infrastructure Security, Privileged Access Review)

**Q: Is multi-factor authentication (MFA) supported?**
A: Wallet-based authentication is inherently single-factor (cryptographic signature). Privy supports MFA through its authentication service. Cloudflare Access supports MFA for admin users. Platform-level MFA enforcement for end users is not currently implemented.
Source: [SECURITY.md](./SECURITY.md)

---

## Logging and Monitoring

**Q: What logging and monitoring is in place?**
A: All application logs are sent to AWS CloudWatch with defined retention periods (14-30 days depending on service). All administrative actions are recorded in a DynamoDB audit log with 365-day retention. A central PII redaction utility strips sensitive data (emails, wallet addresses, tokens, API keys, IP addresses) from all structured log output.
Source: [DATA-RETENTION-MATRIX.md](./DATA-RETENTION-MATRIX.md) Section 2.3, [SECURITY.md](./SECURITY.md)

**Q: Are logs tamper-proof?**
A: CloudWatch logs are managed by AWS and follow AWS's integrity controls. DynamoDB audit events are append-only by application design (no delete operations exposed via API), though this is an application-level control, not a cryptographic guarantee.
Source: [DSAR-WORKFLOW.md](./DSAR-WORKFLOW.md) Section 2

**Q: Is PII excluded from logs?**
A: Yes. A central redaction utility (`redact-pii.ts`) is applied to all structured loggers. It redacts email addresses, wallet addresses, bearer/bot tokens, API key patterns, and IPv4 addresses. Message content is not logged (only metadata such as message length and chat ID). Sensitive field names (email, phone, password, token, etc.) are fully replaced.
Source: [DATA-RETENTION-MATRIX.md](./DATA-RETENTION-MATRIX.md) Section 6

---

## Incident Response

**Q: Do you have an incident response plan?**
A: Data breach notification responsibilities are documented with defined owners and a 72-hour awareness-to-notification target (per GDPR Art. 33). Security vulnerability reporting uses GitHub's private vulnerability reporting feature. The operational escalation path is: Engineering lead -> CEO -> Legal counsel -> Supervisory authority liaison.
Source: [ACCOUNTABILITY-CHECKLIST.md](./ACCOUNTABILITY-CHECKLIST.md) Section 3.2, [SECURITY.md](./SECURITY.md) (Reporting Security Vulnerabilities)

**Q: How are security vulnerabilities in dependencies handled?**
A: Automated `pnpm audit` runs in CI on every pull request and blocks merges on high/critical vulnerabilities. Known exceptions are tracked in a machine-readable registry (`.audit-exceptions.json`) with mandatory expiry dates, defined owners, and weekly automated review. Maximum exception duration: 30 days for critical, 90 days for high severity.
Source: [SECURITY.md](./SECURITY.md) (Dependency Security, Security Exception Governance)

---

## Subprocessors

**Q: What third-party services process personal data?**
A: 10 third-party services are documented in the subprocessor register: AWS (infrastructure), OpenRouter (LLM inference), Replicate (media generation), Privy (authentication), Stripe (payments), Helius (blockchain queries), Telegram, Discord, X (platform integrations), and Solana RPC providers.
Source: [SUBPROCESSOR-REGISTER.md](./SUBPROCESSOR-REGISTER.md)

**Q: Do you have Data Processing Agreements (DPAs) with subprocessors?**
A: DPAs are executed or covered by standard terms for AWS and Stripe. DPAs with OpenRouter, Replicate, and Privy are pending execution (targeted by 2026-04-30). Telegram, Discord, and X are classified as independent controllers (platform API relationships), not processors.
Source: [SUBPROCESSOR-REGISTER.md](./SUBPROCESSOR-REGISTER.md) (DPA Execution Status Summary)

**Q: Where do subprocessors store data?**
A: All primary processors are US-based. AWS infrastructure runs in us-east-1 and us-west-2. Telegram operates from UAE/Global. Blockchain services are decentralized. A full transfer impact assessment is documented.
Source: [TRANSFER-IMPACT-ASSESSMENT.md](./TRANSFER-IMPACT-ASSESSMENT.md) Section 2

---

## Data Retention

**Q: What are your data retention periods?**
A: Retention varies by data class, all enforced by automated controls (DynamoDB TTL, S3 lifecycle, CloudWatch retention): chat messages (24 hours), ephemeral AI memory (1 day), durable memory (90 days), archival memory (unlimited), audit logs (365 days, configurable), application logs (14-30 days), temporary media (1 day), general media (30-day transition to tiered storage).
Source: [DATA-RETENTION-MATRIX.md](./DATA-RETENTION-MATRIX.md) Sections 2.1-2.5

**Q: Can data be deleted on request?**
A: Yes. The platform provides automated DSAR endpoints for data inventory, export (structured JSON), and erasure. Erasure covers chat history, identity links, AI memories, and auto-issues. Audit events are retained under a documented lawful-basis exception (GDPR Art. 5(2)). A dry-run mode is available to preview deletions before executing.
Source: [DSAR-WORKFLOW.md](./DSAR-WORKFLOW.md) Sections 2-3

---

## DSAR and Privacy Rights

**Q: How do you handle data subject access requests?**
A: Three automated API endpoints are available: inventory (discover what data is held), export (download all personal data in JSON), and erasure (delete with audit trail). All endpoints require authentication; users can only access their own data. Erasure requests are themselves recorded as audit events for accountability.
Source: [DSAR-WORKFLOW.md](./DSAR-WORKFLOW.md)

**Q: What data is included in an export?**
A: Exports include chat history, audit log entries, identity links, AI memories, and auto-issues. Known gaps: S3 media assets and CloudWatch logs are not yet included in automated exports (media expires via lifecycle rules; logs do not contain message content).
Source: [DSAR-WORKFLOW.md](./DSAR-WORKFLOW.md) Section 6

**Q: How is consent managed?**
A: Server-side immutable consent records are stored in DynamoDB with `acceptedAt`, `status`, and `revokedAt` fields. No TTL -- records are intentionally long-lived for GDPR Article 7(1) evidence. The client-side consent banner syncs with the server; the server is the source of truth.
Source: [GDPR-COMPLIANCE-AUDIT-v2.md](./GDPR-COMPLIANCE-AUDIT-v2.md) Section 2 (Remediation #2)

---

## Compliance Certifications

**Q: Do you hold SOC 2, ISO 27001, or other certifications?**
A: No. Cenetex Inc. does not currently hold SOC 2, ISO 27001, or other formal security certifications. The platform relies on AWS's underlying compliance certifications (SOC 1/2/3, ISO 27001, etc.) for infrastructure-level controls.

**Q: Have you completed a GDPR compliance assessment?**
A: Yes. Two internal engineering compliance audits have been conducted (most recently 2026-03-08). The assessment found partial compliance with defensible controls in place. Four major remediation PRs have been completed (privacy notices, consent evidence, DSAR workflow, PII log redaction). Remaining gaps are primarily governance artifacts (DPAs, DPIA, RoPA). These are internal engineering assessments, not formal legal opinions.
Source: [GDPR-COMPLIANCE-AUDIT-v2.md](./GDPR-COMPLIANCE-AUDIT-v2.md)

**Q: Has a penetration test been conducted?**
A: Not yet. No formal penetration test has been conducted. This is a recognized gap.

---

## Business Continuity

**Q: What is your disaster recovery strategy?**
A: The platform uses AWS managed services (DynamoDB, S3, Lambda) which provide built-in durability and availability guarantees per AWS SLAs. DynamoDB provides cross-region replication capability (not currently enabled). S3 provides 99.999999999% durability. No formal business continuity plan (BCP) or disaster recovery plan (DRP) document exists yet.

**Q: What is your uptime SLA?**
A: No formal uptime SLA is currently offered. The platform inherits AWS service SLAs for underlying infrastructure.

---

## Cross-Platform Identity

**Q: How is cross-platform identity linking handled?**
A: Users can link identities across platforms (wallet, email, Telegram, Discord, X). Consent is required for cross-platform data sharing. Revocation immediately blocks future cross-platform data reuse and purges cross-platform memories where feasible. Retention exceptions (audit logs, channel state buffers, CloudWatch logs) are documented with lawful basis.
Source: [CONSENT-REVOCATION-SEMANTICS.md](./CONSENT-REVOCATION-SEMANTICS.md)

---

## Document References

| Topic | Canonical Source |
|-------|-----------------|
| Trust overview | [TRUST-OVERVIEW.md](./TRUST-OVERVIEW.md) |
| Security policy | [SECURITY.md](./SECURITY.md) |
| Data retention | [DATA-RETENTION-MATRIX.md](./DATA-RETENTION-MATRIX.md) |
| DSAR workflow | [DSAR-WORKFLOW.md](./DSAR-WORKFLOW.md) |
| Subprocessor register | [SUBPROCESSOR-REGISTER.md](./SUBPROCESSOR-REGISTER.md) |
| International transfers | [TRANSFER-IMPACT-ASSESSMENT.md](./TRANSFER-IMPACT-ASSESSMENT.md) |
| GDPR audit | [GDPR-COMPLIANCE-AUDIT-v2.md](./GDPR-COMPLIANCE-AUDIT-v2.md) |
| Accountability checklist | [ACCOUNTABILITY-CHECKLIST.md](./ACCOUNTABILITY-CHECKLIST.md) |
| Consent revocation | [CONSENT-REVOCATION-SEMANTICS.md](./CONSENT-REVOCATION-SEMANTICS.md) |
