# Accountability Checklist

> Last updated: 2026-03-08
> Owner: Cenetex Inc. (Data Controller)
> Contact: privacy@cenetex.com
> Review cadence: Quarterly (next review due: 2026-06-08)

This document establishes the accountability framework for GDPR compliance across the RATi Avatar System, covering Records of Processing Activities (RoPA), Data Protection Impact Assessment (DPIA), ownership responsibilities, and review cadence.

---

## 1. Records of Processing Activities (RoPA)

Per GDPR Article 30, the following is a summary of processing activities. A detailed RoPA should be maintained as a separate controlled document by the privacy team.

### 1.1 RoPA Template

| Field | Value |
|-------|-------|
| **Controller** | Cenetex Inc. |
| **Contact** | privacy@cenetex.com |
| **DPO** | Not yet appointed (see Section 3.3) |
| **Purpose of processing** | Provision of AI avatar platform services including authentication, conversation processing, content generation, NFT-gated access, and platform integrations |
| **Categories of data subjects** | Platform users (authenticated via wallet or Privy), avatar operators, administrative users |
| **Categories of personal data** | Identity data (wallet addresses, email), conversation data (chat messages, AI memories), session metadata (IP, User-Agent), blockchain data (NFT ownership), generated content (media), audit logs |
| **Recipients** | See SUBPROCESSOR-REGISTER.md for full processor list |
| **International transfers** | EU/EEA/UK to US (see TRANSFER-IMPACT-ASSESSMENT.md) |
| **Retention periods** | See DATA-RETENTION-MATRIX.md and Privacy Policy Section 5 |
| **Technical and organizational measures** | Encryption (TLS, KMS), access controls (wallet auth, Privy), PII redaction, DynamoDB partition isolation, audit logging, dependency security scanning |

### 1.2 Processing Activities Register

| # | Processing Activity | Lawful Basis | Data Categories | Retention | Automated Decision-Making |
|---|---------------------|-------------|-----------------|-----------|--------------------------|
| 1 | User authentication (wallet/Privy) | Art. 6(1)(b) contract performance | Wallet address, email, session metadata | Sessions: 24h; Identity: until deletion | No |
| 2 | AI conversation processing | Art. 6(1)(b) contract performance | Chat messages, conversation context | Chat: 24h; Memory: 1d/90d/unlimited by tier | Yes -- AI generates responses and memories |
| 3 | NFT ownership verification | Art. 6(1)(b) contract performance | Wallet public key, NFT ownership status | Stateless (queried on demand) | Yes -- automated feature gating based on NFT ownership |
| 4 | Media generation | Art. 6(1)(b) contract performance | AI prompts, input media | Temp media: 1d; General: 30d then tiered | No |
| 5 | Content publishing (Telegram/Discord/X) | Art. 6(1)(a) consent | Message content, media | Posted: 90d; Rejected: 7d; Pending: 30d | No |
| 6 | Audit logging | Art. 6(1)(f) legitimate interest | Admin actions, user identifiers, timestamps | 365 days | No |
| 7 | Payment processing | Art. 6(1)(b) contract performance | Payment data, email, billing address | Per Stripe retention policy | No |
| 8 | Platform analytics and debugging | Art. 6(1)(f) legitimate interest | Application logs (PII-redacted), error traces | 14-30 days (CloudWatch) | No |

### 1.3 RoPA Status

| Item | Status |
|------|--------|
| Processing activities identified | Done (see above) |
| Lawful basis documented per activity | Done (see above) |
| Retention periods aligned with implementation | Done (see DATA-RETENTION-MATRIX.md) |
| Formal RoPA document created and maintained | Pending -- template above should be formalized by privacy team |
| RoPA filed with supervisory authority (if required) | Not yet required (organization size threshold to be confirmed) |

---

## 2. Data Protection Impact Assessment (DPIA)

### 2.1 DPIA Trigger Assessment

Per GDPR Article 35 and EDPB Guidelines on DPIAs, a DPIA is required when processing is "likely to result in a high risk to the rights and freedoms of natural persons." The following assessment evaluates whether the RATi OS platform triggers a DPIA requirement.

| Trigger Criterion (Art. 35 / EDPB) | Applicable? | Reasoning |
|-------------------------------------|-------------|-----------|
| Systematic and extensive evaluation of personal aspects (profiling) | **Yes** | AI generates memories, extracts facts, and builds persistent context about users across conversations |
| Large-scale processing of special categories | No | Platform does not intentionally collect Art. 9 special category data, though user-submitted conversation content could incidentally contain such data |
| Systematic monitoring of publicly accessible areas | No | Platform monitors user-initiated interactions, not public spaces |
| Innovative use of new technologies | **Yes** | LLM-based AI processing of personal data, generative AI content creation |
| Automated decision-making with legal/significant effects | **Partial** | NFT-gated access decisions are automated but effects are limited to feature access, not legal consequences |
| Large-scale processing | **Partial** | Multi-tenant platform processing conversations for potentially many users across multiple messaging platforms |
| Matching or combining datasets | **Yes** | Cross-platform identity linking (wallet + email + Telegram + Discord + Twitter) |
| Data concerning vulnerable subjects | No | Platform requires age 18+; no intentional processing of children's or vulnerable persons' data |
| Preventing data subjects from exercising rights | No | DSAR workflow implemented (export, erasure, inventory) |

**DPIA trigger conclusion: Yes -- a DPIA is required.**

At least three trigger criteria are met (profiling/evaluation, innovative technology, dataset combination). A full DPIA should be conducted.

### 2.2 DPIA Status

| Item | Status |
|------|--------|
| DPIA trigger assessment | Done (this document) |
| Full DPIA conducted | **Not yet started** |
| DPIA document created | Pending |
| Supervisory authority consultation (if required by DPIA outcome) | N/A until DPIA is completed |
| Mitigating measures identified and implemented | Partially -- technical measures in place (encryption, minimization, redaction, retention controls), but DPIA may identify additional requirements |

### 2.3 DPIA Action Items

| # | Action | Owner | Target Date | Status |
|---|--------|-------|-------------|--------|
| 1 | Engage privacy counsel to conduct full DPIA | Legal team | 2026-05-31 | Not started |
| 2 | Document residual risks and mitigating measures | Privacy team + Engineering | 2026-06-30 | Not started |
| 3 | Determine if supervisory authority consultation is needed | Legal counsel | After DPIA completion | Not started |
| 4 | Implement any additional measures identified by DPIA | Engineering | TBD (after DPIA) | Not started |

---

## 3. Ownership Matrix

### 3.1 Privacy Responsibilities

| Responsibility | Owner | Backup | Cadence |
|---------------|-------|--------|---------|
| Overall GDPR compliance | CEO / Cenetex leadership | Legal counsel | Ongoing |
| Privacy policy maintenance | Engineering + Legal | Privacy team | On change / quarterly review |
| DPA execution with processors | Legal team | CEO | On processor onboarding |
| DSAR response (access, erasure, portability) | Engineering (technical) + Legal (coordination) | Privacy team | Within 30 days of request |
| Consent mechanism maintenance | Engineering | -- | On change |
| Data breach notification (Art. 33/34) | CEO + Legal | Engineering (technical investigation) | Within 72 hours of awareness |
| DPIA execution and refresh | Legal counsel + Privacy team | Engineering (technical input) | On trigger / annual refresh |
| RoPA maintenance | Privacy team | Engineering | Quarterly |
| Subprocessor register updates | Engineering + Legal | -- | On change / quarterly review |
| Transfer impact assessment refresh | Legal counsel | Privacy team | Annual |
| Security measures and incident response | Engineering | -- | Ongoing |
| Audit log review | Engineering | -- | Monthly |
| Privileged access review | Engineering + Leadership | -- | Quarterly (see ACCESS-REVIEW.md) |
| Training and awareness | Leadership | -- | Annual |

### 3.2 Incident Response Contacts

| Role | Contact | Escalation |
|------|---------|-----------|
| Privacy contact (external) | privacy@cenetex.com | -- |
| Data breach lead | CEO / Cenetex leadership | Legal counsel |
| Technical incident response | Engineering lead | On-call rotation |
| Supervisory authority liaison | Legal counsel | CEO |

### 3.3 Data Protection Officer (DPO)

**Current status:** A DPO has not yet been formally appointed.

**Assessment:** Under GDPR Article 37, a DPO must be appointed if the controller's core activities consist of processing operations that require regular and systematic monitoring of data subjects on a large scale, or large-scale processing of special categories of data. Whether RATi OS triggers this requirement depends on the scale of processing, which should be assessed as the platform grows.

**Action:** Evaluate DPO appointment requirement as part of the DPIA process (see Section 2.3, Action 1).

---

## 4. Review Cadence

### 4.1 Scheduled Reviews

| Review | Frequency | Next Due | Owner | Deliverable |
|--------|-----------|----------|-------|-------------|
| Privacy policy accuracy check | Quarterly | 2026-06-08 | Engineering + Legal | Updated PrivacyPolicy.tsx if needed |
| Subprocessor register update | Quarterly | 2026-06-08 | Engineering + Legal | Updated SUBPROCESSOR-REGISTER.md |
| Retention matrix verification | Quarterly | 2026-06-08 | Engineering | Verify TTLs in code match DATA-RETENTION-MATRIX.md |
| Consent mechanism audit | Quarterly | 2026-06-08 | Engineering | Verify consent flow, version tracking |
| DSAR workflow test | Quarterly | 2026-06-08 | Engineering | Run test export/erasure against staging |
| Transfer impact assessment refresh | Annual | 2027-03-08 | Legal counsel | Updated TRANSFER-IMPACT-ASSESSMENT.md |
| DPIA refresh | Annual | TBD (after initial DPIA) | Legal counsel + Engineering | Updated DPIA document |
| Security audit (dependencies) | Continuous (CI) + Weekly | Ongoing | Engineering | pnpm audit, security exception review |
| Privileged access recertification | Quarterly | Per ACCESS-REVIEW.md schedule | Engineering + Leadership | Access review evidence artifacts |
| Training and awareness | Annual | 2027-03-08 | Leadership | Training records |

### 4.2 Event-Triggered Reviews

| Trigger | Review Required | Owner |
|---------|----------------|-------|
| New processor onboarded | Update subprocessor register, execute DPA, update privacy policy | Legal + Engineering |
| Data breach or security incident | Incident response, breach notification assessment, post-incident review | Engineering + Legal |
| New data category collected | Update RoPA, assess DPIA impact, update privacy policy | Engineering + Legal |
| Regulatory guidance change | Assess impact, update documentation as needed | Legal counsel |
| Platform expansion to new jurisdiction | Update TIA, assess local requirements | Legal counsel |
| Significant architecture change | Review data flows, update RoPA, reassess DPIA | Engineering |
| User complaint or supervisory authority inquiry | Investigate, respond within required timeframe | Legal + Engineering |

---

## 5. Document Cross-References

| Document | Location | Purpose |
|----------|----------|---------|
| Privacy Policy | `packages/admin-ui/src/components/PrivacyPolicy.tsx` | User-facing privacy notice |
| Data Retention Matrix | `docs/DATA-RETENTION-MATRIX.md` | Canonical retention periods |
| GDPR Compliance Audit v2 | `docs/GDPR-COMPLIANCE-AUDIT-v2.md` | Gap analysis and remediation tracking |
| Subprocessor Register | `docs/SUBPROCESSOR-REGISTER.md` | Third-party processor inventory |
| Transfer Impact Assessment | `docs/TRANSFER-IMPACT-ASSESSMENT.md` | International transfer safeguards |
| DSAR Workflow | `docs/DSAR-WORKFLOW.md` | Data subject rights implementation |
| Security Policy | `docs/SECURITY.md` | Security practices and dependency management |
| Access Review | `docs/ACCESS-REVIEW.md` | Privileged access recertification |
| Terms of Use | `docs/TERMS-OF-USE.md` | User terms (DRAFT) |
| Consent Banner | `packages/admin-ui/src/components/ConsentBanner.tsx` | Consent collection UI |

---

## Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-03-08 | Initial accountability checklist created | Engineering |
