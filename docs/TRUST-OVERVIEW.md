# RATi OS Trust Overview

> Last updated: 2026-03-08
> Owner: Cenetex Inc.
> Contact: privacy@cenetex.com

This document provides a concise overview of the security, privacy, and compliance posture of the RATi Avatar System (RATi OS) for prospective buyers and partners.

---

## Platform Overview

RATi OS is a multi-tenant AI avatar platform built on AWS serverless infrastructure. Users authenticate via Solana wallet or Privy (email/social), interact with AI avatars through chat interfaces (Telegram, Discord, web), and manage avatars through a conversational admin experience. All user actions occur within the chat interface -- there are no separate settings pages or dashboards.

## Data Hosting and Infrastructure

The platform runs entirely on AWS (us-east-1, us-west-2) using managed serverless services: DynamoDB for data storage, Lambda for compute, S3 for media, SQS for message queuing, and CloudFront for CDN. Cenetex Inc. is incorporated in Canada, which benefits from an EU adequacy finding under PIPEDA. See [TRANSFER-IMPACT-ASSESSMENT.md](./TRANSFER-IMPACT-ASSESSMENT.md) for full international transfer details.

## Authentication and Access Control

User authentication is handled via Solana wallet signatures or Privy (email/social login). NFT ownership gates access to premium features. Administrative access uses Cloudflare Access with token-based webhook validation. Lambda execution roles follow the principle of least privilege. See [SECURITY.md](./SECURITY.md) for the full security policy.

## Data Retention and Deletion

Every data class has a declared retention period enforced by DynamoDB TTLs, S3 lifecycle rules, or CloudWatch log retention settings. Key retention periods: chat messages (24 hours), ephemeral AI memory (1 day), durable memory (90 days), audit logs (365 days, configurable). 45 of 47 retention controls are compliant; 2 items (Secrets Manager rotation) have documented remediation plans. See [DATA-RETENTION-MATRIX.md](./DATA-RETENTION-MATRIX.md) for the complete matrix.

## Privacy Rights (DSAR)

The platform provides automated Data Subject Access Request (DSAR) endpoints for data inventory, export, and erasure. Users can discover what data is held, export it in structured JSON, and request deletion. Audit events are retained under a documented lawful-basis exception (GDPR Art. 5(2) accountability). Known limitations: S3 media assets and CloudWatch logs are not yet covered by automated erasure (they expire via lifecycle/retention policies). See [DSAR-WORKFLOW.md](./DSAR-WORKFLOW.md) for the workflow and API reference.

## Subprocessors

The platform uses 10 third-party services. DPAs are executed or covered by standard terms for AWS and Stripe. DPAs with OpenRouter, Replicate, and Privy are pending execution (targeted by 2026-04-30). Platform APIs (Telegram, Discord, X) act as independent controllers, not processors. Blockchain services (Helius, Solana RPC) handle only public pseudonymous data. See [SUBPROCESSOR-REGISTER.md](./SUBPROCESSOR-REGISTER.md) for the full register and DPA status.

## Security Controls

- **Encryption in transit**: TLS 1.2+ for all API calls and processor communications.
- **Encryption at rest**: AWS KMS (AES-256) for DynamoDB and S3.
- **Dependency security**: Automated `pnpm audit` in CI blocks merges on high/critical CVEs. Known exceptions are tracked in a machine-readable registry with mandatory expiry dates and weekly automated review.
- **PII redaction**: A central redaction utility strips emails, wallet addresses, tokens, API keys, and IP addresses from all structured logs.
- **Audit logging**: All administrative actions are logged with 365-day retention.
- **Privileged access**: Quarterly recertification of all privileged identities (GitHub admins, deployment roles, admin wallets). See [ACCESS-REVIEW.md](./ACCESS-REVIEW.md).

See [SECURITY.md](./SECURITY.md) for the full security policy and exception governance.

## Compliance Status

The platform has undergone two internal engineering compliance audits against GDPR requirements (see [GDPR-COMPLIANCE-AUDIT-v2.md](./GDPR-COMPLIANCE-AUDIT-v2.md)). Current status:

- **Completed**: Privacy notices aligned with actual retention, server-side consent evidence, DSAR workflow (export/erasure), PII log redaction, extended audit trail, subprocessor register, transfer impact assessment, accountability checklist.
- **In progress**: DPA execution with OpenRouter, Replicate, and Privy (target: 2026-04-30). Full DPIA (target: 2026-05-31). Terms of Use finalization (currently DRAFT). Secrets Manager rotation automation. WAF placement operational verification.
- **Not yet started**: Formal RoPA filing. DPO appointment evaluation. EU-region deployment option assessment.

**No formal third-party certifications (SOC 2, ISO 27001, penetration test reports) are currently held.** These audits are internal engineering assessments, not legal advice or formal attestations.

---

## Document References

| Topic | Canonical Source |
|-------|-----------------|
| Security policy and dependency management | [SECURITY.md](./SECURITY.md) |
| Data retention periods | [DATA-RETENTION-MATRIX.md](./DATA-RETENTION-MATRIX.md) |
| DSAR workflow and API | [DSAR-WORKFLOW.md](./DSAR-WORKFLOW.md) |
| Subprocessor inventory | [SUBPROCESSOR-REGISTER.md](./SUBPROCESSOR-REGISTER.md) |
| International transfers | [TRANSFER-IMPACT-ASSESSMENT.md](./TRANSFER-IMPACT-ASSESSMENT.md) |
| GDPR compliance audit | [GDPR-COMPLIANCE-AUDIT-v2.md](./GDPR-COMPLIANCE-AUDIT-v2.md) |
| Accountability and DPIA status | [ACCOUNTABILITY-CHECKLIST.md](./ACCOUNTABILITY-CHECKLIST.md) |
| Consent revocation semantics | [CONSENT-REVOCATION-SEMANTICS.md](./CONSENT-REVOCATION-SEMANTICS.md) |
| Privileged access review | [ACCESS-REVIEW.md](./ACCESS-REVIEW.md) |
