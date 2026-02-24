# SWARM-019: Onboarding E2E and Stability Tests

**Priority:** P1 - Integrated on mainline (validation pass)
**Package:** `@swarm/admin-api`, `@swarm/admin-ui`
**Risk:** Low - additive test and validation coverage

## Worker Assignment

- **Assigned Worker:** `worker-019` (active)
- **Branch:** `feat/swarm-019`
- **Worktree:** `/Users/ratimics/develop/aws-swarm-swarm-019` (provisioned)
- **Current Lane Status:** `integrated on mainline (validation pass)` (`8f0540c`; deterministic onboarding matrix + onboarding route tests)
- **Core Mission:** Protect onboarding overhaul quality with deterministic integration and end-to-end stability coverage.

## Problem

Without high-confidence test coverage, onboarding improvements can regress quickly due to auth, platform, and UI interaction complexity.

## Contract Alignment Targets

- **SWARM-012 (`onboarding_contract_v1`):** tests validate state-machine legality, step metadata-driven UI progression, and resumability.
- **SWARM-013 (orchestrator API):** tests use canonical endpoints and enforce idempotent `execute-step`, typed errors, and explicit retryability.
- **SWARM-011 (`onboarding_funnel_v1`):** tests assert funnel and failure telemetry is emitted with consistent stage/event semantics and no PII leakage.
- **SWARM-014/016/017/018 alignment:** auth link-vs-switch determinism, Telegram verified/repairable/blocked behavior, readiness gates, and typed retry/resume semantics.

## Deterministic Assertion Catalog

- **A1 - Canonical contract:** `GET /onboarding/{avatarId}` reports contract version `onboarding_contract_v1`.
- **A2 - Step transition legality:** each step transition follows allowed state-machine transitions only (no skipped required transitions).
- **A3 - Execute idempotency:** replaying `POST /onboarding/{avatarId}/steps/{stepId}/execute` does not duplicate side effects.
- **A4 - Optional-step semantics:** skipped optional steps are explicit and do not mutate required-step completion history.
- **A5 - Terminal gating:** activation-success terminal state is reachable only when all required readiness checks are verified.
- **A6 - Auth determinism:** no implicit identity switching; account context changes only after explicit switch action.
- **A7 - Resume determinism:** after refresh/session recovery, current step and prior completions are preserved exactly.
- **A8 - Typed error contract:** step failures return typed class and retryability (`validation|transient|dependency|auth|configuration`, retryable true/false).
- **A9 - Retry convergence:** retryable failure then successful retry yields the same terminal state as clean happy path.
- **A10 - Non-retryable blocking:** non-retryable failures prevent progression until corrected input/action.
- **A11 - Telemetry completeness:** each transition/failure emits `onboarding_funnel_v1` stage event with correlation identifiers.
- **A12 - Root-cause uniqueness:** each failed attempt maps to one deterministic root-cause class across API response, telemetry, and logs.

## End-to-End Matrix

### Wallet-first coverage

| Case | Scenario | Coverage focus | Required assertions |
|---|---|---|---|
| `WF-01` | Wallet-first happy path (required steps only) | canonical progression from entry to activation readiness and activation success | `A1 A2 A3 A5 A11` |
| `WF-02` | Wallet-first + optional email link | optional branch correctness and return to main path | `A1 A2 A3 A4 A5 A6 A11` |
| `WF-03` | Wallet-first with explicit link-vs-switch decision | auth handshake determinism (no implicit switch) | `A2 A3 A6 A11` |
| `WF-04` | Wallet-first mid-flow refresh and resume | resumable UI/API orchestration | `A2 A7 A11` |

### Email-first coverage

| Case | Scenario | Coverage focus | Required assertions |
|---|---|---|---|
| `EF-01` | Email-first happy path (required steps only) | canonical progression from email entry to activation readiness and activation success | `A1 A2 A3 A5 A11` |
| `EF-02` | Email-first + wallet link (recommended flow) | identity-link stability and account continuity | `A2 A3 A5 A6 A11` |
| `EF-03` | Email-first wallet link conflict, explicit switch fallback | conflict handling without silent state corruption | `A2 A6 A8 A10 A11 A12` |
| `EF-04` | Email-first session expiry and resume after re-auth | auth-expired deterministic recovery | `A2 A7 A8 A11 A12` |

## Failure + Retry/Resume Coverage Matrix

| Case | Failure/Interruption Type | Injection point | Expected behavior | Deterministic assertions |
|---|---|---|---|---|
| `FR-01` | `transient` dependency failure | Telegram verify/diagnostics execute | step remains retryable; retry succeeds without duplicate side effects | `A3 A8 A9 A11 A12` |
| `FR-02` | `validation` failure | malformed/invalid user step payload | failure is non-retryable until input fixed; no hidden retries | `A8 A10 A11 A12` |
| `FR-03` | `configuration` failure | missing/invalid integration secret | step enters repairable path; repair action is idempotent | `A3 A8 A9 A11 A12` |
| `FR-04` | `auth` failure | session expires during step execution | deterministic auth error; re-auth returns to same current step | `A7 A8 A10 A11 A12` |
| `FR-05` | orchestrator timeout/retry race | client timeout around `execute-step` | safe replay converges to single committed step result | `A2 A3 A9 A12` |
| `FR-06` | browser refresh/navigation interruption | in-progress onboarding wizard | recovered state matches pre-refresh status and history | `A2 A7 A11` |
| `FR-07` | concurrent duplicate execute requests | double submit of same step | only one logical transition is committed; response parity across duplicates | `A2 A3 A12` |
| `FR-08` | explicit restart flow | `restart` action from partial progress | state resets cleanly; stale completion artifacts not retained | `A1 A2 A11` |

## CI Reporting and Artifact Expectations

### Required CI checks

- `onboarding-e2e-wallet-email` runs `WF-*` and `EF-*` matrix cases.
- `onboarding-stability-retry-resume` runs `FR-*` matrix cases.
- `onboarding-telemetry-contract` validates `onboarding_funnel_v1` event completeness/shape and correlation joinability.

### Required artifacts per test run

- `onboarding-matrix-results.json`: case-level status, duration, deterministic assertion pass/fail map (`A1..A12`).
- `onboarding-state-snapshots.ndjson`: ordered pre/post snapshots from `GET /onboarding/{avatarId}` for every case transition.
- `onboarding-step-execution.ndjson`: per `execute-step` request/response metadata including step id, attempt, retryability, and idempotency outcome.
- `onboarding-telemetry.ndjson`: filtered structured events for onboarding scope, tagged with funnel version and correlation identifiers.
- `onboarding-failure-digest.md` (failures only): one row per failed case with `case id`, `failed step`, `error class`, `retryable`, `correlation id`, `root cause`, `first failing assertion`.
- Browser/UI traces for failed E2E cases (video/screenshot/trace bundle).

### Root-cause visibility requirements

- Every failed case must include a deterministic `rootCauseClass` that matches API typed error class and telemetry classification.
- Failure digest must include both the failing step identifier and the upstream dependency/subsystem classification when applicable.
- Telemetry and API artifacts must be joinable by correlation identifiers without manual log scraping.
- CI summary must report pass/fail counts by matrix group (`WF`, `EF`, `FR`) and by error class (`validation`, `transient`, `dependency`, `auth`, `configuration`).

## Dependencies

- SWARM-012 through SWARM-018 core contracts and flows.

## Mainline Evidence (2026-02-06)

- `8f0540c` (`test(admin-api): add onboarding stability matrix coverage (SWARM-019)`)
  - Added deterministic contract matrix tests at `packages/admin-api/src/services/onboarding/stability-matrix.test.ts`.
  - Added onboarding route handler tests at `packages/admin-api/src/handlers/avatar-routes/onboarding.test.ts`.
- Local validation commands:
  - `bun test packages/admin-api/src/services/onboarding/stability-matrix.test.ts packages/admin-api/src/handlers/avatar-routes/onboarding.test.ts`
  - `pnpm --filter @swarm/admin-api build`
  - `bun test packages/admin-api/src/handlers/avatar-routes --bail=1`

## Acceptance Criteria

- [ ] Wallet-first and email-first matrices (`WF-*`, `EF-*`) are implemented and green.
- [ ] Failure/retry/resume matrix (`FR-*`) is implemented with deterministic assertions (`A1..A12`).
- [ ] Retryable vs non-retryable behavior is verified against typed error classes.
- [ ] Resume behavior is validated for refresh and auth/session interruption paths.
- [ ] CI required checks publish onboarding artifacts and root-cause digest on failures.
- [ ] Telemetry assertions validate `onboarding_funnel_v1` event completeness and correlation integrity.
