# SWARM-016: Telegram Step Diagnostics and Repair

**Priority:** P1 - Next Sprint
**Package:** `@swarm/admin-api`, `@swarm/admin-ui`
**Risk:** Medium - touches user-facing integration setup flow

## Worker Assignment

- **Assigned Worker:** `worker-016` (active)
- **Branch:** `feat/swarm-016`
- **Worktree:** `/Users/ratimics/develop/aws-swarm-swarm-016` (provisioned)
- **Current Lane Status:** `integrated on mainline (validation pass)` (Telegram onboarding status/execute semantics and diagnostics/repair response shaping promoted)
- **Core Mission:** Convert Telegram onboarding from multi-action manual setup into one verified step with built-in diagnosis and auto-repair.

## Problem

Telegram setup still requires manual interpretation of multiple statuses and can leave users unsure if the integration is actually ready.

## Solution

1. Define a single Telegram onboarding step contract (`pending`, `verified`, `repairable`, `blocked`).
2. Auto-run diagnostics after token/setup actions.
3. Offer one-click repair and re-validation when repairable.

## Telegram Step Contract (SWARM-012/013 Compatible)

- **Step key:** `telegram`
- **State names (fixed):** `pending`, `verified`, `repairable`, `blocked`
- **Execution surface:** SWARM-013 `POST /onboarding/{avatarId}/steps/{stepId}/execute`
- **Determinism rule:** For the same persisted inputs and external Telegram state, diagnostics must return the same state and reason codes.

### Deterministic Step States

| State | Meaning | Entry Conditions | Exit Conditions |
|---|---|---|---|
| `pending` | Setup is incomplete or diagnostics have not yet produced a terminal readiness result. | No token configured, first-time setup, or retryable transient check failure before classification. | Moves to `verified`, `repairable`, or `blocked` after diagnostics complete. |
| `verified` | Telegram integration is ready for traffic. | Token valid, webhook matches desired URL, webhook secret present and matches expected value. | Reverts only if later diagnostics detect drift/failure. |
| `repairable` | Integration is not ready, but backend can apply safe automatic fixes. | Diagnostics detect known fixable issues (for this scope: missing secret, webhook mismatch). | One-click repair runs; then moves to `verified`, remains `repairable`, or escalates to `blocked` if fix cannot complete safely. |
| `blocked` | Integration is not ready and cannot be fixed automatically. | Diagnostics detect non-repairable issue (for this scope: invalid token). | Requires explicit user action (replace token) before returning to `pending` then re-diagnosing. |

### Allowed Transitions

- `pending -> verified | repairable | blocked`
- `repairable -> verified | repairable | blocked`
- `verified -> repairable | blocked` (on drift/regression)
- `blocked -> pending` (after user updates token/config and re-executes step)

No other transitions are valid under SWARM-012 transition validation.

## Auto-Diagnostic Flow

Diagnostics run automatically after every Telegram step execution and after every repair attempt.

1. Load desired onboarding config for `avatarId` and `telegram` step.
2. Collect current integration facts in stable order:
   - Validate bot token against Telegram API.
   - Read webhook configuration from Telegram.
   - Validate secret presence/match in managed config.
3. Produce normalized findings with typed reason codes.
4. Map findings to one deterministic state:
   - No findings: `verified`
   - At least one fixable finding and no blocking finding: `repairable`
   - Any blocking finding: `blocked`
   - Incomplete prerequisites before checks: `pending`
5. Persist state + findings through the SWARM-013 onboarding record.

## One-Click Repair Behavior

When current state is `repairable`, execute performs backend-managed repair actions in fixed order:

1. Ensure webhook secret exists in managed config.
2. Ensure Telegram webhook URL and secret match desired values.
3. Re-run diagnostics immediately after mutations complete.

Behavioral requirements:

- Repair from `pending`, `verified`, or `blocked` is a no-op mutation and must still return current diagnostics.
- Repair only applies safe upsert-style operations; it must not rotate token automatically.
- Response always includes resulting step state and normalized findings for UI rendering.

## Idempotency Expectations

Aligned with SWARM-013 step execution idempotency:

- Repeating the same execute request for `avatarId=X`, `step=telegram`, `action=repair|verify` must be safe.
- Duplicate requests must not create divergent side effects; operations are convergent upserts.
- If a request is retried after partial success, subsequent execution must reconcile to the same final state (`verified`, `repairable`, or `blocked`) and return current findings.
- Idempotent replays may reuse persisted execution result when inputs/fingerprint are unchanged.

## Failure-Mode Matrix

| Failure Path | Diagnostic Signal / Code | Step State | One-Click Repair | Idempotency Expectation |
|---|---|---|---|---|
| Webhook mismatch | Actual webhook URL or secret differs from desired (`TELEGRAM_WEBHOOK_MISMATCH`) | `repairable` | Call Telegram webhook set/update with desired URL + secret, then re-diagnose | Repeated repair requests converge to one webhook config; extra calls are safe no-ops once matched |
| Missing secret | Managed secret missing/empty (`TELEGRAM_SECRET_MISSING`) | `repairable` | Create/set expected secret, then ensure webhook uses it, then re-diagnose | Repeated repair does not create conflicting secrets; same value is upserted |
| Invalid token | Telegram auth failure (`TELEGRAM_TOKEN_INVALID`) | `blocked` | No automatic token repair; require user-provided valid token, then re-execute diagnostics | Repeated execute returns `blocked` until token changes; no side-effect writes on replay |

## Dependencies

- SWARM-012 contract.
- SWARM-013 orchestrator API.
- SWARM-015 onboarding wizard.

## Acceptance Criteria

- [ ] Telegram step state machine uses only `pending`, `verified`, `repairable`, `blocked`
- [ ] Diagnostics result is normalized (typed reason codes) and consumable by wizard UI
- [ ] Auto-diagnostics run after every execute and post-repair flow
- [ ] Repair action is idempotent, convergent, and always followed by re-diagnostics
- [ ] Failure handling explicitly covers webhook mismatch, missing secret, and invalid token paths
- [ ] Final user outcome remains binary: ready (`verified`) vs not-ready (all other states with actionable reason)
