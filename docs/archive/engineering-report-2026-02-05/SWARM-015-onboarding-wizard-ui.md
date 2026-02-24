# SWARM-015: Onboarding Wizard UI

**Priority:** P1 - Next Sprint
**Package:** `@swarm/admin-ui`
**Risk:** Medium - major UX surface change

## Worker Assignment

- **Assigned Worker:** `worker-015` (active)
- **Branch:** `feat/swarm-015`
- **Worktree:** `/Users/ratimics/develop/aws-swarm-swarm-015` (provisioned)
- **Current Lane Status:** `integrated on mainline (validation pass)` (wizard route, API client normalization, and onboarding telemetry plumbing promoted into admin-ui)
- **Core Mission:** Replace fragmented setup prompts with one guided onboarding wizard driven by backend step state.

## Problem

Setup actions are currently distributed across modal flows and integration panels. Users can miss required actions or complete steps out of order.

## Solution

1. Create a dedicated onboarding route/surface with stepper state.
2. Render only valid next actions from orchestrator step metadata.
3. Keep advanced configuration outside the default onboarding path.

## Wizard Information Architecture

`@swarm/admin-ui` is a pure contract consumer. The backend state machine (`onboarding_contract_v1`, SWARM-012) and orchestrator API (SWARM-013) are the single source of truth for step order, validity, and transitions.

### Required Path (blocking for activation)

| Order | Step ID | Section | Requirement | Exit Condition |
|---|---|---|---|---|
| 1 | `account_handshake` | Account and identity verification | Required | Canonical account/session resolved (SWARM-014) |
| 2 | `avatar_basics` | Avatar minimum profile/config | Required | Minimum required profile fields are valid |
| 3 | `telegram_connection` | Telegram setup and verification | Required | Step status is `verified` (SWARM-016 contract) |
| 4 | `readiness_checks` | Pre-activation readiness report | Required | All required checks pass (SWARM-017) |
| 5 | `activation` | Final enablement action | Required | Activation succeeds from verified onboarding state |

### Optional Path (non-blocking)

| Step ID | Section | Requirement | Notes |
|---|---|---|---|
| `wallet_link` | Link additional wallet identity | Optional | Available where auth context supports link flow (SWARM-014) |
| `email_recovery_link` | Add recovery login identity | Optional | Suggested for wallet-first users |
| `advanced_config` | Non-critical tuning/settings | Optional | Intentionally outside required funnel path |

### Resume Behavior

1. Wizard route is stable (`/avatars/:avatarId/onboarding`); active step is always derived from backend status, never from URL-local step IDs.
2. On mount and after every mutate action, call status endpoint and fully replace client step state from response.
3. If an execution is already in flight, show the backend-reported in-progress step and lock conflicting actions.
4. Skip behavior is backend-authoritative: optional steps are skippable only when orchestrator exposes a skip action.
5. Session expiration redirects to auth, then returns to the same onboarding route and rehydrates from status.
6. Restart is explicit and destructive, only via orchestrator restart action and confirmation UI.

## Backend-Driven UI Contract for Valid Next Actions

UI must render controls from backend-provided `validNextActions` only. No client-side inference of legal transitions.

### Status Contract Expectations (`GET /onboarding/{avatarId}`)

- Top-level fields: `contractVersion`, `funnelVersion`, `avatarId`, `attemptId`, `state`, `currentStepId`, `steps`, `globalActions`.
- `contractVersion` must be `onboarding_contract_v1` (SWARM-012).
- `funnelVersion` must be `onboarding_funnel_v1` (SWARM-011).
- Each step object must include:
  - `id`, `title`, `requirement` (`required|optional`), `status`
  - `validNextActions[]` with backend-authorized actions only
  - `blockingReasons[]` when status is blocked/invalid
  - `lastError` with typed class/code when failed (aligned to SWARM-018 taxonomy)

### Action Rendering Rules

1. Primary CTA for active step is selected from `validNextActions` in priority order: `execute`, `retry`, `continue`.
2. Optional-step skip button is rendered only when `skip_optional` action is present.
3. Restart control is rendered only when `globalActions` contains `restart`.
4. Unknown action types are ignored in UI but logged as contract warnings.
5. After action calls (`execute-step`, `skip-optional`, `restart`), UI refreshes status and re-renders from new response snapshot.
6. If `contractVersion` is unsupported, UI must show a deterministic "update required" blocking state.

## Funnel Instrumentation Checklist (`onboarding_funnel_v1`)

All UI onboarding telemetry must be emitted with schema version `onboarding_funnel_v1` and must avoid PII payloads.

### Required Event Envelope

- `schemaVersion` = `onboarding_funnel_v1`
- `contractVersion` = `onboarding_contract_v1`
- `source` = `admin_ui_onboarding_wizard`
- `avatarId`, `attemptId`, `sessionId`
- `stepId`, `stepRequirement`, `stepStatus`
- `eventName`, `eventTimestamp`
- `result` (`success|failure|skipped|abandoned`) where applicable
- `errorClass`, `errorCode` for failures (typed per SWARM-018)

### Checklist

- [ ] Emit `onboarding_stage_enter` once when a step becomes active in UI.
- [ ] Emit `onboarding_stage_exit` once when leaving a step, with `result`.
- [ ] Emit `onboarding_action_initiated` for every user-triggered backend action (`execute`, `retry`, `skip_optional`, `restart`).
- [ ] Emit `onboarding_action_completed` for successful action responses.
- [ ] Emit `onboarding_action_failed` for failed action responses, including typed `errorClass` and `errorCode`.
- [ ] Emit `onboarding_resumed` when wizard rehydrates from existing server-side progress.
- [ ] Emit `onboarding_abandoned` when user exits before completion (route leave/session end).
- [ ] Emit `onboarding_completed` when activation step reaches terminal success.
- [ ] Ensure event `stepId` values exactly match backend step IDs (no UI aliases).
- [ ] Ensure no PII in telemetry fields (no wallet address, email, auth token, or free-text error bodies).

## Dependencies

- SWARM-012 contract.
- SWARM-013 orchestrator API.
- SWARM-014 auth handshake stabilization.

## Acceptance Criteria

- [ ] Single onboarding UI flow for new avatar setup
- [ ] Wizard IA is explicitly defined with required and optional sections
- [ ] Step actions are driven exclusively by backend-provided valid next actions
- [ ] Required vs optional steps are clearly separated and skip semantics are backend-authorized
- [ ] Users can leave and resume from server-side state without progress loss
- [ ] Funnel instrumentation checklist implemented with `onboarding_funnel_v1` + no-PII guardrails
