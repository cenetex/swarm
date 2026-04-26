# Handler Deployment Audit (#1519)

## Overview

This document traces how handler Lambda function names are determined by the CDK infrastructure code, focusing on why the `-split` suffix exists and how it prevents naming collisions.

## Key Files

- **`packages/infra/bin/swarm.ts`** (lines 145-157) — Suffix strategy logic
- **`packages/infra/src/stacks/admin-api-stack.ts`** (line 344) — SharedHandlers instantiation
- **`packages/infra/src/constructs/shared-handlers.ts`** (lines 571-599) — EventBridge-scheduled handlers

## Function Naming Logic

### Prod/Staging with `useExistingResources=true` (current production mode)

```typescript
// packages/infra/bin/swarm.ts:149
const nonSharedResourceSuffix = (useExistingResources && !nameSuffix) ? '-split' : nameSuffix;
```

When deploying to production/staging with existing shared infrastructure:

- `useExistingResources = true` → indicates prod/staging (reusing legacy monolith's DynamoDB tables, S3 buckets, etc.)
- `nameSuffix` is *empty* (no hash-based suffix)
- Result: `nonSharedResourceSuffix = '-split'`

This suffix is passed to `AdminApiStack`:

```typescript
// packages/infra/bin/swarm.ts:207
const adminApiStack = new AdminApiStack(app, `SwarmApi-${environment}${nameSuffix}`, {
  environment,
  nameSuffix: nonSharedResourceSuffix,  // ← This is '-split' in prod
  // ...
});
```

### Handler Resource Naming

Handlers are created with the `nameSuffix`:

```typescript
// packages/infra/src/constructs/shared-handlers.ts:571-572
const twitterMentionPoller = new nodejs.NodejsFunction(this, 'TwitterMentionPollerShared', {
  functionName: `swarm-${environment}${suffix}-twitter-mention-poller`,
  // ...
});
```

With `environment='prod'` and `suffix='-split'`:

```
functionName = 'swarm-prod-split-twitter-mention-poller'
```

### All Scheduled Handlers

| Handler | Construct ID | Entry Point | Function Name (prod) |
|---------|--------------|-------------|----------------------|
| Twitter Poller | `TwitterMentionPollerShared` | `twitter/twitter-mention-poller-shared.ts` | `swarm-prod-split-twitter-mention-poller` |
| Autonomous Tweets | `AutonomousTweetPoster` | `twitter/autonomous-tweet-poster.ts` | `swarm-prod-split-autonomous-tweet-poster` |
| Platform Heartbeat | `PlatformHeartbeat` | `social/platform-heartbeat.ts` | `swarm-prod-split-platform-heartbeat` |
| Station Agent | `StationAgentRunner` | `station/station-agent-runner.ts` | `swarm-prod-split-station-agent-runner` |
| DLQ Processor | `DlqProcessor` | `dlq-processor.ts` | `swarm-prod-split-dlq-processor` |

### EventBridge Rules

All scheduled handlers have EventBridge rules:

```typescript
// packages/infra/src/constructs/shared-handlers.ts
const twitterMentionPollRule = new events.Rule(this, 'TwitterMentionPollSchedule', {
  schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
  targets: [new targets.LambdaFunction(twitterMentionPoller, { ... })],
});

const autonomousTweetRule = new events.Rule(this, 'AutonomousTweetSchedule', {
  schedule: events.Schedule.rate(cdk.Duration.hours(1)),
  targets: [new targets.LambdaFunction(autonomousTweetPoster, { ... })],
});

const platformHeartbeatRule = new events.Rule(this, 'PlatformHeartbeatSchedule', {
  schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
  targets: [new targets.LambdaFunction(this.platformHeartbeat, { ... })],
});

const dlqProcessorRule = new events.Rule(this, 'DlqProcessorSchedule', {
  schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
  targets: [new targets.LambdaFunction(this.dlqProcessor, { ... })],
});

new events.Rule(this, 'StationAgentSchedule', {
  schedule: events.Schedule.rate(cdk.Duration.hours(1)),
  targets: [new targets.LambdaFunction(stationAgentRunner, { ... })],
});
```

**Each rule correctly targets the `-split` version in production.**

## Why Legacy Lambdas (Non-Split) Exist

The legacy `swarm-prod-X` Lambdas (without `-split` suffix) are orphaned from the failed nested-stack migration:

1. **PR #1427**: Attempted to create `-split` versions alongside the original stack
2. Both versions were deployed for a brief window
3. **PR #1434**: The nested-stack migration was reverted, but:
   - Original non-split Lambdas were NOT deleted (**orphaned**)
   - EventBridge rules targeting them were NOT disabled (**active drift**)
   - New CDK code continued deploying only the `-split` versions

**Result**: Duplicate execution of the same workload with 2× cost.

## Verification

### CDK Current Behavior (Correct ✓)

In production, CDK currently deploys ONLY the `-split` versions:

```bash
# Simulate CDK synthesis to verify function names
pnpm run -s cdk synth SwarmApi-prod -c environment=prod -c useExistingResources=true 2>/dev/null | \
  jq '.Resources | keys[] | select(contains("Lambda")) | select(contains("twitter|autonomous|heartbeat|station|dlq"))'

# Expected output: All function names contain "split"
# - TwitterMentionPollerSharedXXXXXX
# - AutonomousTweetPosterXXXXXX
# - etc.
```

### AWS Actual State (Incorrect ✗ — Issue #1519)

In AWS, both versions are currently running:

```bash
# List all Lambda functions matching the handlers
aws lambda list-functions --region us-east-1 --profile prod \
  --query "Functions[?contains(FunctionName, 'mention-poller') || contains(FunctionName, 'autonomous-tweet') || contains(FunctionName, 'platform-heartbeat') || contains(FunctionName, 'station-agent') || contains(FunctionName, 'dlq-processor')] | [].[FunctionName, CodeSize, LastModified]" \
  --output table

# Expected:
# | FunctionName                              | CodeSize | LastModified              |
# |-------------------------------------------|----------|---------------------------|
# | swarm-prod-split-twitter-mention-poller   | 15000000 | 2026-04-24T09:00:00+00:00 |
# | swarm-prod-twitter-mention-poller         | 25000000 | 2026-04-20T14:00:00+00:00 | ← ORPHANED (old)
# | swarm-prod-split-autonomous-tweet-poster  | 12000000 | 2026-04-24T09:00:00+00:00 |
# | swarm-prod-autonomous-tweet-poster        | 22000000 | 2026-04-20T14:00:00+00:00 | ← ORPHANED (old)
```

## Export Verification

Handler exports in `packages/handlers/src/index.ts` are imported correctly by the CDK:

```typescript
export { handler as twitterMentionPollerShared } from './twitter/twitter-mention-poller-shared.js';
export { handler as autonomousTweetPoster } from './twitter/autonomous-tweet-poster.js';
// etc.
```

The CDK correctly bundles these entries and creates the Lambda functions. **No code changes are needed in handlers or infra.**

## Conclusion

**CDK Code**: ✓ Correct — Already deploying only `-split` versions in production  
**AWS State**: ✗ Incorrect — Orphaned non-split Lambdas still have active EventBridge rules

**Fix Required**: Manual AWS cleanup per `docs/infra/LEGACY-LAMBDA-CLEANUP-1519.md`

**No Code Changes**: This is purely an AWS infrastructure cleanup, not a code issue.
