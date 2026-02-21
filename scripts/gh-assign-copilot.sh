#!/usr/bin/env bash
# Assign a GitHub issue to Copilot coding agent via GraphQL.
#
# Usage:
#   scripts/gh-assign-copilot.sh <issue-number>
#
# REST API does not support bot assignment — GraphQL is required.
# The Copilot bot ID is discovered dynamically via suggestedActors.

set -euo pipefail

REPO_OWNER="${GH_REPO_OWNER:-cenetex}"
REPO_NAME="${GH_REPO_NAME:-aws-swarm}"

if [ $# -lt 1 ]; then
  echo "Usage: $0 <issue-number>" >&2
  exit 1
fi

ISSUE_NUMBER="$1"

# Step 1: Get the issue node ID
ISSUE_ID=$(gh api graphql -f query="
query {
  repository(owner: \"$REPO_OWNER\", name: \"$REPO_NAME\") {
    issue(number: $ISSUE_NUMBER) { id }
  }
}" --jq '.data.repository.issue.id')

if [ -z "$ISSUE_ID" ] || [ "$ISSUE_ID" = "null" ]; then
  echo "Error: issue #$ISSUE_NUMBER not found in $REPO_OWNER/$REPO_NAME" >&2
  exit 1
fi

# Step 2: Find the Copilot bot ID from suggested actors
COPILOT_ID=$(gh api graphql -f query="
query {
  repository(owner: \"$REPO_OWNER\", name: \"$REPO_NAME\") {
    issue(number: $ISSUE_NUMBER) {
      suggestedActors(first: 20) {
        nodes {
          ... on Bot { login id }
          ... on User { login id }
        }
      }
    }
  }
}" --jq '.data.repository.issue.suggestedActors.nodes[] | select(.login == "copilot-swe-agent") | .id')

if [ -z "$COPILOT_ID" ] || [ "$COPILOT_ID" = "null" ]; then
  echo "Error: copilot-swe-agent not found in suggested actors." >&2
  echo "Ensure Copilot coding agent is enabled for $REPO_OWNER/$REPO_NAME." >&2
  exit 1
fi

# Step 3: Assign Copilot to the issue
RESULT=$(gh api graphql -f query="
mutation {
  replaceActorsForAssignable(input: {
    assignableId: \"$ISSUE_ID\",
    actorIds: [\"$COPILOT_ID\"]
  }) {
    assignable {
      ... on Issue {
        number
        assignees(first: 5) {
          nodes { login }
        }
      }
    }
  }
}" --jq '.data.replaceActorsForAssignable.assignable.assignees.nodes[].login')

echo "Issue #$ISSUE_NUMBER assigned to: $RESULT"
