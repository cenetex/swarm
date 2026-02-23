# PRD: Agentic Coding Control Plane for AWS Swarm

Status: Draft
Owner: Engineering
Date: 2026-02-16

## 1) Summary

AWS Swarm already has strong CI, local hooks, operational scripts, and an agentic intake pattern (GitHub issue -> assign to Copilot), but it does not yet provide a deterministic, machine-verifiable control plane that allows coding agents to write, validate, and route review outcomes end-to-end on every PR.

This PRD defines how to evolve the repository so agentic coding can safely handle near-100% of implementation and first-pass review work while preserving strict risk controls.

The target loop is:

1. Coding agent proposes changes.
2. Risk policy gate computes required checks from changed paths.
3. Review agent status is validated against current PR head SHA.
4. Evidence is verified (tests, UI/browser artifacts, review state).
5. Findings are either remediated in-branch by an automation agent or converted into harness-gap issues.

Current-state note:

- Feature/bug work is already initiated via GitHub issues and assigned to Copilot automation.
- Avatar and automated browser actors can already report issues through the Issues API.
- This PRD formalizes and hardens the missing control-plane links between those systems.

## 2) Repository Baseline (Current State)

### Existing strengths

- CI exists in .github/workflows/ci.yml with lint, build, and test jobs.
- Deployment workflows are established (.github/workflows/deploy.yml and reusable deploy workflows).
- Local gatekeeping exists via .husky/pre-commit and .husky/pre-push.
- Operational and debugging scripts already exist (scripts/test-api.sh, scripts/avatar-logs.sh, scripts/avatar-inspect.sh).
- Browser and UI smoke capabilities exist (scripts/test-browser.mjs, scripts/smoke-admin-ui.mjs).
- Issue tracking and labeling automation exists (.github/workflows/issue-management.yml).
- GitHub issue creation/assignment automation exists (scripts/gh-create-issue.sh and scripts/gh-assign-copilot.sh).
- Avatar/automation issue intake already exists via POST /issues (packages/admin-api/src/handlers/issues.ts) backed by deduplicated auto-issues storage (packages/admin-api/src/services/auto-issues.ts).

### Current gaps

- No single machine-readable risk/merge policy contract.
- No preflight policy gate that runs before expensive CI fanout.
- No current-head SHA discipline for review-agent findings.
- No canonical rerun-comment writer to avoid duplicate rerun requests.
- No deterministic workflow for auto-resolving bot-only threads post-clean rerun.
- Browser evidence is available but not standardized as required PR artifacts.
- No deterministic bridge from internal auto-issues to normalized GitHub issues with policy labels, Copilot assignment rules, and replay-safe dedupe.
- Incident-to-harness-gap loop exists conceptually, but lacks end-to-end SLA instrumentation and merge-policy linkage.

## 3) Goals and Non-Goals

### Goals

- G1: Enforce deterministic, risk-aware merge policy from a single contract.
- G2: Ensure review-agent state is valid only for current PR head SHA.
- G3: Make UI and critical-flow evidence machine-verifiable in CI.
- G4: Reduce human coordination burden with deterministic rerun and cleanup automations.
- G5: Turn production regressions into repeatable harness cases with measurable closure times.

### Non-goals

- N1: Replacing existing CI jobs in ci.yml.
- N2: Forcing one review vendor (solution must be review-agent agnostic).
- N3: Auto-merging without policy and evidence checks.
- N4: Introducing non-chat-first product workflows.

## 4) Product Requirements

### R1: Single policy contract

Create one repository contract file, proposed path:

- .github/policy/risk-merge-policy.json

Contract must define:

- Risk tiers by file/path rules.
- Required checks per tier.
- Docs drift rules for control-plane changes.
- Browser evidence requirements for UI/user-flow changes.
- Review-agent requirements by tier.

Minimum schema fields:

- version
- riskTierRules
- mergePolicy
- docsDriftRules
- evidenceRules
- reviewPolicy

### R2: Deterministic preflight gate before fanout

Add new workflow:

- .github/workflows/risk-policy-gate.yml

Behavior:

1. Trigger on pull_request events (opened, synchronize, reopened, ready_for_review).
2. Determine changed files and highest risk tier.
3. Evaluate contract rules deterministically.
4. Block if docs drift rules are unmet.
5. Block if required checks for tier are absent/failed.
6. If review required, verify review-agent run state for current head SHA.

Ordering requirement:

- Expensive jobs (full tests, browser evidence, security scans) must depend on successful risk-policy-gate.

### R3: Current-head SHA review discipline

For any configured review agent:

- Gate must only accept review status tied to pull_request.head.sha.
- Stale findings/comments for prior SHAs are informational and must not satisfy policy.
- synchronize events require fresh review run.
- Timeout and non-success review runs are blocking for required tiers.

### R4: Canonical rerun-request writer with SHA dedupe

Add one workflow as canonical rerun comment author:

- .github/workflows/review-agent-rerun.yml

Requirements:

- Exactly one workflow writes rerun requests.
- Deduplicate by marker and sha:<headSha> token.
- Avoid duplicate bot comments across workflows.

### R5: Optional remediation loop (guardrailed)

Add optional workflow:

- .github/workflows/review-remediation.yml

Behavior:

- On actionable review findings for current head SHA:
  - Launch coding agent remediation on same PR branch.
  - Apply focused fixes only.
  - Run targeted validation commands.
  - Push follow-up commit to trigger synchronize and normal policy loop.

Guardrails:

- No bypass of risk-policy-gate.
- Ignore stale findings not tied to current head.
- Model/effort config pinned for reproducibility.

### R6: Auto-resolve bot-only threads after clean rerun

Add workflow:

- .github/workflows/review-auto-resolve-threads.yml

Requirements:

- Run only after clean review state for current head SHA.
- Auto-resolve unresolved threads only when all participants are review bot identities.
- Never auto-resolve threads with human comments.
- Re-run risk-policy-gate after auto-resolve actions.

### R7: Browser evidence as first-class artifact

Introduce standardized manifest/artifact process for UI-flow changes.

Leverage existing assets:

- scripts/test-browser.mjs
- scripts/smoke-admin-ui.mjs

Add commands:

- pnpm harness:ui:capture-browser-evidence
- pnpm harness:ui:verify-browser-evidence

Evidence requirements (when risk rules require UI evidence):

- Required flows executed.
- Entrypoint route and expected auth mode recorded.
- Expected identity/account signal present.
- Artifacts fresh for current head SHA.

### R8: Incident to harness-gap loop

Formalize the loop:

- production regression -> harness gap issue -> harness case added -> closure SLA tracked

Integrate with existing issue mechanisms:

- issues/staging/
- .github/workflows/issue-management.yml
- GitHub Issues (authoritative source of truth)

Add weekly KPI reporting command:

- pnpm harness:weekly-metrics

### R9: Internal issue intake -> GitHub/Copilot bridge

Formalize a deterministic bridge from internal issue intake to actionable GitHub backlog items.

Existing inputs:

- POST /issues in admin API (internal tests, browser tests, avatars, runtime tooling)
- auto-issues dedupe/fingerprinting records in ADMIN_TABLE

Required behavior:

1. Poll or subscribe to new/open internal issues.
2. Map issue fingerprint/severity/category to GitHub labels and templates.
3. Create or update corresponding GitHub issue idempotently (fingerprint key).
4. Assign Copilot by policy (for example: all high/critical, selected medium classes).
5. Link internal issueId <-> GitHub issue number for traceability.
6. Prevent duplicate GitHub issue creation across retries/races.

Implementation shape:

- Add bridge workflow/script (for example, scripts/sync-internal-issues-to-github.mjs).
- Reuse existing gh CLI and GraphQL assignment conventions already used by scripts/gh-create-issue.sh and scripts/gh-assign-copilot.sh.
- Emit structured run summary for auditability and weekly metrics.

## 5) Proposed Risk Tiering for AWS Swarm

Initial path-based tiering (v1 proposal):

- High
  - packages/admin-api/src/handlers/**
  - packages/admin-api/src/auth/**
  - packages/admin-api/src/services/secrets.ts
  - packages/handlers/src/webhook-security.ts
  - packages/handlers/src/telegram-webhook-shared.ts
  - packages/core/src/services/**
  - packages/mcp-server/src/**
  - packages/infra/src/**
- Medium
  - packages/handlers/src/** (except files in High)
  - packages/admin-api/src/** (except files in High)
  - scripts/**
  - .github/workflows/**
- Low
  - docs/**
  - non-runtime metadata and content files

## 6) Check Matrix (v1)

Required checks by tier:

- High
  - risk-policy-gate
  - CI (lint/build/test from ci.yml)
  - review-agent-status
  - browser-evidence (if UI paths changed)
  - conversation-resolution (if PR has review threads)
- Medium
  - risk-policy-gate
  - CI
  - review-agent-status
- Low
  - risk-policy-gate
  - CI

## 7) Functional Specs by Component

### 7.1 Policy evaluator package

Add lightweight policy tooling under:

- packages/plan-tests or new package tools/policy (implementation choice to be finalized)

Capabilities:

- Parse contract JSON.
- Compute highest risk tier from changed paths.
- Resolve required checks.
- Validate docs drift rules.
- Emit machine-readable gate result JSON for workflow consumption.

### 7.2 Workflow orchestration

New workflows:

- risk-policy-gate.yml
- review-agent-rerun.yml
- review-auto-resolve-threads.yml
- review-remediation.yml (optional, feature-flagged)
- internal-issues-sync.yml (new bridge from auto-issues to GitHub/Copilot)

CI integration update:

- Ensure expensive jobs execute only when risk-policy-gate passes.

### 7.3 Evidence artifacts

Artifact structure proposal:

- test-outputs/evidence/<headSha>/manifest.json
- test-screenshots/<headSha>/...

Manifest fields:

- headSha
- generatedAt
- actor
- flowsRun[]
- assertions[]
- artifacts[]
- status

## 8) Non-Functional Requirements

- Determinism: Same commit + same inputs => same gate verdict.
- Auditability: Every gate decision emits structured explanation.
- Idempotency: Rerun requests and thread cleanup must be deduplicated.
- Performance: Preflight gate target under 90 seconds for median PR.
- Safety: No policy bypass path in remediation workflows.

## 9) Success Metrics

Primary:

- 100% of PRs evaluated by risk-policy-gate.
- 100% of high-tier PRs validated against current-head review state.
- 0 merges with stale review evidence.

Secondary:

- 30% reduction in median time-to-green for high-tier PRs.
- 50% reduction in duplicate rerun bot comments.
- 90% of regressions converted to harness-gap issues within 24h.
- 95% of new high/critical internal issues linked to GitHub issues within 10 minutes.
- 90% of policy-eligible GitHub issues auto-assigned to Copilot without manual intervention.

## 10) Rollout Plan

### Phase 0: Contract and dry-run (1 week)

- Add contract file and evaluator logic.
- Run gate in report-only mode in PR comments/check summary.
- Validate tier mapping and docs drift rules.

Exit criteria:

- No false positives on 20 consecutive PRs.

### Phase 1: Enforced preflight + review SHA checks (1-2 weeks)

- Enforce risk-policy-gate as required check.
- Enforce current-head review status check for high/medium tiers.
- Add canonical rerun workflow with dedupe.

Exit criteria:

- No stale-review merges over 2 weeks.

### Phase 2: Browser evidence and thread cleanup (1-2 weeks)

- Add capture/verify evidence commands and workflow wiring.
- Enforce evidence on UI-critical path changes.
- Enable bot-only thread auto-resolve after clean rerun.

Exit criteria:

- 95% evidence manifest validity rate for required PRs.

### Phase 3: Remediation loop + harness-gap SLOs (2 weeks)

- Enable optional remediation workflow behind repo variable flag.
- Wire incident-to-gap automation and weekly metrics reporting.
- Enable internal issue -> GitHub/Copilot sync with idempotent dedupe and label mapping.

Exit criteria:

- Measurable drop in repeated regression class for top 3 failure categories.
- Internal issue bridge sustains 0 duplicate GitHub issue creations for 2 weeks.

## 11) Risks and Mitigations

- Risk: Overly broad high-tier mapping increases friction.
  - Mitigation: Start conservative, monitor, and tune with dry-run telemetry.
- Risk: Review vendor API variance.
  - Mitigation: Define a normalized review-agent adapter interface.
- Risk: Browser evidence flakes.
  - Mitigation: Require deterministic assertions and freshness checks tied to head SHA.
- Risk: Remediation loop causes noisy commits.
  - Mitigation: Scope-limited patching and targeted validation before push.

## 12) Open Questions

1. Which review agent is first-party default for this repo (Greptile, CodeRabbit, CodeQL+custom, or hybrid)?
2. Should medium tier require review-agent success from day 1, or start with high tier only?
3. Should review remediation be enabled only for labeled PRs (for example, safe-to-remediate)?
4. Where should policy evaluator live for long-term ownership (existing package vs dedicated tools package)?
5. Which internal issue categories should auto-assign Copilot by default vs human triage first?

## 13) Acceptance Criteria

This PRD is complete when:

- Contract file exists and is used as the single source of risk and merge policy truth.
- risk-policy-gate is required and runs before expensive CI fanout.
- Review-agent checks are validated only for current PR head SHA.
- Rerun requests are emitted by one canonical deduplicated workflow.
- Browser evidence is required and machine-verified for UI-critical changes.
- Bot-only stale threads are auto-resolved only after clean current-head rerun.
- Incident regressions are converted into harness-gap cases with tracked closure metrics.
- Internal auto-issues are deterministically synchronized to GitHub issues with dedupe, traceability, and Copilot assignment policy.
