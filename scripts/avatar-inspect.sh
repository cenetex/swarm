#!/bin/bash
# Prints a single consolidated JSON object describing an avatar's current state
# (avatar record + integration statuses + secret keys + recent logs).
#
# Live mode:
#   Use --watch to render a continuously refreshing console view.
#
# Requires AWS credentials (used by scripts/test-api.sh to discover API + fetch INTERNAL_TEST_KEY).
#
# Examples:
#   ./scripts/avatar-inspect.sh staging agent-1-6yan | jq
#   ./scripts/avatar-inspect.sh staging agent-1-6yan --fast-since 24h --cloudwatch-since 7d | jq
#   ./scripts/avatar-inspect.sh staging agent-1-6yan --cloudwatch-query twitter_post --events-limit 50 | jq
#
# Live view:
#   ./scripts/avatar-inspect.sh staging agent-1-6yan --watch --interval 10

set -euo pipefail

ENV=${1:-staging}
AVATAR_ID=${2:-}

if [ -z "$AVATAR_ID" ]; then
  echo "Usage: $0 <env> <avatarId> [--fast-since 24h] [--cloudwatch-since 48h] [--cloudwatch-query q] [--logs-limit N] [--events-limit N] [--watch] [--interval N] [--iterations N] [--no-clear]" >&2
  exit 2
fi

shift 2

FAST_SINCE="24h"
CLOUDWATCH_SINCE="48h"
CLOUDWATCH_QUERY=""
LOGS_LIMIT="200"
EVENTS_LIMIT="100"

WATCH="false"
INTERVAL_SECONDS="10"
ITERATIONS="0"
CLEAR_SCREEN="true"
REFRESH_STATIC_EVERY="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fast-since)
      FAST_SINCE=${2:-}
      shift 2
      ;;
    --cloudwatch-since)
      CLOUDWATCH_SINCE=${2:-}
      shift 2
      ;;
    --cloudwatch-query)
      CLOUDWATCH_QUERY=${2:-}
      shift 2
      ;;
    --logs-limit)
      LOGS_LIMIT=${2:-}
      shift 2
      ;;
    --events-limit)
      EVENTS_LIMIT=${2:-}
      shift 2
      ;;
    --watch)
      WATCH="true"
      shift
      ;;
    --interval)
      INTERVAL_SECONDS=${2:-}
      shift 2
      ;;
    --iterations)
      ITERATIONS=${2:-}
      shift 2
      ;;
    --refresh-static-every)
      REFRESH_STATIC_EVERY=${2:-}
      shift 2
      ;;
    --no-clear)
      CLEAR_SCREEN="false"
      shift
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

export AWS_REGION=${AWS_REGION:-us-east-1}

call_api() {
  local endpoint="$1"
  TEST_API_QUIET=1 ./scripts/test-api.sh "$ENV" "$endpoint" '{}' GET
}

gather_static_json() {
  local avatar_json integrations_json secrets_json
  avatar_json=$(call_api "avatars/${AVATAR_ID}")
  integrations_json=$(call_api "avatars/${AVATAR_ID}/integrations")
  secrets_json=$(call_api "avatars/${AVATAR_ID}/secrets")
  jq -n \
    --argjson avatar "$avatar_json" \
    --argjson integrations "$integrations_json" \
    --argjson secrets "$secrets_json" \
    '{
      avatar: $avatar,
      integrations: ($integrations.integrations // $integrations),
      secrets: $secrets
    }'
}

gather_dynamic_json() {
  local events_json fast_logs_json cloudwatch_logs_json energy_json

  events_json=$(call_api "avatars/${AVATAR_ID}/events?limit=${EVENTS_LIMIT}")
  fast_logs_json=$(call_api "avatars/${AVATAR_ID}/logs?fast=true&since=${FAST_SINCE}&limit=${LOGS_LIMIT}")
  # Energy endpoint may not exist in older deployments; fail open.
  energy_json=$(call_api "avatars/${AVATAR_ID}/energy" || echo 'null')

  local cloudwatch_endpoint
  cloudwatch_endpoint="avatars/${AVATAR_ID}/logs?since=${CLOUDWATCH_SINCE}&limit=${LOGS_LIMIT}&compact=true"
  if [ -n "$CLOUDWATCH_QUERY" ]; then
    local q
    q=$(python3 - <<PY
import urllib.parse
print(urllib.parse.quote("$CLOUDWATCH_QUERY"))
PY
)
    cloudwatch_endpoint="${cloudwatch_endpoint}&query=${q}"
  fi
  cloudwatch_logs_json=$(call_api "$cloudwatch_endpoint")

  jq -n \
    --argjson events "$events_json" \
    --argjson logsFast "$fast_logs_json" \
    --argjson logsCloudwatch "$cloudwatch_logs_json" \
    --argjson energy "$energy_json" \
    '{
      events: $events,
      energy: $energy,
      logs: {
        fast: $logsFast,
        cloudwatch: $logsCloudwatch
      }
    }'
}

gather_json() {
  local static_json dynamic_json
  static_json=$(gather_static_json)
  dynamic_json=$(gather_dynamic_json)

  jq -n \
    --arg env "$ENV" \
    --arg avatarId "$AVATAR_ID" \
    --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --argjson static "$static_json" \
    --argjson dynamic "$dynamic_json" \
    '{
      env: $env,
      avatarId: $avatarId,
      generatedAt: $generatedAt
    } + $static + $dynamic'
}

render_live() {
  local json="$1"

  if [ "$CLEAR_SCREEN" = "true" ]; then
    # Portable clear (works even when TERM is not set)
    printf '\033c'
  fi

  echo "Swarm Avatar Inspect (live)"
  echo "env=$ENV avatarId=$AVATAR_ID interval=${INTERVAL_SECONDS}s (Ctrl-C to exit)"
  echo "generatedAt=$(echo "$json" | jq -r '.generatedAt')"
  echo ""

  echo "Avatar"
  echo "$json" | jq '{avatarId: .avatar.avatarId, name: .avatar.name, enabled: .avatar.enabled, platform: .avatar.platform, inhabitantWallet: .avatar.inhabitantWallet}'
  echo ""

  echo "Integrations"
  echo "$json" | jq '{count: (.integrations|length), items: (.integrations|map({integration, status, details}) )}'
  echo ""

  echo "Secrets"
  echo "$json" | jq '{count: (if (.secrets|type)=="array" then (.secrets|length) else (0) end), keys: (if (.secrets|type)=="array" then (.secrets|map(.key?)|map(select(.!=null))) else [] end)}'
  echo ""

  echo "Events"
  echo "$json" | jq '{count: (.events.count // (.events.events|length) // 0), sample: ((.events.events // .events)|if type=="array" then .[0:5] else [] end)}'
  echo ""

  echo "Energy"
  echo "$json" | jq '.energy | {current, max, refillPerHour, nextRefillIn, refillCap}'
  echo ""

  echo "Logs (fast/DynamoDB)"
  echo "$json" | jq '{source: .logs.fast.source, count: (.logs.fast.logs|length), latest: (.logs.fast.logs[0] // null)}'
  echo ""

  echo "Logs (CloudWatch)"
  echo "$json" | jq '{source: .logs.cloudwatch.source, count: (.logs.cloudwatch.events|length), latest: (.logs.cloudwatch.events[0] // null)}'
}

if [ "$WATCH" = "true" ]; then
  i=0
  static_json=$(gather_static_json)
  while true; do
    if [ "$REFRESH_STATIC_EVERY" != "0" ] && [ "$i" -ne 0 ] && [ $((i % REFRESH_STATIC_EVERY)) -eq 0 ]; then
      static_json=$(gather_static_json)
    fi

    dynamic_json=$(gather_dynamic_json)
    json=$(jq -n \
      --arg env "$ENV" \
      --arg avatarId "$AVATAR_ID" \
      --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --argjson static "$static_json" \
      --argjson dynamic "$dynamic_json" \
      '{ env: $env, avatarId: $avatarId, generatedAt: $generatedAt } + $static + $dynamic')

    render_live "$json"

    i=$((i + 1))
    if [ "$ITERATIONS" != "0" ] && [ "$i" -ge "$ITERATIONS" ]; then
      exit 0
    fi

    sleep "$INTERVAL_SECONDS"
  done
else
  gather_json
fi
