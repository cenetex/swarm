# Leadership Operating Scorecard

> **Owner**: Leadership
> **Last reviewed**: 2026-02-23
> **Status**: Active -- metric set is stable (see [Metric Stability](#metric-stability))
> **Related**: [STRATEGY-OPERATIONS.md](./STRATEGY-OPERATIONS.md) | [ISSUE-GOVERNANCE.md](./ISSUE-GOVERNANCE.md)

Automated weekly scorecard that drives data-informed reprioritization during triage reviews.

## Purpose

The scorecard collects reliability, delivery, queue health, and CI/CD quality metrics and compares them against defined thresholds. When thresholds are breached, explicit reprioritization recommendations are generated. The scorecard is a **required input** for the weekly triage review (see [ISSUE-GOVERNANCE.md](./ISSUE-GOVERNANCE.md)).

The scorecard answers three questions each week:

1. **Is the platform reliable?** (Reliability metrics)
2. **Is the team delivering?** (Delivery and DORA-aligned metrics)
3. **Is the product working for users?** (Product/runtime quality metrics)

When the answer to any question is "no," the reprioritization triggers in this document prescribe specific actions.

## Review Cadence and Ownership

| Activity | When | Owner | Authority |
|----------|------|-------|-----------|
| Scorecard generation | Monday 08:00 UTC (automated) | CI | N/A |
| Scorecard review and triage | Monday triage meeting | Leadership | Reprioritize issues, reassign work, create incidents |
| Threshold tuning | Quarterly (Jan, Apr, Jul, Oct) | Leadership | Adjust thresholds based on trailing 12-week trend |
| Metric set review | Quarterly or after architecture change | Leadership | Add, remove, or modify metrics (see [Metric Stability](#metric-stability)) |
| Ad-hoc review | On any production incident | On-call + Leadership | Escalate to RED if warranted |

**Accountability**: Leadership is responsible for reviewing the scorecard every week. If triage is skipped, the scorecard must still be reviewed asynchronously and any RED-grade recommendations acted on within 24 hours.

## Workflow

- **Workflow:** `.github/workflows/leadership-scorecard.yml`
- **Schedule:** Every Monday at 08:00 UTC (1 hour before ticket health report)
- **Manual run:** `workflow_dispatch` with optional `environment` input
- **Artifacts:** Markdown + JSON uploaded with 90-day retention

---

## Metric Categories

The scorecard is organized into four categories. Each category maps to a strategic question. All metrics, thresholds, and the actions triggered by threshold breaches are defined below.

### 1. Reliability Metrics

**Question**: Is the platform reliable enough to support users and growth?

These metrics require AWS credentials via OIDC. When credentials are unavailable, the section is marked as skipped.

| ID | Metric | Source | Threshold | Severity |
|----|--------|--------|-----------|----------|
| R1 | Lambda error rate (MessageProcessor) | CloudWatch `AWS/Lambda` Errors/Invocations | >5% | Critical |
| R2 | DLQ messages (max over period) | CloudWatch `AWS/SQS` ApproximateNumberOfMessagesVisible | >0 | Critical |
| R3 | Queue depth (max over period) | CloudWatch `AWS/SQS` ApproximateNumberOfMessagesVisible | >10 | Warning |
| R4 | MessageProcessor P99 latency | CloudWatch `AWS/Lambda` Duration p99 | >30,000ms | Warning |
| R5 | Active CloudWatch alarms | CloudWatch DescribeAlarms (ALARM state) | >0 | Critical |
| R6 | Incident count (trailing 7d) | GitHub issues `type:bug` + `priority:high` closed in period | Tracked (no threshold) | Informational |
| R7 | Mean time to recover (MTTR) | Time from `priority:high` `type:bug` creation to close | Tracked (no threshold) | Informational |

**R6 and R7** are derived metrics computed from GitHub issue timestamps. They are not yet automated in `leadership-scorecard.sh` but are tracked manually during triage until automation is added. These metrics establish a baseline -- thresholds will be set once 8 weeks of data are collected.

#### Reliability metric definitions

- **Lambda error rate**: Percentage of MessageProcessor Lambda invocations that result in errors over the 7-day period. Includes both handled and unhandled errors. A rate above 5% indicates systemic failure, not transient issues.
- **DLQ messages**: Maximum number of messages visible in any dead-letter queue during the period. Any non-zero value means messages failed processing and need manual recovery.
- **Queue depth**: Maximum number of messages visible in the main processing queue during the period. Sustained depth above 10 indicates the consumer cannot keep up with inbound traffic.
- **P99 latency**: The 99th percentile duration of the MessageProcessor Lambda. Values above 30 seconds suggest slow upstream API calls (AI providers, DynamoDB) or resource exhaustion.
- **Active alarms**: Count of CloudWatch alarms in ALARM state at scorecard generation time. Any active alarm requires investigation.
- **Incident count**: Number of production incidents (high-priority bugs) opened and resolved in the trailing 7 days. Trend indicates platform stability trajectory.
- **MTTR**: Average elapsed time from incident creation to resolution. Measures team responsiveness. Lower is better; no fixed target pre-scale.

### 2. Delivery Metrics (DORA-aligned)

**Question**: Is the team delivering value at a sustainable pace?

| ID | Metric | Source | Threshold | Severity |
|----|--------|--------|-----------|----------|
| D1 | PRs merged (throughput) | GitHub API | Current vs prior 7-day period | Informational |
| D2 | Issues closed (throughput) | GitHub API | Current vs prior 7-day period | Informational |
| D3 | Open PRs | GitHub API | Snapshot | Informational |
| D4 | Stale PRs (>7d without merge) | GitHub API | >3 triggers recommendation | Warning |
| D5 | Lead time for changes | GitHub API (PR created-to-merged) | Tracked (no threshold) | Informational |
| D6 | Change failure rate | GitHub Actions deploy failures / total deploys | Tracked (no threshold) | Informational |
| D7 | Deploy frequency | GitHub Actions deploy workflow runs | Tracked (no threshold) | Informational |

**D5, D6, and D7** are DORA metrics. D6 and D7 are partially captured by the existing CI/CD Quality section (deploy count, deploy failures). D5 (lead time) is derived from PR metadata and tracked manually during triage until automation is added.

#### Delivery metric definitions

- **PRs merged / Issues closed**: Raw throughput over a 7-day rolling window, compared week-over-week. A sustained decline (>2 consecutive weeks of lower throughput) signals delivery friction.
- **Stale PRs**: Open PRs with no activity for more than 7 days. Stale PRs indicate review bottlenecks or abandoned work.
- **Lead time for changes**: Median time from first commit on a branch to PR merge. Shorter lead times indicate a healthy CI/CD pipeline and review process.
- **Change failure rate**: Percentage of deployments that result in a rollback, hotfix, or incident. Derived from deploy workflow failures and post-deploy incident correlation.
- **Deploy frequency**: Number of production deployments in the period. Higher frequency (with low change failure rate) indicates mature delivery practices.

### 3. Product / Runtime Quality Metrics

**Question**: Is the product working well for users?

| ID | Metric | Source | Threshold | Severity |
|----|--------|--------|-----------|----------|
| Q1 | CI failure rate | GitHub Actions API (ci.yml) | >20% | Warning |
| Q2 | CI failure rate (severe) | GitHub Actions API (ci.yml) | >50% | Critical |
| Q3 | Deploy count | GitHub Actions API (deploy.yml) | Tracked (no threshold) | Informational |
| Q4 | Deploy failures | GitHub Actions API (deploy.yml) | >0 in period | Warning |
| Q5 | DLQ rate (messages failed / total processed) | CloudWatch DLQ visible / Lambda invocations | >1% | Warning |
| Q6 | Chat success rate | CloudWatch Lambda errors inverse | Tracked (no threshold) | Informational |

**Q5** is derived from existing R1 and R2 data (DLQ messages relative to total Lambda invocations). **Q6** is the inverse of the Lambda error rate, expressed as a percentage of messages successfully processed end-to-end. Both are computed from existing data points and do not require new data sources.

#### Product quality metric definitions

- **CI failure rate**: Percentage of CI workflow runs that fail in the period. Above 20% indicates flaky tests or broken builds that slow delivery. Above 50% indicates CI is effectively broken and blocks all merges.
- **Deploy failures**: Number of deploy workflow runs that fail. Any failure requires investigation since it means code that passed CI could not be deployed.
- **DLQ rate**: Ratio of messages landing in dead-letter queues to total messages processed. This is the user-facing failure rate -- each DLQ message represents a user interaction that was not completed.
- **Chat success rate**: Percentage of inbound messages that are processed successfully (no Lambda error, no DLQ). This is the primary user-experience metric. Computed as `(1 - error_rate) * (1 - dlq_rate)`.

### 4. Queue Health (Issue Backlog)

**Question**: Is the backlog healthy and well-managed?

| ID | Metric | Source | Threshold | Severity |
|----|--------|--------|-----------|----------|
| B1 | Total open issues | GitHub API | Tracked (no threshold) | Informational |
| B2 | Unassigned high-priority | GitHub API | >0 | Critical |
| B3 | Missing type/priority labels | GitHub API | Tracked (no threshold) | Informational |
| B4 | Blocked issues | GitHub API | Tracked (no threshold) | Informational |
| B5 | In-progress issues | GitHub API | >WIP cap (8) | Warning |
| B6 | Stale issues (>30d without activity) | GitHub API | >25% of open issues | Warning |
| B7 | Priority distribution | GitHub API | Tracked (no threshold) | Informational |

#### Queue health metric definitions

- **Unassigned high-priority**: Any high-priority issue without an assignee. High-priority issues must always have an owner. Zero tolerance.
- **In-progress issues**: Count of issues with `status:in-progress` label. Exceeding the WIP cap (8) indicates overcommitment and context switching.
- **Stale issues**: Percentage of open issues with no activity for 30+ days. High staleness indicates backlog neglect and makes prioritization unreliable.

---

## Thresholds and Recommendations

When a metric breaches its threshold, the scorecard generates a specific recommendation. Recommendations include:

- **Category prefix** (RELIABILITY, DELIVERY, QUEUE HEALTH, QUALITY) for quick scanning
- **Observed value** and **threshold** for context
- **Action reference** pointing to the relevant runbook or governance doc

### Health Grade

The overall health grade is derived from recommendation count and severity:

| Grade | Criteria | Meaning |
|-------|----------|---------|
| GREEN | No threshold breaches | All systems nominal. Continue planned work. |
| YELLOW | 1-2 threshold breaches, none Critical severity | Attention needed. Address recommendations during triage. |
| RED | 3+ threshold breaches, OR any Critical severity breach | Immediate action required. Feature work is blocked. |

A single Critical-severity breach (R1, R2, R5, B2, Q2) immediately escalates the grade to RED regardless of total breach count.

---

## Reprioritization Triggers

Reprioritization triggers are rules that map specific metric movements to concrete priority and scheduling actions. They remove ambiguity from the triage process by prescribing what must happen when a threshold is breached.

### Trigger Rules

Each rule follows the pattern: **IF** metric condition **THEN** action. Actions are mandatory unless explicitly overridden with documented rationale during triage.

#### Reliability triggers

| ID | Condition | Action | Urgency |
|----|-----------|--------|---------|
| T-R1 | Lambda error rate >5% | Escalate to P0 incident. Assign on-call. Block new feature branch starts. Follow [RUNBOOK.md](./RUNBOOK.md). | Immediate |
| T-R2 | DLQ messages >0 | Create `priority:high` `type:bug` issue if none exists. Run DLQ recovery per [RUNBOOK.md](./RUNBOOK.md) Section 3. | Within 24h |
| T-R3 | Queue depth >10 (sustained) | Investigate consumer health. If Lambda errors are also elevated, escalate to T-R1. Otherwise create `priority:medium` issue. | Within 48h |
| T-R4 | P99 latency >30s | Create `priority:medium` issue to investigate slow paths (AI provider latency, DynamoDB throttling). | Within 1 week |
| T-R5 | Active alarms >0 | Immediate shift to incident response per [RUNBOOK.md](./RUNBOOK.md). Feature PRs may continue in-flight but no new feature branches. | Immediate |
| T-R6 | MTTR trending up for 3+ weeks | Review incident response process. Create `priority:medium` issue to improve alerting or runbook coverage. | Within 1 week |

#### Delivery triggers

| ID | Condition | Action | Urgency |
|----|-----------|--------|---------|
| T-D1 | PR throughput declining 2+ consecutive weeks | Review for blockers: team capacity, review bottlenecks, CI flakiness. Discuss in triage. | Triage discussion |
| T-D2 | Stale PRs >3 | Each stale PR must be reviewed: reassign reviewer, close if abandoned, or merge if approved. | Within 1 week |
| T-D3 | Lead time increasing 3+ consecutive weeks | Investigate CI pipeline speed, review turnaround, and branch complexity. Create improvement issue if root cause is systemic. | Within 2 weeks |
| T-D4 | Change failure rate >20% (of deploys) | Freeze non-critical deploys. Review failing deploy logs. Strengthen staging verification gate (G5 in [STRATEGY-OPERATIONS.md](./STRATEGY-OPERATIONS.md)). | Within 48h |

#### Product / runtime quality triggers

| ID | Condition | Action | Urgency |
|----|-----------|--------|---------|
| T-Q1 | CI failure rate >20% | Create `priority:medium` issue to fix flaky tests or broken builds. Assign to coding agent. | Within 1 week |
| T-Q2 | CI failure rate >50% | Escalate to `priority:high`. CI is effectively broken. All efforts focus on restoring green builds. Block new PRs until rate drops below 50%. | Within 24h |
| T-Q3 | Deploy failures >0 in period | Investigate each failed deploy. If pattern emerges, create issue to harden deploy pipeline. | Within 1 week |
| T-Q4 | DLQ rate >1% | Create `priority:high` issue. More than 1 in 100 user messages is failing. Investigate top failure paths. | Within 48h |
| T-Q5 | Chat success rate drops >5 percentage points week-over-week | Treat as potential incident. Cross-reference with R1/R2 to determine root cause. If correlated with a deploy, consider rollback. | Within 24h |

#### Queue health triggers

| ID | Condition | Action | Urgency |
|----|-----------|--------|---------|
| T-B1 | Unassigned high-priority >0 | Assign owner during triage. High-priority issues must never be unowned. | During triage |
| T-B2 | In-progress >WIP cap (8) | Enforce overflow protocol: return blocked items to backlog, close stale items, complete in-flight work before pulling new items. See [STRATEGY-OPERATIONS.md](./STRATEGY-OPERATIONS.md) section 2. | During triage |
| T-B3 | Stale issues >25% of open | Allocate one sprint slot to backlog grooming. Apply aging policy from [ISSUE-GOVERNANCE.md](./ISSUE-GOVERNANCE.md). | Within 1 week |
| T-B4 | Missing labels >10% of open issues | Run label audit during triage. Assign type and priority to all unlabeled issues. | During triage |

### Compound Triggers

Some conditions combine multiple metrics to determine the appropriate response.

| ID | Condition | Action |
|----|-----------|--------|
| T-C1 | Health grade RED + any `priority:high` `type:feature` issues in-progress | Pause feature work. Reassign capacity to reliability/security until grade returns to YELLOW or GREEN. |
| T-C2 | DLQ >0 + Lambda error rate >5% | Treat as correlated incident. Single P0 issue, not separate bugs. |
| T-C3 | CI failure rate >20% + stale PRs >3 | Delivery pipeline is congested. Fix CI first (root cause), then clear stale PRs. Do not merge PRs into a broken CI. |
| T-C4 | MTTR trending up + incident count trending up | Systemic reliability issue. Create `priority:high` meta-issue for reliability improvement sprint. Allocate extra capacity from feature delivery. |

### Override Protocol

A trigger action may be deferred or dismissed only when:

1. The override is discussed during triage and documented as a comment on the scorecard GitHub Actions run or the relevant issue.
2. A rationale is recorded (e.g., "DLQ message was a known test artifact, not a user-facing failure").
3. The override is time-boxed: if the condition persists the following week, the trigger must be acted on.

Overrides are never silent. Every dismissed recommendation must have a written rationale.

---

## Triage Integration

The scorecard is designed to feed directly into the weekly triage cadence described in [ISSUE-GOVERNANCE.md](./ISSUE-GOVERNANCE.md):

1. **Before triage:** Review the scorecard markdown (posted to Actions step summary or downloaded as artifact).
2. **During triage:** Walk through each recommendation and apply the corresponding trigger rule. Record decisions.
3. **Priority adjustments:** If a trigger prescribes a priority change, apply it. Validate against the priority criteria in ISSUE-GOVERNANCE.md.
4. **After triage:** Record any priority changes as comments on affected issues with a reference to the scorecard run.

### Weekly Triage Checklist (Scorecard Additions)

Add these steps to the existing triage process:

- [ ] Download or review the latest leadership scorecard from GitHub Actions artifacts
- [ ] Check the health grade -- RED requires immediate attention before proceeding
- [ ] For RED grade: identify Critical-severity breaches and apply corresponding T-* triggers immediately
- [ ] For YELLOW grade: review each recommendation and apply the corresponding T-* trigger rule
- [ ] For RELIABILITY recommendations: cross-reference with [MONITORING-OPERATOR-GUIDE.md](./MONITORING-OPERATOR-GUIDE.md) and [RUNBOOK.md](./RUNBOOK.md)
- [ ] For QUEUE HEALTH recommendations: apply the aging policy from [ISSUE-GOVERNANCE.md](./ISSUE-GOVERNANCE.md)
- [ ] For DELIVERY recommendations: review stale PRs and reassign or close
- [ ] For QUALITY recommendations: create issues for CI fixes or assign to coding agents
- [ ] Check for compound trigger conditions (T-C1 through T-C4)
- [ ] Document any trigger overrides with written rationale
- [ ] Verify that all actions from the previous week's scorecard were completed or carried forward

---

## Metric Stability

The scorecard metric set is considered **stable** as of 2026-02-23. This means:

- The metrics listed in this document are the canonical set used for weekly leadership reviews.
- Metrics are not added, removed, or redefined without a documented decision during a quarterly metric set review.
- Threshold values may be tuned quarterly based on trailing data, but the metric definitions themselves are fixed between reviews.
- New metrics under consideration are tracked in the "Future Metrics" section below and are not acted on until formally adopted.

### Versioning

| Version | Date | Change |
|---------|------|--------|
| 1.0 | 2026-02-23 | Initial stable metric set. 4 categories, 25 metrics, 18 trigger rules. |

When the metric set changes, increment the version, update this table, and note the change in the quarterly review record.

### Future Metrics (Under Consideration)

These metrics are being evaluated for inclusion in a future version. They are not part of the current scorecard and do not trigger reprioritization actions.

| Metric | Category | Rationale | Blocker |
|--------|----------|-----------|---------|
| Chat success rate (end-to-end) | Product Quality | Requires custom CloudWatch metric or application-level instrumentation beyond Lambda error counting | Instrumentation not yet deployed |
| Cost per message | Product Quality | Unit economics indicator; requires correlation of AWS Cost Explorer data with message volume | Daily cost report provides raw data but scorecard integration is pending |
| Deployment lead time (commit to prod) | Delivery | Full DORA metric; requires timestamp correlation across CI + deploy workflows | Multi-step deploy makes timestamp extraction non-trivial |

---

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
| Strategy operations and reprioritization policy | [STRATEGY-OPERATIONS.md](./STRATEGY-OPERATIONS.md) |
| Triage process and priority criteria | [ISSUE-GOVERNANCE.md](./ISSUE-GOVERNANCE.md) |
| Ticket health report (complementary) | `.github/workflows/ticket-health.yml` |
| Operational monitoring | [MONITORING-OPERATOR-GUIDE.md](./MONITORING-OPERATOR-GUIDE.md) |
| Incident response | [RUNBOOK.md](./RUNBOOK.md) |
| Cost controls | [COST-CONTROLS-PLAYBOOK.md](./COST-CONTROLS-PLAYBOOK.md) |
| Cost & activity reports | [OPERATIONS-REPORTS.md](./OPERATIONS-REPORTS.md) |
| Scorecard script | `scripts/leadership-scorecard.sh` |
| Scorecard workflow | `.github/workflows/leadership-scorecard.yml` |

---

*Last updated: 2026-02-23*
