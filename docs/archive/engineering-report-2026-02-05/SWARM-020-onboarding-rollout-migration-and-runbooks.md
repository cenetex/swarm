# SWARM-020: Onboarding Rollout, Migration, and Runbooks

**Priority:** P1 - Next Sprint
**Package:** Docs, `@swarm/admin-api`, `@swarm/admin-ui`, Ops
**Risk:** Medium - rollout quality determines user impact

## Worker Assignment

- **Assigned Worker:** `worker-020` (active)
- **Branch:** `feat/swarm-020`
- **Worktree:** `/Users/ratimics/develop/aws-swarm-swarm-020` (provisioned)
- **Current Lane Status:** `integrated on mainline (validation pass)` (rollout decision service and cohort-based onboarding routing promoted into avatar creation flow)
- **Core Mission:** Ship onboarding overhaul safely with staged rollout controls, support playbooks, and clear rollback paths.

## Problem

Even a strong onboarding redesign can cause incidents if rollout, migration, and support handling are not explicitly engineered.

## Solution

1. Ship onboarding v2 behind explicit feature flags with deterministic cohort assignment.
2. Gate each rollout phase on SWARM-019 stability checks and live health thresholds.
3. Provide migration/rollback procedures that preserve session continuity and fast fallback to legacy onboarding.
4. Publish support/incident runbook outline with concrete triage and mitigation flow.
5. Produce post-rollout comparison report against SWARM-011 baseline metrics.

## Dependencies

- SWARM-011 through SWARM-019 completion at review level.

## Rollout Preconditions (SWARM-019 Aligned)

Before Phase 0 starts, all of the following are required:

1. SWARM-019 onboarding stability suite is a required CI check and passing on `main`.
2. Green coverage for:
   - wallet-first onboarding end-to-end
   - email-first onboarding end-to-end
   - Telegram failure/retry recovery path
   - auth/session interruption with resume verification
3. Test artifacts expose failing step and root-cause details for support handoff.
4. SWARM-011 baseline dashboard and query presets are available for completion rate, median setup time, and top failure classes.
5. Rollback toggles (`onboarding.v2.forceLegacy`, `onboarding.v2.rolloutPercent=0`) are validated in staging.

No phase promotion is allowed while any SWARM-019 required check is red.

## Phased Rollout Cohorts

Rollout unit: **new onboarding attempts only**. Cohort assignment must be sticky for the life of an onboarding attempt.

| Phase | Cohort | Exposure Target | Minimum Duration | Entry Gate | Promotion Gate |
|------|--------|-----------------|------------------|------------|----------------|
| 0 | Internal dogfood (engineering + support test avatars) | 0% external traffic | 1 business day | Preconditions complete | No Sev-1/Sev-2 onboarding incidents, SWARM-019 suite green |
| 1 | Canary allowlist avatars | 5% of new attempts (allowlist + hash) | 2 days | Phase 0 stable | Completion rate within 3 percentage points of SWARM-011 baseline; no hard rollback trigger |
| 2 | Limited public cohort | 25% of new attempts (hash based) | 3-5 days | Phase 1 stable | Completion rate within 2 percentage points of baseline; median setup time within +15% of baseline |
| 3 | Broad public cohort | 50% then 100% (two-step ramp) | 2 days at 50% before 100% | Phase 2 stable | Metrics at/above target for 48h and SWARM-019 suite remains green |

Cohort rules:

1. Assignment key is deterministic (`hash(userId + avatarId) % 100`) to prevent flip-flop behavior.
2. In-flight onboarding attempts stay pinned to assigned version (`v1` or `v2`) until completion/abandonment.
3. Support may force a single avatar or account to legacy mode without changing global rollout percentage.

## Feature-Flag Controls

| Flag | Type | Default | Scope | Purpose |
|------|------|---------|-------|---------|
| `onboarding.v2.enabled` | boolean | `false` | global | Master gate for onboarding v2 code path |
| `onboarding.v2.rolloutPercent` | integer `0..100` | `0` | global | Percentage-based cohort exposure for new attempts |
| `onboarding.v2.avatarAllowlist` | string[] | `[]` | avatar | Canary allowlist for early phases |
| `onboarding.v2.forceLegacy` | boolean | `false` | global | Immediate kill switch routing all new attempts to v1 |
| `onboarding.v2.accountOverrides` | map | `{}` | account | Support override for targeted mitigation |
| `onboarding.v2.readinessGateStrict` | boolean | `true` | global | Keeps SWARM-017 activation readiness enforcement unchanged in v2 |
| `onboarding.v2.shadowMetrics` | boolean | `true` | global | Emits parallel metrics/logs for v1 vs v2 comparison |

Flag control policy:

1. `forceLegacy=true` takes precedence over all other flags.
2. Rollout changes are performed by runbook operator only, logged with incident/change ID.
3. Percentage increases are limited to one phase boundary at a time (no direct jump from 5% to 100%).

## Migration Plan (Onboarding Session Safety)

1. Add explicit session version field (`onboardingVersion: v1 | v2`) at onboarding-attempt creation.
2. Keep existing in-progress `v1` sessions on legacy flow; do not auto-migrate mid-session.
3. Start `v2` assignment only for new attempts after flag enablement.
4. Maintain dual-read support for analytics during rollout (`onboarding_funnel_v1` baseline mapping + v2 tags).
5. After Phase 3 stabilizes, archive legacy-only fields behind a scheduled cleanup plan (separate ticket).

## Rollback Triggers and Procedures

### Hard Rollback Triggers (Immediate)

Trigger hard rollback to legacy onboarding if any condition is met:

1. SWARM-019 required CI stability check fails on `main` for two consecutive runs.
2. Onboarding API `5xx` error rate exceeds 2% for 10 consecutive minutes.
3. Sev-1 onboarding incident declared, or two Sev-2 incidents within 1 hour attributable to v2.
4. Auth/session resume failure rate exceeds 1% of attempts for 30 minutes.

### Soft Rollback / Rollout Freeze Triggers

Freeze phase promotion and revert to previous phase percentage if any condition is met:

1. Completion rate degrades by more than 3 percentage points vs SWARM-011 baseline for 60 minutes.
2. Median setup time increases by more than 20% vs baseline for 60 minutes.
3. Any top-5 SWARM-011 failure class doubles in rate for two consecutive 30-minute windows.

### Rollback Procedure

1. Set `onboarding.v2.forceLegacy=true`.
2. Set `onboarding.v2.rolloutPercent=0`.
3. Confirm new attempts route to `v1`; keep existing `v2` sessions resumable for support-guided completion.
4. Announce incident status in support channel with trigger and impacted cohort.
5. Capture timeline, flag snapshot, and failing SWARM-019 artifact links in incident record.
6. Require coordinator sign-off before re-entering Phase 0.

## Support/Incident Runbook Outline (Onboarding Failures)

### 1. Detection

1. Alert sources: onboarding error-rate alarm, completion-rate anomaly, SWARM-019 check failures, support ticket spikes.
2. Auto-capture: current flag values, cohort percentage, deployment SHA, affected avatar IDs.

### 2. Triage

1. Classify severity (`Sev-1`, `Sev-2`, `Sev-3`) and incident commander.
2. Determine blast radius: single avatar, cohort slice, or global.
3. Identify failure class (`auth`, `telegram`, `dependency`, `validation`, `state-resume`).

### 3. Diagnostics

1. Query consolidated logs endpoint:
   - `GET /avatars/{avatarId}/logs?since=30m&level=ERROR&subsystem=chat`
   - `GET /avatars/{avatarId}/logs?since=30m&query=onboarding`
2. Validate onboarding step and error class from structured logs (`event`, `avatarId`, `requestId`).
3. Cross-check latest SWARM-019 artifact for matching failing step/root cause.

### 4. Mitigation

1. Apply account/avatar override for isolated failures.
2. Freeze rollout or execute hard rollback for cohort/global failures.
3. Guide affected users through retry/resume path or temporary legacy fallback.

### 5. Communication

1. Post status update every 30 minutes until mitigation complete.
2. Provide support macro with current workaround and ETA.
3. Notify coordinator when rollback is activated or reverted.

### 6. Closure

1. Confirm recovery metrics remain stable for 24 hours.
2. File post-incident summary with root cause, trigger, mitigation, and follow-up owner.
3. Add/adjust SWARM-019 regression test for the escaped failure mode.

## Post-Rollout Comparison Plan (vs SWARM-011 Baseline)

### Comparison Window

1. Baseline reference: SWARM-011 reported sample window (`onboarding_funnel_v1`).
2. Evaluation windows: Phase 1 day-2, Phase 2 day-3+, Phase 3 day-2 and day-7 checkpoints.
3. Compare like-for-like segments: same avatar class, auth path (wallet/email), and traffic period.

### Metrics and Decision Thresholds

| Metric | Baseline Source (SWARM-011) | Target at GA |
|------|-------------------------------|--------------|
| Funnel completion rate | onboarding completion ratio | Not below baseline; target +2 percentage points |
| Median time to activate | setup duration median | <= baseline +10% |
| Top-5 failure classes | ranked by count | No class >1.25x baseline rate |
| Resume success rate | interruption/recovery events | >= 99% |
| Support contact rate per 100 attempts | support incident tagging | <= baseline |

### Reporting Deliverables

1. Publish phased rollout report with baseline vs v2 deltas and confidence notes.
2. Include metric slices by wallet-first and email-first paths (SWARM-019 parity).
3. Document regression list, mitigation taken, and go-forward recommendation:
   - advance
   - hold
   - rollback
4. Share report links in coordination checkpoint before marking SWARM-020 complete.

## Acceptance Criteria

- [ ] Phased rollout cohorts are defined with explicit entry/promotion gates
- [ ] Feature flags and override controls are documented with precedence rules
- [ ] Rollback triggers and hard/soft rollback procedures are documented and staging-validated
- [ ] Support/incident runbook outline covers detection, triage, diagnostics, mitigation, communication, and closure
- [ ] Phase promotion requires SWARM-019 required checks to remain green
- [ ] Post-rollout report plan compares v2 against SWARM-011 baseline metrics by auth-path segment
