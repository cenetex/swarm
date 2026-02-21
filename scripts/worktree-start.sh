#!/usr/bin/env bash
# Signal that work has started on an issue by pushing the branch and labeling.
#
# This bridges the gap between local worktree creation and GitHub project
# board visibility. The project-sync workflow picks up the branch create
# event and moves the issue to "In progress".
#
# Usage:
#   scripts/worktree-start.sh <issue-number> [branch-name]
#
# What it does:
#   1. Pushes the current branch to origin (triggers project-sync create event)
#   2. Adds status:in-progress label to the issue
#   3. Prints confirmation with issue + branch info
#
# The branch name is optional — defaults to the current branch. If the branch
# doesn't contain the issue number, a warning is printed (project-sync uses
# the branch name to link issues).
#
# Examples:
#   # From inside a worktree on branch fix/issue-310-heartbeat-null-tablename
#   scripts/worktree-start.sh 310
#
#   # Explicit branch (e.g. before checkout)
#   scripts/worktree-start.sh 310 fix/issue-310-heartbeat-null-tablename

set -euo pipefail

# ── Colors ──────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

if [ $# -lt 1 ]; then
  echo "Usage: $0 <issue-number> [branch-name]" >&2
  exit 1
fi

ISSUE_NUMBER="$1"
BRANCH="${2:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")}"

if [ -z "$BRANCH" ] || [ "$BRANCH" = "HEAD" ]; then
  echo -e "${RED}Error: not on a branch. Pass branch name as second arg.${NC}" >&2
  exit 1
fi

# Validate issue exists
if ! gh issue view "$ISSUE_NUMBER" --json number >/dev/null 2>&1; then
  echo -e "${RED}Error: issue #$ISSUE_NUMBER not found${NC}" >&2
  exit 1
fi

# Warn if branch doesn't contain the issue number (project-sync won't link it)
if ! echo "$BRANCH" | grep -qE "issue-${ISSUE_NUMBER}[^0-9]|issue-${ISSUE_NUMBER}$"; then
  echo -e "${YELLOW}Warning: branch '$BRANCH' doesn't contain 'issue-$ISSUE_NUMBER'${NC}"
  echo -e "${YELLOW}  project-sync uses branch name to link issues — consider renaming${NC}"
fi

# Step 1: Push branch to origin (triggers project-sync create event)
echo "Pushing branch '$BRANCH' to origin..."
if git push -u origin "$BRANCH" 2>/dev/null; then
  echo -e "${GREEN}  Branch pushed${NC}"
else
  echo -e "${YELLOW}  Branch already exists on origin (or push failed)${NC}"
fi

# Step 2: Add status:in-progress label
echo "Labeling issue #$ISSUE_NUMBER..."
if gh issue edit "$ISSUE_NUMBER" --add-label "status:in-progress" 2>/dev/null; then
  echo -e "${GREEN}  Added status:in-progress label${NC}"
else
  echo -e "${YELLOW}  Label may already be set (or edit failed)${NC}"
fi

# Summary
ISSUE_TITLE=$(gh issue view "$ISSUE_NUMBER" --json title --jq '.title' 2>/dev/null || echo "?")
echo ""
echo -e "${GREEN}Issue #$ISSUE_NUMBER is now visible as In Progress on the project board${NC}"
echo "  Issue:  #$ISSUE_NUMBER — $ISSUE_TITLE"
echo "  Branch: $BRANCH"
