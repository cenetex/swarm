# Phased SharedHandlers Migration Runbook

## Overview

This runbook documents the phased approach to migrate `SharedHandlers` resources from `AdminApiStack` to a nested stack, `SharedHandlersStack`, to reduce the top-level CloudFormation resource count from **511 to ≤450**.

**Status**: Phase 1 (Foundation) in progress  
**Tracking Issue**: [#1435](https://github.com/cenetex/aws-swarm/issues/1435)  
**Key Reference**: [#1353](https://github.com/cenetex/aws-swarm/issues/1353) (original resource-count pressure), [#1427](https://github.com/cenetex/aws-swarm/pull/1427) (failed attempt), [#1434](https://github.com/cenetex/aws-swarm/issues/1434) (revert)

---

## Background: Why Phased Migration?

### The Problem

PR #1427 attempted to move all 111 SharedHandlers resources to a nested stack in a single changeset. This failed with `AlreadyExists` errors during staging deployment because:

1. CloudFormation tried to create new SQS queues in the nested stack with the same physical names (e.g., `swarm-staging-messages.fifo`)
2. Simultaneously, CloudFormation tried to delete the old queues from the parent stack
3. These named resources cannot be created and deleted in the same changeset—CloudFormation hits a conflict

### The Solution: CDK Resource Import + RemovalPolicy.RETAIN

This phased approach avoids the conflict:

1. **Phase 1** (PR #1435): Establish nested stack skeleton. No resources move yet.
2. **Phase 2** (PR #1436): Apply `RemovalPolicy.RETAIN` to first batch of resources. Deploy to staging → prod to verify retention.
3. **Phase 3** (PR #1437): Move retained resources into nested stack using CDK import. Deploy to staging → prod.
4. **Repeat** phases 2-3 for remaining resource batches (~25 resources per slice).

Each phase is independently deployable, reversible, and production-safe.

---

## Phase 1: Foundation (this PR)

**Goal**: Publish the nested-stack class and resource-count regression test so downstream phases have something to reference. **Do not instantiate anything inside the nested stack yet** — if we did, every queue / Lambda / alarm would exist twice and the stack would blow through the 500-resource limit.

**Changes**:
- Add `SharedHandlersStack` as an empty `cdk.NestedStack` skeleton (`packages/infra/src/stacks/shared-handlers-stack.ts`). Class accepts the props shape it will eventually need, but the constructor creates zero child resources.
- `AdminApiStack` is **unchanged**: it continues to instantiate `SharedHandlers` directly. No nested stack wiring.
- Add resource-count regression test (`packages/infra/test/resource-count.test.ts`) — cap at 500 (the CFN hard limit). Target ≤ 450 is the end-of-migration goal, not a Phase 1 assertion.
- Add this runbook.

**Resource Count Impact**: **0** — the skeleton is not synthesized into any Lambda / queue / alarm, so the stack template byte-for-byte matches the pre-PR template except for the (empty) nested stack record.

> **Why not instantiate SharedHandlers inside the nested stack in Phase 1?**
> A prior revision tried that. It doubled every named resource and hit `AlreadyExists` at synth/deploy time. Phase 1 must be a zero-delta foundational change; resource motion only begins in Phase 2+.

**Testing**:
```bash
pnpm build                              # TypeScript + CDK synthesis
pnpm typecheck                          # Type checking
pnpm test                               # All tests including new resource-count test
# Deploy to staging
cdk deploy SwarmApi-staging --profile staging
```

**Success Criteria**:
- ✅ Staging deployment succeeds without downtime
- ✅ Webhook paths (Telegram, Discord, Twitter) remain operational
- ✅ Resource-count test passes (all stacks ≤ 500 resources)
- ✅ No `AlreadyExists` or resource replacement errors

---

## Phase 2: RemovalPolicy.RETAIN (PR #1436+)

**Goal**: Apply `RemovalPolicy.RETAIN` to batches of named resources so they survive stack updates.

**Slice 1: SQS Queues** (~6 resources)
- `swarm-{env}-messages.fifo`
- `swarm-{env}-responses.fifo`
- `swarm-{env}-media.fifo`
- `swarm-{env}-posts.fifo`
- `swarm-{env}-dlq.fifo`
- `swarm-{env}-scheduler-dlq`

**Changes** (in `packages/infra/src/constructs/shared-handlers.ts`):

```typescript
// Add RemovalPolicy to each SQS queue
this.dlq = new sqs.Queue(this, 'DeadLetterQueue', {
  queueName: `swarm-${environment}${suffix}-dlq.fifo`,
  fifo: true,
  removalPolicy: cdk.RemovalPolicy.RETAIN,  // ← NEW
  // ... rest of config
});
```

**Deployment Order**:
1. Deploy to staging with `RemovalPolicy.RETAIN`
2. Verify queues still work (test consuming/producing messages)
3. Deploy to production with `RemovalPolicy.RETAIN`
4. Monitor for any queue-related issues

**Success Criteria**:
- ✅ Staging deploy completes without errors
- ✅ SQS queues remain operational (not recreated)
- ✅ CloudFormation drift detection finds no issues
- ✅ Production deploy completes without errors
- ✅ No message loss or queue disruption

**Repeat for Slice 2** (Lambda Functions ~40 resources), **Slice 3** (Log Groups ~12 resources), **Slice 4** (Alarms ~25 resources).

---

## Phase 3: CDK Import (PR #1437+)

**Goal**: Move retained resources from parent stack to nested stack via CDK import.

**Slice 1: SQS Queues**

### Step 1: Verify RemovalPolicy is Active (from Phase 2)

```bash
# Check CloudFormation stack in AWS Console
# All SQS queues should show DeletionPolicy: Retain in template
aws cloudformation get-template --stack-name SwarmApi-staging \
  --query 'TemplateBody' | jq '.Resources | keys[] | select(contains("Queue"))'
```

### Step 2: Remove Resource from Parent Stack Template

Edit `packages/infra/src/constructs/shared-handlers.ts`:

```typescript
// REMOVE or COMMENT OUT the queue instantiation from the direct construct
// this.dlq = new sqs.Queue(this, 'DeadLetterQueue', { ... });
// Will be created only in SharedHandlersStack (nested)
```

**Important**: Do NOT deploy yet. First, add the CDK import statement.

### Step 3: Add CDK Import Statements (in SharedHandlersStack)

Edit `packages/infra/src/stacks/shared-handlers-stack.ts`:

```typescript
// Import existing queue from the parent stack
import * as sqs from 'aws-cdk-lib/aws-sqs';

// In SharedHandlersStack constructor:
const dlq = sqs.Queue.fromQueueArn(this, 'DlqImport', 
  `arn:aws:sqs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:swarm-${environment}${suffix}-dlq.fifo`
);
```

### Step 4: Run CDK Diff and Import

```bash
# Synthesize and check what changed
cdk diff SwarmApi-staging

# Expected output:
# Resources removed from top-level
# Resources added to nested stack
```

### Step 5: Deploy to Staging

```bash
# Deploy to staging first
cdk deploy SwarmApi-staging --profile staging --require-approval never

# Watch for any AlreadyExists errors or resource replacement
```

**Success Criteria**:
- ✅ Staging deploy completes without `AlreadyExists` errors
- ✅ No resource replacement (queue names unchanged)
- ✅ Queue functionality preserved (producers/consumers still work)
- ✅ CloudFormation stack shows resources moved to nested stack

### Step 6: Deploy to Production

```bash
# Once staging is green, deploy to production
cdk deploy SwarmApi-prod --profile prod --require-approval never
```

**Success Criteria**:
- ✅ Production deploy completes successfully
- ✅ No downtime on webhook paths
- ✅ Queue depth alarms still firing correctly
- ✅ CloudFormation resource count reduced

---

## Resource Migration Schedule

| Phase | Batch | Resources | PR | Estimated Timeline |
|-------|-------|-----------|----|--------------------|
| 1 | Foundation | Nested stack scaffold | #1435 | Week 1 |
| 2 | SQS Queues | 6 queues | #1436 | Week 2 |
| 3 | SQS Queues | Move via import | #1437 | Week 2 |
| 2 | Lambdas | 13 functions | #1438 | Week 3 |
| 3 | Lambdas | Move via import | #1439 | Week 3 |
| 2 | Log Groups | 12 groups | #1440 | Week 4 |
| 3 | Log Groups | Move via import | #1441 | Week 4 |
| 2 | Alarms | 23 alarms | #1442 | Week 4 |
| 3 | Alarms | Move via import | #1443 | Week 5 |

**Final Result**: `SwarmApi-prod` reduced from **511 → ~350 resources**, maintaining a safe buffer below CloudFormation's 500-resource hard limit.

---

## Rollback Procedures

### If a Phase 2 (RemovalPolicy.RETAIN) Deploy Fails

1. Revert the PR
2. Deploy the previous version
3. No resources are affected (RemovalPolicy.RETAIN only prevents deletion)

### If a Phase 3 (Import) Deploy Fails

1. Revert the PR (resources go back to parent construct)
2. Deploy the previous version
3. Cloudformation will re-adopt the resources in the parent stack
4. Queue names and state are preserved (RemovalPolicy.RETAIN is still active)

### If Resources Are Accidentally Deleted

If a queue is accidentally deleted after RemovalPolicy.RETAIN was removed:

```bash
# Restore from DLQ backup or redrive from CloudWatch logs
# Runbook: docs/RUNBOOK.md § 3 "SQS DLQ Recovery"
```

---

## Monitoring & Alarms

During the migration, monitor these dashboards:

1. **CloudWatch Dashboard**: `Swarm/{environment}/Operations`
   - Queue depth, Lambda errors, throttles
   - Should remain unchanged during each deploy

2. **CloudFormation Console**: Stack events
   - Watch for `CREATE_IN_PROGRESS` (new nested stack)
   - Watch for resource replacement (should not occur)

3. **Webhook Ingestion**: Monitor Telegram/Discord/Twitter ingest rates
   - Should not drop during deployment

---

## Acceptance Criteria for Full Migration

- [ ] Top-level `SwarmApi-prod` resource count ≤ 450
- [ ] Zero `AlreadyExists` errors across all staging deploys
- [ ] No downtime on any webhook path during slice deploys
- [ ] All alarms still fire and notify SNS topic
- [ ] Queue depths remain low (no buildup)
- [ ] DLQ processor continues to work
- [ ] All 5 phases completed and merged to main
- [ ] Documentation updated

---

## References

- **Issue #1353**: Original resource-count pressure (511/500)
- **PR #1427**: Attempted single-shot nested stack migration (reverted)
- **Issue #1434**: Revert tracking + follow-up action
- **Stack Audit**: `docs/infra/stack-audit-2026-04-17.md` (resource breakdown)
- **CDK Import Docs**: https://docs.aws.amazon.com/cdk/v2/guide/cfn_import.html
- **CloudFormation Import**: https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/cfn-console-import-resources.html
