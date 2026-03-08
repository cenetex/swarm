# Project Charter

**Status:** Active
**Date:** 2026-02-01
**Owner:** Leadership

**Related documents:**
- [ICP.md](ICP.md) -- ideal customer profiles, buying signals, design partner criteria
- [GTM-STRATEGY-M2.md](GTM-STRATEGY-M2.md) -- go-to-market strategy, funnel KPIs
- [BILLING-STRATEGY.md](BILLING-STRATEGY.md) -- tier definitions, entitlement limits, pricing
- [LAUNCH-PLAYBOOKS.md](LAUNCH-PLAYBOOKS.md) -- per-ICP launch playbooks

---

## 1. Project Scope

AWS Swarm is a multi-tenant, chat-first platform for deploying persistent AI avatars across messaging platforms (Telegram, Discord, X). The platform provides avatar creation, persona management, multi-platform deployment, memory, media generation, and operational controls -- all managed through a conversational admin interface.

### 1a. Milestone Definitions

| Milestone | Scope | Status |
|-----------|-------|--------|
| **M1 -- Foundation** | Auth, onboarding, entitlements, Orb-holder auto-boost, energy unification, ascension-to-Pro, memory TTL/delete/export, audit logging, correlation IDs, CloudWatch dashboards, DLQ alarms, staging canary, operational runbook. | Shipped (2026-02) |
| **M2 -- Revenue Activation** | Stripe Checkout integration, self-serve plan upgrades, ICP validation with design partners, public billing launch, GTM execution. | In progress |
| **M3 -- Governance** | RBAC, SSO, organizational management, multi-user account controls, enterprise compliance features. | Planned |

### 1b. Public Billing Launch Gate (Revenue Activation)

Public billing (Stripe self-serve) must NOT launch until the following conditions are met:

1. **ICP validated:** At least 5 design-partner conversations produce convergent results on problem-solution fit, pricing acceptance, and day-7 retention. See [ICP.md](ICP.md) Section 6 for validation thresholds.
2. **Stripe integration tested:** Checkout flow, webhook handling, and entitlement sync verified in staging with real Stripe test transactions.
3. **Operational readiness:** CloudWatch dashboards, DLQ alarms, and incident runbook are active and tested. See [RUNBOOK.md](RUNBOOK.md).
4. **Stop/go decision:** Leadership reviews validation data and makes explicit go/no-go call. No silent launches.

If ICP validation thresholds are not met, the ICP must be revised and another round of 5 conversations conducted before re-evaluating.

---

## 2. Success Criteria

| Criterion | Target | Measurement |
|-----------|--------|-------------|
| Platform stability | < 0.1% error rate on message processing | CloudWatch error metrics |
| Activation speed | < 10 minutes from sign-up to first live response | Funnel event timestamps (F2 to F3) |
| Design partner retention | 80% active at day 7 | F4 funnel events |
| First paid customer | At least 1 Stripe subscription | Stripe dashboard |
| ICP validation | 5+ convergent design-partner conversations | ICP.md tracking table |

---

## 3. Stakeholders

| Role | Responsibility |
|------|---------------|
| Leadership | Strategy, go/no-go decisions, resource allocation |
| Engineering | Platform development, infrastructure, reliability |
| Community | Design partner recruitment, channel engagement |
| Operations | Monitoring, incident response, cost controls |

---

## 4. Constraints

- **Chat-first design:** All user-facing features must work through the admin chat. No settings pages, no modals, no separate workflows. See [design-philosophy.md](design-philosophy.md).
- **Multi-tenant isolation:** Each avatar's data (secrets, memory, state) must be completely isolated. See design-philosophy.md Section 4.
- **Write-only secrets:** Bot tokens and API keys stored via AWS Secrets Manager are write-only. The platform can never read back secret values through the UI or API.
- **No PII in logs:** Structured logging captures metadata only. Message content is never logged.

---

## 5. Risks

| ID | Risk | Probability | Impact | Mitigation |
|----|------|-------------|--------|------------|
| R1 | Cold-start latency degrades first-message experience | Medium | Medium | Monitor TTFR metric; provisioned concurrency if median exceeds 10s |
| R2 | Telegram webhook reliability (external dependency) | Low | High | Retry logic, DLQ monitoring, webhook re-registration on failure |
| R3 | Multi-platform persona drift | Low | Medium | Unified SwarmEnvelope processing pipeline; same LLM call regardless of platform |
| R4 | Stripe integration complexity delays M2 | Medium | High | Manual entitlement assignment as fallback; design partners do not require self-serve billing |
| R5 | Web3 layer creates friction for non-crypto users | Medium | Medium | Email sign-up is default; wallet connection is optional; Web3 augmentation is additive, not required |
| R6 | Media generation abuse (cost exposure) | Medium | High | Entitlement-enforced daily limits; energy burst pool with caps; rate limiting |
| R7 | Competitor launches similar product | Low | Medium | Chat-first differentiation is architectural, not a feature toggle; hard to replicate quickly |
| R8 | No clear ICP defined for paying users | High | High | ICP.md drafted; design partner validation required before public billing launch (Section 1b) |

---

## 6. Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-02-01 | Defer Stripe to M2; use manual entitlements for M1 | Reduce M1 scope to ship foundation faster |
| 2026-02-07 | Unify energy as burst pool, not parallel gate | Eliminate double-gating confusion between entitlements and energy |
| 2026-02-07 | Orb-holder auto-boost on free tier | Reward Web3-engaged users without requiring paid subscription |
| 2026-03-01 | Require 5 design-partner conversations before public billing | Prevent premature launch without validated ICP |

---

*This charter governs project scope and launch gates. All milestone exits require explicit leadership sign-off.*
