#!/usr/bin/env bash
# Weekly Ticket Health Report
#
# Computes triage quality metrics for GitHub issues:
#   - Unassigned high-priority issues
#   - Issues missing type:* or priority:* labels
#   - Aging buckets (>14d, >30d, >60d)
#   - Status distribution by status:* labels
#
# Usage:
#   ./scripts/ticket-health-report.sh            # Human-readable markdown
#   ./scripts/ticket-health-report.sh --json      # Machine-readable JSON
#
# Environment:
#   GH_TOKEN or GITHUB_TOKEN must be set (gh CLI auth)
#   GITHUB_STEP_SUMMARY — if set, appends markdown to Actions job summary

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
REPO="cenetex/aws-swarm"

# ── Fetch all open issues ────────────────────────────────────────────────
# gh issue list with --json gives us structured data. Fetch up to 500 open issues.
ALL_ISSUES=$(gh issue list \
  --repo "$REPO" \
  --state open \
  --limit 500 \
  --json number,title,labels,assignees,createdAt,updatedAt)

TOTAL_COUNT=$(echo "$ALL_ISSUES" | jq 'length')

# ── 1. Unassigned high-priority issues ───────────────────────────────────
UNASSIGNED_HIGH=$(echo "$ALL_ISSUES" | jq '[
  .[] | select(
    (.assignees | length) == 0 and
    (.labels | map(.name) | any(test("^priority:high$")))
  )
]')
UNASSIGNED_HIGH_COUNT=$(echo "$UNASSIGNED_HIGH" | jq 'length')

# ── 2. Issues missing labels ────────────────────────────────────────────
# Missing = no label matching type:* OR no label matching priority:*
MISSING_TYPE=$(echo "$ALL_ISSUES" | jq '[
  .[] | select(
    (.labels | map(.name) | any(test("^type:"))) | not
  )
]')
MISSING_TYPE_COUNT=$(echo "$MISSING_TYPE" | jq 'length')

MISSING_PRIORITY=$(echo "$ALL_ISSUES" | jq '[
  .[] | select(
    (.labels | map(.name) | any(test("^priority:"))) | not
  )
]')
MISSING_PRIORITY_COUNT=$(echo "$MISSING_PRIORITY" | jq 'length')

MISSING_EITHER=$(echo "$ALL_ISSUES" | jq '[
  .[] | select(
    ((.labels | map(.name) | any(test("^type:"))) | not) or
    ((.labels | map(.name) | any(test("^priority:"))) | not)
  )
]')
MISSING_EITHER_COUNT=$(echo "$MISSING_EITHER" | jq 'length')

# ── 3. Aging buckets ────────────────────────────────────────────────────
NOW_EPOCH=$(date +%s)

age_count() {
  local days="$1"
  local cutoff_epoch=$((NOW_EPOCH - days * 86400))
  # jq: parse createdAt ISO date and compare
  echo "$ALL_ISSUES" | jq --argjson cutoff "$cutoff_epoch" '[
    .[] | select(
      (.createdAt | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) < $cutoff
    )
  ] | length'
}

AGE_14=$(age_count 14)
AGE_30=$(age_count 30)
AGE_60=$(age_count 60)

# ── 4. Status distribution ──────────────────────────────────────────────
# Count issues by each status:* label. Issues without a status:* label go into "no-status".
STATUS_DIST=$(echo "$ALL_ISSUES" | jq '
  [.[] | {
    statuses: [.labels[].name | select(startswith("status:"))]
  }] |
  map(if .statuses | length == 0 then .statuses = ["(no status)"] else . end) |
  [.[].statuses[]] |
  group_by(.) |
  map({label: .[0], count: length}) |
  sort_by(-.count)
')

# ── 5. Type distribution ────────────────────────────────────────────────
TYPE_DIST=$(echo "$ALL_ISSUES" | jq '
  [.[] | {
    types: [.labels[].name | select(startswith("type:"))]
  }] |
  map(if .types | length == 0 then .types = ["(no type)"] else . end) |
  [.[].types[]] |
  group_by(.) |
  map({label: .[0], count: length}) |
  sort_by(-.count)
')

# ── Output: JSON mode ───────────────────────────────────────────────────
if [[ -n "$JSON_MODE" ]]; then
  jq -n \
    --argjson total "$TOTAL_COUNT" \
    --argjson unassigned_high "$UNASSIGNED_HIGH" \
    --argjson unassigned_high_count "$UNASSIGNED_HIGH_COUNT" \
    --argjson missing_type_count "$MISSING_TYPE_COUNT" \
    --argjson missing_priority_count "$MISSING_PRIORITY_COUNT" \
    --argjson missing_either_count "$MISSING_EITHER_COUNT" \
    --argjson missing_either "$MISSING_EITHER" \
    --argjson age_14 "$AGE_14" \
    --argjson age_30 "$AGE_30" \
    --argjson age_60 "$AGE_60" \
    --argjson status_distribution "$STATUS_DIST" \
    --argjson type_distribution "$TYPE_DIST" \
    --arg generated_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{
      generated_at: $generated_at,
      total_open_issues: $total,
      unassigned_high_priority: {
        count: $unassigned_high_count,
        issues: [$unassigned_high[] | {number, title}]
      },
      missing_labels: {
        missing_type: $missing_type_count,
        missing_priority: $missing_priority_count,
        missing_either: $missing_either_count,
        issues: [$missing_either[] | {number, title, labels: [.labels[].name]}]
      },
      aging: {
        older_than_14d: $age_14,
        older_than_30d: $age_30,
        older_than_60d: $age_60
      },
      status_distribution: $status_distribution,
      type_distribution: $type_distribution
    }'
  exit 0
fi

# ── Output: Markdown mode ───────────────────────────────────────────────
report() {
  echo "# Ticket Health Report"
  echo ""
  echo "**Generated:** $(date -u +%Y-%m-%dT%H:%M:%SZ)  "
  echo "**Open issues:** $TOTAL_COUNT"
  echo ""

  # Section 1: Unassigned high-priority
  echo "## Unassigned High-Priority Issues ($UNASSIGNED_HIGH_COUNT)"
  echo ""
  if [[ "$UNASSIGNED_HIGH_COUNT" -eq 0 ]]; then
    echo "None -- all high-priority issues have assignees."
  else
    echo "| # | Title |"
    echo "|---|-------|"
    echo "$UNASSIGNED_HIGH" | jq -r '.[] | "| #\(.number) | \(.title) |"'
  fi
  echo ""

  # Section 2: Missing labels
  echo "## Issues Missing Labels ($MISSING_EITHER_COUNT)"
  echo ""
  echo "- Missing **type:** label: $MISSING_TYPE_COUNT"
  echo "- Missing **priority:** label: $MISSING_PRIORITY_COUNT"
  echo ""
  if [[ "$MISSING_EITHER_COUNT" -gt 0 ]]; then
    echo "<details><summary>Show issues</summary>"
    echo ""
    echo "| # | Title | Labels |"
    echo "|---|-------|--------|"
    echo "$MISSING_EITHER" | jq -r '.[] | "| #\(.number) | \(.title) | \([.labels[].name] | join(", ")) |"'
    echo ""
    echo "</details>"
  fi
  echo ""

  # Section 3: Aging buckets
  echo "## Aging Buckets"
  echo ""
  echo "| Bucket | Count |"
  echo "|--------|-------|"
  echo "| > 14 days | $AGE_14 |"
  echo "| > 30 days | $AGE_30 |"
  echo "| > 60 days | $AGE_60 |"
  echo ""

  # Section 4: Status distribution
  echo "## Status Distribution"
  echo ""
  echo "| Status | Count |"
  echo "|--------|-------|"
  echo "$STATUS_DIST" | jq -r '.[] | "| \(.label) | \(.count) |"'
  echo ""

  # Section 5: Type distribution
  echo "## Type Distribution"
  echo ""
  echo "| Type | Count |"
  echo "|------|-------|"
  echo "$TYPE_DIST" | jq -r '.[] | "| \(.label) | \(.count) |"'
  echo ""
}

MARKDOWN=$(report)
echo "$MARKDOWN"

# Append to GitHub Actions step summary if available
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  echo "$MARKDOWN" >> "$GITHUB_STEP_SUMMARY"
fi
