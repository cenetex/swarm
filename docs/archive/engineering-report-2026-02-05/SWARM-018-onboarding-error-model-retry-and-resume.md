# SWARM-018: Onboarding Error Model, Retry, and Resume

**Priority:** P1 - Next Sprint
**Package:** `@swarm/admin-api`, `@swarm/admin-ui`, `@swarm/core`
**Risk:** Medium - error semantics are cross-cutting

## Worker Assignment

- **Assigned Worker:** `worker-018`
- **Branch:** `feat/swarm-018`
- **Worktree:** `/Users/ratimics/develop/aws-swarm-swarm-018`
- **Current Lane Status:** `integrated on mainline (validation pass)` (typed error/retry/resume primitives + auth-orchestrator hooks promoted; onboarding unit tests added)
- **Core Mission:** Make onboarding failures predictable and recoverable with typed errors, retry policy, and resumable execution.

## Problem

Users currently see mixed failure messaging and inconsistent retry behavior across setup steps.

## Solution

1. Define typed onboarding error classes and code taxonomy aligned with SWARM-012 transition errors.
2. Make retryability deterministic (`retryable`, `retryStrategy`, `retryAfterMs`, `maxAttempts`).
3. Persist failure history and resume token metadata for safe resume and support diagnostics.
4. Standardize API and UI decision points for retry vs resume vs remediation.

## Dependencies

- SWARM-012 contract.
- SWARM-013 orchestrator API.
- SWARM-014 auth/session error semantics.
- SWARM-015 wizard UI state handling.

## Error Contract (Typed)

### Base Error Envelope

```ts
export type OnboardingErrorType =
  | 'validation'
  | 'transient'
  | 'dependency'
  | 'auth'
  | 'configuration';

export interface OnboardingErrorEnvelope {
  errorType: OnboardingErrorType;
  errorCode: OnboardingErrorCode;
  message: string; // user-safe
  retryable: boolean;
  retryStrategy: 'none' | 'immediate' | 'exponential_backoff' | 'after_remediation' | 'after_reauth';
  retryAfterMs?: number;
  maxAttempts?: number;
  attempt?: number;
  correlationId: string;
  onboardingContractVersion: 'onboarding_contract_v1';
  runId: string;
  state: string;
  step?: string;
  resumeToken?: string;
}
```

### Typed Error Classes

| Class | `errorType` | Purpose | Retryability source |
|---|---|---|---|
| `OnboardingTransitionError` | `validation`\|`dependency`\|`auth`\|`configuration`\|`transient` | SWARM-012 transition/guard failures | Code table below (canonical) |
| `OnboardingValidationError` | `validation` | Invalid payloads, unsupported actions, idempotency mismatches | Always non-retryable until request changes |
| `OnboardingDependencyError` | `dependency` | Third-party/downstream step dependency failures | Usually retryable, except deterministic dependency preconditions |
| `OnboardingAuthError` | `auth` | Session/account authorization failures | Non-retryable until re-auth/session refresh |
| `OnboardingConfigurationError` | `configuration` | Missing/invalid setup conditions requiring user action | Non-retryable until remediation |
| `OnboardingTransientError` | `transient` | Timeouts, write conflicts, temporary platform failures | Retryable with bounded backoff |
| `OnboardingResumeTokenError` | `validation`\|`auth` | Expired, mismatched, tampered, or replayed resume token | Non-retryable with stale token; recover via fresh `GET /onboarding/{avatarId}` |

### Error Codes and Retryability Flags

`OnboardingErrorCode` must include the SWARM-012 transition codes exactly as named.

#### Canonical SWARM-012 Transition Codes (do not rename)

| errorCode | errorType | retryable | retryStrategy | Notes |
|---|---|---|---|---|
| `invalid_transition` | `validation` | `false` | `none` | Event not legal for current state |
| `prerequisite_not_met` | `dependency` | `false` | `none` | Required prior step incomplete |
| `step_not_skippable` | `validation` | `false` | `none` | Optional-skip attempted on required step |
| `readiness_checks_failed` | `configuration` | `false` | `after_remediation` | Blocking readiness gate failure |
| `blocker_unresolved` | `configuration` | `false` | `after_remediation` | `blocked` resume attempted before fix |
| `terminal_state_transition_denied` | `validation` | `false` | `none` | Transition requested from terminal state |
| `actor_not_authorized` | `auth` | `false` | `after_reauth` | Session/account scope failure |
| `idempotency_key_conflict` | `validation` | `false` | `none` | Same key reused with different payload |
| `transition_write_conflict` | `transient` | `true` | `exponential_backoff` | Persistence race/transient write issue |

#### SWARM-018 Execution/Resume Codes

| errorCode | errorType | retryable | retryStrategy | Notes |
|---|---|---|---|---|
| `step_payload_invalid` | `validation` | `false` | `none` | Step input schema invalid |
| `step_dependency_unavailable` | `dependency` | `true` | `exponential_backoff` | External API/service unavailable |
| `step_dependency_timeout` | `transient` | `true` | `exponential_backoff` | Timeout during dependency call |
| `step_rate_limited` | `dependency` | `true` | `exponential_backoff` | Respect `retryAfterMs` |
| `configuration_missing` | `configuration` | `false` | `after_remediation` | Required account/config item missing |
| `resume_token_expired` | `validation` | `false` | `none` | Token TTL exceeded |
| `resume_token_invalid` | `auth` | `false` | `none` | Signature/tamper/mismatch failure |
| `resume_token_replayed` | `validation` | `false` | `none` | Token sequence older than latest persisted sequence |
| `retry_attempt_limit_reached` | `configuration` | `false` | `after_remediation` | Max attempts consumed for current step |

## Retry Policy

### Step-Level Retry Defaults

| Step class | maxAttempts | initialBackoffMs | multiplier | maxBackoffMs | Jitter |
|---|---:|---:|---:|---:|---|
| External dependency steps (`integration`, readiness probes) | 3 | 1000 | 2.0 | 10000 | ±20% |
| Persistence/transient platform writes | 4 | 250 | 2.0 | 4000 | ±20% |
| Auth/config/validation failures | 0 | 0 | n/a | n/a | n/a |

### Retry Rules

- API is source of truth for `retryable`; UI must not infer retryability from HTTP status alone.
- If `retryable=true`, API returns `attempt`, `maxAttempts`, and optional `retryAfterMs`.
- If `attempt >= maxAttempts`, API returns `retry_attempt_limit_reached` and `retryable=false`.
- Client auto-retry is permitted only for `retryStrategy=exponential_backoff` and only while wizard remains on the same step.

## Resume Token Behavior

### Token Contract

Resume token is opaque to the UI and signed by backend (HMAC/JWT-equivalent). Minimum claims:

| Field | Description |
|---|---|
| `v` | Contract version (`onboarding_contract_v1`) |
| `avatarId` | Avatar scope |
| `runId` | Onboarding run identifier |
| `state` | State snapshot token was issued for |
| `step` | Step snapshot token was issued for |
| `failureSeq` | Monotonic failure sequence number |
| `iat` | Issued-at timestamp (ms) |
| `exp` | Expiry timestamp (ms) |
| `nonce` | Anti-replay nonce |

### Issue, Validate, Rotate

- Issue token on:
  - `GET /onboarding/{avatarId}` for non-terminal runs.
  - Any non-2xx step execution response.
  - Any state mutation that changes `state`, `step`, or `failureSeq`.
- Validate token on mutating onboarding calls (`execute`, `skip`, `restart`) when token is present.
- Reject token with `resume_token_invalid` if signature, `avatarId`, `runId`, or `v` mismatch.
- Reject token with `resume_token_expired` if `now > exp`.
- Reject token with `resume_token_replayed` if `failureSeq` is older than persisted run sequence.
- Rotate token after every successful mutation and every failure append.

### TTL and Invalidation

- Default token TTL: 24h (or shorter if session TTL is shorter).
- Tokens are immediately superseded when newer token is issued for same `runId` + higher `failureSeq`.
- Terminal states (`completed`, `cancelled`) invalidate outstanding tokens.

## Persisted Failure History

Persist failure history in onboarding run record for supportability and deterministic retries.

```ts
export interface OnboardingFailureRecord {
  failureId: string;
  runId: string;
  avatarId: string;
  state: string;
  step: string;
  event: string;
  occurredAt: string; // ISO timestamp
  attempt: number;
  maxAttempts: number;
  errorType: OnboardingErrorType;
  errorCode: OnboardingErrorCode;
  retryable: boolean;
  retryStrategy: 'none' | 'immediate' | 'exponential_backoff' | 'after_remediation' | 'after_reauth';
  retryAfterMs?: number;
  correlationId: string;
  requestId?: string;
  idempotencyKey?: string;
  resumeTokenHash: string; // never store raw token
  details?: Record<string, string | number | boolean>;
  resolvedAt?: string;
  resolution?: 'retry_succeeded' | 'restart_onboarding' | 'cancel_onboarding' | 'manual_remediation';
}
```

### Persistence Rules

- Append one `OnboardingFailureRecord` per failed mutation attempt.
- Maintain `failureSeq` and `lastFailure` summary on run root for fast reads.
- Retain latest 100 failures per run inline; archive older failures to cold log store if needed.
- Never persist raw secrets or raw resume token; store only hashed token fingerprint.

## API Handling Expectations (Retry + Resume)

### Response Requirements for Step Failures

Every non-2xx response from `POST /onboarding/{avatarId}/steps/{stepId}/execute` must include:

- `error` envelope with typed fields above.
- `onboarding` snapshot (`runId`, `state`, `step`, `failureSeq`).
- `resumeToken` (except when authorization cannot reveal run context).

### Decision Points

| Decision point | API requirement | UI requirement |
|---|---|---|
| Retryable transient/dependency failure with attempts remaining | Return `retryable=true`, `retryStrategy=exponential_backoff`, `attempt`, `maxAttempts`, optional `retryAfterMs` | Auto-retry with bounded backoff; show countdown and cancel option |
| Retryable code but attempts exhausted | Return `retry_attempt_limit_reached`, `retryable=false` | Stop auto-retry; show remediation/help CTA and manual retry only after user action |
| Non-retryable transition/config error | Return canonical SWARM-012 code and current canonical state | Disable blind retry; route user to required remediation step |
| Auth/session failure | Return `actor_not_authorized` (or auth equivalent), `retryStrategy=after_reauth` | Trigger re-auth flow; then refresh onboarding state before resuming |
| Resume token expired/invalid/replayed | Return token code + fresh state snapshot if allowed | Discard local token; call `GET /onboarding/{avatarId}` and continue from canonical step |
| Browser refresh/session restore | Return latest canonical run state + fresh token via `GET /onboarding/{avatarId}` | Rehydrate wizard from API state; do not trust stale client-only state |

## UI Handling Expectations

- UI must key remediation copy/actions by `errorCode`, not free-form message text.
- UI must show `correlationId` for support on all hard failures.
- UI must preserve unsent user input locally, but server state remains source of truth for step status.
- UI must not auto-retry `after_remediation`, `after_reauth`, or `none` strategies.
- UI resume action should call canonical step execute with latest `resumeToken` and idempotency key.

## Acceptance Criteria

- [ ] Typed onboarding error classes and `OnboardingErrorCode` union are defined in contract docs
- [ ] SWARM-012 transition error codes are reused exactly and mapped to explicit retryability
- [ ] Resume token lifecycle (issue, validate, rotate, expire, invalidate) is specified
- [ ] Persisted `failureHistory` fields are fully specified with retention and security rules
- [ ] API failure responses include deterministic retry/resume decision fields
- [ ] UI handling matrix covers retry, resume, re-auth, and remediation paths
- [ ] Logs and support flows include `correlationId`, `runId`, and `failureId` linkage
