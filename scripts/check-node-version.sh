#!/usr/bin/env bash
MIN_MAJOR=20
CURRENT=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$CURRENT" -lt "$MIN_MAJOR" ]; then
  echo "ERROR: Node >= $MIN_MAJOR required (found $(node -v)). Use 'nvm use' to switch."
  exit 1
fi
