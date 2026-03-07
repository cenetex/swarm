#!/usr/bin/env bash

set -euo pipefail

REPO="cenetex/aws-swarm"
BRANCH="${1:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")}"

if [[ "${SKIP_ISSUE_HYGIENE:-}" == "1" || "${SKIP_ISSUE_HYGIENE:-}" == "true" ]]; then
  echo "pre-commit: SKIP_ISSUE_HYGIENE set; skipping issue hygiene check"
  exit 0
fi

if [[ -z "$BRANCH" || "$BRANCH" == "HEAD" ]]; then
  exit 0
fi

if [[ ! "$BRANCH" =~ issue-([0-9]+)([^0-9]|$) ]]; then
  exit 0
fi

ISSUE_NUMBER="${BASH_REMATCH[1]}"

warn_and_skip() {
  echo "pre-commit: warning: $1"
  echo "pre-commit: skipping issue hygiene check for #$ISSUE_NUMBER"
  exit 0
}

if ! command -v gh >/dev/null 2>&1; then
  warn_and_skip "'gh' CLI not found"
fi

if ! command -v jq >/dev/null 2>&1; then
  warn_and_skip "'jq' not found"
fi

if ! gh auth status >/dev/null 2>&1; then
  warn_and_skip "GitHub CLI is not authenticated"
fi

ISSUE_ERR="$(mktemp)"
trap 'rm -f "$ISSUE_ERR"' EXIT

if ! ISSUE_JSON="$(gh issue view "$ISSUE_NUMBER" --repo "$REPO" --json number,state,title,body,labels,url 2>"$ISSUE_ERR")"; then
  ERR_TEXT="$(cat "$ISSUE_ERR")"
  if echo "$ERR_TEXT" | grep -qiE 'could not resolve to an issue|not found|http 404'; then
    echo "ERROR: Branch '$BRANCH' references issue #$ISSUE_NUMBER, but that issue does not exist in $REPO."
    exit 1
  fi
  warn_and_skip "could not fetch issue #$ISSUE_NUMBER from GitHub (${ERR_TEXT:-unknown error})"
fi

ISSUE_TITLE="$(echo "$ISSUE_JSON" | jq -r '.title')"
ISSUE_URL="$(echo "$ISSUE_JSON" | jq -r '.url')"
ISSUE_STATE="$(echo "$ISSUE_JSON" | jq -r '.state')"
ISSUE_BODY="$(echo "$ISSUE_JSON" | jq -r '.body // ""')"

declare -a FAILURES=()

has_label_prefix() {
  local prefix="$1"
  echo "$ISSUE_JSON" | jq -e --arg prefix "$prefix" '.labels | any(.name | startswith($prefix))' >/dev/null
}

has_label_exact() {
  local label="$1"
  echo "$ISSUE_JSON" | jq -e --arg label "$label" '.labels | any(.name == $label)' >/dev/null
}

has_heading() {
  local heading="$1"
  printf '%s\n' "$ISSUE_BODY" | grep -qiE "^##[[:space:]]+${heading}\$"
}

has_checkbox() {
  printf '%s\n' "$ISSUE_BODY" | grep -qE '^[[:space:]]*-[[:space:]]\[[ xX]\]'
}

if [[ "$ISSUE_STATE" != "OPEN" ]]; then
  FAILURES+=("issue must be open (current state: $ISSUE_STATE)")
fi

if ! has_label_prefix "priority:"; then
  FAILURES+=("add a priority:* label")
fi

if ! has_label_prefix "type:"; then
  FAILURES+=("add a type:* label")
fi

if has_label_exact "status:blocked"; then
  FAILURES+=("remove status:blocked after clarifying scope and requirements")
fi

if ! has_heading "Objective"; then
  FAILURES+=("add a '## Objective' section")
fi

if ! has_heading "Scope"; then
  FAILURES+=("add a '## Scope' section")
fi

if ! has_heading "Constraints"; then
  FAILURES+=("add a '## Constraints' section")
fi

if ! has_heading "Acceptance Criteria"; then
  FAILURES+=("add a '## Acceptance Criteria' section")
fi

if ! has_checkbox; then
  FAILURES+=("include checklist items with '- [ ]' checkboxes")
fi

if [[ "${#FAILURES[@]}" -gt 0 ]]; then
  echo "ERROR: GitHub issue hygiene check failed for #$ISSUE_NUMBER — $ISSUE_TITLE"
  echo "       $ISSUE_URL"
  echo ""
  for failure in "${FAILURES[@]}"; do
    echo "  - $failure"
  done
  echo ""
  echo "Fix the issue metadata/body before committing."
  echo "Override locally only if necessary:"
  echo "  SKIP_ISSUE_HYGIENE=1 git commit ..."
  echo "  SKIP_PRECOMMIT=1 git commit ..."
  exit 1
fi

echo "pre-commit: issue hygiene OK for #$ISSUE_NUMBER"
