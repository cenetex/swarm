# SWARM-006: Wire CloudWatch Alarm Actions to SNS

**Priority:** P1 — Next Sprint
**Package:** `@swarm/infra`
**Risk:** Low — additive infra change, no runtime impact

## Worker Assignment

- **Assigned Worker:** `worker-006`
- **Branch:** `feat/swarm-006`
- **Worktree:** `/Users/ratimics/develop/aws-swarm-swarm-006`
- **Core Mission:** Ensure every existing production alarm produces actionable notifications by wiring alarm actions through shared SNS infrastructure.

## Problem

CloudWatch alarms exist for queue depth, DLQ depth/age, and Lambda errors — but none have `alarmActions` configured. They fire silently with no notifications.

8 alarms in `constructs/avatar.ts` and potentially more in `constructs/shared-handlers.ts` all lack action configuration.

## Solution

1. Add an SNS topic construct to `SharedInfrastructure`
2. Wire all alarms to the SNS topic via `addAlarmAction()`
3. Add email/Slack subscription as a configurable parameter
4. Pass the SNS topic to avatar constructs via props

## Acceptance Criteria

- [ ] SNS topic created in shared infra
- [ ] All existing CloudWatch alarms have `alarmActions` pointing to SNS topic
- [ ] Email subscription configurable via CDK context or environment variable
- [ ] `cdk diff` shows only additive changes (no resource replacement)
