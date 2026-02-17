#!/bin/bash
# Security audit with documented exceptions
# This script runs pnpm audit and filters out documented exceptions

set -e

echo "Running security audit..."

# Run audit at audit-level=high and capture output
if pnpm audit --audit-level=high 2>&1 | tee /tmp/audit-output.txt; then
  echo "✅ Security audit passed - no high/critical vulnerabilities found"
  exit 0
fi

# Audit failed - check if it's only due to documented exceptions
if grep -q "GHSA-3gc7-fjrx-p6mg" /tmp/audit-output.txt; then
  # Check if there are OTHER high/critical issues besides bigint-buffer
  if grep -E "(high|critical)" /tmp/audit-output.txt | grep -v "bigint-buffer" | grep -v "GHSA-3gc7-fjrx-p6mg" > /dev/null; then
    echo "❌ Security audit failed - vulnerabilities found beyond documented exceptions"
    cat /tmp/audit-output.txt
    exit 1
  else
    echo "⚠️  Security audit found only documented exceptions:"
    echo "    - bigint-buffer (GHSA-3gc7-fjrx-p6mg) - documented in .audit-exceptions.json"
    echo "✅ No new high/critical vulnerabilities - PASS"
    exit 0
  fi
else
  # Failed for other reasons
  echo "❌ Security audit failed"
  cat /tmp/audit-output.txt
  exit 1
fi

