# Operations Reports: Cost + Activity

This repo now supports automated cost and activity reporting via GitHub Actions.

## Workflow

- Workflow: `.github/workflows/cost-activity-report.yml`
- Schedule: daily at `06:20 UTC`
- Manual run: `workflow_dispatch` with:
  - `environment`: `staging` or `production`
  - `days`: report window in days (`1-30`)
  - `include_aws_cost`: query AWS Cost Explorer or skip

The workflow writes:

- Markdown report: `test-outputs/reports/cost-activity-<env>.md`
- JSON report: `test-outputs/reports/cost-activity-<env>.json`

Both are uploaded as workflow artifacts.

## Cost Response Playbook

For cost anomaly triage, containment, and follow-up actions, use:

- `docs/COST-CONTROLS-PLAYBOOK.md`

## Weekly Cost Review

Daily reports feed into the **weekly cost review** performed during Monday triage. The review evaluates KPIs against concrete targets and creates corrective-action issues when thresholds are breached. See:

- KPI targets and variance bands: `docs/COST-CONTROLS-PLAYBOOK.md` sections 6-8
- Weekly cadence and ownership: `docs/STRATEGY-OPERATIONS.md` section 4 and section 6

## Automatic Cost-Control Signals

Each generated report now includes a `signals` block (in JSON and markdown summary table) with machine-evaluated statuses for:

- `awsCostJump`
- `costPerMessageJump`
- `spendRiseActivityFlat`
- `projectedMonthEndSpendBreach`

These are evaluated using the thresholds defined in `docs/COST-CONTROLS-PLAYBOOK.md`.

For budget projection, set `MONTHLY_BUDGET_USD` as a repository/environment variable in GitHub Actions.

## Data Sources

- Activity usage counters from DynamoDB daily usage records:
  - key format: `pk=USAGE#{avatarId}`, `sk=DAY#{YYYY-MM-DD}`
  - fields: `messagesProcessed`, `mediaCreditsUsed`, `voiceMinutesUsed`, `toolCallsMade`, `imageGenerations`, `videoGenerations`, `stickerGenerations`
- Avatar list from `ADMIN_TABLE` configs (`GSI1`, `sk=CONFIG`)
- AWS cost from Cost Explorer (`ce:GetCostAndUsage`) when enabled

## Roadmap KPI Mapping

Roadmap references reviewed from `ROADMAP.md` and `PLAN.md` (last reviewed 2026-02-20):

1. `M2: Usage metering surfaced in admin UI`
   - active avatars
   - metered operations volume
2. `M2: Operational hardening`
   - activity trend by day
   - top avatars by activity/cost pressure
3. `M3: SaaS reliability and cost optimization for scale`
   - AWS unblended cost
   - estimated usage cost model
   - cost per active avatar and cost per message

## Optional Unit Cost Configuration

Set repository/environment variables to turn usage into estimated USD:

- `COST_PER_MESSAGE_USD`
- `COST_PER_MEDIA_CREDIT_USD`
- `COST_PER_VOICE_MINUTE_USD`
- `COST_PER_TOOL_CALL_USD`
- `COST_PER_IMAGE_GEN_USD`
- `COST_PER_VIDEO_GEN_USD`
- `COST_PER_STICKER_GEN_USD`
- `MONTHLY_BUDGET_USD` (enables projected month-end spend breach signal)

If these are unset, estimated usage cost is reported as `0` and AWS Cost Explorer remains the primary cost signal.

## IAM Requirements

The workflow role (`AWS_ROLE_ARN`) should include at minimum:

- `cloudformation:DescribeStacks`
- `dynamodb:Query` on the admin table
- `ce:GetCostAndUsage` (if `include_aws_cost=true`)
