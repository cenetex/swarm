#!/bin/bash
# Wrapper script to run vitest instead of bun's native test runner
# Usage: ./scripts/test.sh [vitest args...]

exec pnpm -r test "$@"
