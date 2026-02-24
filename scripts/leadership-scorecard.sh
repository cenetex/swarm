#!/usr/bin/env bash
# Weekly Leadership Operating Scorecard
#
# Collects reliability, delivery, queue health, and runtime quality metrics
# and generates a scorecard with prior-period comparison and threshold breach
# recommendations.
#
# Usage:
#   ./scripts/leadership-scorecard.sh            # Human-readable markdown
#   ./scripts/leadership-scorecard.sh --json      # Machine-readable JSON
#
# Environment:
#   GH_TOKEN or GITHUB_TOKEN — required (gh CLI auth)
#   GITHUB_STEP_SUMMARY — if set, appends markdown to Actions job summary
#   AWS_REGION — if set, queries CloudWatch for reliability metrics
#   ENVIRONMENT — staging or production (default: production)

set -euo pipefail

# ── Args ─────────────────────────────────────────────────────────────────
JSON_MODE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) JSON_MODE=1 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

# ── Config ───────────────────────────────────────────────────────────────
REPO="${GITHUB_REPOSITORY:-cenetex/aws-swarm}"
ENVIRONMENT="${ENVIRONMENT:-production}"
AWS_REGION="${AWS_REGION:-us-east-1}"
NOW_EPOCH=$(date +%s)
PERIOD_DAYS=7
PRIOR_PERIOD_DAYS=14

# Date ranges (ISO 8601)
CURRENT_START=$(date -u -d "@$((NOW_EPOCH - PERIOD_DAYS * 86400))" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
  || date -u -r "$((NOW_EPOCH - PERIOD_DAYS * 86400))" +%Y-%m-%dT%H:%M:%SZ)
PRIOR_START=$(date -u -d "@$((NOW_EPOCH - PRIOR_PERIOD_DAYS * 86400))" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null \
  || date -u -r "$((NOW_EPOCH - PRIOR_PERIOD_DAYS * 86400))" +%Y-%m-%dT%H:%M:%SZ)
NOW_ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# ── Thresholds ───────────────────────────────────────────────────────────
# These thresholds trigger reprioritization recommendations when breached.
THRESHOLD_ERROR_RATE=5            # percent — Lambda error rate
THRESHOLD_DLQ_MESSAGES=0          # any DLQ messages trigger alert
THRESHOLD_QUEUE_DEPTH=10          # sustained queue depth
THRESHOLD_P99_LATENCY_MS=30000    # 30s message processor P99
THRESHOLD_PR_MERGE_DAYS=7         # PRs older than 7 days
THRESHOLD_UNASSIGNED_HIGH=0       # unassigned high-priority issues
THRESHOLD_STALE_ISSUES_PCT=25     # percent of open issues older than 30d
THRESHOLD_CI_FAILURE_RATE=20      # percent CI failure rate

# ── Helpers ──────────────────────────────────────────────────────────────
recommendations=()
add_recommendation() {
  recommendations+=("$1")
}

# ═════════════════════════════════════════════════════════════════════════
# SECTION 1: DELIVERY THROUGHPUT
# ═════════════════════════════════════════════════════════════════════════

# PRs merged this period
PRS_MERGED_CURRENT=$(gh pr list \
  --repo "$REPO" \
  --state merged \
  --limit 200 \
  --json mergedAt \
  --jq "[.[] | select(.mergedAt >= \"$CURRENT_START\")] | length")

# PRs merged prior period (prior week only, not cumulative)
PRS_MERGED_PRIOR=$(gh pr list \
  --repo "$REPO" \
  --state merged \
  --limit 200 \
  --json mergedAt \
  --jq "[.[] | select(.mergedAt >= \"$PRIOR_START\" and .mergedAt < \"$CURRENT_START\")] | length")

# Open PRs and their ages
OPEN_PRS=$(gh pr list \
  --repo "$REPO" \
  --state open \
  --limit 100 \
  --json number,title,createdAt,author)
OPEN_PR_COUNT=$(echo "$OPEN_PRS" | jq 'length')

# Stale PRs (older than threshold)
STALE_PR_CUTOFF=$((NOW_EPOCH - THRESHOLD_PR_MERGE_DAYS * 86400))
STALE_PRS=$(echo "$OPEN_PRS" | jq --argjson cutoff "$STALE_PR_CUTOFF" '[
  .[] | select(
    (.createdAt | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) < $cutoff
  )
]')
STALE_PR_COUNT=$(echo "$STALE_PRS" | jq 'length')

if [[ "$STALE_PR_COUNT" -gt 3 ]]; then
  add_recommendation "DELIVERY: $STALE_PR_COUNT PRs are older than ${THRESHOLD_PR_MERGE_DAYS}d. Consider prioritizing PR reviews or closing stale PRs."
fi

# Issues closed this period vs prior
ISSUES_CLOSED_CURRENT=$(gh issue list \
  --repo "$REPO" \
  --state closed \
  --limit 200 \
  --json closedAt \
  --jq "[.[] | select(.closedAt >= \"$CURRENT_START\")] | length")

ISSUES_CLOSED_PRIOR=$(gh issue list \
  --repo "$REPO" \
  --state closed \
  --limit 200 \
  --json closedAt \
  --jq "[.[] | select(.closedAt >= \"$PRIOR_START\" and .closedAt < \"$CURRENT_START\")] | length")

# ═════════════════════════════════════════════════════════════════════════
# SECTION 2: QUEUE HEALTH (from ticket-health data)
# ═════════════════════════════════════════════════════════════════════════

ALL_ISSUES=$(gh issue list \
  --repo "$REPO" \
  --state open \
  --limit 500 \
  --json number,title,labels,assignees,createdAt,updatedAt,milestone)

TOTAL_OPEN=$(echo "$ALL_ISSUES" | jq 'length')

# Unassigned high-priority issues
UNASSIGNED_HIGH=$(echo "$ALL_ISSUES" | jq '[
  .[] | select(
    (.assignees | length) == 0 and
    (.labels | map(.name) | any(test("^priority:high$")))
  )
]')
UNASSIGNED_HIGH_COUNT=$(echo "$UNASSIGNED_HIGH" | jq 'length')

if [[ "$UNASSIGNED_HIGH_COUNT" -gt "$THRESHOLD_UNASSIGNED_HIGH" ]]; then
  add_recommendation "QUEUE HEALTH: $UNASSIGNED_HIGH_COUNT high-priority issues are unassigned. Assign owners or delegate to coding agents immediately."
fi

# Priority distribution
PRIORITY_DIST=$(echo "$ALL_ISSUES" | jq '
  [.[] | {
    priorities: [.labels[].name | select(startswith("priority:"))]
  }] |
  map(if .priorities | length == 0 then .priorities = ["(no priority)"] else . end) |
  [.[].priorities[]] |
  group_by(.) |
  map({label: .[0], count: length}) |
  sort_by(-.count)
')

# Issues older than 30 days (stale ratio)
AGE_30_CUTOFF=$((NOW_EPOCH - 30 * 86400))
STALE_ISSUES=$(echo "$ALL_ISSUES" | jq --argjson cutoff "$AGE_30_CUTOFF" '[
  .[] | select(
    (.createdAt | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) < $cutoff
  )
] | length')

if [[ "$TOTAL_OPEN" -gt 0 ]]; then
  STALE_PCT=$((STALE_ISSUES * 100 / TOTAL_OPEN))
else
  STALE_PCT=0
fi

if [[ "$STALE_PCT" -gt "$THRESHOLD_STALE_ISSUES_PCT" ]]; then
  add_recommendation "QUEUE HEALTH: ${STALE_PCT}% of open issues are older than 30 days (threshold: ${THRESHOLD_STALE_ISSUES_PCT}%). Run aging policy from ISSUE-GOVERNANCE.md."
fi

# Issues missing labels
MISSING_LABELS=$(echo "$ALL_ISSUES" | jq '[
  .[] | select(
    ((.labels | map(.name) | any(test("^type:"))) | not) or
    ((.labels | map(.name) | any(test("^priority:"))) | not)
  )
] | length')

# Blocked issues
BLOCKED_COUNT=$(echo "$ALL_ISSUES" | jq '[
  .[] | select(.labels | map(.name) | any(test("^status:blocked$")))
] | length')

# In-progress issues
IN_PROGRESS_COUNT=$(echo "$ALL_ISSUES" | jq '[
  .[] | select(.labels | map(.name) | any(test("^status:in-progress$")))
] | length')

# ═════════════════════════════════════════════════════════════════════════
# SECTION 3: RELIABILITY (CloudWatch — optional)
# ═════════════════════════════════════════════════════════════════════════

LAMBDA_ERROR_RATE="N/A"
DLQ_MESSAGE_TOTAL="N/A"
QUEUE_DEPTH_MAX="N/A"
PROCESSOR_P99_MS="N/A"
ALARMS_IN_ALARM="N/A"
CW_AVAILABLE="false"

if command -v aws &>/dev/null && aws sts get-caller-identity &>/dev/null 2>&1; then
  CW_AVAILABLE="true"

  # Lambda error rate (MessageProcessor)
  INVOCATIONS=$(aws cloudwatch get-metric-statistics \
    --region "$AWS_REGION" \
    --namespace "AWS/Lambda" \
    --metric-name "Invocations" \
    --dimensions Name=FunctionName,Value="swarm-${ENVIRONMENT}-message-processor" \
    --start-time "$CURRENT_START" \
    --end-time "$NOW_ISO" \
    --period $((PERIOD_DAYS * 86400)) \
    --statistics Sum \
    --query 'Datapoints[0].Sum' \
    --output text 2>/dev/null || echo "0")

  ERRORS=$(aws cloudwatch get-metric-statistics \
    --region "$AWS_REGION" \
    --namespace "AWS/Lambda" \
    --metric-name "Errors" \
    --dimensions Name=FunctionName,Value="swarm-${ENVIRONMENT}-message-processor" \
    --start-time "$CURRENT_START" \
    --end-time "$NOW_ISO" \
    --period $((PERIOD_DAYS * 86400)) \
    --statistics Sum \
    --query 'Datapoints[0].Sum' \
    --output text 2>/dev/null || echo "0")

  if [[ "$INVOCATIONS" != "None" && "$INVOCATIONS" != "0" && "$INVOCATIONS" != "" ]]; then
    # Use awk for floating point
    LAMBDA_ERROR_RATE=$(awk "BEGIN { printf \"%.1f\", ($ERRORS / $INVOCATIONS) * 100 }")
    ERROR_RATE_NUM=$(awk "BEGIN { printf \"%.0f\", ($ERRORS / $INVOCATIONS) * 100 }")
    if [[ "$ERROR_RATE_NUM" -ge "$THRESHOLD_ERROR_RATE" ]]; then
      add_recommendation "RELIABILITY: Lambda error rate is ${LAMBDA_ERROR_RATE}% (threshold: ${THRESHOLD_ERROR_RATE}%). Investigate MessageProcessor failures — see RUNBOOK.md."
    fi
  else
    LAMBDA_ERROR_RATE="no data"
  fi

  # DLQ message count
  DLQ_MESSAGE_TOTAL=0
  for dlq_name in "swarm-${ENVIRONMENT}-dlq.fifo" "swarm-${ENVIRONMENT}-scheduler-dlq"; do
    DLQ_DEPTH=$(aws cloudwatch get-metric-statistics \
      --region "$AWS_REGION" \
      --namespace "AWS/SQS" \
      --metric-name "ApproximateNumberOfMessagesVisible" \
      --dimensions Name=QueueName,Value="$dlq_name" \
      --start-time "$CURRENT_START" \
      --end-time "$NOW_ISO" \
      --period $((PERIOD_DAYS * 86400)) \
      --statistics Maximum \
      --query 'Datapoints[0].Maximum' \
      --output text 2>/dev/null || echo "0")
    if [[ "$DLQ_DEPTH" != "None" && "$DLQ_DEPTH" != "" ]]; then
      DLQ_MESSAGE_TOTAL=$(awk "BEGIN { printf \"%.0f\", $DLQ_MESSAGE_TOTAL + $DLQ_DEPTH }")
    fi
  done

  if [[ "$DLQ_MESSAGE_TOTAL" -gt "$THRESHOLD_DLQ_MESSAGES" ]]; then
    add_recommendation "RELIABILITY: DLQ received $DLQ_MESSAGE_TOTAL messages this period. Run DLQ recovery per RUNBOOK.md Section 3."
  fi

  # Max queue depth (messages queue)
  QUEUE_DEPTH_MAX=$(aws cloudwatch get-metric-statistics \
    --region "$AWS_REGION" \
    --namespace "AWS/SQS" \
    --metric-name "ApproximateNumberOfMessagesVisible" \
    --dimensions Name=QueueName,Value="swarm-${ENVIRONMENT}-messages.fifo" \
    --start-time "$CURRENT_START" \
    --end-time "$NOW_ISO" \
    --period 300 \
    --statistics Maximum \
    --query 'max_by(Datapoints, &Maximum).Maximum' \
    --output text 2>/dev/null || echo "0")
  if [[ "$QUEUE_DEPTH_MAX" == "None" || "$QUEUE_DEPTH_MAX" == "" ]]; then
    QUEUE_DEPTH_MAX="0"
  fi
  QUEUE_DEPTH_INT=$(awk "BEGIN { printf \"%.0f\", $QUEUE_DEPTH_MAX }")
  if [[ "$QUEUE_DEPTH_INT" -ge "$THRESHOLD_QUEUE_DEPTH" ]]; then
    add_recommendation "RELIABILITY: Max queue depth reached ${QUEUE_DEPTH_INT} (threshold: ${THRESHOLD_QUEUE_DEPTH}). Check consumer Lambda health."
  fi

  # MessageProcessor P99 duration
  PROCESSOR_P99_MS=$(aws cloudwatch get-metric-statistics \
    --region "$AWS_REGION" \
    --namespace "AWS/Lambda" \
    --metric-name "Duration" \
    --dimensions Name=FunctionName,Value="swarm-${ENVIRONMENT}-message-processor" \
    --start-time "$CURRENT_START" \
    --end-time "$NOW_ISO" \
    --period $((PERIOD_DAYS * 86400)) \
    --extended-statistics p99 \
    --query 'Datapoints[0].ExtendedStatistics.p99' \
    --output text 2>/dev/null || echo "0")
  if [[ "$PROCESSOR_P99_MS" == "None" || "$PROCESSOR_P99_MS" == "" ]]; then
    PROCESSOR_P99_MS="no data"
  else
    P99_INT=$(awk "BEGIN { printf \"%.0f\", $PROCESSOR_P99_MS }")
    if [[ "$P99_INT" -ge "$THRESHOLD_P99_LATENCY_MS" ]]; then
      add_recommendation "RELIABILITY: MessageProcessor P99 latency is ${P99_INT}ms (threshold: ${THRESHOLD_P99_LATENCY_MS}ms). Investigate slow AI API calls or DynamoDB throttling."
    fi
  fi

  # Alarms currently in ALARM state
  ALARMS_IN_ALARM=$(aws cloudwatch describe-alarms \
    --region "$AWS_REGION" \
    --alarm-name-prefix "swarm-${ENVIRONMENT}" \
    --state-value ALARM \
    --query 'MetricAlarms | length(@)' \
    --output text 2>/dev/null || echo "0")
  if [[ "$ALARMS_IN_ALARM" != "0" && "$ALARMS_IN_ALARM" != "" ]]; then
    add_recommendation "RELIABILITY: $ALARMS_IN_ALARM CloudWatch alarm(s) are currently in ALARM state. Investigate per MONITORING-OPERATOR-GUIDE.md."
  fi
fi

# ═════════════════════════════════════════════════════════════════════════
# SECTION 4: CI/CD QUALITY
# ═════════════════════════════════════════════════════════════════════════

# Recent CI workflow runs
CI_RUNS=$(gh run list \
  --repo "$REPO" \
  --workflow ci.yml \
  --limit 20 \
  --json status,conclusion,createdAt \
  2>/dev/null || echo "[]")

CI_TOTAL=$(echo "$CI_RUNS" | jq "[.[] | select(.createdAt >= \"$CURRENT_START\")] | length")
CI_FAILURES=$(echo "$CI_RUNS" | jq "[.[] | select(.createdAt >= \"$CURRENT_START\" and .conclusion == \"failure\")] | length")

if [[ "$CI_TOTAL" -gt 0 ]]; then
  CI_FAILURE_RATE=$((CI_FAILURES * 100 / CI_TOTAL))
else
  CI_FAILURE_RATE=0
fi

if [[ "$CI_FAILURE_RATE" -ge "$THRESHOLD_CI_FAILURE_RATE" ]]; then
  add_recommendation "QUALITY: CI failure rate is ${CI_FAILURE_RATE}% (threshold: ${THRESHOLD_CI_FAILURE_RATE}%). Review recent failures and fix flaky tests."
fi

# Deploy workflow runs
DEPLOY_RUNS=$(gh run list \
  --repo "$REPO" \
  --workflow deploy.yml \
  --limit 10 \
  --json status,conclusion,createdAt \
  2>/dev/null || echo "[]")

DEPLOY_TOTAL=$(echo "$DEPLOY_RUNS" | jq "[.[] | select(.createdAt >= \"$CURRENT_START\")] | length")
DEPLOY_FAILURES=$(echo "$DEPLOY_RUNS" | jq "[.[] | select(.createdAt >= \"$CURRENT_START\" and .conclusion == \"failure\")] | length")

# ═════════════════════════════════════════════════════════════════════════
# SECTION 5: RECOMMENDATIONS SUMMARY
# ═════════════════════════════════════════════════════════════════════════

RECOMMENDATION_COUNT=${#recommendations[@]}

# Derive a health grade
if [[ "$RECOMMENDATION_COUNT" -eq 0 ]]; then
  HEALTH_GRADE="GREEN"
elif [[ "$RECOMMENDATION_COUNT" -le 2 ]]; then
  HEALTH_GRADE="YELLOW"
else
  HEALTH_GRADE="RED"
fi

# ═════════════════════════════════════════════════════════════════════════
# OUTPUT
# ═════════════════════════════════════════════════════════════════════════

if [[ -n "$JSON_MODE" ]]; then
  # Build recommendations JSON array
  REC_JSON="[]"
  for rec in "${recommendations[@]+"${recommendations[@]}"}"; do
    REC_JSON=$(echo "$REC_JSON" | jq --arg r "$rec" '. + [$r]')
  done

  jq -n \
    --arg generated_at "$NOW_ISO" \
    --arg period "${PERIOD_DAYS}d" \
    --arg current_start "$CURRENT_START" \
    --arg prior_start "$PRIOR_START" \
    --arg environment "$ENVIRONMENT" \
    --arg health_grade "$HEALTH_GRADE" \
    --argjson prs_merged_current "$PRS_MERGED_CURRENT" \
    --argjson prs_merged_prior "$PRS_MERGED_PRIOR" \
    --argjson open_pr_count "$OPEN_PR_COUNT" \
    --argjson stale_pr_count "$STALE_PR_COUNT" \
    --argjson issues_closed_current "$ISSUES_CLOSED_CURRENT" \
    --argjson issues_closed_prior "$ISSUES_CLOSED_PRIOR" \
    --argjson total_open_issues "$TOTAL_OPEN" \
    --argjson unassigned_high_count "$UNASSIGNED_HIGH_COUNT" \
    --argjson missing_labels "$MISSING_LABELS" \
    --argjson blocked_count "$BLOCKED_COUNT" \
    --argjson in_progress_count "$IN_PROGRESS_COUNT" \
    --argjson stale_issues "$STALE_ISSUES" \
    --argjson stale_pct "$STALE_PCT" \
    --argjson priority_distribution "$PRIORITY_DIST" \
    --arg lambda_error_rate "$LAMBDA_ERROR_RATE" \
    --arg dlq_messages "$DLQ_MESSAGE_TOTAL" \
    --arg queue_depth_max "$QUEUE_DEPTH_MAX" \
    --arg processor_p99_ms "$PROCESSOR_P99_MS" \
    --arg alarms_in_alarm "$ALARMS_IN_ALARM" \
    --argjson cw_available "$CW_AVAILABLE" \
    --argjson ci_total "$CI_TOTAL" \
    --argjson ci_failures "$CI_FAILURES" \
    --argjson ci_failure_rate "$CI_FAILURE_RATE" \
    --argjson deploy_total "$DEPLOY_TOTAL" \
    --argjson deploy_failures "$DEPLOY_FAILURES" \
    --argjson recommendation_count "$RECOMMENDATION_COUNT" \
    --argjson recommendations "$REC_JSON" \
    '{
      generated_at: $generated_at,
      period: $period,
      current_period_start: $current_start,
      prior_period_start: $prior_start,
      environment: $environment,
      health_grade: $health_grade,
      delivery: {
        prs_merged: { current: $prs_merged_current, prior: $prs_merged_prior },
        open_prs: $open_pr_count,
        stale_prs: $stale_pr_count,
        issues_closed: { current: $issues_closed_current, prior: $issues_closed_prior }
      },
      queue_health: {
        total_open_issues: $total_open_issues,
        unassigned_high_priority: $unassigned_high_count,
        missing_labels: $missing_labels,
        blocked: $blocked_count,
        in_progress: $in_progress_count,
        stale_issues_over_30d: $stale_issues,
        stale_pct: $stale_pct,
        priority_distribution: $priority_distribution
      },
      reliability: {
        cloudwatch_available: $cw_available,
        lambda_error_rate_pct: $lambda_error_rate,
        dlq_messages_max: $dlq_messages,
        queue_depth_max: $queue_depth_max,
        processor_p99_ms: $processor_p99_ms,
        alarms_in_alarm: $alarms_in_alarm
      },
      ci_cd_quality: {
        ci_runs: $ci_total,
        ci_failures: $ci_failures,
        ci_failure_rate_pct: $ci_failure_rate,
        deploys: $deploy_total,
        deploy_failures: $deploy_failures
      },
      recommendations: {
        count: $recommendation_count,
        items: $recommendations
      }
    }'
  exit 0
fi

# ── Output: Markdown mode ───────────────────────────────────────────────
delta() {
  local current="$1" prior="$2"
  if [[ "$prior" -eq 0 ]]; then
    if [[ "$current" -eq 0 ]]; then echo "---"; else echo "+${current}"; fi
  else
    local diff=$((current - prior))
    local pct=$((diff * 100 / prior))
    if [[ "$diff" -ge 0 ]]; then
      echo "+${diff} (+${pct}%)"
    else
      echo "${diff} (${pct}%)"
    fi
  fi
}

report() {
  echo "# Leadership Operating Scorecard"
  echo ""
  echo "**Generated:** $NOW_ISO"
  echo "**Period:** ${PERIOD_DAYS}-day rolling window (since $CURRENT_START)"
  echo "**Environment:** $ENVIRONMENT"
  echo "**Health Grade:** $HEALTH_GRADE"
  echo ""

  # ── Delivery Throughput ──
  echo "## Delivery Throughput"
  echo ""
  echo "| Metric | Current Period | Prior Period | Delta |"
  echo "|--------|---------------|-------------|-------|"
  echo "| PRs merged | $PRS_MERGED_CURRENT | $PRS_MERGED_PRIOR | $(delta "$PRS_MERGED_CURRENT" "$PRS_MERGED_PRIOR") |"
  echo "| Issues closed | $ISSUES_CLOSED_CURRENT | $ISSUES_CLOSED_PRIOR | $(delta "$ISSUES_CLOSED_CURRENT" "$ISSUES_CLOSED_PRIOR") |"
  echo ""
  echo "| Metric | Value |"
  echo "|--------|-------|"
  echo "| Open PRs | $OPEN_PR_COUNT |"
  echo "| Stale PRs (>${THRESHOLD_PR_MERGE_DAYS}d) | $STALE_PR_COUNT |"
  echo ""

  # ── Queue Health ──
  echo "## Queue Health (Issue Backlog)"
  echo ""
  echo "| Metric | Value | Threshold |"
  echo "|--------|-------|-----------|"
  echo "| Total open issues | $TOTAL_OPEN | -- |"
  echo "| Unassigned high-priority | $UNASSIGNED_HIGH_COUNT | ${THRESHOLD_UNASSIGNED_HIGH} |"
  echo "| Missing type/priority labels | $MISSING_LABELS | -- |"
  echo "| Blocked issues | $BLOCKED_COUNT | -- |"
  echo "| In-progress issues | $IN_PROGRESS_COUNT | -- |"
  echo "| Stale issues (>30d) | $STALE_ISSUES (${STALE_PCT}%) | ${THRESHOLD_STALE_ISSUES_PCT}% |"
  echo ""
  echo "### Priority Distribution"
  echo ""
  echo "| Priority | Count |"
  echo "|----------|-------|"
  echo "$PRIORITY_DIST" | jq -r '.[] | "| \(.label) | \(.count) |"'
  echo ""

  # ── Reliability ──
  echo "## Reliability (CloudWatch)"
  echo ""
  if [[ "$CW_AVAILABLE" == "true" ]]; then
    echo "| Metric | Value | Threshold |"
    echo "|--------|-------|-----------|"
    echo "| Lambda error rate (MessageProcessor) | ${LAMBDA_ERROR_RATE}% | ${THRESHOLD_ERROR_RATE}% |"
    echo "| DLQ messages (max, period) | $DLQ_MESSAGE_TOTAL | ${THRESHOLD_DLQ_MESSAGES} |"
    echo "| Queue depth (max, period) | $QUEUE_DEPTH_MAX | ${THRESHOLD_QUEUE_DEPTH} |"
    echo "| MessageProcessor P99 latency | ${PROCESSOR_P99_MS}ms | ${THRESHOLD_P99_LATENCY_MS}ms |"
    echo "| Active alarms | $ALARMS_IN_ALARM | 0 |"
  else
    echo "_CloudWatch metrics unavailable (no AWS credentials). Skipped._"
  fi
  echo ""

  # ── CI/CD Quality ──
  echo "## CI/CD Quality"
  echo ""
  echo "| Metric | Value | Threshold |"
  echo "|--------|-------|-----------|"
  echo "| CI runs (period) | $CI_TOTAL | -- |"
  echo "| CI failures | $CI_FAILURES | -- |"
  echo "| CI failure rate | ${CI_FAILURE_RATE}% | ${THRESHOLD_CI_FAILURE_RATE}% |"
  echo "| Deploys (period) | $DEPLOY_TOTAL | -- |"
  echo "| Deploy failures | $DEPLOY_FAILURES | -- |"
  echo ""

  # ── Recommendations ──
  echo "## Reprioritization Recommendations"
  echo ""
  if [[ "$RECOMMENDATION_COUNT" -eq 0 ]]; then
    echo "No threshold breaches detected. All metrics within acceptable ranges."
  else
    echo "**${RECOMMENDATION_COUNT} threshold breach(es) detected:**"
    echo ""
    for i in "${!recommendations[@]}"; do
      echo "$((i + 1)). ${recommendations[$i]}"
    done
  fi
  echo ""

  # ── Triage Integration ──
  echo "---"
  echo ""
  echo "_This scorecard is a required input for the weekly triage review. See [LEADERSHIP-SCORECARD.md](../docs/LEADERSHIP-SCORECARD.md) and [ISSUE-GOVERNANCE.md](../docs/ISSUE-GOVERNANCE.md) for the triage process._"
  echo ""
}

MARKDOWN=$(report)
echo "$MARKDOWN"

# Append to GitHub Actions step summary if available
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  echo "$MARKDOWN" >> "$GITHUB_STEP_SUMMARY"
fi
