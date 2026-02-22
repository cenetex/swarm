#!/usr/bin/env bash
REQUIRED_MAJOR=20
CURRENT=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$CURRENT" != "$REQUIRED_MAJOR" ]; then
  echo "ERROR: Node $REQUIRED_MAJOR.x required (found $(node -v)). Use 'nvm use' to switch."
  exit 1
fi
