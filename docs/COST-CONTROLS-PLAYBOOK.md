# Cost Controls Playbook

Operational playbook for identifying and containing unexpected spend growth in staging or production.

Related docs:
- `docs/OPERATIONS-REPORTS.md`
- `docs/RUNBOOK.md`
- `scripts/generate-cost-activity-report.mjs`

## 1. When to Run This Playbook

Run this playbook when one or more of these signals appear in a daily report:

| Signal | Threshold | Severity |
|---|---|---|
| AWS unblended cost jump | `>= 30%` day-over-day and `>= $15` absolute increase | P2 |
| Cost per message jump | `>= 2x` versus prior 7-day baseline | P2 |
| Spend rises but activity is flat | AWS cost up `>= 25%`, messages change within `+/- 10%` | P2 |
| Projected month-end spend breach | Forecast exceeds internal budget guardrail by `>= 20%` | P1 |

Use your environment-specific budget values for the final signal.

## 2. Fast Triage (First 15 Minutes)

1. Generate a fresh report for the affected environment.

```bash
ENVIRONMENT=staging
AWS_REGION=us-east-1
MONTHLY_BUDGET_USD=400
if [ "$ENVIRONMENT" = "production" ]; then CDK_ENV=prod; else CDK_ENV="$ENVIRONMENT"; fi

ADMIN_TABLE=$(aws cloudformation describe-stacks \
  --stack-name "SwarmStack-${CDK_ENV}" \
  --query "Stacks[0].Outputs[?contains(OutputKey, 'AdminTableName')].OutputValue | [0]" \
  --output text)

ADMIN_TABLE="$ADMIN_TABLE" AWS_REGION="$AWS_REGION" node scripts/generate-cost-activity-report.mjs \
  --environment "$ENVIRONMENT" \
  --days 7 \
  --include-aws-cost true \
  --monthly-budget-usd "$MONTHLY_BUDGET_USD" \
  --output "test-outputs/reports/cost-activity-${ENVIRONMENT}.md" \
  --json-output "test-outputs/reports/cost-activity-${ENVIRONMENT}.json"
```

2. Identify where cost pressure is concentrated.

```bash
REPORT="test-outputs/reports/cost-activity-${ENVIRONMENT}.json"

jq '{awsCostUsd: .awsCost.totalUsd, messages: .usage.totals.messagesProcessed, activeAvatars: .usage.activeAvatarCount}' "$REPORT"
jq '.signals | {triggeredCount, triggered, awsCostJump: .awsCostJump.status, costPerMessageJump: .costPerMessageJump.status, spendRiseActivityFlat: .spendRiseActivityFlat.status, projectedMonthEndSpendBreach: .projectedMonthEndSpendBreach.status}' "$REPORT"
jq '.signals | {awsCostJump: .awsCostJump.observed, costPerMessageJump: .costPerMessageJump.observed, spendRiseActivityFlat: .spendRiseActivityFlat.observed, projectedMonthEndSpendBreach: .projectedMonthEndSpendBreach.observed}' "$REPORT"
jq '.usage.avatars[:10] | map({avatarId, estimatedUsageCostUsd, activityUnits, messagesProcessed, toolCallsMade, imageGenerations, videoGenerations})' "$REPORT"
jq '.usage.days | map({date, estimatedUsageCostUsd, messagesProcessed, activityUnits})' "$REPORT"
```

3. Classify the spike:
- **Single-avatar spike:** one avatar dominates `estimatedUsageCostUsd` and activity units.
- **Platform-wide activity spike:** many avatars increase together and queues/traffic rise.
- **Infrastructure drift:** AWS cost rises while usage metrics stay flat.

## 3. Containment Actions

Choose the smallest action that stops the cost growth safely.

| Scenario | First containment action | Rollback |
|---|---|---|
| Single-avatar runaway usage/abuse | Pause the avatar in Admin UI (`status=paused`) | Resume avatar (`status=active`) after root cause fix |
| Telegram ingress flood | Temporarily remove webhook for affected avatar | Re-register webhook after controls are in place |
| Retry/error storm (high errors + DLQ growth) | Follow `docs/RUNBOOK.md` DLQ + processor recovery steps | Resume normal queue flow after errors stabilize |
| Baseline infra cost drift | Run orphaned secret cleanup dry run, then execute if confirmed | None (deletion is permanent; validate first) |

### Telegram webhook emergency stop (per avatar)

```bash
AVATAR_ID=<avatar-id>
TOKEN=$(aws secretsmanager get-secret-value \
  --region "$AWS_REGION" \
  --secret-id "swarm/${AVATAR_ID}/telegram_bot_token/default" \
  --query SecretString --output text)

curl -s "https://api.telegram.org/bot${TOKEN}/deleteWebhook" | jq .
```

### Orphaned secret cleanup (cost baseline drift)

```bash
# Dry run first
ADMIN_TABLE="$ADMIN_TABLE" AWS_REGION="$AWS_REGION" pnpm exec tsx scripts/cleanup-orphaned-secrets.ts

# Execute only after reviewing dry-run output
ADMIN_TABLE="$ADMIN_TABLE" AWS_REGION="$AWS_REGION" pnpm exec tsx scripts/cleanup-orphaned-secrets.ts --execute
```

## 4. Verification After Containment

1. Re-run the report for `--days 1` and confirm trend reversal.
2. Confirm queue depth and Lambda error alarms are recovering (see `docs/RUNBOOK.md` sections 3-6).
3. Confirm no additional avatars are entering high-cost behavior.
4. Record incident summary:
- trigger signal
- root cause class
- containment action
- recovery timestamp
- follow-up task/owner

## 5. Follow-Up Hardening Checklist

1. If spike was abuse: tighten ingress controls (rate limiting, webhook validation, allowlists).
2. If spike was feature misuse: add stricter per-avatar limits or safer defaults.
3. If spike was retry storm: add alerting on repeated error patterns before cost impact.
4. If spike was infra drift: schedule weekly dry-run of `cleanup-orphaned-secrets.ts`.

---

## 6. Cost KPI Targets

Concrete targets for cost key performance indicators. These targets are reviewed quarterly and adjusted as scale changes. All values are derived from the CDK budget guardrails (`packages/infra/src/constructs/budget-guardrails.ts`) and operational experience.

### Environment Budgets

| Environment | Monthly Budget | Source |
|-------------|---------------|--------|
| **Staging** | $100 USD | CDK `monthlyBudgetUsd` (recommended) |
| **Production** | $500 USD | CDK `monthlyBudgetUsd` (recommended) |

### KPI Definitions and Targets

| KPI | Definition | Target | Measurement Source |
|-----|-----------|--------|-------------------|
| **Staging idle cost** | AWS cost on zero-traffic days (no active avatars, no messages processed) | **<= $2.50/day ($75/mo)** | Daily cost report on days with `messagesProcessed == 0` |
| **Production idle cost** | AWS cost on zero-traffic days | **<= $8.00/day ($240/mo)** | Daily cost report on days with `messagesProcessed == 0` |
| **Cost per active avatar per day** | `awsCost.totalUsd / usage.activeAvatarCount` | **<= $1.50** (pre-scale; revisit at >50 avatars) | Daily report JSON |
| **Cost per message** | `awsCost.totalUsd / usage.totals.messagesProcessed` | **<= $0.05** | Daily report JSON |
| **Orphaned secret count** | Secrets in Secrets Manager with no matching avatar in DynamoDB | **0** | `cleanup-orphaned-secrets.ts --dry-run` |
| **Budget utilization** | Percentage of monthly budget consumed | **<= 80%** at any point before day 25 of the month | AWS Budget alerts (50%, 80%, 100% thresholds) |
| **Cost anomaly impact** | Absolute dollar impact of detected anomalies | **< $10** per anomaly | Cost Anomaly Detection subscription |

### Variance Thresholds

When a KPI exceeds its target, the variance determines the response urgency.

| Variance Band | Condition | Response | SLA |
|---------------|-----------|----------|-----|
| **Green** | KPI within target | No action. Record in weekly review notes. | -- |
| **Yellow** | KPI exceeds target by **< 25%** | Investigate root cause during weekly review. Document finding. | Resolve within 7 days |
| **Red** | KPI exceeds target by **>= 25%** | Create a corrective-action issue immediately. Escalate to triage. | Resolve within 3 days |
| **Critical** | Any signal from section 1 is triggered | Execute fast triage (section 2) within 15 minutes. | Same-day containment |

---

## 7. Weekly Cost Review Cadence

A proactive weekly review complements the reactive playbook (sections 1-5). The review runs every **Monday during triage**.

### Owner

**Leadership** owns the weekly cost review. Findings feed directly into backlog reprioritization during the Monday triage session.

### Review Workflow

```
Monday triage
  │
  ├─ Step 1: Collect inputs
  │    ├─ Daily cost reports from the past 7 days (artifacts from cost-activity-report.yml)
  │    ├─ AWS Budget console: current month spend vs. budget
  │    ├─ Cost Anomaly Detection: any open anomalies
  │    └─ Leadership scorecard: COST recommendations
  │
  ├─ Step 2: Evaluate KPIs against targets (section 6)
  │    ├─ Compute 7-day average for each KPI
  │    ├─ Compare against target thresholds
  │    └─ Classify each KPI as Green / Yellow / Red
  │
  ├─ Step 3: Corrective actions
  │    ├─ Green KPIs: no action, note in review log
  │    ├─ Yellow KPIs: document root cause hypothesis, assign investigation owner
  │    └─ Red KPIs: create GitHub issue (see escalation path below)
  │
  ├─ Step 4: Backlog impact
  │    ├─ Red cost issues get priority:high + type:infra labels
  │    ├─ If >= 2 Red KPIs: pause lowest-priority in-progress feature work
  │    └─ Update portfolio allocation if cost trend threatens budget
  │
  └─ Step 5: Record review
       └─ Post summary as a comment on the weekly triage issue or thread
```

### Generating the 7-Day Summary

```bash
# Pull the last 7 days of reports
ENVIRONMENT=staging  # or production
AWS_REGION=us-east-1
MONTHLY_BUDGET_USD=100  # staging; use 500 for production
if [ "$ENVIRONMENT" = "production" ]; then CDK_ENV=prod; else CDK_ENV="$ENVIRONMENT"; fi

ADMIN_TABLE=$(aws cloudformation describe-stacks \
  --stack-name "SwarmStack-${CDK_ENV}" \
  --query "Stacks[0].Outputs[?contains(OutputKey, 'AdminTableName')].OutputValue | [0]" \
  --output text)

ADMIN_TABLE="$ADMIN_TABLE" AWS_REGION="$AWS_REGION" node scripts/generate-cost-activity-report.mjs \
  --environment "$ENVIRONMENT" \
  --days 7 \
  --include-aws-cost true \
  --monthly-budget-usd "$MONTHLY_BUDGET_USD" \
  --output "test-outputs/reports/cost-review-${ENVIRONMENT}-weekly.md" \
  --json-output "test-outputs/reports/cost-review-${ENVIRONMENT}-weekly.json"
```

Then extract the KPI values:

```bash
REPORT="test-outputs/reports/cost-review-${ENVIRONMENT}-weekly.json"

# Cost per active avatar per day (7-day average)
jq '[.usage.days[] | select(.messagesProcessed > 0)] |
  if length > 0 then
    { avgCostPerAvatar: ([.[].estimatedUsageCostUsd] | add / length),
      daysWithActivity: length }
  else { avgCostPerAvatar: "N/A", daysWithActivity: 0 }
  end' "$REPORT"

# Idle cost (days with zero messages)
jq '[.usage.days[] | select(.messagesProcessed == 0)] |
  if length > 0 then
    { avgIdleCostUsd: "check AWS Cost Explorer for zero-traffic days",
      zeroDays: length }
  else { zeroDays: 0 }
  end' "$REPORT"

# Signal status summary
jq '.signals | {triggeredCount, awsCostJump: .awsCostJump.status, costPerMessageJump: .costPerMessageJump.status, spendRiseActivityFlat: .spendRiseActivityFlat.status, projectedMonthEndSpendBreach: .projectedMonthEndSpendBreach.status}' "$REPORT"
```

---

## 8. Escalation: KPI Breach to Corrective-Action Issue

When a Red-band KPI is identified during weekly review (or a Critical signal fires at any time), a corrective-action issue must be created to ensure tracking and resolution.

### Issue Creation Template

```bash
KPI_NAME="staging-idle-cost"          # e.g., staging-idle-cost, cost-per-message, orphaned-secrets
OBSERVED_VALUE="$3.80/day"
TARGET_VALUE="<= $2.50/day"
VARIANCE="52%"

gh issue create \
  --title "fix(infra): cost KPI breach — ${KPI_NAME} at ${OBSERVED_VALUE} (target: ${TARGET_VALUE})" \
  --label "type:infra,priority:high" \
  --body "$(cat <<EOF
## Cost KPI Breach

| Field | Value |
|-------|-------|
| **KPI** | ${KPI_NAME} |
| **Observed** | ${OBSERVED_VALUE} |
| **Target** | ${TARGET_VALUE} |
| **Variance** | ${VARIANCE} over target |
| **Band** | Red |
| **Detected** | Weekly cost review $(date +%Y-%m-%d) |

## Context

<!-- Paste relevant snippets from the weekly cost report -->

## Expected Corrective Actions

1. Identify root cause (infrastructure drift, usage spike, config change).
2. Implement fix or containment.
3. Verify KPI returns to Green/Yellow in the next daily report.
4. Update this issue with resolution summary.

## References

- [Cost Controls Playbook](docs/COST-CONTROLS-PLAYBOOK.md)
- [Cost Controls Playbook](docs/COST-CONTROLS-PLAYBOOK.md)
EOF
)"
```

### Escalation Rules

| Condition | Action |
|-----------|--------|
| Single Red KPI | Create issue with `priority:high` + `type:infra`. Assign to leadership. |
| >= 2 Red KPIs simultaneously | Additionally: pause the lowest-priority `status:in-progress` feature issue and reassign capacity to cost investigation. |
| Critical signal (section 1) | Skip weekly cadence. Execute fast triage immediately (section 2). Create issue post-containment. |
| Red KPI persists for 2+ consecutive weeks | Escalate to `priority:high` + `type:security` (budget exhaustion risk). Consider emergency budget increase or feature rollback. |
| Monthly budget >= 80% before day 20 | Create forecasting issue. Evaluate whether to reduce avatar limits or disable non-essential features for remainder of month. |

### Linking Cost Issues to Backlog Reprioritization

Cost corrective-action issues participate in the standard triage process defined in `docs/ISSUE-GOVERNANCE.md`:

1. Cost issues labeled `priority:high` are worked before feature issues of equal or lower priority (see priority order in `CLAUDE.md`).
2. If a cost issue causes the WIP cap to be reached, blocked or stale items are returned to backlog to make room (see WIP caps in `CLAUDE.md`).
3. Cost issues that require infrastructure changes follow the standard PR workflow and must pass the release gate contract (see `RELEASE-GATES.md`) before deployment.
4. Resolution of cost issues is tracked as part of the "Cost trend" operating metric in Monday triage.

---

## 9. Quarterly KPI Target Review

Cost KPI targets (section 6) are not permanent. They must be reviewed quarterly alongside the billing strategy review (`docs/BILLING-STRATEGY.md`).

### Review Checklist

- [ ] Compare actual 90-day averages against current targets.
- [ ] Adjust idle cost targets if infrastructure has grown (new constructs, additional environments).
- [ ] Adjust cost-per-avatar and cost-per-message targets if user base has scaled significantly.
- [ ] Review `monthlyBudgetUsd` values in CDK context and update if necessary.
- [ ] Verify anomaly detection threshold ($10) is still appropriate for current spend levels.
- [ ] Update this playbook with revised targets and note the revision date.

---

*Last updated: 2026-02-23*
