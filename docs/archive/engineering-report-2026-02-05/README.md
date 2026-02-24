# Engineering Report — 2026-02-05

## Deep Codebase Analysis & Prioritized Recommendations

**Scope:** Full analysis of all 10 packages (~50K+ LOC), 90 test files, 5 CI/CD workflows, 34 scripts, and CDK infrastructure.

### Executive Summary

AWS Swarm is a **well-architected, production-grade multi-platform AI avatar framework** running on AWS serverless. The architecture is sound — queue-based async processing, multi-tenant shared handlers, and a unified MCP tool registry — but there are clear areas where technical debt, testing gaps, and structural issues need attention.

## Coordination Snapshot (2026-02-06)

- Coordination source of truth: [`COORDINATION.md`](./COORDINATION.md) (includes assignment authority, worker roster, and coordinator runbook)
- Current execution state: `main` is at `88828c3`; locally provisioned SWARM branches/worktrees include `feat/swarm-008` through `feat/swarm-020`.
- Governance mode is `mainline-first`; SWARM-001/002/003/004 are tracked as `completed-by-commit` in the coordination closure ledger.
- Live activity is being tracked in `COORDINATION.md` under **Engineering Change Watch** (including branch/worktree drift and likely ticket mapping).
- Onboarding overhaul has been decomposed into SWARM-011 through SWARM-020 for phased execution; all Wave 6 docs lanes (`worker-011` through `worker-020`) have now been dispatched and are in `review`.
- Latest successful dispatch run is `/tmp/swarm-workers/20260206T182912Z` (`worker-014` through `worker-020`, all exit `0`); an earlier non-escalated attempt `/tmp/swarm-workers/20260206T175732Z` failed on session-path permissions and was rerun successfully with escalation.
- Latest implementation dispatch run is `/tmp/swarm-workers/20260206T184805Z` (`worker-012`, `013`, `014`, `017`, `018`, all exit `0`) with code deltas staged in lane worktrees.
- Follow-on implementation dispatch run is `/tmp/swarm-workers/20260206T200331Z` (`worker-015`, `016`, `020`, all exit `0`) with additional code deltas staged in lane worktrees.
- Coordinator integration update (2026-02-06): SWARM-008/012/013/014/015/016/017/018/019/020 implementation deltas were merged into `main` worktree routing/modules and validated locally.
- Validation snapshot (2026-02-06): `pnpm --filter @swarm/admin-api build`, `pnpm --filter @swarm/infra build`, `pnpm --filter @swarm/admin-ui build`, `bun test packages/admin-api/src/handlers/avatar-routes`, `bun test packages/admin-api/src/services/accounts/auth-orchestrator.test.ts`, `bun test packages/admin-api/src/services/onboarding/errors.test.ts packages/admin-api/src/services/onboarding/resume-token.test.ts`, and `bun test packages/admin-api/src/services/onboarding/stability-matrix.test.ts packages/admin-api/src/handlers/avatar-routes/onboarding.test.ts` all passed.
- Testing stream has been marked complete by coordination; no execution-lane test churn was introduced while promoting implementation deltas.
- SWARM-012/SWARM-013 alignment gate has been reconciled in docs and recorded in [`SWARM-012-013-alignment-notes.md`](./SWARM-012-013-alignment-notes.md).

### Repository Metrics

| Metric | Value |
|--------|-------|
| Packages | 10 (core, handlers, admin-api, admin-ui, infra, mcp-server, layer, claude-code-worker, profile-page, plan-tests) |
| Source files | ~350+ |
| Test files | 90 |
| LOC (TypeScript) | ~50,000+ |
| CI/CD workflows | 5 |
| AWS resources | 30+ (Lambda, DynamoDB, SQS, S3, CloudFront, API GW, ECS, EventBridge) |

### Plan Status Board (2026-02-06)

| Ticket | Current Status | Evidence |
|--------|----------------|----------|
| SWARM-001 | Completed-by-commit | `f18a552` |
| SWARM-002 | Completed-by-commit | `3223c53` |
| SWARM-003 | Completed-by-commit | `3223c53` |
| SWARM-004 | Completed-by-commit | `edad325` |
| SWARM-005 | In progress on mainline (partial) | `bc92632` |
| SWARM-006 | In review on mainline | `288687f` |
| SWARM-007 | In progress on mainline | `22b7ed6`, `c127e91` |
| SWARM-008 | Integrated on mainline (validation pass) | `33762c8`, `5c1c25d` |
| SWARM-009 | Integrated on mainline (validation pass) | `fd4ec31`; legacy monolithic stack removed, dead code deleted, duplicate service types unified |
| SWARM-010 | Integrated on mainline (validation pass) | `88828c3`; EventBridge target DLQs added, per-avatar LLM timeout configurable, deploy workflow decomposed via `workflow_call` |
| SWARM-011 | Review (checkpoint complete) | Run `20260206T060843Z`; doc expanded and promoted to `main` |
| SWARM-012 | Integrated on mainline (validation pass) | `services/onboarding/contract-v1.ts` landed; admin-api/infra/admin-ui builds passing |
| SWARM-013 | Integrated on mainline (validation pass) | Onboarding orchestrator endpoints + route wiring + infra routes landed |
| SWARM-014 | Integrated on mainline (validation pass) | Canonical onboarding auth/account resolver wired into Crossmint/Privy handlers/services |
| SWARM-015 | Integrated on mainline (validation pass) | Admin UI onboarding wizard route + API client + telemetry plumbing landed |
| SWARM-016 | Integrated on mainline (validation pass) | Telegram onboarding step status/execution + diagnostics/repair response shaping landed |
| SWARM-017 | Integrated on mainline (validation pass) | Activation readiness report endpoint + activation gate enforcement landed |
| SWARM-018 | Integrated on mainline (validation pass) | Typed onboarding error/retry/resume primitives landed (`services/onboarding/error-types.ts`, `errors.ts`, `resume-token.ts`, `persistence.ts`) with auth-orchestrator hooks and focused tests |
| SWARM-019 | Integrated on mainline (validation pass) | `8f0540c`; onboarding stability matrix + onboarding route tests added and passing |
| SWARM-020 | Integrated on mainline (validation pass) | Onboarding rollout flag/cohort routing wired into avatar creation flow |

---

## Key Findings

### 1. Mega-File Problem

Several critical files have grown far beyond maintainability limits:

| File | Lines | Concern |
|------|-------|---------|
| `admin-api/handlers/chat.ts` | 2,516 | Monolithic chat handler |
| `admin-api/handlers/avatars.ts` | 1,789 | 40+ routes, zero tests |
| `admin-api/types.ts` | 1,676 | All types in one file |
| `handlers/telegram-webhook-shared.ts` | 1,554 | Auth + channel + activation + admin |
| `handlers/message-processor.ts` | 1,483 | Core brain, hard to test |
| `core/types/index.ts` | 1,368 | Every type definition |

### 2. Code Duplication

| Pattern | Locations | Impact |
|---------|-----------|--------|
| Secret-fetching logic | message-processor.ts, response-sender.ts, continuation-processor.ts, telegram-webhook-shared.ts | Same `fetchAvatarSecrets` reimplemented 3x with raw `secretsClient.send()`, while `load-avatar-secrets.ts` utility exists |
| Default avatar config | message-processor.ts, response-sender.ts | Identical inline 20-line fallback objects |
| Fetch-retry | core/services/llm (inline), core/utils/fetch-retry.ts | Two implementations with different semantics |
| System prompt building | response-generator.ts (legacy), prompt-builder.ts (unified) | Two divergent strategies |

### 3. Testing Gaps

| Untested Area | Risk | Package |
|---------------|------|---------|
| LLM service (Bedrock/OpenRouter/Anthropic/Retry) | 🔴 Critical | core |
| `avatars.ts` handler (1,789 LOC, 40+ routes) | 🔴 Critical | admin-api |
| Discord adapter (778 LOC) | 🟡 High | core |
| claude-code-worker (entire package) | 🟡 High | claude-code-worker |
| 23/27 MCP tool files | 🟡 High | mcp-server |
| Prompt builder | 🟡 Medium | core |
| LLM circuit breaker in message processor | 🔴 Critical | handlers |

### 4. Security Gaps

- **No WAF** on CloudFront or API Gateway (relies solely on Cloudflare Access)
- **Wildcard Bedrock IAM** — `bedrock:InvokeModel` on `Resource: *`
- **Per-avatar SQS unencrypted** — shared queues use SQS_MANAGED, per-avatar don't
- **Disabled dangerous code** in deploy workflow (S3 bucket deletion)

### 5. Operational Gaps

- **CloudWatch alarms fire silently** — no `alarmActions` configured on any alarm
- **No circuit breaker on message processor LLM calls** — 90s timeout exhausts concurrency
- **No DLQ on EventBridge rules** — failed invocations lost silently
- **LLM timeouts hardcoded** — not configurable per avatar

### 6. Developer Experience Gaps

- No `.prettierrc` config file (Prettier installed but unconfigured)
- No `.editorconfig`
- No `CODEOWNERS`
- `lint-staged` runs ESLint only, not Prettier
- No coverage thresholds enforced
- 1,247-line deploy workflow needs decomposition

---

## Tickets

See individual ticket files in this directory:

| Priority | Ticket | Branch | Description |
|----------|--------|--------|-------------|
| P0 | [SWARM-001](./SWARM-001-circuit-breaker-message-processor.md) | `feat/swarm-001` | Add circuit breaker to message processor LLM calls |
| P0 | [SWARM-002](./SWARM-002-consolidate-secret-loading.md) | `feat/swarm-002` | Consolidate duplicated secret-loading into shared utility |
| P0 | [SWARM-003](./SWARM-003-extract-default-avatar-config.md) | `feat/swarm-003` | Extract default avatar config to shared constant |
| P0 | [SWARM-004](./SWARM-004-developer-tooling.md) | `feat/swarm-004` | Add .prettierrc, .editorconfig, coverage thresholds |
| P1 | [SWARM-005](./SWARM-005-decompose-mega-files.md) | `feat/swarm-005` | Decompose mega-files into focused modules |
| P1 | [SWARM-006](./SWARM-006-wire-alarm-actions.md) | `feat/swarm-006` | Wire CloudWatch alarm actions to SNS |
| P1 | [SWARM-007](./SWARM-007-test-critical-paths.md) | `feat/swarm-007` | Add tests for LLM service, avatars handler, Discord adapter |
| P2 | [SWARM-008](./SWARM-008-security-hardening.md) | `feat/swarm-008` | WAF, scoped IAM, SQS encryption |
| P2 | [SWARM-009](./SWARM-009-deprecate-legacy.md) | `feat/swarm-009` | Deprecate legacy stack, processors, dead code |
| P2 | [SWARM-010](./SWARM-010-operational-improvements.md) | `feat/swarm-010` | EventBridge DLQs, configurable timeouts |

## Onboarding Overhaul Stories (Next 10)

| Priority | Ticket | Branch | Description |
|----------|--------|--------|-------------|
| P0 | [SWARM-011](./SWARM-011-onboarding-audit-and-funnel-baseline.md) | `feat/swarm-011` | Baseline onboarding funnel metrics and failure taxonomy |
| P0 | [SWARM-012](./SWARM-012-onboarding-state-machine-contract.md) | `feat/swarm-012` | Define deterministic onboarding state machine contract |
| P0 | [SWARM-013](./SWARM-013-onboarding-orchestrator-api.md) | `feat/swarm-013` | Build idempotent onboarding orchestration API |
| P0 | [SWARM-014](./SWARM-014-auth-account-handshake-simplification.md) | `feat/swarm-014` | Simplify auth/account handshake for onboarding stability |
| P1 | [SWARM-015](./SWARM-015-onboarding-wizard-ui.md) | `feat/swarm-015` | Unified guided onboarding wizard in Admin UI |
| P1 | [SWARM-016](./SWARM-016-telegram-step-diagnostics-and-repair.md) | `feat/swarm-016` | Verified Telegram onboarding step with auto-diagnostics/repair |
| P1 | [SWARM-017](./SWARM-017-activation-readiness-gates.md) | `feat/swarm-017` | Enforce readiness gates before activation |
| P1 | [SWARM-018](./SWARM-018-onboarding-error-model-retry-and-resume.md) | `feat/swarm-018` | Typed onboarding error model with retry/resume behavior |
| P1 | [SWARM-019](./SWARM-019-onboarding-e2e-and-stability-tests.md) | `feat/swarm-019` | End-to-end onboarding stability test suite |
| P1 | [SWARM-020](./SWARM-020-onboarding-rollout-migration-and-runbooks.md) | `feat/swarm-020` | Rollout controls, migration plan, and runbooks |
