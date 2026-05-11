#!/usr/bin/env bash
set -euo pipefail

REQUIRED_MAJOR=20
MIN_MINOR=18
MIN_PATCH=1

CURRENT_VERSION=$(node -v | sed 's/^v//')
CURRENT_MAJOR=$(echo "$CURRENT_VERSION" | cut -d. -f1)
CURRENT_MINOR=$(echo "$CURRENT_VERSION" | cut -d. -f2)
CURRENT_PATCH=$(echo "$CURRENT_VERSION" | cut -d. -f3)

if [ "$CURRENT_MAJOR" -ne "$REQUIRED_MAJOR" ]; then
  echo "ERROR: Node $REQUIRED_MAJOR.x required (found v$CURRENT_VERSION). Run 'nvm use' from the repo root."
  exit 1
fi

if [ "$CURRENT_MINOR" -lt "$MIN_MINOR" ] || { [ "$CURRENT_MINOR" -eq "$MIN_MINOR" ] && [ "$CURRENT_PATCH" -lt "$MIN_PATCH" ]; }; then
  echo "ERROR: Node >= $REQUIRED_MAJOR.$MIN_MINOR.$MIN_PATCH required (found v$CURRENT_VERSION). Run 'nvm install' and 'nvm use'."
  exit 1
fi
