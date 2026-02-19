#!/usr/bin/env bash
set -euo pipefail
# ---------------------------------------------------------------------------
# check-coverage.sh — enforce minimum test-coverage thresholds
#
# Usage:
#   bun test --coverage 2>&1 | tee /tmp/cov.txt
#   ./scripts/check-coverage.sh /tmp/cov.txt [threshold]
#
# Or pipe directly:
#   bun test --coverage 2>&1 | ./scripts/check-coverage.sh - [threshold]
#
# threshold defaults to 40 (percent).
# ---------------------------------------------------------------------------

INPUT="${1:--}"
THRESHOLD="${2:-40}"

# Read coverage output from file or stdin
if [ "$INPUT" = "-" ]; then
  COV_OUTPUT="$(cat)"
else
  COV_OUTPUT="$(cat "$INPUT")"
fi

# Extract the "All files" summary line
# Format: All files  | % Funcs | % Lines |
ALL_FILES_LINE=$(echo "$COV_OUTPUT" | grep "All files" || true)

if [ -z "$ALL_FILES_LINE" ]; then
  echo "ERROR: Could not find 'All files' line in coverage output."
  echo "       Make sure you ran: bun test --coverage"
  exit 1
fi

# Parse function and line percentages from the All files row
FUNC_PCT=$(echo "$ALL_FILES_LINE" | awk -F'|' '{gsub(/[[:space:]]/, "", $2); print $2}')
LINE_PCT=$(echo "$ALL_FILES_LINE" | awk -F'|' '{gsub(/[[:space:]]/, "", $3); print $3}')

echo "Coverage summary:"
echo "  Functions: ${FUNC_PCT}%"
echo "  Lines:     ${LINE_PCT}%"
echo "  Threshold: ${THRESHOLD}%"

FAILED=0

# Compare using awk for floating-point comparison
if echo "$FUNC_PCT $THRESHOLD" | awk '{exit !($1 < $2)}'; then
  echo "FAIL: Function coverage ${FUNC_PCT}% is below threshold ${THRESHOLD}%"
  FAILED=1
fi

if echo "$LINE_PCT $THRESHOLD" | awk '{exit !($1 < $2)}'; then
  echo "FAIL: Line coverage ${LINE_PCT}% is below threshold ${THRESHOLD}%"
  FAILED=1
fi

if [ "$FAILED" -eq 1 ]; then
  echo ""
  echo "Coverage is below the required ${THRESHOLD}% threshold."
  echo "Add tests to bring coverage above the minimum."
  exit 1
fi

echo "PASS: Coverage meets the ${THRESHOLD}% threshold."
