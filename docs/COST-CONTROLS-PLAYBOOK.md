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
