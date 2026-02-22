#!/bin/bash
# Security audit with documented exceptions
# This script runs pnpm audit and filters out documented exceptions,
# then validates the security exception registry for schema compliance
# and expiry enforcement.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ---------------------------------------------------------------------------
# Step 1: Validate the security exception registry
# ---------------------------------------------------------------------------
echo "Validating security exception registry..."
if node "$SCRIPT_DIR/validate-security-exceptions.mjs"; then
  echo "✅ Security exception registry is valid"
else
  echo "❌ Security exception registry validation failed"
  exit 1
fi
echo ""

# ---------------------------------------------------------------------------
# Step 2: Run pnpm audit
# ---------------------------------------------------------------------------
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
    echo "    - bigint-buffer (GHSA-3gc7-fjrx-p6mg) - documented in .github/policy/security-exceptions.json (SEC-EX-001)"
    echo "✅ No new high/critical vulnerabilities - PASS"
    exit 0
  fi
else
  # Failed for other reasons
  echo "❌ Security audit failed"
  cat /tmp/audit-output.txt
  exit 1
fi

