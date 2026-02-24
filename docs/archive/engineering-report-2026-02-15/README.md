# Engineering Report — 2026-02-15

## Full Repository Analysis & Prioritized Recommendations

**Scope:** Complete analysis of all packages (~121K source LOC, ~26K test LOC), 112 test files, 7 CI/CD workflows, CDK infrastructure, build system, and operational posture.

**Comparison baseline:** Prior engineering report from 2026-02-05.

---

## Executive Summary

AWS Swarm has matured significantly since the 2026-02-05 report. M1 (Paid Telegram MVP) is **complete** at v1.0.1 — authentication/onboarding, entitlements, energy unification, memory management, activation flows, observability, and operational runbook are all shipped. The codebase has grown from ~50K to ~121K source LOC with 112 test files (up from 90). However, the rapid growth has introduced **build failures in two packages**, a **high test failure rate (114 of 574 tests failing)**, and continued growth of mega-files that were flagged in the prior report.

### Key Changes Since 2026-02-05

| Area | Then | Now |
|------|------|-----|
| Source LOC | ~50K | ~121K (+142%) |
| Test files | 90 | 112 (+24%) |
| Test results | Not captured | 401 pass, 114 fail, 66 errors, 59 skip |
| Version | Not captured | 0.1.68 |
| M1 status | In progress | Complete |
| Packages | 10 | 10 (+ 2 peripheral: plan-tests, profile-page) |
| CI/CD workflows | 5 | 7 |

---

## 1. Repository Metrics

### 1.1 Codebase Size

| Package | Source LOC | Test Files | Test LOC |
|---------|-----------|------------|----------|
| admin-api | 59,939 | 67 | ~15,000 |
| core | 15,149 | 18 | ~4,500 |
| handlers | 14,805 | 15 | ~3,800 |
| admin-ui | 14,028 | 6 | ~800 |
| mcp-server | 10,938 | 4 | ~1,200 |
| infra | 5,185 | 0 | 0 |
| claude-code-worker | ~600 | 0 | 0 |
| **Total** | **~121,000** | **112** | **~26,300** |

### 1.2 Dependency Snapshot

- **Runtime:** Node.js 20, TypeScript 5.7, ES2022 target
- **Package manager:** pnpm 10.19.0 with workspace protocol
- **Frontend:** React 18 + Zustand + Vite
- **Backend:** AWS Lambda + API Gateway (HTTP API)
- **Database:** DynamoDB (single-table patterns)
- **Queue:** SQS (message + response queues)
- **Auth:** Privy (Crossmint) + Solana Phantom wallet
- **LLM:** Anthropic Claude SDK ^0.39.0, AWS Bedrock Runtime, OpenRouter
- **Testing:** Bun test runner (primary), Vitest config (coverage)
- **Infrastructure:** AWS CDK v2
- **Key SDKs:** AWS SDK v3 ^3.700.0, grammy ^1.30.0, twitter-api-v2 ^1.18.0, zod ^3.24.0

---

## 2. Build Health

### 2.1 Current Build Status: FAILING

Running `pnpm -r build` produces **two package failures**:

#### `claude-code-worker` — Missing type declarations

```
error TS2307: Cannot find module 'path' or its corresponding type declarations.
error TS2307: Cannot find module '@aws-sdk/client-sqs' or its corresponding type declarations.
error TS2580: Cannot find name 'process'. Do you need to install type definitions for node?
```

**Root cause:** `@types/node` is not in `devDependencies` and AWS SDK types are not installed. The package has no `tsconfig.json` inheriting from the base config properly.

#### `profile-page` — Missing vite binary

```
sh: 1: vite: not found
```

**Root cause:** `node_modules` not installed; `vite` is listed as a dependency but `pnpm install` may not have been run for this workspace member.

#### Remaining packages build successfully

`core`, `handlers`, `admin-api`, `admin-ui`, `infra`, `mcp-server`, and `layer` all compile without errors.

---

## 3. Test Health

### 3.1 Test Summary

| Metric | Value |
|--------|-------|
| Total tests | 574 |
| Passing | 401 (69.9%) |
| Failing | 114 (19.9%) |
| Errors | 66 (11.5%) |
| Skipped | 59 (10.3%) |
| expect() calls | 882 |
| Duration | 1.77s |

### 3.2 Failure Analysis

The **66 errors** are almost entirely caused by **missing module resolution** in the Bun test runner:

| Missing Module | Affected Packages | Occurrences |
|----------------|-------------------|-------------|
| `@aws-sdk/lib-dynamodb` | admin-api, core, handlers | 18 |
| `@aws-sdk/client-dynamodb` | admin-api, core, handlers | 4 |
| `@aws-sdk/client-secrets-manager` | admin-api, core | 2 |
| `@aws-sdk/client-sqs` | handlers | 1 |
| `@aws-sdk/client-bedrock-runtime` | core | 1 |
| `@aws-sdk/client-cloudwatch-logs` | admin-api | 1 |
| `@swarm/core` | admin-api, handlers | 8 |
| `@solana/web3.js` | admin-api | 2 |
| `zod` | admin-api, handlers, mcp-server | 7 |
| `grammy` | core | 1 |
| `twitter-api-v2` | admin-api, core | 2 |
| `yaml` | core | 1 |
| `zustand` | admin-ui | 1 |
| `react/jsx-dev-runtime` | admin-ui | 1 |
| Others (bs58, jimp, tweetnacl) | various | 3+ |

**Root cause:** The test environment (Bun) cannot resolve many workspace and third-party dependencies. This is likely a `pnpm install` or hoisting issue in this environment, but it means **CI reliability depends on correct dependency installation** — any CI caching issue could reproduce this.

### 3.3 Test Coverage by Package

| Package | Test Files | Test Ratio | Assessment |
|---------|-----------|------------|------------|
| admin-api | 67 | Good | Best covered, but many tests error out on missing deps |
| core | 18 | Moderate | Key services covered (state, llm, media, usage) |
| handlers | 15 | Moderate | Webhook, media, message processing covered |
| admin-ui | 6 | Low | Only auth bootstrap, wallet linking, clipboard, PrivyProvider |
| mcp-server | 4 | Low | Only registry, tool-router, admin, twitter tools |
| infra | 0 | None | Zero tests for CDK constructs |
| claude-code-worker | 0 | None | Zero tests |

**Coverage threshold** is set at 25% (lines/functions/branches/statements) — well below industry norms of 60-80%.

---

## 4. Architecture Assessment

### 4.1 Strengths

1. **Clean control/runtime plane separation.** The admin API handles configuration and identity; the runtime plane handles message ingestion, LLM processing, and delivery. These are decoupled via SQS.

2. **Queue-based async processing.** Webhook → SQS → message-processor → response-sender provides reliable, retryable message handling with DLQ support.

3. **Entitlement enforcement.** Atomic DynamoDB conditionals enforce plan limits at the handler layer, preventing usage overruns.

4. **MCP tool registry.** The `mcp-server` package provides a unified tool catalog with schema validation, enabling consistent tool access across admin API and handlers.

5. **Correlation ID propagation.** Request IDs flow from webhook → SQS attributes → handler context, enabling cross-service tracing.

6. **Chat-first design.** All user interactions route through the chat interface — no separate settings pages or configuration modals.

7. **Comprehensive CI/CD.** 7 workflows covering CI, CDK deploy, admin UI deploy, agent deploy, fast deploy, and issue management.

8. **Security posture.** Telegram webhook secret verification, IP validation, write-only secrets, KMS encryption, sanitized logging.

### 4.2 Architectural Concerns

1. **Mega-file persistence.** Several files flagged in the 2026-02-05 report remain large or have grown:

   | File | Lines | Change from 02-05 |
   |------|-------|--------------------|
   | `admin-ui/components/ToolPrompts.tsx` | 2,876 | New largest file |
   | `admin-api/services/memory.ts` | 2,211 | New entry |
   | `infra/constructs/admin-api.ts` | 2,127 | Not previously flagged |
   | `admin-api/types.ts` | 1,737 | Was 1,676 (+61) |
   | `admin-api/handlers/chat.ts` | 1,661 | Was 2,516 (reduced) |
   | `admin-api/services/media.ts` | 1,469 | New entry |
   | `handlers/services/platform-mcp-adapter.ts` | 1,438 | New entry |
   | `core/types/index.ts` | 1,252 | Was 1,368 (reduced) |

   `chat.ts` was partially decomposed (good), but new mega-files have emerged, particularly `ToolPrompts.tsx` and `memory.ts`.

2. **admin-api dominance.** The admin-api package holds ~50% of all source code (59,939 LOC). It functions as a monolith containing services for auth, billing, memory, media, onboarding, Telegram, Twitter, NFTs, wallets, voice, and more. This creates high coupling and slow build times.

3. **Dual test runner confusion.** The repo has both a `vitest.config.ts` (with coverage thresholds) and a `bunfig.toml`, but tests are executed via `bun test`. The vitest config appears unused or only used for coverage reporting, creating confusion about which runner is authoritative.

---

## 5. CI/CD Pipeline Assessment

### 5.1 Workflows

| Workflow | Trigger | Status |
|----------|---------|--------|
| `ci.yml` | Push/PR to main | Active — build, lint, test, CDK synth |
| `deploy.yml` | Push to main, tags, manual | Active — orchestrates CDK + UI deploy |
| `deploy-cdk-reusable.yml` | Called by deploy.yml | Active — CDK deploy with hotswap option |
| `deploy-admin-ui-reusable.yml` | Called by deploy.yml | Active — S3 sync + CloudFront invalidation |
| `deploy-agent.yml` | Manual | Active — individual agent deployment |
| `fast-deploy.yml` | Manual | Active — quick deployment variant |
| `issue-management.yml` | Issue events | Active — auto-labeling |

### 5.2 Pipeline Strengths

- **Concurrency control:** `cancel-in-progress: false` prevents deploy stomping.
- **Environment gates:** Staging auto-deploys; production requires tags or manual trigger.
- **E2E tests:** Staging deploy triggers Telegram and Web E2E tests.
- **Production smoke:** Optional HTTP endpoint checks after prod deploy.
- **Browser visual tests:** Playwright-based visual regression (opt-in).
- **Deploy tagging:** Successful prod deploys are auto-tagged with timestamp.
- **AWS account verification:** Every deploy job verifies the AWS account ID matches expectations.

### 5.3 Pipeline Gaps

- **No test gate in CI before merge.** If the test suite has 114 failures, it's unclear whether CI is blocking merges or if the threshold is effectively "some tests can fail."
- **No build verification for all packages.** `claude-code-worker` and `profile-page` fail to build but this may not block CI.
- **No dependency audit.** No `npm audit` or equivalent in CI.

---

## 6. Security Assessment

### 6.1 Strengths

- Write-only secrets (admin can SET but not READ secret values)
- KMS encryption for all secrets
- Telegram webhook secret token verification with timing-safe comparison
- IP range verification for Telegram webhooks
- Sanitized logging (no message content logged)
- OIDC-based GitHub Actions AWS authentication (no static credentials)
- Cloudflare Access for zero-trust admin authentication

### 6.2 Areas for Improvement

- No `npm audit` in CI pipeline
- No CSP headers visible in admin-ui configuration
- No rate limiting visible on admin API authentication endpoints (beyond chat rate limiting)
- The `internal-test-key.ts` utility warrants review to ensure it cannot leak into production

---

## 7. Identified Issues (Prioritized)

### P0 — Critical (blocking development/CI)

| # | Issue | Package | Impact |
|---|-------|---------|--------|
| 1 | `claude-code-worker` build fails — missing `@types/node` and AWS SDK types | claude-code-worker | Cannot compile package |
| 2 | 114 test failures + 66 errors in test suite | all | CI reliability, developer confidence |
| 3 | Module resolution failures in Bun test runner | all | Tests cannot import workspace deps or many third-party packages |

### P1 — High (technical debt, maintainability)

| # | Issue | Package | Impact |
|---|-------|---------|--------|
| 4 | `ToolPrompts.tsx` is 2,876 lines — largest file in repo | admin-ui | Unmaintainable, hard to review |
| 5 | `admin-api` is 60K LOC monolith — 50% of codebase | admin-api | Coupling, build times, blast radius |
| 6 | Zero tests for CDK infrastructure | infra | Infra changes untested |
| 7 | Coverage threshold at 25% — below industry norms | all | Low confidence in correctness |

### P2 — Medium (operational, DX)

| # | Issue | Package | Impact |
|---|-------|---------|--------|
| 8 | `profile-page` build fails — missing vite dependency | profile-page | Cannot build package |
| 9 | Dual test runner confusion (vitest config + bun execution) | root | Developer confusion |
| 10 | admin-ui has only 6 test files for 14K LOC | admin-ui | Frontend regressions undetected |
| 11 | No dependency security audit in CI | ci | Vulnerable deps could ship |

### P3 — Low (nice-to-have improvements)

| # | Issue | Package | Impact |
|---|-------|---------|--------|
| 12 | mcp-server has only 4 test files for 10.9K LOC | mcp-server | Tool registry changes risky |
| 13 | Some conventional commit scopes missing (e.g., `mcp-server`) | docs | Inconsistent commit messages |

---

## 8. Recommendations

### Immediate (this sprint)

1. **Fix `claude-code-worker` build** — add `@types/node` and AWS SDK packages to `devDependencies`/`dependencies`.
2. **Fix test environment** — ensure `pnpm install` resolves all workspace and third-party dependencies for Bun. Consider adding a CI step that verifies `pnpm install --frozen-lockfile` before test execution.
3. **Triage the 114 test failures** — distinguish genuine logic failures from environment/module-resolution issues. Fix or skip with explanatory comments.

### Near-term (next 2 sprints)

4. **Decompose `ToolPrompts.tsx`** — split into individual tool prompt components (one per tool or tool category).
5. **Add CDK infrastructure snapshot tests** — use CDK `assertions` module to verify synthesized templates.
6. **Raise coverage threshold** — target 40% as an intermediate goal, then 60%.
7. **Add `npm audit` to CI** — fail on high/critical vulnerabilities.

### Medium-term (M2 planning horizon)

8. **Decompose admin-api** — extract domain services (billing, onboarding, memory, media) into separate packages or at least clear module boundaries with barrel exports.
9. **Consolidate test runner** — choose either Vitest or Bun as the single test runner and remove the other's configuration.
10. **Add admin-ui component tests** — use React Testing Library for core flows (chat, onboarding wizard, auth).

---

## 9. M1 Completion Assessment

All M1 tasks in PLAN.md are checked off:

- [x] Authentication and onboarding (wallet + Crossmint)
- [x] Billing and entitlements (manual + Orb-holder auto-boost)
- [x] Memory opt-in and retention (TTL, delete, export)
- [x] Deploy and activate flow (readiness gates, audit log)
- [x] Observability and reliability (correlation IDs, CloudWatch dashboards, alarms)
- [x] End-to-end validation (Telegram canary, smoke tests, runbook)

**M1 is complete.** The project is positioned to begin M2 (Multi-platform parity: Discord/X adapters, unified tool registry, usage metering UI, SQS payload offload).

---

## 10. Comparison with 2026-02-05 Report

| Finding from 02-05 | Status as of 02-15 |
|---------------------|---------------------|
| Mega-file problem (chat.ts at 2,516 lines) | Partially addressed — chat.ts reduced to 1,661 but new mega-files emerged (ToolPrompts.tsx at 2,876) |
| Code duplication (DynamoDB client, secret loading) | Partially addressed — some consolidation occurred (SWARM-002, SWARM-003) |
| Test coverage gaps | Test file count increased 90→112, but failure rate is high (20%) |
| Infrastructure tests missing | Still zero tests for infra package |
| CI/CD improvements needed | Significantly improved — 5→7 workflows, E2E tests, browser tests, prod smoke checks |
| Security hardening | Addressed — Telegram webhook security, sanitized logging, OIDC auth |
| Onboarding overhaul (SWARM-011 through SWARM-020) | All 10 tickets integrated and validated |

---

*Report generated 2026-02-15. Next review recommended: 2026-03-01.*
