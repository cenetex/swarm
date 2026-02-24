# SWARM-014: Auth and Account Handshake Simplification

**Priority:** P0 - Do Now
**Package:** `@swarm/admin-api`, `@swarm/admin-ui`
**Risk:** High - auth/session behavior is user-critical

## Worker Assignment

- **Assigned Worker:** `worker-014` (active)
- **Branch:** `feat/swarm-014`
- **Worktree:** `/Users/ratimics/develop/aws-swarm-swarm-014` (provisioned)
- **Current Lane Status:** `integrated on mainline (validation pass)` (canonical onboarding auth/account resolver promoted into Crossmint and Privy auth flows)
- **Core Mission:** Make account identity and session truth deterministic so onboarding cannot enter split-brain auth states.

## Problem

Onboarding stability still depends on multiple auth surfaces and transition paths. Identity-link/switch behavior remains error-prone in edge cases.

## Solution

1. Consolidate onboarding auth checks around one canonical account/session resolver.
2. Make link-vs-switch flows explicit and enforceable across UI/API.
3. Standardize onboarding-specific auth error responses for deterministic UI handling.

## Contract Scope

- Applies to existing SWARM-013 onboarding endpoints only:
  - `GET /onboarding/{avatarId}`
  - `POST /onboarding/{avatarId}/steps/{stepId}/execute`
- Must stay compatible with SWARM-012 `onboarding_contract_v1` guarantees:
  - Deterministic transitions only.
  - Invalid transitions rejected with typed errors.
  - Resume after interruption remains supported.
- No implicit or hidden state transitions may be introduced by auth/account logic.

## Canonical Auth/Account Resolution Path

All onboarding API entrypoints must run one shared resolver before any step logic:

- `resolveOnboardingAuthAccount(request, avatarId, step?)` (name illustrative; one canonical implementation only)
- No step handler, wallet callback, or crossmint callback may bypass this resolver.

Deterministic resolver order:

1. Validate session credentials from request auth context.
2. If session is missing or invalid: return typed auth failure (`AUTH_REQUIRED`).
3. If session is expired: return typed auth failure (`SESSION_EXPIRED`).
4. Load `sessionAccountId` and onboarding ownership context (`avatarOwnerAccountId`).
5. Load target identity ownership (wallet or crossmint identity) if the step involves identity binding.
6. Emit exactly one resolution outcome:
   - `ALLOW_CONTINUE`: session account matches avatar owner account.
   - `ALLOW_LINK`: identity is unbound or already bound to current owner account; explicit link intent is still required by request contract.
   - `REQUIRE_SWITCH`: identity belongs to a different account; switch is required and no state mutation occurs.

Resolver output is consumed by both status and execute-step APIs so UI and API observe the same truth path.

## Link-vs-Switch Flow Contract

### Non-negotiable rule

- Onboarding must never implicitly switch account context.
- When ownership differs, API must return a typed error requiring explicit switch action.

### Behavior Matrix

| Case | Condition | API behavior | State machine impact |
|---|---|---|---|
| Link to current account | Session account owns avatar and target identity is unbound | Accept execute request only when request intent is explicit link | Advance step on success |
| Idempotent relink | Identity already linked to current account | Return success/idempotent result | No duplicate transition |
| Switch required | Identity linked to different account | Return typed error (`ACCOUNT_SWITCH_REQUIRED`) with safe switch metadata | No transition; state unchanged |
| Ambiguous intent | Request lacks explicit link/switch intent when required | Return typed error (`ACCOUNT_INTENT_REQUIRED`) | No transition; state unchanged |

### UI Contract

- UI must present explicit user choice when resolver returns switch-required context:
  - `Link current account` (only if link is allowed)
  - `Switch account`
- UI must not auto-retry with a switch path without user confirmation.
- After explicit switch and re-auth, UI resumes by re-fetching `GET /onboarding/{avatarId}` and continuing from returned step state.

## Deterministic Session-Expired Handling

When session expires during onboarding:

- API response is always typed auth error: `SESSION_EXPIRED`.
- HTTP status remains consistent across onboarding endpoints (recommended: `401`).
- Response includes resumable context required by SWARM-013 flow (`avatarId`, current step, retry-safe action hint).

Deterministic handling requirements:

1. No onboarding state transition is committed when returning `SESSION_EXPIRED`.
2. No partial account-link mutation is committed when returning `SESSION_EXPIRED`.
3. Failure counters/retry counters do not increment for `SESSION_EXPIRED`.
4. UI clears stale auth context, re-authenticates, then resumes from canonical `GET /onboarding/{avatarId}` state.

## Regression Scenarios (Wallet + Crossmint Transitions)

Add coverage in integration/E2E suites (owned by SWARM-014 and SWARM-019 test plans):

| ID | Scenario | Expected result |
|---|---|---|
| R1 | Wallet-first onboarding, then crossmint link to same account | Link succeeds; no account switch; state advances deterministically |
| R2 | Crossmint-first onboarding, then wallet link to same account | Link succeeds; idempotent re-entry supported |
| R3 | Wallet belongs to account B while onboarding session is account A | API returns `ACCOUNT_SWITCH_REQUIRED`; no implicit switch; state unchanged |
| R4 | Crossmint identity belongs to account B while onboarding session is account A | API returns `ACCOUNT_SWITCH_REQUIRED`; no implicit switch; state unchanged |
| R5 | Session expires between onboarding status fetch and wallet execute-step call | Execute returns `SESSION_EXPIRED`; no mutation; resume works after re-auth |
| R6 | Session expires during crossmint onboarding transition/callback window | Typed `SESSION_EXPIRED` on next protected call; no partial link; resume from canonical status |
| R7 | Repeating same wallet or crossmint link execute request after success | Idempotent success response; no duplicate link or invalid transition |
| R8 | User explicitly chooses switch, re-authenticates as target account, resumes onboarding | Resume continues from canonical step; transition history remains valid per SWARM-012 |

## Implementation Notes

- API and UI must consume the same typed auth/account outcomes to avoid split-brain behavior.
- Error taxonomy names here should map into SWARM-018 typed error model without changing the resolver semantics.
- Any contract additions must be reflected in SWARM-013 endpoint response schema and SWARM-012 transition tests.

## Dependencies

- SWARM-012 contract.
- SWARM-013 orchestrator endpoint shape.

## Acceptance Criteria

- [ ] Onboarding uses one backend session/account truth path
- [ ] Link-vs-switch user flow is explicit in both API and UI contract
- [ ] No implicit identity switching during onboarding
- [ ] Session-expired behavior is deterministic and recoverable
- [ ] Regression tests cover wallet + crossmint onboarding transitions
- [ ] Resolver path is shared by onboarding status and execute-step endpoints
- [ ] `ACCOUNT_SWITCH_REQUIRED` and `SESSION_EXPIRED` produce no state mutation
