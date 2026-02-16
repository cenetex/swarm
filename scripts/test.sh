#!/bin/bash
# Wrapper script to run tests via bun
# Usage: ./scripts/test.sh [bun test args...]

exec bun test "$@"
