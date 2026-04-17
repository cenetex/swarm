#!/usr/bin/env bash
# Finalize completed agent worktrees: commit, rebase, push, and create PRs.
#
# Walks worktree directories, finds ones with uncommitted changes on
# issue branches, and for each:
#   1. Commits all changes with a conventional commit message
#   2. Rebases onto main
#   3. Pushes to origin
#   4. Creates a PR (if one doesn't exist)
#
# Usage:
#   scripts/worktree-finalize.sh [options]
#
# Options:
#   --dir PATH        Worktree base directory (default: /private/tmp)
#   --prefix PREFIX   Worktree directory prefix (default: aws-swarm-)
#   --issues N,N,...  Only finalize these issue numbers (default: all)
#   --dry-run         Show what would be done without doing it
#   --no-rebase       Skip rebase onto main (just commit + push)
#
# Examples:
#   # Finalize all worktrees in /private/tmp/aws-swarm-*
#   scripts/worktree-finalize.sh
#
#   # Finalize specific issues
#   scripts/worktree-finalize.sh --issues 310,297,287
#
#   # Dry run to preview
#   scripts/worktree-finalize.sh --dry-run

set -euo pipefail

# ── Colors ──────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

# ── Defaults ────────────────────────────────────────────────────────────
WORKTREE_DIR="/private/tmp"
WORKTREE_PREFIX="aws-swarm-"
ISSUE_FILTER=""
DRY_RUN=""
NO_REBASE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)        WORKTREE_DIR="$2"; shift 2 ;;
    --prefix)     WORKTREE_PREFIX="$2"; shift 2 ;;
    --issues)     ISSUE_FILTER="$2"; shift 2 ;;
    --dry-run)    DRY_RUN=1; shift ;;
    --no-rebase)  NO_REBASE=1; shift ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: $0 [--dir PATH] [--prefix PREFIX] [--issues N,N,...] [--dry-run] [--no-rebase]" >&2
      exit 1
      ;;
  esac
done

# Build list of issue numbers to process (empty = all).
# Uses a space-delimited string for bash-3 compatibility: macOS's /bin/bash
# is 3.2 and does not support associative arrays (`declare -A`).
FILTER_SET=""
if [ -n "$ISSUE_FILTER" ]; then
  IFS=',' read -ra NUMS <<< "$ISSUE_FILTER"
  for n in "${NUMS[@]}"; do
    FILTER_SET="${FILTER_SET} ${n} "
  done
fi

# ── Discover worktrees ──────────────────────────────────────────────────
WORKTREES=()
for dir in "${WORKTREE_DIR}/${WORKTREE_PREFIX}"*; do
  [ -d "$dir" ] || continue
  # Extract issue number from directory name (e.g., aws-swarm-310 → 310)
  num=$(basename "$dir" | sed "s/^${WORKTREE_PREFIX}//")
  if [ -n "$ISSUE_FILTER" ] && [[ "$FILTER_SET" != *" ${num} "* ]]; then
    continue
  fi
  WORKTREES+=("$dir")
done

if [ ${#WORKTREES[@]} -eq 0 ]; then
  echo "No matching worktrees found in ${WORKTREE_DIR}/${WORKTREE_PREFIX}*"
  exit 0
fi

echo -e "${BLUE}=== Worktree Finalizer ===${NC}"
echo "Found ${#WORKTREES[@]} worktree(s) to process"
echo ""

# ── Counters ────────────────────────────────────────────────────────────
FINALIZED=0
SKIPPED=0
FAILED=0
PR_URLS=()

# ── Process each worktree ──────────────────────────────────────────────
for WT_DIR in "${WORKTREES[@]}"; do
  DIR_NAME=$(basename "$WT_DIR")
  ISSUE_NUM=$(echo "$DIR_NAME" | sed "s/^${WORKTREE_PREFIX}//")
  BRANCH=$(git -C "$WT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")

  echo -e "${BLUE}--- #$ISSUE_NUM ($DIR_NAME) ---${NC}"
  echo "  Branch: $BRANCH"

  # Check for changes
  CHANGED_FILES=$(git -C "$WT_DIR" status --short 2>/dev/null)
  COMMITTED_AHEAD=$(git -C "$WT_DIR" rev-list main..HEAD --count 2>/dev/null || echo "0")
  # Subtract commits that are already on main (worktrees branched from main include main's history)
  # We only care about commits unique to this branch
  HAS_CHANGES=""
  if [ -n "$CHANGED_FILES" ]; then
    HAS_CHANGES="uncommitted"
  fi

  if [ -z "$HAS_CHANGES" ]; then
    # Check if there's a diff vs main (committed changes)
    DIFF_STAT=$(git -C "$WT_DIR" diff --stat main 2>/dev/null | tail -1)
    if [ -z "$DIFF_STAT" ]; then
      echo -e "  ${YELLOW}No changes vs main — skipping${NC}"
      SKIPPED=$((SKIPPED + 1))
      echo ""
      continue
    fi
    # Has committed-only changes (no uncommitted)
    HAS_CHANGES="committed"
  fi

  # Get issue title for PR/commit
  ISSUE_TITLE=$(gh issue view "$ISSUE_NUM" --json title --jq '.title' 2>/dev/null || echo "issue-$ISSUE_NUM")

  if [ -n "$DRY_RUN" ]; then
    echo -e "  ${YELLOW}[DRY RUN] Would finalize: $HAS_CHANGES changes${NC}"
    echo "  Issue: #$ISSUE_NUM — $ISSUE_TITLE"
    echo "  Changes:"
    if [ "$HAS_CHANGES" = "uncommitted" ]; then
      echo "$CHANGED_FILES" | sed 's/^/    /'
    fi
    git -C "$WT_DIR" diff --stat main 2>/dev/null | sed 's/^/    /'
    FINALIZED=$((FINALIZED + 1))
    echo ""
    continue
  fi

  # Step 1: Commit uncommitted changes
  if [ "$HAS_CHANGES" = "uncommitted" ]; then
    echo "  Committing changes..."
    git -C "$WT_DIR" add -A
    # Use the issue title as the commit message (it already follows conventional commit format)
    git -C "$WT_DIR" commit -m "$(cat <<EOF
${ISSUE_TITLE}

Closes #${ISSUE_NUM}

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)" 2>/dev/null || {
      echo -e "  ${RED}Commit failed — skipping${NC}"
      FAILED=$((FAILED + 1))
      echo ""
      continue
    }
    echo -e "  ${GREEN}Committed${NC}"
  fi

  # Step 2: Rebase onto main
  if [ -z "$NO_REBASE" ]; then
    echo "  Rebasing onto main..."
    git -C "$WT_DIR" fetch origin main 2>/dev/null || true
    if git -C "$WT_DIR" rebase origin/main 2>/dev/null; then
      echo -e "  ${GREEN}Rebased${NC}"
    else
      echo -e "  ${RED}Rebase conflict — aborting rebase, pushing as-is${NC}"
      git -C "$WT_DIR" rebase --abort 2>/dev/null || true
    fi
  fi

  # Step 3: Push to origin
  echo "  Pushing to origin..."
  if git -C "$WT_DIR" push -u origin "$BRANCH" --force-with-lease 2>/dev/null; then
    echo -e "  ${GREEN}Pushed${NC}"
  else
    echo -e "  ${RED}Push failed — skipping PR creation${NC}"
    FAILED=$((FAILED + 1))
    echo ""
    continue
  fi

  # Step 4: Create PR (if one doesn't already exist)
  EXISTING_PR=$(gh pr list --head "$BRANCH" --json number --jq '.[0].number' 2>/dev/null || echo "")
  if [ -n "$EXISTING_PR" ]; then
    echo -e "  ${YELLOW}PR #$EXISTING_PR already exists${NC}"
    PR_URLS+=("https://github.com/cenetex/aws-swarm/pull/$EXISTING_PR")
  else
    echo "  Creating PR..."
    # Build PR body from issue
    ISSUE_BODY=$(gh issue view "$ISSUE_NUM" --json body --jq '.body' 2>/dev/null || echo "")
    PR_URL=$(gh pr create \
      --head "$BRANCH" \
      --base main \
      --title "$ISSUE_TITLE" \
      --body "$(cat <<EOF
## Summary

Closes #${ISSUE_NUM}

${ISSUE_BODY:+### From issue description

${ISSUE_BODY}
}
## Test plan

- [ ] CI passes (lint, build, test)
- [ ] Changes reviewed for correctness

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)" 2>/dev/null) || {
      echo -e "  ${RED}PR creation failed${NC}"
      FAILED=$((FAILED + 1))
      echo ""
      continue
    }
    echo -e "  ${GREEN}Created: $PR_URL${NC}"
    PR_URLS+=("$PR_URL")
  fi

  # Step 5: Label issue as in-progress (project-sync will pick up the PR event too)
  gh issue edit "$ISSUE_NUM" --add-label "status:in-progress" 2>/dev/null || true

  FINALIZED=$((FINALIZED + 1))
  echo ""
done

# ── Summary ─────────────────────────────────────────────────────────────
echo -e "${BLUE}=== Summary ===${NC}"
echo -e "  Finalized: ${GREEN}$FINALIZED${NC}"
echo -e "  Skipped:   ${YELLOW}$SKIPPED${NC}"
echo -e "  Failed:    ${RED}$FAILED${NC}"

if [ ${#PR_URLS[@]} -gt 0 ]; then
  echo ""
  echo "PRs:"
  for url in "${PR_URLS[@]}"; do
    echo "  $url"
  done
fi
