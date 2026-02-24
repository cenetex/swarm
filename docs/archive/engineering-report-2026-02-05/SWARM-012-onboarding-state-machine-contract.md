# SWARM-012: Onboarding State Machine Contract

**Priority:** P0 - Do Now
**Package:** `@swarm/admin-api`, `@swarm/core`
**Risk:** Medium - contract changes affect UI and API integration

## Worker Assignment

- **Assigned Worker:** `worker-012` (active)
- **Branch:** `feat/swarm-012`
- **Worktree:** `/Users/ratimics/develop/aws-swarm-swarm-012` (provisioned)
- **Current Lane Status:** `integrated on mainline (validation pass)` (state machine contract module and route/service wiring promoted with admin-api/infra/admin-ui build coverage)
- **Core Mission:** Replace implicit onboarding flow with an explicit, validated state machine that is deterministic and resumable.

## Problem

Current onboarding logic is spread across handlers and UI prompts. Step validity and ordering are implicit, making edge cases and retries brittle.

## Solution

1. Define onboarding states, transitions, guards, and terminal states.
2. Define machine-readable step metadata for UI rendering.
3. Add strict transition validation in backend orchestration layer.

## Dependencies

- SWARM-011 baseline metrics for transition/failure prioritization.

## Acceptance Criteria

- [ ] State machine schema exists (states, events, guards, retry policy)
- [ ] Invalid transitions are rejected with typed errors
- [ ] State machine supports resume after interruption
- [ ] Contract is versioned (`onboarding_contract_v1`)
- [ ] Contract tests validate all valid/invalid transitions

## `onboarding_contract_v1`: States, Events, Guards, Terminal States

### SWARM-013 API Alignment

- `GET /onboarding/{avatarId}` is read-only and does not emit a transition event.
- `POST /onboarding/{avatarId}/steps/{stepId}/execute` emits one of the step completion events below (`auth_verified`, `profile_saved`, `integration_verified`, `readiness_verified`, `activation_succeeded`) or `block_transition`.
- If current state is `not_started`, first `execute` must atomically emit `start_onboarding` before processing the requested step event.
- `POST /onboarding/{avatarId}/steps/{stepId}/skip-optional` emits `skip_optional_integration` (only for optional integration steps).
- `POST /onboarding/{avatarId}/restart` emits `restart_onboarding`.

### States

| state | kind | description |
|---|---|---|
| `not_started` | initial | No onboarding run exists for this avatar yet. |
| `auth_pending` | non_terminal | Account/session handshake must succeed (SWARM-014 dependency). |
| `profile_pending` | non_terminal | Required avatar profile/config data is incomplete. |
| `integration_pending` | non_terminal | Required integrations are not yet verified; some integrations may be optional. |
| `readiness_pending` | non_terminal | Readiness gates are running or failing; all required gates must pass before activation. |
| `ready_to_activate` | non_terminal | Required onboarding steps are complete and activation can be executed. |
| `blocked` | non_terminal | Flow is paused due to a non-retryable failure pending remediation. |
| `completed` | terminal | Activation succeeded and onboarding is complete. |
| `cancelled` | terminal | Onboarding was explicitly cancelled by user/operator action. |

### Terminal States

| state | terminal_rule |
|---|---|
| `completed` | Immutable in `onboarding_contract_v1`; no outgoing transitions are valid. |
| `cancelled` | Immutable in `onboarding_contract_v1`; no outgoing transitions are valid. |

### Events

| event | intent |
|---|---|
| `start_onboarding` | Initialize onboarding state for an avatar run. |
| `auth_verified` | Auth/account step finished successfully. |
| `profile_saved` | Profile/config step finished successfully. |
| `integration_verified` | Integration verification step finished successfully. |
| `skip_optional_integration` | Skip the integration step when metadata marks it optional. |
| `readiness_verified` | Readiness checks completed with all required gates passing. |
| `activation_succeeded` | Activation step completed successfully. |
| `block_transition` | Enter `blocked` due to a non-retryable failure. |
| `resolve_blocker` | Exit `blocked` after remediation and resume the captured pre-block state. |
| `restart_onboarding` | Reset run back to `auth_pending`. |
| `cancel_onboarding` | Terminate run and move to `cancelled`. |

### Transition Guards

| guard | rule |
|---|---|
| `actor_authorized` | Caller is authorized for `avatarId` and session is valid. |
| `event_allowed_in_state` | Requested event is defined as valid for current `from_state`. |
| `idempotency_key_consistent` | Mutating requests include a stable idempotency key; replay payload must be identical. |
| `required_prerequisites_complete` | Prior required steps for the event are complete. |
| `step_is_optional` | `skip_optional_integration` is only valid when step metadata marks integration as optional. |
| `blocker_is_resolved` | Blocking condition re-check passes before leaving `blocked`. |
| `resume_target_present` | Stored pre-block state exists and is one of the defined non-terminal states. |
| `readiness_checks_passed` | Required readiness gates report no blocking failures. |
| `activation_not_already_completed` | Avatar is not already activated in persistent state. |
| `failure_is_non_retryable` | `block_transition` can only be used for non-retryable failures. |

## Valid Transition Matrix

| from_state | event | to_state | guard |
|---|---|---|---|
| `not_started` | `start_onboarding` | `auth_pending` | `actor_authorized`, `event_allowed_in_state`, `idempotency_key_consistent` |
| `auth_pending` | `auth_verified` | `profile_pending` | `actor_authorized`, `event_allowed_in_state`, `idempotency_key_consistent`, `required_prerequisites_complete` |
| `profile_pending` | `profile_saved` | `integration_pending` | `actor_authorized`, `event_allowed_in_state`, `idempotency_key_consistent`, `required_prerequisites_complete` |
| `integration_pending` | `integration_verified` | `readiness_pending` | `actor_authorized`, `event_allowed_in_state`, `idempotency_key_consistent`, `required_prerequisites_complete` |
| `integration_pending` | `skip_optional_integration` | `readiness_pending` | `actor_authorized`, `event_allowed_in_state`, `idempotency_key_consistent`, `step_is_optional` |
| `readiness_pending` | `readiness_verified` | `ready_to_activate` | `actor_authorized`, `event_allowed_in_state`, `idempotency_key_consistent`, `readiness_checks_passed` |
| `ready_to_activate` | `activation_succeeded` | `completed` | `actor_authorized`, `event_allowed_in_state`, `idempotency_key_consistent`, `activation_not_already_completed` |
| `auth_pending` | `block_transition` | `blocked` | `actor_authorized`, `event_allowed_in_state`, `idempotency_key_consistent`, `failure_is_non_retryable` |
| `profile_pending` | `block_transition` | `blocked` | `actor_authorized`, `event_allowed_in_state`, `idempotency_key_consistent`, `failure_is_non_retryable` |
| `integration_pending` | `block_transition` | `blocked` | `actor_authorized`, `event_allowed_in_state`, `idempotency_key_consistent`, `failure_is_non_retryable` |
| `readiness_pending` | `block_transition` | `blocked` | `actor_authorized`, `event_allowed_in_state`, `idempotency_key_consistent`, `failure_is_non_retryable` |
| `ready_to_activate` | `block_transition` | `blocked` | `actor_authorized`, `event_allowed_in_state`, `idempotency_key_consistent`, `failure_is_non_retryable` |
| `blocked` | `resolve_blocker` | `auth_pending, profile_pending, integration_pending, readiness_pending, ready_to_activate` | `actor_authorized`, `event_allowed_in_state`, `idempotency_key_consistent`, `blocker_is_resolved`, `resume_target_present` |
| `auth_pending` | `restart_onboarding` | `auth_pending` | `actor_authorized`, `event_allowed_in_state`, `idempotency_key_consistent` |
| `profile_pending` | `restart_onboarding` | `auth_pending` | `actor_authorized`, `event_allowed_in_state`, `idempotency_key_consistent` |
| `integration_pending` | `restart_onboarding` | `auth_pending` | `actor_authorized`, `event_allowed_in_state`, `idempotency_key_consistent` |
| `readiness_pending` | `restart_onboarding` | `auth_pending` | `actor_authorized`, `event_allowed_in_state`, `idempotency_key_consistent` |
| `ready_to_activate` | `restart_onboarding` | `auth_pending` | `actor_authorized`, `event_allowed_in_state`, `idempotency_key_consistent` |
| `blocked` | `restart_onboarding` | `auth_pending` | `actor_authorized`, `event_allowed_in_state`, `idempotency_key_consistent` |
| `auth_pending` | `cancel_onboarding` | `cancelled` | `actor_authorized`, `event_allowed_in_state`, `idempotency_key_consistent` |
| `profile_pending` | `cancel_onboarding` | `cancelled` | `actor_authorized`, `event_allowed_in_state`, `idempotency_key_consistent` |
| `integration_pending` | `cancel_onboarding` | `cancelled` | `actor_authorized`, `event_allowed_in_state`, `idempotency_key_consistent` |
| `readiness_pending` | `cancel_onboarding` | `cancelled` | `actor_authorized`, `event_allowed_in_state`, `idempotency_key_consistent` |
| `ready_to_activate` | `cancel_onboarding` | `cancelled` | `actor_authorized`, `event_allowed_in_state`, `idempotency_key_consistent` |
| `blocked` | `cancel_onboarding` | `cancelled` | `actor_authorized`, `event_allowed_in_state`, `idempotency_key_consistent` |

## Invalid Transition Examples Mapped to Error Categories

| invalid_transition_example | why_invalid | expected_error_category | example_typed_error_code |
|---|---|---|---|
| `not_started` + `profile_saved` | Profile step cannot execute before onboarding/auth initialization. | `validation` | `invalid_transition` |
| `not_started` + `auth_verified` | `start_onboarding` has not created a run yet. | `validation` | `invalid_transition` |
| `profile_pending` + `activation_succeeded` | Activation prerequisites (`integration`, `readiness`) are incomplete. | `dependency` | `prerequisite_not_met` |
| `integration_pending` + `skip_optional_integration` when integration is required | Skip is only legal for optional integration steps. | `validation` | `step_not_skippable` |
| `readiness_pending` + `activation_succeeded` with failing readiness checks | Required readiness gates are still failing. | `configuration` | `readiness_checks_failed` |
| `blocked` + `resolve_blocker` while remediation check still fails | Blocker has not been cleared by required diagnostics/remediation. | `configuration` | `blocker_unresolved` |
| `completed` + `restart_onboarding` | `completed` is terminal and immutable in v1. | `validation` | `terminal_state_transition_denied` |
| `cancelled` + `start_onboarding` | `cancelled` is terminal and immutable in v1. | `validation` | `terminal_state_transition_denied` |
| any mutating event by unauthorized actor | Actor/session guard fails for avatar scope. | `auth` | `actor_not_authorized` |
| mutating event with reused idempotency key and different payload | Idempotent replay payload mismatch. | `validation` | `idempotency_key_conflict` |
| valid `(from_state,event)` pair fails due to storage timeout/conflict | Transition intent is valid but persistence failed transiently. | `transient` | `transition_write_conflict` |
