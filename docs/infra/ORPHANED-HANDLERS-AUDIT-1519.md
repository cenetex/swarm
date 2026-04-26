# Orphaned Handler Audit — Issue #1519

**Quick Reference** for identifying and cleaning up duplicate EventBridge-scheduled Lambda handlers from failed migration PR #1427.

---

## Problem Statement

Two identical EventBridge rules invoke scheduled Lambda handlers:
- **Authoritative**: `swarm-prod-{handler}` (defined in CDK, non-split)
- **Orphaned**: `swarm-prod-split-{handler}` (orphaned AWS infrastructure, from failed migration)

Result: **2× invocations, 2× API hits, 2× cost** for no functional benefit.

---

## Quick Audit Checklist

### ✅ Authoritative Handlers (from CDK `packages/infra/src/constructs/shared-handlers.ts`)

```typescript
// Line 574-587: twitter-mention-poller
const twitterMentionPoller = new nodejs.NodejsFunction(this, 'TwitterMentionPollerShared', {
  functionName: `swarm-${environment}${suffix}-twitter-mention-poller`,
  // ... scheduled every 1 minute (Line 595-602)
});

// Line 606-628: autonomous-tweet-poster
const autonomousTweetPoster = new nodejs.NodejsFunction(this, 'AutonomousTweetPoster', {
  functionName: `swarm-${environment}${suffix}-autonomous-tweet-poster`,
  // ... scheduled every 1 hour (Line 621-628)
});

// Line 632-654: platform-heartbeat
this.platformHeartbeat = new nodejs.NodejsFunction(this, 'PlatformHeartbeat', {
  functionName: `swarm-${environment}${suffix}-platform-heartbeat`,
  // ... scheduled every 15 minutes (Line 647-654)
});

// Line 657-680: station-agent-runner
const stationAgentRunner = new nodejs.NodejsFunction(this, 'StationAgentRunner', {
  functionName: `swarm-${environment}${suffix}-station-agent-runner`,
  // ... scheduled every 1 hour (Line 673-680)
});

// Line 713-754: dlq-processor
this.dlqProcessor = new nodejs.NodejsFunction(this, 'DlqProcessor', {
  functionName: `swarm-${environment}${suffix}-dlq-processor`,
  // ... scheduled every 15 minutes (Line 747-754)
});
```

### ⚠️ Orphaned Handlers (AWS prod, not in CDK)

These should **NOT** exist or should be disabled:

```
swarm-prod-split-twitter-mention-poller     → DELETE EventBridge rule
swarm-prod-split-autonomous-tweet-poster    → DELETE EventBridge rule
swarm-prod-split-platform-heartbeat         → DELETE EventBridge rule
swarm-prod-split-station-agent-runner       → DELETE EventBridge rule
swarm-prod-split-dlq-processor              → DELETE EventBridge rule
```

---

## AWS Console Steps (Prod Account: 332730082708)

### 1. Confirm Orphaned Rules Exist

```
AWS Console → EventBridge → Rules
Search: "swarm-prod-split"
Result: Should see 5 rules targeting split-* Lambdas
```

### 2. Disable Each Rule (One-by-One, Test After Each)

```
Rule: swarm-prod-split-twitter-mention-poller
├─ Click "Disable" (top of rule detail page)
├─ Wait 5 minutes
├─ Check CloudWatch: no new invocations on the split Lambda
└─ If OK, proceed to next rule
```

### 3. Monitor CloudWatch During Disabling

```bash
# For each rule being disabled, watch:
aws cloudwatch get-metric-statistics \
  --namespace AWS/Lambda \
  --metric-name Invocations \
  --dimensions Name=FunctionName,Value=swarm-prod-split-twitter-mention-poller \
  --start-time $(date -u -d '10 minutes ago' +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 60 \
  --statistics Sum \
  --profile prod
# After disable: metric should drop to zero
```

### 4. Delete Disabled Rules (After 24h Observation)

```
EventBridge → Rules
Search: "swarm-prod-split"
For each disabled rule:
  ├─ Right-click → Delete
  ├─ Confirm deletion
  └─ Done
```

### 5. Verify Authoritative Rules Still Active

```bash
aws events list-rules --profile prod | jq '.Rules[] | select(.Name | startswith("swarm-prod-")) | {Name, State}'
# Should show 5 rules with State: ENABLED (not split variants)
```

---

## Handler Comparison Matrix

| Handler | Authoritative Name | Schedule | EventBridge Rule | CDK Line | Orphaned Variant | Status |
|---------|-------------------|----------|------------------|----------|------------------|--------|
| Twitter Poller | `swarm-prod-twitter-mention-poller` | 1 min | `TwitterMentionPollSchedule` | 574-602 | `swarm-prod-split-*` | ⚠️ Orphaned |
| Tweet Poster | `swarm-prod-autonomous-tweet-poster` | 1 hr | `AutonomousTweetSchedule` | 606-628 | `swarm-prod-split-*` | ⚠️ Orphaned |
| Heartbeat | `swarm-prod-platform-heartbeat` | 15 min | `PlatformHeartbeatSchedule` | 632-654 | `swarm-prod-split-*` | ⚠️ Orphaned |
| Agent Runner | `swarm-prod-station-agent-runner` | 1 hr | `StationAgentSchedule` | 657-680 | `swarm-prod-split-*` | ⚠️ Orphaned |
| DLQ Processor | `swarm-prod-dlq-processor` | 15 min | `DlqProcessorSchedule` | 713-754 | `swarm-prod-split-*` | ⚠️ Orphaned |

---

## Cost Recovery

**Deleted rules save**:
- Lambda invocations: ~5K/day duplicate invocations → **$0.30/month**
- Twitter API read quota: 50% recovery (~10K reads/month)
- CloudWatch logs: Not significant (~1 MB/day)

**Timeline**: 3 minutes to disable, 24 hours to observe, then delete.

---

## Rollback Plan

If deleting orphaned rules causes issues:

1. Go back to EventBridge Console
2. Re-create the rules with same schedules and targets
3. Verify double-invocations resume
4. Post issue in Slack #oncall

---

## References

- **Full Cleanup Guide**: `docs/infra/LEGACY-HANDLER-CLEANUP-1519.md`
- **Migration Background**: `docs/infra/PHASED-MIGRATION-RUNBOOK.md`
- **CDK Source**: `packages/infra/src/constructs/shared-handlers.ts` (lines 574-754)
- **Issue**: #1519
