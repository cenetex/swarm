# SWARM-011: Onboarding Audit and Funnel Baseline

**Priority:** P0 - Do Now
**Package:** `@swarm/admin-api`, `@swarm/admin-ui`, Docs
**Risk:** Low - additive observability and analysis

## Worker Assignment

- **Assigned Worker:** `worker-011` (active)
- **Branch:** `feat/swarm-011`
- **Worktree:** `/Users/ratimics/develop/aws-swarm-swarm-011` (provisioned)
- **Current Lane Status:** `review` (checkpoint captured 2026-02-06, run `20260206T060843Z`; detailed doc output promoted to `main` for coordinator review)
- **Core Mission:** Establish a trusted baseline for onboarding drop-off, error classes, and time-to-activate before behavior changes.

## Problem

Onboarding failures are visible anecdotally but not measured consistently end-to-end. Without a baseline, an overhaul risks moving problems instead of removing them.

## Solution

1. Define canonical onboarding funnel stages and event names.
2. Add structured events and counters for each stage transition/failure.
3. Publish a baseline report covering completion rate, median setup time, and top failure reasons.

## Onboarding Funnel Taxonomy (`onboarding_funnel_v1`)

Stage IDs are step-oriented so they map directly to SWARM-012 state transitions and SWARM-013 step execution APIs.

| Stage ID | Stage Name | Entry Criteria | Success Criteria | Failure Classes |
|----------|------------|----------------|------------------|-----------------|
| `session_started` | Session Started | User lands on onboarding surface and backend creates/returns canonical onboarding state (`GET /onboarding/{avatarId}`) | `onboarding_session_id` is issued and initial state is persisted as resumable | `transient`, `dependency` |
| `account_auth_resolved` | Account and Auth Resolved | Session exists and onboarding attempts identity/session resolution for the actor | One canonical account/session truth is established for this onboarding attempt | `auth`, `validation`, `dependency`, `transient` |
| `profile_basics_completed` | Profile Basics Completed | Auth is resolved and required profile step is entered via orchestrator | Required profile fields pass validation and step is marked complete | `validation`, `configuration`, `transient` |
| `integration_credentials_verified` | Integration Credentials Verified | Required integration/auth material is submitted (wallet/email/provider credentials as applicable) | Required credentials are validated and persisted for the session | `validation`, `auth`, `dependency`, `configuration`, `transient` |
| `channel_health_verified` | Channel Health Verified | Channel step (for example Telegram) executes diagnostics/verification | Channel status is deterministically `verified` (or explicit non-applicable path recorded) | `dependency`, `configuration`, `validation`, `transient` |
| `readiness_passed` | Readiness Gates Passed | All required onboarding steps have terminal success states | Readiness report has no blocking checks and activation is allowed | `configuration`, `dependency`, `validation`, `transient` |
| `activation_completed` | Activation Completed | Readiness has passed and activation is requested | Activation endpoint succeeds and avatar enters active state | `validation`, `dependency`, `transient`, `configuration` |

Failure classes align to onboarding typed error families used across SWARM-012/013/018:

- `validation`: invalid payload, guard violation, or invalid step/state transition
- `auth`: account/session/link/switch authorization failures
- `dependency`: upstream provider/service/database failures
- `configuration`: missing or invalid required setup/configuration
- `transient`: timeout, throttling, or retryable infrastructure faults

## Structured Telemetry Event Schema

All onboarding funnel telemetry events MUST be structured JSON and include both funnel and contract versions for cross-ticket compatibility.

### Canonical Event Names

| Event Name | Emitted When |
|------------|--------------|
| `onboarding.session.started` | New onboarding session is initialized |
| `onboarding.stage.entered` | A funnel stage is entered |
| `onboarding.stage.succeeded` | A stage reaches success criteria |
| `onboarding.stage.failed` | A stage attempt fails |
| `onboarding.session.completed` | Activation is completed |
| `onboarding.session.abandoned` | Session is inactive past abandonment timeout and never completes |

### Required Event Fields

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `event_name` | string | yes | One of canonical event names above |
| `event_version` | string | yes | `onboarding_events_v1` |
| `funnel_version` | string | yes | `onboarding_funnel_v1` |
| `contract_version` | string | yes | `onboarding_contract_v1` |
| `occurred_at` | string (ISO-8601) | yes | UTC timestamp |
| `environment` | string | yes | `staging` or `prod` |
| `source` | string | yes | `admin_ui` or `admin_api` |
| `avatar_id` | string | yes | Canonical avatar ID |
| `onboarding_session_id` | string | yes | Stable per onboarding attempt |
| `attempt_id` | string | yes | Stable per step attempt; increments on retries |
| `stage_id` | string | yes | One of `onboarding_funnel_v1` stage IDs |
| `stage_name` | string | yes | Human-readable stage label |
| `status` | string | yes | `entered`, `succeeded`, `failed`, `completed`, `abandoned` |
| `request_id` | string | yes | Correlates to API/log request ID |
| `trace_id` | string | yes | Cross-service correlation ID |
| `duration_ms` | number | conditional | Required on `succeeded` and `failed` events |
| `failure_class` | string | conditional | Required on `onboarding.stage.failed`; one of typed classes |
| `failure_code` | string | conditional | Required on `onboarding.stage.failed`; machine-readable code |
| `retryable` | boolean | conditional | Required on `onboarding.stage.failed` |

### PII Handling Notes

- Do not emit raw email, wallet address, access token, provider token, webhook URL secret, or free-form user text.
- If actor-level correlation is needed, emit one-way hashed IDs (`actor_id_hash`) with environment-scoped salt.
- `failure_code` is machine-safe; `failure_message` (if present) must be redacted and capped to non-sensitive templates.
- UI events must not include field payload values; emit only schema-safe metadata (field names, counts, booleans).
- Retention policy for raw event data should follow least-privilege access and existing production log retention controls.

## Baseline Measurement Plan

### Measurement Windows

| Window | Definition | Purpose |
|--------|------------|---------|
| 7-day rolling | Trailing 7 x 24h from report generation time | Fast signal for regressions and release checks |
| 14-day rolling | Trailing 14 x 24h from report generation time | Stability baseline with lower day-of-week variance |

Eligibility rules:

- Include sessions where `onboarding.session.started` occurs inside the measurement window.
- Count each `onboarding_session_id` once for completion and time-to-activation metrics.
- Compute step failure rates on all attempts (`attempt_id`) and also report session-level unique failures.

### Core Metrics

| Metric | Definition | Formula | Report By |
|--------|------------|---------|-----------|
| Completion Rate | Share of started sessions that reach activation | `completed_sessions / started_sessions` | 7-day and 14-day |
| Time-to-Activation | Time from session start to activation success | `activation_completed_at - session_started_at` (report `p50`, `p90`) | 7-day and 14-day |
| Step Failure Rate | Failure pressure by stage | `failed_attempts(stage_id) / entered_attempts(stage_id)` | Per stage for 7-day and 14-day |

### Baseline Output Requirements

- Publish one baseline table for 7-day and one for 14-day window in the SWARM onboarding report.
- Include top 5 `failure_code` entries with counts and mapped `failure_class`.
- Segment results by entry path where available (`wallet-first`, `email-first`) to support SWARM-019 coverage goals.
- Flag any stage with failure rate above threshold (initial default: `>10%`) for SWARM-012/013 prioritization.

## Dependencies

- None (starting point for SWARM-012 through SWARM-020).

## Acceptance Criteria

- [ ] Funnel stages are documented and versioned (`onboarding_funnel_v1`)
- [ ] Admin API emits structured stage transition events
- [ ] Admin UI emits stage-entry/exit events (no PII leakage)
- [ ] Structured telemetry schema includes required fields and PII handling rules
- [ ] Baseline plan defines 7-day and 14-day windows with metric formulas
- [ ] Baseline report produced from staging/prod sample window
- [ ] Top 5 failure classes are identified with concrete counts
