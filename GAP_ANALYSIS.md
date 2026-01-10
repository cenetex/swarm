# AWS Swarm Gap Analysis (Vision vs Current State)

## Scope and Sources
- North Star: `GRAND_VISION.md`
- Current State + Plan: `PLAN.md`
- Product snapshot: `README.md`

This document maps the vision to the current implementation status and highlights gaps, risks, and recommended next steps.

---

## Current State (from `PLAN.md`)

**Done**
- Monorepo + TypeScript baseline, core types, platform adapters (Telegram/Twitter/Web), processors, services, handlers, CDK infra, admin API/UI, secrets management, CI/CD.
- SQS pipeline (ingest → processor → sender).

**Partial**
- Agent templates stored in DB, no import/export workflow.
- Logs API exists; UI + standardized schema pending.
- Solana wallets implemented; Ethereum disabled.
- Tests exist in admin-api/core; no end-to-end tests.

**Not Started / Missing**
- Discord adapter.
- Media pipeline callback contract.
- Deploy trigger from admin.
- Real agent configs.
- End-to-end Telegram test.

---

## Vision Requirements (from `GRAND_VISION.md`)

- Unified multi-platform identity (Telegram/X/Discord/Web) with shared memory and policy.
- Durable, opt-in memory with minimal collection by default; privacy and retention controls.
- Agentic control plane with conversational configuration and governance for high-risk actions.
- Scalable serverless runtime with observability, safety, and tool governance.
- Marketplace and portability with licensing/provenance.
- Open by default with CC0 for docs/schemas/reference data where feasible.

---

## Gap Analysis

### Platform Coverage and Runtime
**Current:** Telegram/Twitter/Web adapters complete; Discord missing.  
**Gap:** Vision requires coherent multi-platform presence.  
**Impact:** Narrative and product positioning outpace capabilities; affects early credibility.  
**Next:** Decide Discord integration model (gateway vs interactions), implement adapter, add unified channel policy tests.

### Memory, Privacy, and Data Retention
**Current:** DynamoDB state and archival intent are present; retention defaults and opt-in controls not specified in plan.  
**Gap:** Vision requires minimal data by default, opt-in durable memory for paying customers, deletion/export workflows, and revocable archival access.  
**Impact:** Regulatory and trust risk; operational cost creep without clear retention boundaries.  
**Next:** Define retention tiers, implement stateless free-tier defaults, deletion/export flows, and archival key revocation strategy.

### Agentic Control Plane (Admin UX + Automation)
**Current:** Conversational admin UI/API exists; deploy trigger and import/export workflows are missing.  
**Gap:** Vision promises full conversational configuration and portability of agents/templates.  
**Impact:** Limits self-serve onboarding and marketplace readiness.  
**Next:** Add deploy hooks, template export/import, and agent config versioning.

### Governance and High-Risk Actions
**Current:** Credits, rate limits, and write-only secrets are present; explicit approval flows are not listed.  
**Gap:** Vision requires policy + approvals for high-risk actions (transactions, spend, external side effects).  
**Impact:** Safety posture is incomplete; enterprise buyers may block adoption.  
**Next:** Define approval policy model, integrate tool-level approvals, and add auditable decision logs.

### Observability and Logs
**Current:** Logs API exists; standardized schema + UI pending.  
**Gap:** Vision expects correlated traces and explainability.  
**Impact:** Debugging and compliance workflows are manual.  
**Next:** Standardize log schema across handlers, build logs UI, add correlation IDs across pipeline.

### Media Pipeline and Async Jobs
**Current:** Media callbacks are stubbed; response-sender queues jobs without callback routing.  
**Gap:** Vision requires reliable multi-step workflows and media services.  
**Impact:** Broken or unreliable media workflows.  
**Next:** Define callback contract, implement idempotent response queue, and add retries/timeout handling.

### Marketplace and Portability
**Current:** Templates stored in DB; no export/import tooling or licensing/provenance controls.  
**Gap:** Vision requires marketplace-ready templates, consented portability, and licensing.  
**Impact:** Cannot safely enable trading or migration.  
**Next:** Implement template packaging, ownership metadata, licensing terms, and export/import.

### Open Source and CC0
**Current:** MIT license; no explicit CC0 stance for docs/schemas/reference data.  
**Gap:** Vision states open by default with CC0 where feasible.  
**Impact:** Inconsistent public positioning; unclear for contributors.  
**Next:** Identify CC0-eligible assets (docs, schemas, reference data) and add explicit licensing in repo.

---

## Risks and Dependencies

- **Platform scope mismatch:** Vision implies full multi-platform support while current focus is Telegram-first.
- **Privacy + retention:** Without defaults that minimize storage, compliance and cost risks increase.
- **Governance:** Missing approval workflows for high-risk tools can block enterprise adoption.
- **Marketplace readiness:** Lack of export/import and licensing prevents safe portability.
- **Reliability:** Missing end-to-end tests and media callback contracts risk regressions.

---

## Suggested Priorities (Phase-Aligned)

1) **Stability + Trust Foundations**
   - Retention tiers + stateless defaults.
   - Approval policy model for high-risk actions.
   - Standardized logging + correlation IDs.

2) **Platform Completeness**
   - Discord adapter + channel parity tests.
   - Media callback contract with idempotency and retries.

3) **Control Plane Productization**
   - Deploy hooks.
   - Import/export templates + versioning.
   - First real agent configs + E2E Telegram test.

4) **Marketplace Readiness**
   - Licensing/provenance metadata.
   - Migration/export flows with consent checks.

5) **Open Source Alignment**
   - Add CC0 coverage for docs/schemas/reference data where feasible.

---

## Open Questions

- What is the minimal retention policy for the free tier (hours, days, or request-scoped only)?
- Which assets should be CC0 vs MIT vs other permissive licenses?
- Do we treat Discord as a core requirement for MVP or as a Phase 2 capability?
- What explicit approval UX should exist for transactions and spend?
