# Leadership Operating Scorecard

Automated weekly scorecard that drives data-informed reprioritization during triage reviews.

## Purpose

The scorecard collects reliability, delivery, queue health, and CI/CD quality metrics and compares them against defined thresholds. When thresholds are breached, explicit reprioritization recommendations are generated. The scorecard is a **required input** for the weekly triage review (see [ISSUE-GOVERNANCE.md](./ISSUE-GOVERNANCE.md)).

## Workflow

- **Workflow:** `.github/workflows/leadership-scorecard.yml`
- **Schedule:** Every Monday at 08:00 UTC (1 hour before ticket health report)
- **Manual run:** `workflow_dispatch` with optional `environment` input
- **Artifacts:** Markdown + JSON uploaded with 90-day retention

## Metrics

### 1. Delivery Throughput

| Metric | Source | Comparison |
|--------|--------|------------|
| PRs merged | GitHub API | Current vs prior 7-day period |
| Issues closed | GitHub API | Current vs prior 7-day period |
| Open PRs | GitHub API | Snapshot |
| Stale PRs (>7d) | GitHub API | Count |

### 2. Queue Health (Issue Backlog)

| Metric | Source | Threshold |
|--------|--------|-----------|
| Total open issues | GitHub API | -- |
| Unassigned high-priority | GitHub API | 0 (any triggers recommendation) |
| Missing type/priority labels | GitHub API | -- |
| Blocked issues | GitHub API | -- |
| In-progress issues | GitHub API | -- |
| Stale issues (>30d) | GitHub API | >25% of open issues |
| Priority distribution | GitHub API | -- |

### 3. Reliability (CloudWatch)

These metrics require AWS credentials via OIDC. When credentials are unavailable, the section is marked as skipped.

| Metric | Source | Threshold |
|--------|--------|-----------|
| Lambda error rate (MessageProcessor) | CloudWatch `AWS/Lambda` | >5% |
| DLQ messages (max over period) | CloudWatch `AWS/SQS` | >0 |
| Queue depth (max over period) | CloudWatch `AWS/SQS` | >10 |
| MessageProcessor P99 latency | CloudWatch `AWS/Lambda` | >30,000ms |
| Active alarms | CloudWatch Alarms | >0 |

### 4. CI/CD Quality

| Metric | Source | Threshold |
|--------|--------|-----------|
| CI runs | GitHub Actions API | -- |
| CI failure rate | GitHub Actions API | >20% |
| Deploy count | GitHub Actions API | -- |
| Deploy failures | GitHub Actions API | -- |

## Thresholds and Recommendations

When a metric breaches its threshold, the scorecard generates a specific recommendation. Recommendations include:

- **Category prefix** (RELIABILITY, DELIVERY, QUEUE HEALTH, QUALITY) for quick scanning
- **Observed value** and **threshold** for context
- **Action reference** pointing to the relevant runbook or governance doc

### Health Grade

The overall health grade is derived from recommendation count:

| Grade | Criteria |
|-------|----------|
| GREEN | No threshold breaches |
| YELLOW | 1-2 threshold breaches |
| RED | 3+ threshold breaches |

## Triage Integration

The scorecard is designed to feed directly into the weekly triage cadence described in [ISSUE-GOVERNANCE.md](./ISSUE-GOVERNANCE.md):

1. **Before triage:** Review the scorecard markdown (posted to Actions step summary or downloaded as artifact).
2. **During triage:** Use the recommendations section to drive reprioritization discussion.
3. **Priority adjustments:** If the scorecard recommends reprioritization, validate the recommendation against the priority criteria in ISSUE-GOVERNANCE.md before changing labels.
4. **After triage:** Record any priority changes as comments on affected issues with a reference to the scorecard run.

### Weekly Triage Checklist (Scorecard Additions)

Add these steps to the existing triage process:

- [ ] Download or review the latest leadership scorecard from GitHub Actions artifacts
- [ ] Check the health grade -- RED requires immediate attention
- [ ] Review each recommendation and decide: act now, defer, or dismiss with rationale
- [ ] For RELIABILITY recommendations: cross-reference with [MONITORING-OPERATOR-GUIDE.md](./MONITORING-OPERATOR-GUIDE.md) and [RUNBOOK.md](./RUNBOOK.md)
- [ ] For QUEUE HEALTH recommendations: apply the aging policy from [ISSUE-GOVERNANCE.md](./ISSUE-GOVERNANCE.md)
- [ ] For DELIVERY recommendations: review stale PRs and reassign or close
- [ ] For QUALITY recommendations: create issues for CI fixes or assign to coding agents

## Data Model

The JSON artifact follows this schema:

```json
{
  "generated_at": "ISO 8601 timestamp",
  "period": "7d",
  "current_period_start": "ISO 8601",
  "prior_period_start": "ISO 8601",
  "environment": "production",
  "health_grade": "GREEN | YELLOW | RED",
  "delivery": {
    "prs_merged": { "current": 0, "prior": 0 },
    "open_prs": 0,
    "stale_prs": 0,
    "issues_closed": { "current": 0, "prior": 0 }
  },
  "queue_health": {
    "total_open_issues": 0,
    "unassigned_high_priority": 0,
    "missing_labels": 0,
    "blocked": 0,
    "in_progress": 0,
    "stale_issues_over_30d": 0,
    "stale_pct": 0,
    "priority_distribution": [{ "label": "priority:high", "count": 0 }]
  },
  "reliability": {
    "cloudwatch_available": true,
    "lambda_error_rate_pct": "0.0",
    "dlq_messages_max": "0",
    "queue_depth_max": "0",
    "processor_p99_ms": "0",
    "alarms_in_alarm": "0"
  },
  "ci_cd_quality": {
    "ci_runs": 0,
    "ci_failures": 0,
    "ci_failure_rate_pct": 0,
    "deploys": 0,
    "deploy_failures": 0
  },
  "recommendations": {
    "count": 0,
    "items": []
  }
}
```

## IAM Requirements

The workflow role (`AWS_ROLE_ARN`) needs read-only CloudWatch access:

- `cloudwatch:GetMetricStatistics`
- `cloudwatch:DescribeAlarms`

These are typically included in `CloudWatchReadOnlyAccess`. If AWS credentials are not available (e.g., OIDC not configured), the reliability section is skipped gracefully.

## Cross-References

| Topic | Location |
|-------|----------|
| Triage process and priority criteria | [ISSUE-GOVERNANCE.md](./ISSUE-GOVERNANCE.md) |
| Ticket health report (complementary) | `.github/workflows/ticket-health.yml` |
| Operational monitoring | [MONITORING-OPERATOR-GUIDE.md](./MONITORING-OPERATOR-GUIDE.md) |
| Incident response | [RUNBOOK.md](./RUNBOOK.md) |
| Cost controls | [COST-CONTROLS-PLAYBOOK.md](./COST-CONTROLS-PLAYBOOK.md) |
| Cost & activity reports | [OPERATIONS-REPORTS.md](./OPERATIONS-REPORTS.md) |
| Scorecard script | `scripts/leadership-scorecard.sh` |
| Scorecard workflow | `.github/workflows/leadership-scorecard.yml` |
