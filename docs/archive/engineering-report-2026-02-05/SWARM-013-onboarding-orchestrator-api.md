# SWARM-013: Onboarding Orchestrator API

**Priority:** P0 - Do Now
**Package:** `@swarm/admin-api`
**Risk:** Medium - introduces new API path and orchestration layer

## Worker Assignment

- **Assigned Worker:** `worker-013` (active)
- **Branch:** `feat/swarm-013`
- **Worktree:** `/Users/ratimics/develop/aws-swarm-swarm-013` (provisioned)
- **Current Lane Status:** `integrated on mainline (validation pass)` (onboarding orchestrator endpoints, handler routing, and infra path wiring promoted and validated)
- **Core Mission:** Expose a single backend onboarding interface that executes and tracks steps idempotently.

## Problem

Onboarding requires clients to call multiple endpoint families directly, increasing coupling and handling complexity.

## Contract Alignment (SWARM-012)

- Contract version is fixed to `onboarding_contract_v1`.
- SWARM-012 state machine is authoritative for step order, transition guards, and terminal states.
- `onboarding.state` MUST use SWARM-012 canonical states (`not_started`, `auth_pending`, `profile_pending`, `integration_pending`, `readiness_pending`, `ready_to_activate`, `blocked`, `completed`, `cancelled`).
- Error codes MUST use SWARM-012/SWARM-018 canonical `snake_case` names.
- Invalid transitions MUST return typed errors (not generic 500s).
- Step metadata returned by this API is machine-readable and stable for UI rendering (`stepId`, `order`, `optional`, `status`, retry hints).

## Canonical API Contract

### Base Path

- `/onboarding/{avatarId}`

### Endpoints

1. `GET /onboarding/{avatarId}` (`status`)
2. `POST /onboarding/{avatarId}/steps/{stepId}/execute` (`execute-step`)
3. `POST /onboarding/{avatarId}/restart` (`restart`)
4. `POST /onboarding/{avatarId}/steps/{stepId}/skip-optional` (`skip-optional`)

### Deterministic Response Envelope (All Endpoints)

All responses MUST include the same top-level keys in the same shape. Unknown/unused values are `null`, not omitted.

```json
{
  "contractVersion": "onboarding_contract_v1",
  "requestId": "aws-request-id",
  "timestamp": "2026-02-05T21:00:00.000Z",
  "avatarId": "avatar-123",
  "action": {
    "type": "status|execute_step|restart|skip_optional",
    "stepId": "connect_telegram",
    "result": "applied|no_op|replayed|rejected",
    "reasonCode": null
  },
  "idempotency": {
    "key": "0f6b0904-0f23-4fd7-99d8-6e9d4b6cbef2",
    "scope": "avatar:avatar-123:action:execute_step:step:connect_telegram",
    "replayed": false,
    "inFlight": false
  },
  "onboarding": {
    "state": "not_started|auth_pending|profile_pending|integration_pending|readiness_pending|ready_to_activate|blocked|completed|cancelled",
    "resumeTargetState": null,
    "currentStepId": "connect_telegram",
    "revision": 7,
    "updatedAt": "2026-02-05T21:00:00.000Z",
    "steps": [
      {
        "stepId": "connect_wallet",
        "order": 1,
        "optional": false,
        "status": "pending|in_progress|completed|failed|skipped|blocked",
        "attemptCount": 1,
        "retryable": false,
        "nextRetryAt": null,
        "lastError": {
          "code": null,
          "category": null,
          "message": null,
          "retryable": null
        }
      }
    ],
    "allowedActions": ["execute_step", "skip_optional", "restart"]
  },
  "error": null
}
```

### Error Envelope

Typed errors are deterministic and user-safe:

```json
{
  "error": {
    "code": "invalid_transition",
    "category": "validation|transient|dependency|auth|configuration",
    "message": "Step cannot be executed from current state.",
    "retryable": false,
    "details": {
      "currentState": "blocked",
      "expectedStates": ["ready_to_activate"]
    }
  }
}
```

## Endpoint Details

### 1) Status

- **Method/Path:** `GET /onboarding/{avatarId}`
- **Purpose:** Return canonical state snapshot without mutating state.
- **Success:** `200`
- **Action payload:** `action.type=status`, `action.result=no_op`, `action.stepId=null`
- **Idempotency payload:** `idempotency.key=null`, `idempotency.replayed=false`

### 2) Execute Step

- **Method/Path:** `POST /onboarding/{avatarId}/steps/{stepId}/execute`
- **Headers:** `Idempotency-Key` (required)
- **Body:**

```json
{
  "expectedRevision": 7,
  "input": {}
}
```

- **Success:** `200`
- **Behavior:**
  - If current state is `not_started`, initialize onboarding via `start_onboarding` before executing the requested step transition.
  - Valid transition and execution success: `action.result=applied`
  - Step already terminal (`completed` or `skipped`): `action.result=no_op`
  - Replay with same key and same fingerprint: `action.result=replayed`, same body/status as original
- **Invalid state:** `409` with `error.code=invalid_transition`
- **Timeout:** `504` with `error.code=step_dependency_timeout`, `error.retryable=true`

### 3) Restart

- **Method/Path:** `POST /onboarding/{avatarId}/restart`
- **Headers:** `Idempotency-Key` (required)
- **Body (optional):**

```json
{
  "reason": "user_requested"
}
```

- **Success:** `200`
- **Behavior:**
  - Machine resets to SWARM-012 restart target state (`auth_pending`) and `revision` increments
  - If already at initial state: `action.result=no_op`
- **Invalid state:** `409` with `error.code=transition_write_conflict` when an exclusive transition is active

### 4) Skip Optional

- **Method/Path:** `POST /onboarding/{avatarId}/steps/{stepId}/skip-optional`
- **Headers:** `Idempotency-Key` (required)
- **Body:** `{}` (or omitted)
- **Success:** `200`
- **Behavior:**
  - Optional and currently skippable: `action.result=applied`, step status becomes `skipped`
  - Already `skipped` or `completed`: `action.result=no_op`
- **Invalid request:** `422` with `error.code=step_not_skippable` when step is required
- **Invalid state:** `409` with `error.code=invalid_transition` when skip is not currently allowed

## Idempotency Requirements

Applies to mutating endpoints (`execute-step`, `restart`, `skip-optional`):

1. **Key requirement**
   - `Idempotency-Key` is required.
   - Recommended format: UUID v4; max length 128 ASCII chars.
2. **Scope**
   - Uniqueness scope: `(avatarId, actionType, stepId|null, idempotencyKey)`.
3. **Fingerprinting**
   - Persist request fingerprint over method + path + normalized body.
4. **Replay behavior**
   - Same scope + same fingerprint MUST return original HTTP status + original body byte-equivalent except `timestamp`.
   - Response MUST set `idempotency.replayed=true`.
5. **Conflict behavior**
   - Same scope + different fingerprint: `409`, `error.code=idempotency_key_conflict`.
   - Same scope while original request is still executing: `409`, `error.code=idempotency_in_flight`, include `error.details.retryAfterMs`.
6. **Retention**
   - Store idempotency records for at least 24 hours.

## Integration Test Matrix Notes

| Category | Scenario | Endpoint | Expected Result |
|---|---|---|---|
| Success | Read status for active onboarding | `GET /onboarding/{avatarId}` | `200`; deterministic envelope; `contractVersion=onboarding_contract_v1` |
| Success | Execute valid next step | `POST .../execute` | `200`; `action.result=applied`; step status moves to `completed`; revision increments |
| Success | Skip valid optional step | `POST .../skip-optional` | `200`; step status `skipped`; allowed actions update |
| Success | Restart from mid-flow | `POST .../restart` | `200`; state reset to `auth_pending`; all steps reset per contract |
| Retry | Replay same execute request/key | `POST .../execute` | Same status/body as first response; `idempotency.replayed=true` |
| Retry | Re-run failed retryable step with new key | `POST .../execute` | Prior error preserved in history; new attempt succeeds or returns typed retryable error |
| Retry | Key reuse with different body | Mutating endpoints | `409`; `error.code=idempotency_key_conflict` |
| Timeout | Downstream timeout during execute | `POST .../execute` | `504`; `error.code=step_dependency_timeout`; `error.retryable=true`; snapshot still deterministic |
| Timeout | Replay timed-out request with same key | `POST .../execute` | Same `504` envelope replayed, `idempotency.replayed=true` |
| Invalid State | Execute step out of order | `POST .../execute` | `409`; `error.code=invalid_transition`; includes expected states |
| Invalid State | Skip required step | `POST .../skip-optional` | `422`; `error.code=step_not_skippable`; `retryable=false` |
| Invalid State | Restart during exclusive in-flight transition | `POST .../restart` | `409`; `error.code=transition_write_conflict` |

## Dependencies

- SWARM-012 state machine contract.

## Acceptance Criteria

- [ ] `GET /onboarding/{avatarId}` returns canonical onboarding state
- [ ] `POST /onboarding/{avatarId}/steps/{stepId}/execute` is idempotent
- [ ] `POST /onboarding/{avatarId}/restart` and `POST /onboarding/{avatarId}/steps/{stepId}/skip-optional` are canonicalized with deterministic response shapes
- [ ] Idempotency behavior is specified for key scope, replay, and conflict outcomes
- [ ] Step errors return typed, user-safe codes/messages
- [ ] Retryable vs non-retryable failures are explicit
- [ ] API integration tests cover success, retry, timeout, and invalid-state cases
