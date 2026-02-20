# Roadmap: M1 Paid Telegram MVP (2-week slices)

**Status:** Completed milestone (archived reference)

**Last reviewed:** 2026-02-20

Current execution plan:
- [PLAN.md](../PLAN.md)

This document is retained as the historical execution plan for M1.
M1 is complete; this file is no longer the active source of truth for current milestone execution.

## What “M1 done” means (acceptance criteria)

An operator can:
1) Create/select an avatar in Admin UI.
2) Connect Telegram and verify it is receiving updates.
3) Purchase a plan (or apply entitlements) and see the effective limits.
4) Deploy/activate the avatar explicitly (with audit trail).
5) Chat with the avatar on Telegram.
6) Free tier stays stateless beyond request handling.
7) Paid tier enables durable memory within configured retention and supports delete/export.
8) Runtime enforces plan limits (tools, media, voice, memory writes).
9) Logs endpoint can diagnose the common failures quickly.

Security gates for M1:
10) Auth verification paths fail closed (no client-trust fallback for identity assertions).
11) Internal test bypass keys are disabled in production.
12) Public webhooks validate a shared secret/signature before mutating job state.

Primary references:
- Plan definition: [PLAN.md](../PLAN.md)
- Near-term milestone summary: [ROADMAP.md](../ROADMAP.md)
- Verified shipped + remaining gaps: [engineering-report-platform-status-2026-01-18.md](engineering-report-platform-status-2026-01-18.md)
- Auth/onboarding spec: [AUTHENTICATION-IMPROVEMENTS.md](AUTHENTICATION-IMPROVEMENTS.md)

## P0 (Week 1–2): unblock users + make failures diagnosable

### P0.1 Telegram verification/diagnosis
- Ship `diagnose_telegram` tool and a “setup verified” UX after token setup.
- Output should include: token present, webhook URL/status, last update seen/age, recent errors, and next action.

Reference:
- [docs/engineering-report-platform-status-2026-01-18.md](engineering-report-platform-status-2026-01-18.md)

### P0.2 Access-mode transition hardening
- Add regression tests for browse/limited/chat/admin transitions and avatar switching.
- Fix any reproducible race conditions uncovered by tests.

Reference:
- [docs/engineering-report-platform-status-2026-01-18.md](engineering-report-platform-status-2026-01-18.md)

### P0.3 Tool interactivity contract (smallest safe step)
- Start moving “pause-for-input” behavior from hardcoded name lists to tool metadata.
- Keep the legacy fallback until parity is proven.

Reference:
- [docs/engineering-report-platform-status-2026-01-18.md](engineering-report-platform-status-2026-01-18.md)

## P1 (Week 3–6): paid plans + enforcement (the MVP core)

### P1.1 Billing decision + entitlement schema
- **Decision (2026-02-07):** Manual entitlements + Orb-holder auto-boost for M1. Stripe deferred to M2. Energy system unified as burst pool within entitlement framework. See [BILLING-STRATEGY.md](BILLING-STRATEGY.md).
- ~~Decide billing provider + plan model (Stripe vs manual entitlements).~~ **Done.**
- ~~Define a shared entitlement schema used by Admin API and runtime.~~ **Done.** `EntitlementRecord` + `PlanLimits` + `RuntimeContract`.
- ~~Store entitlements in DynamoDB and expose via Admin API.~~ **Done.** `entitlements.ts` + `avatar-routes/entitlements.ts`.
- **Remaining:** Unify energy as burst pool within entitlement limits; auto-boost for Orb holders.

Reference:
- [PLAN.md](../PLAN.md)
- [BILLING-STRATEGY.md](BILLING-STRATEGY.md)

### P1.2 Runtime enforcement
- ~~Enforce entitlements in runtime handlers (message processor, media tools, voice tools).~~ **Done.** Atomic DynamoDB conditionals in `entitlement-enforcement.ts`.
- ~~Default free tier to **no durable memory writes**.~~ **Done.** `isMemoryWriteAllowed()` checks `memoryEnabled`.
- **Remaining:** Unify energy + entitlement enforcement to eliminate double-gating on media/voice operations.

Reference:
- [PLAN.md](../PLAN.md)

### P1.3 Memory opt-in + retention controls
- Add memory configuration fields (enabled, retentionDays) to avatar config.
- Implement delete/export endpoints for paid memory.
- Enforce retention policy via TTL and/or scheduled cleanup.

Reference:
- [PLAN.md](../PLAN.md)

### P1.4 Deploy/activate flow + audit logging
- Add Admin API endpoint to deploy/activate.
- Add Admin UI control to trigger deploy and show status.
- Record deploy events in audit log.

Reference:
- [PLAN.md](../PLAN.md)

## P1.5 (Week 5–6, parallelizable): observability baseline

### P1.5.1 Correlation IDs + structured logging consistency
- Standardize requestId/avatarId propagation across webhook → SQS → handlers.
- Ensure logs endpoint remains the primary debugging surface.

Reference:
- [AGENTS.md](../AGENTS.md)

### P1.5.2 Canary + runbooks
- Add a staging Telegram canary avatar and test script.
- Document runbook for Telegram webhook failures and DLQ recovery.

Reference:
- [PLAN.md](../PLAN.md)

## P2 (post-M1 hardening): performance + maintainability

### P2.1 SSE job updates
- Add an SSE endpoint + Admin UI integration, keep polling fallback.

Reference:
- [docs/engineering-report-platform-status-2026-01-18.md](engineering-report-platform-status-2026-01-18.md)

### P2.2 Reduce chat orchestration change risk
- Refactor `processChat` into testable modules (context, llm, tools, response).
- Add focused unit tests around orchestration boundaries.

Reference:
- [docs/engineering-report-platform-status-2026-01-18.md](engineering-report-platform-status-2026-01-18.md)

### P2.3 Split MCP adapter by domain
- Split adapters (media/wallet/social/gallery/secrets/jobs) to reduce coupling.

Reference:
- [docs/engineering-report-platform-status-2026-01-18.md](engineering-report-platform-status-2026-01-18.md)

## P3 (defer until after M1 unless explicitly pulled forward)

### Dynamic Context & Prompt Reduction
- Implements channel summaries, pinned memories, toolset activation, prompt reduction.
- Depends on M1 P1.3 (memory retention) and MEMORY.md Phases 2-4.
- See [DYNAMIC-CONTEXT-RFC.md](DYNAMIC-CONTEXT-RFC.md) for full specification.

Reference:
- [docs/DYNAMIC-CONTEXT-RFC.md](DYNAMIC-CONTEXT-RFC.md)

### Step Functions "durable agent runtime"
- Defer until P0/P1 stability work lands.

Reference:
- [docs/legacy/2026-01/reports/engineering-report-agentic-resilience-stepfunctions-2026-01-19.md](legacy/2026-01/reports/engineering-report-agentic-resilience-stepfunctions-2026-01-19.md)

### Unified integrations + UI panels
- Defer big migrations; prefer incremental read-only status + connection test first.

Reference:
- [docs/legacy/2026-01/proposals/proposal-unified-integrations.md](legacy/2026-01/proposals/proposal-unified-integrations.md)

### Token launch integration (irreversible on-chain actions)
- Defer until entitlements + approvals + audit logs are solid.

Reference:
- [docs/legacy/2026-01/proposals/design-token-launch-mcp-integration.md](legacy/2026-01/proposals/design-token-launch-mcp-integration.md)

### Janus-inspired research features (lab harness, modes beyond defaults)
- Only ship what is measurable and reduces prod risk; treat the rest as post-M1.

References:
- [docs/legacy/2026-01/reports/engineering-report-janus-integration-2026-01-20.md](legacy/2026-01/reports/engineering-report-janus-integration-2026-01-20.md)
- [docs/legacy/2026-01/research/engineering-janus-integration.md](legacy/2026-01/research/engineering-janus-integration.md)
