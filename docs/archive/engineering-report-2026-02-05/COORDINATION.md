# SWARM Coordination Snapshot - 2026-02-06

## Scope

This snapshot aligns SWARM tickets with actual git worktree and branch state so agents can coordinate without stepping on each other.

## Assignment Authority

- Swarm coordinator: `codex`
- Authority: the coordinator may assign or reassign workers, define core mission statements, and change execution order by updating this file plus the corresponding `SWARM-00x` ticket document.
- Assignment rule: ticket ownership is official only when worker, branch, and mission are all present in this file and the ticket document.

## Governance Mode

**Active mode (effective 2026-02-06):** `mainline-first`

In this mode:
- `main` commit history is the delivery source of truth.
- Ticket branches are coordination lanes and may be marked superseded if work lands directly on `main`.
- Ticket closure may be recorded as `completed-by-commit` when closure criteria are met.

### Closure Criteria (`completed-by-commit`)

A ticket may be closed without a ticket-branch PR when all are true:
1. At least one `main` commit explicitly maps to the ticket scope.
2. The changed files materially satisfy ticket acceptance intent.
3. Evidence commit SHA(s) are recorded in this document.
4. Residual risks or follow-up validation items are recorded.
5. Coordinator marks ticket status as `completed-by-commit`.

## Observed Repository State

Snapshot collected on **2026-02-06** from:
- `git worktree list`
- `git -C <worktree> status --short --branch`
- `git branch --list 'feat/swarm-*' -v`

### Current Findings

- `main` is at `8f0540c` with SWARM-008 and SWARM-019 integration commits applied on top of prior onboarding waves.
- Local SWARM branches currently present: `feat/swarm-008` through `feat/swarm-020` (legacy lanes still provisioned for coordination replay and drift tracking).
- Local SWARM worktrees currently present: `swarm-008` through `swarm-020`.
- SWARM-001/002/003/004 were delivered via `main` commits and are tracked via closure ledger.
- SWARM-005/006/007 now have additional mainline progress (`bc92632`, `288687f`, `c127e91`) and remain open for closure review.
- Wave 6 dispatch now has successful runs covering SWARM-011 through SWARM-020 (`20260206T060843Z`, `20260206T164723Z`, `20260206T182912Z`), and docs outputs have been promoted into `main` for coordinator review.
- Execution Wave 1 and Wave 2 deltas were promoted to mainline runtime paths for SWARM-012/013/014/015/016/017/020 and validated via package builds plus avatar-routes tests.
- SWARM-018 was promoted from lane primitives into the current onboarding module set (`error-types.ts`, `errors.ts`, `resume-token.ts`, `persistence.ts`) and validated with focused onboarding unit tests plus admin-api build.
- SWARM-008 has been normalized and integrated on mainline (`33762c8`, `5c1c25d`) covering WAF/IAM/SQS hardening plus deploy workflow cleanup.
- Testing stream has been declared complete; onboarding integration now includes deterministic onboarding matrix and route tests directly on mainline (`8f0540c`).

## Worker Assignment Matrix

| Worker | Ticket | Branch | Worktree | Core Mission | Status (2026-02-06) | Notes |
|--------|--------|--------|----------|--------------|-----------------------|-------|
| `worker-001` | SWARM-001 | `(deprovisioned locally)` | `(deprovisioned locally)` | Add fail-fast LLM protection in `message-processor` using shared circuit breaker logic from `@swarm/core`. | Completed-by-commit | Implemented on `main` via `f18a552` |
| `worker-002` | SWARM-002 | `(deprovisioned locally)` | `(deprovisioned locally)` | Replace duplicated secret fetching with shared `loadAvatarSecrets()` utility in all targeted handlers. | Completed-by-commit | Implemented on `main` via `3223c53` |
| `worker-003` | SWARM-003 | `(deprovisioned locally)` | `(deprovisioned locally)` | Introduce canonical `DEFAULT_AVATAR_CONFIG` and remove divergent inline fallback objects. | Completed-by-commit | Implemented on `main` via `3223c53` |
| `worker-004` | SWARM-004 | `(deprovisioned locally)` | `(deprovisioned locally)` | Establish consistent formatting and coverage guardrails (`.editorconfig`, `.prettierrc`, lint-staged, vitest thresholds). | Completed-by-commit | Implemented on `main` via `edad325` |
| `worker-005` | SWARM-005 | `(mainline-first lane)` | `(n/a)` | Decompose oversized files into focused modules while preserving existing exports and behavior. | In progress on mainline (partial) | Commit `bc92632` adds decomposed core type modules; further decomposition still required |
| `worker-006` | SWARM-006 | `(mainline-first lane)` | `(n/a)` | Wire all current CloudWatch alarms to actionable SNS notifications without replacements. | In review on mainline | Commit `288687f` wires alarm actions to SNS; validate full alarm coverage before closure |
| `worker-007` | SWARM-007 | `(mainline-first lane)` | `(n/a)` | Add high-value tests for LLM services, avatars handler, Discord adapter, and worker critical paths. | In progress on mainline | Commits `22b7ed6` and `c127e91` add core/admin-api test coverage; Discord/worker paths still open |
| `worker-008` | SWARM-008 | `feat/swarm-008` | `/Users/ratimics/develop/aws-swarm-swarm-008` | Harden security posture with WAF, scoped Bedrock IAM, queue encryption, and workflow cleanup. | Integrated on mainline (validation pass) | WAF + IAM + queue encryption in `33762c8`; deploy workflow cleanup in `5c1c25d` |
| `worker-009` | SWARM-009 | `feat/swarm-009` | `/Users/ratimics/develop/aws-swarm-swarm-009` | Remove legacy code paths and duplicate types after migration and compatibility verification. | Assigned, not started | Branch/worktree present and clean at `3223c53` |
| `worker-010` | SWARM-010 | `feat/swarm-010` | `/Users/ratimics/develop/aws-swarm-swarm-010` | Improve operational resilience with EventBridge DLQs, configurable LLM limits, and deploy/admin-api maintainability work. | Assigned, not started | Branch/worktree present and clean at `3223c53` |

## Ticket Closure Ledger (Mainline-First)

| Ticket | Closure | Evidence Commits | Residual Follow-Up |
|--------|---------|------------------|--------------------|
| SWARM-001 | Completed-by-commit | `f18a552` | Confirm acceptance checklist in ticket doc and close worker branch as superseded |
| SWARM-002 | Completed-by-commit | `3223c53` | Confirm message-processor side completed as intended and close worker branch as superseded |
| SWARM-003 | Completed-by-commit | `3223c53` | Confirm all fallback sites migrated and close worker branch as superseded |
| SWARM-004 | Completed-by-commit | `edad325` | Confirm lint/coverage gate behavior in CI and close worker branch as superseded |
| SWARM-008 | Completed-by-commit | `33762c8`, `5c1c25d` | Monitor WAF and API stage associations in next staging deploy diff |
| SWARM-019 | Completed-by-commit | `8f0540c` | Expand matrix/artifact CI automation if full WF/EF/FR case expansion is prioritized |

## Onboarding Story Set - Provisioned (SWARM-011 to SWARM-020)

Status: branches/worktrees remain provisioned for traceability. Wave 6 docs-phase lanes are complete, and implementation deltas for SWARM-012/013/014/015/016/017/018/019/020 are integrated on mainline with local validation evidence.

| Worker | Ticket | Proposed Branch | Worktree | Status | Notes |
|--------|--------|-----------------|----------|--------|-------|
| `worker-011` | SWARM-011 | `feat/swarm-011` | `/Users/ratimics/develop/aws-swarm-swarm-011` | Review (checkpoint complete) | Run `20260206T060843Z`; uncommitted doc update in SWARM-011 ticket file |
| `worker-012` | SWARM-012 | `feat/swarm-012` | `/Users/ratimics/develop/aws-swarm-swarm-012` | Integrated on mainline (validation pass) | State-machine contract module and exports promoted to mainline onboarding services |
| `worker-013` | SWARM-013 | `feat/swarm-013` | `/Users/ratimics/develop/aws-swarm-swarm-013` | Integrated on mainline (validation pass) | Onboarding routes + orchestrator + infra route wiring promoted and validated |
| `worker-014` | SWARM-014 | `feat/swarm-014` | `/Users/ratimics/develop/aws-swarm-swarm-014` | Integrated on mainline (validation pass) | Canonical auth/account resolver integrated into Crossmint/Privy flows |
| `worker-015` | SWARM-015 | `feat/swarm-015` | `/Users/ratimics/develop/aws-swarm-swarm-015` | Integrated on mainline (validation pass) | Admin UI onboarding wizard route/API client/telemetry promoted and built |
| `worker-016` | SWARM-016 | `feat/swarm-016` | `/Users/ratimics/develop/aws-swarm-swarm-016` | Integrated on mainline (validation pass) | Telegram onboarding diagnostics/repair response shaping promoted |
| `worker-017` | SWARM-017 | `feat/swarm-017` | `/Users/ratimics/develop/aws-swarm-swarm-017` | Integrated on mainline (validation pass) | Activation readiness evaluator/endpoint and activation gating promoted |
| `worker-018` | SWARM-018 | `feat/swarm-018` | `/Users/ratimics/develop/aws-swarm-swarm-018` | Integrated on mainline (validation pass) | Typed onboarding error/retry/resume primitives plus auth-orchestrator hooks and onboarding unit tests landed |
| `worker-019` | SWARM-019 | `feat/swarm-019` | `/Users/ratimics/develop/aws-swarm-swarm-019` | Integrated on mainline (validation pass) | Deterministic onboarding matrix + onboarding route tests added in `8f0540c` |
| `worker-020` | SWARM-020 | `feat/swarm-020` | `/Users/ratimics/develop/aws-swarm-swarm-020` | Integrated on mainline (validation pass) | Rollout feature-flag service + cohort assignment helpers promoted into avatar creation flow |

## Dispatch Automation

- Manifest: `docs/engineering-report-2026-02-05/SUBAGENT-DISPATCH-WAVE6.manifest`
- Prompt files: `docs/engineering-report-2026-02-05/dispatch-prompts/wave6/`
- Execution manifest: `docs/engineering-report-2026-02-05/SUBAGENT-DISPATCH-EXECUTION-W1.manifest`
- Execution prompts: `docs/engineering-report-2026-02-05/dispatch-prompts/execution-wave1/`
- Execution manifest (wave 2): `docs/engineering-report-2026-02-05/SUBAGENT-DISPATCH-EXECUTION-W2.manifest`
- Execution prompts (wave 2): `docs/engineering-report-2026-02-05/dispatch-prompts/execution-wave2/`
- Parallel launcher: `scripts/swarm-workers.sh`
- Operational note: launch via escalated shell when running under sandbox, because `codex exec` writes session state under `~/.codex/sessions`.

### Latest Dispatch Evidence

- Run directory: `/tmp/swarm-workers/20260206T200331Z`
- Outcome: `worker-015`, `worker-016`, `worker-020` all exit `0`
- Historical note: checkpoint blocker statuses below reflect lane-local state at run time and are superseded by the mainline integration updates recorded above.
- Checkpoints:
  - `worker-015`: `status=blocked`, `latest_commit=UNCOMMITTED`, blockers=`SWARM-013 onboarding endpoints not available in-branch + dependency install/typecheck unavailable`
  - `worker-016`: `status=review`, `latest_commit=UNCOMMITTED`, blockers=`waiting on SWARM-013 endpoint plumbing in-branch`
  - `worker-020`: `status=review`, `latest_commit=UNCOMMITTED`, blockers=`dependency install/typecheck unavailable`
- Resolution note:
  - Test-stream guardrail held: no new `*.test.ts` / `*.test.ts.vitest` changes were introduced in execution-wave worktrees.

### Failed Attempt (Permission Gate)

- Run directory: `/tmp/swarm-workers/20260206T175732Z`
- Outcome: all launched workers exited `1`
- Cause: `codex` session path access denied under non-escalated sandbox (`/Users/ratimics/.codex/sessions`)
- Resolution: rerun launch with escalation; successful completion in run `20260206T182912Z`

### Prior Dispatch Evidence

- Run directory: `/tmp/swarm-workers/20260206T184805Z`
- Outcome: `worker-012`, `worker-013`, `worker-014`, `worker-017`, `worker-018` all exit `0`
- Checkpoints:
  - `worker-012`: `status=review`, `latest_commit=UNCOMMITTED`, blockers=`dependency install/typecheck unavailable`
  - `worker-013`: `status=review`, `latest_commit=UNCOMMITTED`, blockers=`dependency install/typecheck unavailable`
  - `worker-014`: `status=in_progress`, `latest_commit=UNCOMMITTED`, blockers=`waiting on SWARM-013 onboarding endpoint wiring in-branch`
  - `worker-017`: `status=blocked`, `latest_commit=UNCOMMITTED`, blockers=`dependency install/typecheck unavailable`
  - `worker-018`: `status=review`, `latest_commit=UNCOMMITTED`, blockers=`waiting on SWARM-013 endpoint plumbing in-branch + dependency install/typecheck unavailable`
- Run directory: `/tmp/swarm-workers/20260206T182912Z`
- Outcome: `worker-014` through `worker-020` all exit `0`
- Checkpoints:
  - `worker-014`: `status=review`, `latest_commit=UNCOMMITTED`, blockers=`none`
  - `worker-015`: `status=review`, `latest_commit=UNCOMMITTED`, blockers=`none`
  - `worker-016`: `status=review`, `latest_commit=UNCOMMITTED`, blockers=`none`
  - `worker-017`: `status=review`, `latest_commit=UNCOMMITTED`, blockers=`none`
  - `worker-018`: `status=review`, `latest_commit=UNCOMMITTED`, blockers=`none`
  - `worker-019`: `status=review`, `latest_commit=UNCOMMITTED`, blockers=`none`
  - `worker-020`: `status=review`, `latest_commit=UNCOMMITTED`, blockers=`none`
- Run directory: `/tmp/swarm-workers/20260206T164723Z`
- Outcome: `worker-013` exit `0`
- Checkpoints:
  - `worker-013`: `status=review`, `latest_commit=UNCOMMITTED`, blockers=`none`
- Run directory: `/tmp/swarm-workers/20260206T060843Z`
- Outcome: `worker-011` exit `0`, `worker-012` exit `0`
- Checkpoints:
  - `worker-011`: `status=review`, `latest_commit=UNCOMMITTED`, blockers=`none`
  - `worker-012`: `status=review`, `latest_commit=UNCOMMITTED`, blockers=`none`

## Engineering Change Watch (Docs-Only Monitoring)

Snapshot intent: monitor engineering activity without editing runtime code.

### Recent SWARM-Relevant Commits on `main`

| Commit | Message | Ticket Impact | Files |
|--------|---------|---------------|-------|
| `bc92632` | `refactor(core): add decomposed type modules (SWARM-005 partial)` | SWARM-005 (partial) | `packages/core/src/types/*` |
| `c127e91` | `test(admin-api): add comprehensive avatars handler tests (SWARM-007)` | SWARM-007 (partial) | `packages/admin-api/src/handlers/avatars.test.ts` |
| `4aaa33c` | `docs: add onboarding tickets SWARM-011 through SWARM-020` | Onboarding planning | `docs/engineering-report-2026-02-05/SWARM-011..020*.md` |
| `288687f` | `feat(infra): wire CloudWatch alarm actions to SNS topic (SWARM-006)` | SWARM-006 | `packages/infra/src/constructs/avatar.ts`, `packages/infra/src/constructs/shared.ts`, `packages/infra/src/stacks/avatars-stack.ts`, `packages/infra/src/stacks/shared-infra-stack.ts` |
| `33fdda5` | `docs: update coordination snapshot and engineering report` | Coordination metadata | `docs/engineering-report-2026-02-05/*` |
| `22b7ed6` | `test(core): add LLM service tests (SWARM-007)` | SWARM-007 (partial) | `packages/core/src/services/llm/index.test.ts` |
| `3a008cf` | `feat(admin-api): sync runtime contract with burn/energy augmentations` | Adjacent SWARM-010 | `packages/admin-api/src/handlers/avatars.ts`, `packages/admin-api/src/handlers/wallet-auth.ts`, `packages/admin-api/src/services/runtime-limits.ts` |
| `64c21e4` | `feat(handlers): wire entitlement-based media usage gating` | Adjacent SWARM-010 | `packages/handlers/src/media-processor.ts`, `packages/handlers/src/tweet-poster.ts`, `packages/handlers/src/autonomous-tweet-poster.ts`, `packages/handlers/src/services/platform-mcp-adapter.ts` |
| `4a123a0` | `feat(handlers): introduce RuntimeContract and refactor entitlement enforcement` | Adjacent SWARM-010 / SWARM-005 | `packages/handlers/src/services/entitlement-enforcement.ts` and related runtime contract paths |
| `edad325` | `chore: add developer tooling configs (SWARM-004)` | SWARM-004 | `.editorconfig`, `.prettierrc`, `package.json`, `vitest.config.ts` |
| `f18a552` | `feat(core): add circuit breaker and wire into message processor (SWARM-001)` | SWARM-001 | `packages/core/src/services/circuit-breaker.ts`, `packages/core/src/services/index.ts`, `packages/admin-api/src/services/circuit-breaker.ts`, `packages/handlers/src/message-processor.ts` |
| `3223c53` | `refactor(handlers): extract DEFAULT_AVATAR_CONFIG and consolidate secrets (SWARM-002, SWARM-003)` | SWARM-002, SWARM-003 | `packages/core/src/constants.ts`, `packages/handlers/src/response-sender.ts` |

### Observed In-Main Activity (Uncommitted)

| Area | Files | Likely Ticket Impact | Confidence |
|------|-------|----------------------|------------|
| Coordination status refresh | `docs/engineering-report-2026-02-05/COORDINATION.md`, `docs/engineering-report-2026-02-05/README.md`, `docs/engineering-report-2026-02-05/SWARM-008-security-hardening.md`, `docs/engineering-report-2026-02-05/SWARM-019-onboarding-e2e-and-stability-tests.md` | Ticket closure metadata alignment for SWARM-008 and SWARM-019 | High |

### Branch Discipline Watch

- Risk: active branch/worktree inventory no longer matches historical worker mapping.
- Required coordinator action: keep matrix synced with mainline-first delivery and branch lane checkpoints.
- Current watch item:
  - `feat/swarm-011` through `feat/swarm-020` now contain uncommitted docs from completed dispatch runs; coordinator should decide whether to commit per-lane or treat `main` doc promotion as source of truth and reset lanes.
  - Dispatch run `20260206T175732Z` failed under sandbox permission constraints; rerun `20260206T182912Z` succeeded under escalation.
  - Execution runs `20260206T184805Z` and `20260206T200331Z` have been materially integrated into mainline runtime paths; lane worktrees now primarily serve as historical checkpoint artifacts.
  - Testing stream is complete; targeted onboarding tests (`errors.test.ts`, `resume-token.test.ts`, `stability-matrix.test.ts`, `onboarding.test.ts`) now run on mainline.

## Coordinator Runbook

### Daily Startup Checks

Run these before assigning new work or approving merges:

```bash
git worktree list
for wt in /Users/ratimics/develop/aws-swarm*; do
  [ -e "$wt/.git" ] || continue
  echo "### $wt"
  git -C "$wt" status --short --branch
done
```

Then update this document if any status changed.

### Control Loop Cadence

Use a simple repeating loop:

1. **Intake:** collect progress updates from each worker.
2. **Validate:** confirm branch/worktree/commit with git commands.
3. **Record:** update matrix status, notes, latest SHA, and PR.
4. **Unblock:** resolve conflicts and reassign if needed.
5. **Gate:** approve merge only when definition-of-done checks pass.

Target cadence:
- Every 2-4 hours during active delivery windows.
- Immediately after any worker opens a PR.
- Immediately after any merge to `main`.

### Worker Checkpoint Template

Require every worker to submit this exact block:

```md
### CHECKPOINT
ticket: SWARM-00X
worker: worker-00X
branch: feat/swarm-00X
worktree: /Users/ratimics/develop/aws-swarm-swarm-00X
status: in_progress | review | blocked | merged
latest_commit: <sha>
pr: <url-or-none>
changes: <1-3 lines>
tests_run: <commands and result>
blockers: <none or concrete blocker>
next_step: <single next action>
```

### Coordinator Matrix Update Template

When a worker reports progress, append this under the relevant ticket notes:

```md
[2026-02-06T00:00Z] status=<status> sha=<sha> pr=<url-or-none> blocker=<none|summary>
```

Keep only the last 5 checkpoint lines per ticket to avoid bloat.

### Execution Waves and Merge Order

Use this order to reduce conflicts in shared files:

1. **Wave 1 (P0 core risk):** SWARM-001, SWARM-004
2. **Wave 2 (P0 shared runtime):** SWARM-002, SWARM-003
3. **Wave 3 (P1 reliability/testing):** SWARM-006, SWARM-007
4. **Wave 4 (P1/P2 refactor and cleanup):** SWARM-005, SWARM-009
5. **Wave 5 (P2 infra and operational):** SWARM-008, SWARM-010
6. **Wave 6 (Onboarding foundation):** SWARM-011, SWARM-012, SWARM-013, SWARM-014
7. **Wave 7 (Onboarding UX and resiliency):** SWARM-015, SWARM-016, SWARM-017, SWARM-018
8. **Wave 8 (Onboarding validation and rollout):** SWARM-019, SWARM-020

### Conflict Hotspots

Expect merge conflicts in these areas:
- `packages/handlers/src/message-processor.ts` (SWARM-001, SWARM-002, SWARM-003, SWARM-005)
- `packages/core/src/*` runtime constants/types (SWARM-001, SWARM-003, SWARM-005, SWARM-010)
- Root config/workflow files (SWARM-004, SWARM-008, SWARM-010)

Resolution rule:
1. Lower wave number has merge priority.
2. Higher wave branch rebases onto latest `main`.
3. If behavior-level conflict remains, coordinator decides and records rationale in notes.

### Definition of Done for Merge Approval

A ticket is merge-ready only when all are true:

1. Acceptance criteria in `SWARM-00x` doc are checked off.
2. Tests for impacted packages run and results are posted in checkpoint.
3. `git -C <worktree> status --short --branch` shows only intended changes.
4. PR includes scope summary, risks, and rollback note.
5. Coordination matrix status is set to `review` before merge, then `merged` after merge.

### Blocker Escalation Rules

Escalate immediately to coordinator when:
- Worktree has unrelated dirty files.
- A worker needs to change another ticket's branch.
- Infra change implies replacement/destructive diff.
- Acceptance criteria are ambiguous or contradictory.

Coordinator options:
1. Re-scope ticket.
2. Split follow-up ticket.
3. Reassign worker.
4. Pause wave and publish decision note in this file.

## Coordination Rules for Agents

1. Under `mainline-first`, prefer committing to `main` unless coordinator explicitly requests branch-isolated execution for a ticket.
2. Do not open duplicate PRs for tickets marked `completed-by-commit`; use closure ledger evidence instead.
3. Keep ticket scope isolated: one SWARM ticket per branch/PR.
4. Update this file after each meaningful checkpoint:
   - latest commit SHA
   - PR link
   - status (`not started`, `in progress`, `review`, `merged`)
   - blockers/risks
5. Before handoff or review, re-run:
   - `git -C <worktree> status --short --branch`
   - `git -C <worktree> log --oneline --max-count=5`

## Suggested Next Agent Actions

1. Coordinator: close SWARM-012/013/014/015/016/017/018/020 as integrated-on-mainline in ticket docs with acceptance checklist evidence links.
2. Coordinator: schedule SWARM-019 implementation follow-through (convert drafted E2E/retry matrix into executable suites and CI wiring).
3. Coordinator: normalize or deprovision stale SWARM lane worktrees after capturing any residual artifacts needed for auditability.
4. Coordinator: resolve the `feat/swarm-008` dirty worktree state before assigning new implementation work to that lane.
