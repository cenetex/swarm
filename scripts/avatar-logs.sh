#!/bin/bash
# Convenience wrapper for the consolidated avatar logs endpoint.
#
# Examples:
#   ./scripts/avatar-logs.sh staging agent-1-6yan --since 48h --query twitter_post --cloudwatch
#   ./scripts/avatar-logs.sh staging agent-1-6yan --since 2h --subsystem telegram
#   ./scripts/avatar-logs.sh staging agent-1-6yan --fast --since 2h --level ERROR
#
# Notes:
# - CloudWatch mode is slow but complete.
# - Fast mode uses DynamoDB (last ~24h) and is much faster.

set -euo pipefail

ENV=${1:-staging}
AVATAR_ID=${2:-}

if [ -z "$AVATAR_ID" ]; then
  echo "Usage: $0 <env> <avatarId> [--fast|--cloudwatch] [--since 30m] [--query text] [--subsystem name] [--level LEVEL] [--limit N]" >&2
  exit 2
fi

shift 2

MODE="fast"
SINCE=""
QUERY=""
SUBSYSTEM=""
LEVEL=""
LIMIT=""
START=""
END=""
COMPACT="true"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fast)
      MODE="fast"
      shift
      ;;
    --cloudwatch|--cw)
      MODE="cloudwatch"
      shift
      ;;
    --since)
      SINCE=${2:-}
      shift 2
      ;;
    --query)
      QUERY=${2:-}
      shift 2
      ;;
    --subsystem|--component)
      SUBSYSTEM=${2:-}
      shift 2
      ;;
    --level)
      LEVEL=${2:-}
      shift 2
      ;;
    --limit)
      LIMIT=${2:-}
      shift 2
      ;;
    --start)
      START=${2:-}
      shift 2
      ;;
    --end)
      END=${2:-}
      shift 2
      ;;
    --no-compact)
      COMPACT="false"
      shift
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

urlencode() {
  python3 - <<'PY'
import sys, urllib.parse
print(urllib.parse.quote(sys.argv[1]))
PY
}

QS=""
append_qs() {
  local key="$1"
  local val="$2"
  if [ -z "$val" ]; then
    return
  fi
  local enc
  enc=$(python3 - <<PY
import urllib.parse
print(urllib.parse.quote("$val"))
PY
)
  if [ -z "$QS" ]; then
    QS="${key}=${enc}"
  else
    QS="${QS}&${key}=${enc}"
  fi
}

if [ "$MODE" = "fast" ]; then
  append_qs "fast" "true"
fi

if [ "$COMPACT" = "true" ] && [ "$MODE" = "cloudwatch" ]; then
  append_qs "compact" "true"
fi

append_qs "since" "$SINCE"
append_qs "query" "$QUERY"
append_qs "subsystem" "$SUBSYSTEM"
append_qs "level" "$LEVEL"
append_qs "limit" "$LIMIT"
append_qs "start" "$START"
append_qs "end" "$END"

ENDPOINT="avatars/${AVATAR_ID}/logs"
if [ -n "$QS" ]; then
  ENDPOINT="${ENDPOINT}?${QS}"
fi

# Default region to us-east-1 for convenience; can be overridden by AWS_REGION.
export AWS_REGION=${AWS_REGION:-us-east-1}

# Suppress test-api preamble so stdout is clean JSON.
TEST_API_QUIET=1 ./scripts/test-api.sh "$ENV" "$ENDPOINT" '{}' GET
