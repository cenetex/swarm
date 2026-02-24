# SWARM-017: Activation Readiness Gates

**Priority:** P1 - Next Sprint
**Package:** `@swarm/admin-api`, `@swarm/admin-ui`
**Risk:** Medium - changes activation control logic

## Worker Assignment

- **Assigned Worker:** `worker-017` (active)
- **Branch:** `feat/swarm-017`
- **Worktree:** `/Users/ratimics/develop/aws-swarm-swarm-017` (provisioned)
- **Current Lane Status:** `integrated on mainline (validation pass)` (activation-readiness endpoint plus activation gate enforcement promoted into avatar entitlements routes)
- **Core Mission:** Block premature activation and enforce explicit readiness checks before production enablement.

## Problem

Users can attempt activation while setup is partially complete, which causes unstable runtime behavior and confusing first-run failures.

## Solution

1. Define one versioned activation readiness contract shared by SWARM-013 API and SWARM-015 UI.
2. Gate `POST /avatars/{id}/activate` on required checks only (identity, onboarding state, platform, secrets, diagnostics).
3. Return typed remediation actions for each failed check so the wizard can guide recovery deterministically.
4. Add regression coverage for blocked activation and successful activation outcomes.

## Dependencies

- SWARM-012 onboarding state machine contract.
- SWARM-013 orchestrator API.
- SWARM-015 onboarding wizard.
- SWARM-016 Telegram step reliability.

## Canonical Readiness Check Schema

### Contract Placement and Version

- Contract version: `activation_readiness_v1`
- Producer: SWARM-013 onboarding orchestration layer (`GET /onboarding/{avatarId}`)
- Consumer: SWARM-015 onboarding wizard and activation UI
- Enforcement point: `POST /avatars/{id}/activate` (admin-api)

### Canonical Types

```ts
type ActivationGateStatus = 'pass' | 'fail';
type ReadinessCheckStatus = 'pass' | 'fail' | 'warn' | 'not_applicable';
type RemediationKind = 'execute_step' | 'open_ui_route' | 'open_external_docs' | 'contact_support';

type ActivationReadinessReportV1 = {
  version: 'activation_readiness_v1';
  avatarId: string;
  evaluatedAt: string; // ISO-8601
  gateStatus: ActivationGateStatus;
  summary: {
    requiredTotal: number;
    requiredPassing: number;
    requiredFailing: number;
    optionalTotal: number;
    optionalFailing: number;
  };
  checks: ReadinessCheckV1[];
};

type ReadinessCheckV1 = {
  id: string; // Stable machine ID, e.g. "platform.telegram.webhook_healthy"
  title: string; // UI-safe title
  required: boolean;
  status: ReadinessCheckStatus;
  reasonCode: string; // Stable typed code for SWARM-013/018 compatibility
  message: string; // User-safe explanation
  sourceStep?: string; // SWARM-013 step ID where applicable
  remediation: RemediationActionV1[];
  evidence?: Record<string, string | number | boolean | null>;
};

type RemediationActionV1 = {
  id: string; // Stable action ID
  kind: RemediationKind;
  label: string; // CTA label for UI
  description: string;
  retryable: boolean;
  target?: {
    method?: 'GET' | 'POST';
    endpoint?: string; // e.g. /onboarding/{avatarId}/steps/{stepId}/execute
    route?: string; // e.g. /avatars/{avatarId}/onboarding?step=telegram
    docsUrl?: string;
  };
  supportHint?: {
    runbookKey: string;
    reasonCode: string;
  };
};
```

### Canonical Checks and Pass/Fail Criteria

| Check ID | Required | Pass Criteria | Fail Criteria | Primary Reason Codes |
|---|---|---|---|---|
| `onboarding.state.verified` | Yes | SWARM-012 state is activation-eligible (`ready_for_activation` or `completed`) | State is pre-activation, blocked, or unknown | `ONBOARDING_NOT_READY`, `ONBOARDING_STATE_UNKNOWN` |
| `identity.account.resolved` | Yes | Caller identity maps to owner/admin account resolved by SWARM-013 auth context | Identity unresolved or mismatched | `ACCOUNT_UNRESOLVED`, `ACCOUNT_FORBIDDEN` |
| `platform.enabled.at_least_one` | Yes | At least one supported platform is enabled | No platforms enabled | `NO_PLATFORM_ENABLED` |
| `platform.telegram.profile_complete` | Conditional (required when Telegram enabled) | Telegram required profile fields exist (includes `botUsername`) | Any required Telegram config field missing | `TELEGRAM_CONFIG_MISSING` |
| `platform.telegram.webhook_healthy` | Conditional (required when Telegram enabled) | SWARM-016 diagnostics status is `verified` | Diagnostics status is `repairable`, `blocked`, or stale | `TELEGRAM_WEBHOOK_UNHEALTHY`, `TELEGRAM_DIAGNOSTICS_STALE` |
| `secrets.required.present` | Yes | All required secrets for enabled platforms exist | One or more required secrets are missing | `REQUIRED_SECRET_MISSING` |
| `observability.logging.available` | No | Logging/metrics path available | Logging degraded or unavailable | `OBSERVABILITY_DEGRADED` |

Gate rules:

1. `gateStatus = fail` if any required check has `status = fail`.
2. `status = not_applicable` never blocks activation and is valid only for conditional checks.
3. `status = warn` never blocks activation but must still include remediation guidance.
4. Checks must be deterministic and returned in stable ID order.

## Activation Gate Enforcement Contract

### Enforcement Behavior

For `POST /avatars/{id}/activate`, enforce in this order:

1. Authorization check (existing owner/admin behavior).
2. Fresh readiness evaluation using `activation_readiness_v1` (no stale cached result).
3. If readiness gate fails, do not mutate avatar activation fields.
4. If readiness gate passes, continue activation and return success payload.

### Blocked Activation Response

- HTTP status: `409` (`Conflict`)
- Error code: `ACTIVATION_GATE_BLOCKED`
- Include full `readiness` object for UI rendering and recovery actions.
- Include legacy `issues: string[]` during migration so existing callers remain compatible.

```json
{
  "error": {
    "code": "ACTIVATION_GATE_BLOCKED",
    "message": "Activation blocked until required readiness checks pass.",
    "retryable": true
  },
  "avatarId": "avatar-123",
  "readiness": {
    "version": "activation_readiness_v1",
    "gateStatus": "fail",
    "checks": []
  },
  "issues": [
    "Telegram webhook check failed"
  ]
}
```

### Successful Activation Response

- HTTP status: `200`
- Existing activation payload remains valid.
- Response should include readiness contract version used at activation time.

```json
{
  "success": true,
  "avatarId": "avatar-123",
  "status": "active",
  "activatedAt": 1760000000000,
  "activatedBy": "wallet-or-email",
  "readinessVersion": "activation_readiness_v1"
}
```

## Remediation Guidance Contract

Each failed or warning check must contain at least one remediation action with explicit execution semantics:

1. `execute_step`: Call `POST /onboarding/{avatarId}/steps/{stepId}/execute` (SWARM-013).
2. `open_ui_route`: Navigate to a wizard/setup route rendered by SWARM-015.
3. `open_external_docs`: Open external provider documentation when required.
4. `contact_support`: Non-retryable path with runbook and reason code.

Contract requirements:

1. Remediation actions must be typed and machine-parseable (no text-only instructions).
2. `retryable` must match SWARM-013/SWARM-018 retry semantics.
3. UI must not infer hidden logic; it should execute only actions returned by API contract.
4. Every blocking check must include at least one direct CTA (`execute_step` or `open_ui_route`).

## Regression Scenarios

| Scenario | Setup | Expected API Result | Expected UI Result |
|---|---|---|---|
| Blocked: no platforms enabled | Avatar has no enabled platform | `POST /avatars/{id}/activate` returns `409` with `NO_PLATFORM_ENABLED` | Wizard shows blocking check with CTA to platform step |
| Blocked: Telegram enabled but profile incomplete | Telegram enabled, missing `botUsername` | `409` with `TELEGRAM_CONFIG_MISSING` and remediation action | Wizard routes user to Telegram config step |
| Blocked: Telegram diagnostics not verified | Telegram configured, diagnostics `repairable` or `blocked` | `409` with webhook/diagnostic reason code and step execute action | Wizard surfaces repair CTA and re-check flow |
| Success: all required checks pass | Required checks all `pass`/`not_applicable` | `200` activation success payload and `readinessVersion` | Wizard shows ready state and successful activation confirmation |

## Acceptance Criteria

- [ ] `activation_readiness_v1` schema is implemented and versioned in SWARM-013 response contract
- [ ] `POST /avatars/{id}/activate` enforces required checks and returns typed blocked response contract
- [ ] SWARM-015 UI renders readiness checks and remediation actions without client-side inference
- [ ] Each failing/warning check includes typed remediation guidance with retry semantics
- [ ] Regression tests cover blocked activation (all listed failure scenarios) and successful activation
