#!/bin/bash
#
# Download Avatar-Reported Issues
#
# Downloads issues reported by avatars via report_issue tool,
# and feedback reported via report_user_feedback,
# includes surrounding logs for context, and tracks which
# issues have been downloaded.
#
# Uses CloudWatch Logs Insights for fast parallel queries across all
# log groups (single API call instead of N×filter-log-events).
#
# Usage:
#   ./scripts/download-issues.sh [staging|prod] [--all] [--errors] [--since DURATION] [--all-context] [--profile PROFILE]
#
# Options:
#   staging|prod    Environment to query (default: staging)
#   --all           Download all issues (default: only since last download)
#   --errors        Also scan for Lambda runtime errors (timeouts, crashes). Slower.
#   --since DURATION  Time window, e.g. '1h', '6h', '7d' (default: 24h for --all)
#   --all-context   Include context from all log groups (slower)
#   --profile NAME  AWS CLI profile to use
#

set -e

ENV="${1:-staging}"
DOWNLOAD_ALL=""
ALL_CONTEXT=""
SCAN_ERRORS=""
SINCE_DURATION=""
AWS_PROFILE_ARG=""

shift 0 || true

if [[ "${1:-}" == "staging" || "${1:-}" == "prod" ]]; then
  ENV="$1"
  shift
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all) DOWNLOAD_ALL="--all" ;;
    --all-context) ALL_CONTEXT="--all-context" ;;
    --errors) SCAN_ERRORS="1" ;;
    --since)
      shift
      if [[ -z "${1:-}" ]]; then
        echo "Error: --since requires a value (e.g. 1h, 6h, 7d)" >&2
        exit 2
      fi
      SINCE_DURATION="$1"
      ;;
    --profile)
      shift
      if [[ -z "${1:-}" ]]; then
        echo "Error: --profile requires a value" >&2
        exit 2
      fi
      AWS_PROFILE_ARG="--profile $1"
      ;;
    *)
      echo "Unknown arg: $1" >&2
      echo "Usage: ./scripts/download-issues.sh [staging|prod] [--all] [--errors] [--since DURATION] [--all-context] [--profile PROFILE]" >&2
      exit 2
      ;;
  esac
  shift
done

# Configuration
REGION="us-east-1"
# Build common AWS CLI args (region + optional profile)
AWS_COMMON_ARGS=(--region "${REGION}")
if [[ -n "${AWS_PROFILE_ARG}" ]]; then
  # shellcheck disable=SC2206
  AWS_COMMON_ARGS+=(${AWS_PROFILE_ARG})
fi
STATE_FILE=".issues-downloaded-${ENV}.json"
OUTPUT_DIR="issues/${ENV}"
CONTEXT_MINUTES=2  # Minutes of logs to include before/after each issue

# Parallelism controls (keep these modest to avoid CloudWatch throttling).
MAX_PARALLEL_SEARCH="${MAX_PARALLEL_SEARCH:-6}"
MAX_PARALLEL_CONTEXT="${MAX_PARALLEL_CONTEXT:-4}"
MAX_PARALLEL_EVENTS="${MAX_PARALLEL_EVENTS:-4}"

# Context scope:
# - default: only fetch context from the log group that emitted the issue/feedback event
# - --all-context: fetch context from all discovered log groups (previous behavior; slower)
CONTEXT_SCOPE="log-group"
if [[ -n "${ALL_CONTEXT}" ]]; then
  CONTEXT_SCOPE="all"
fi

# Log groups to search
# NOTE: Lambda log groups use several naming schemes:
#   - CDK default:     /aws/lambda/SwarmStack-{env}-...     (AdminApi construct)
#   - Shared handlers: /aws/lambda/swarm-{env}-...          (SharedHandlers construct)
#   - Claude Code:     /ecs/swarm-claude-code-worker-{env}   (ClaudeCodeWorker)
#                      /aws/lambda/swarm-claude-code-callback-{env}
#
# We discover broadly to avoid missing any handlers.
LOG_GROUP_PREFIXES=(
  "/aws/lambda/SwarmStack-${ENV}-"
  "/aws/lambda/swarm-${ENV}"
  "/aws/lambda/swarm-claude-code-callback-${ENV}"
  "/aws/ecs/"
  "/ecs/swarm-"
)

# Avatar-specific log groups don't have a predictable prefix (they use the avatar ID).
# Discover all /aws/lambda/ log groups and keep ones that look swarm-related by checking
# for handler suffixes used in constructs: *-message-processor, *-discord-webhook, etc.
AVATAR_HANDLER_SUFFIXES="message-processor|discord-webhook|web-chat|response-sender|media-processor|tweet-poster|telegram-webhook"

LOG_GROUPS=()
for PREFIX in "${LOG_GROUP_PREFIXES[@]}"; do
  # shellcheck disable=SC2207
  FOUND=( $(aws logs describe-log-groups \
    --log-group-name-prefix "${PREFIX}" \
    "${AWS_COMMON_ARGS[@]}" \
    --query 'logGroups[].logGroupName' \
    --output text 2>/dev/null || true) )
  for G in "${FOUND[@]}"; do
    LOG_GROUPS+=("${G}")
  done
done

# Discover avatar-specific Lambda log groups by scanning all /aws/lambda/ groups
# and matching known handler suffixes.
# shellcheck disable=SC2207
ALL_LAMBDA_GROUPS=( $(aws logs describe-log-groups \
  --log-group-name-prefix "/aws/lambda/" \
  --region "${REGION}" \
  --query 'logGroups[].logGroupName' \
  --output text 2>/dev/null || true) )
for G in "${ALL_LAMBDA_GROUPS[@]}"; do
  if echo "${G}" | grep -qE "(${AVATAR_HANDLER_SUFFIXES})$"; then
    LOG_GROUPS+=("${G}")
  fi
done

# Dedupe log groups
# shellcheck disable=SC2207
LOG_GROUPS=( $(printf '%s\n' "${LOG_GROUPS[@]}" | sort -u) )

if [[ "${#LOG_GROUPS[@]}" -eq 0 ]]; then
  echo -e "${YELLOW}No matching CloudWatch log groups found for ${ENV}.${NC}"
  echo "Tried prefixes:"; printf '  - %s\n' "${LOG_GROUP_PREFIXES[@]}"
  exit 1
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== Avatar Issue Downloader ===${NC}"
echo "Environment: ${ENV}"

# Create output directory
mkdir -p "${OUTPUT_DIR}"

# Time calculations (Insights uses epoch seconds, filter-log-events uses millis)
NOW_SEC=$(date +%s)
NOW=$((NOW_SEC * 1000))

# Parse --since into seconds
parse_duration_to_seconds() {
  local dur="$1"
  local num unit
  num=$(echo "${dur}" | grep -oE '[0-9]+')
  unit=$(echo "${dur}" | grep -oE '[a-zA-Z]+')
  case "${unit}" in
    m|min|mins) echo $((num * 60)) ;;
    h|hr|hrs|hour|hours) echo $((num * 3600)) ;;
    d|day|days) echo $((num * 86400)) ;;
    w|week|weeks) echo $((num * 604800)) ;;
    *) echo $((num * 3600)) ;;  # default to hours
  esac
}

# Determine start time
LAST_DOWNLOAD_SEC=0
if [[ -n "${SINCE_DURATION}" ]]; then
  SINCE_SEC=$(parse_duration_to_seconds "${SINCE_DURATION}")
  LAST_DOWNLOAD_SEC=$((NOW_SEC - SINCE_SEC))
  echo "Searching last ${SINCE_DURATION}..."
elif [[ -f "${STATE_FILE}" && -z "${DOWNLOAD_ALL}" ]]; then
  LAST_DOWNLOAD_MS=$(jq -r '.lastDownload // 0' "${STATE_FILE}" 2>/dev/null || echo "0")
  LAST_DOWNLOAD_SEC=$((LAST_DOWNLOAD_MS / 1000))
  echo "Last download: $(date -r ${LAST_DOWNLOAD_SEC} 2>/dev/null || echo 'never')"
else
  # Default --all to 7 days instead of epoch (scanning all time is too slow)
  LAST_DOWNLOAD_SEC=$((NOW_SEC - 604800))
  echo "Downloading issues from last 7 days..."
fi

# Temporary directory for collecting issues
ISSUES_DIR=$(mktemp -d)
MAIN_PID=$BASHPID

cleanup() {
  # Background jobs run in subshells and inherit traps.
  # Guard to ensure only the main shell performs cleanup.
  if [[ "$BASHPID" -ne "$MAIN_PID" ]] || [[ "${BASH_SUBSHELL:-0}" -ne 0 ]]; then
    return
  fi

  # Best-effort: stop any in-flight AWS calls before deleting temp dir.
  kill $(jobs -pr) 2>/dev/null || true
  wait 2>/dev/null || true
  rm -rf "${ISSUES_DIR}" 2>/dev/null || true
}

trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

echo -e "${YELLOW}Searching for issues across ${#LOG_GROUPS[@]} log groups...${NC}"

# ============================================================================
# CloudWatch Logs Insights queries (much faster than N × filter-log-events)
# ============================================================================

# Convert LOG_GROUPS array to a format aws logs start-query accepts (space-separated)
# Insights can query up to 50 log groups at once; batch if needed.
run_insights_query() {
  local query="$1"
  local label="$2"
  local output_file="$3"
  shift 3
  local groups=("$@")

  # Insights supports max 50 log groups per query
  local batch_size=50
  local batch_dir
  batch_dir=$(mktemp -d)
  local batch_idx=0

  for ((i=0; i<${#groups[@]}; i+=batch_size)); do
    local batch=("${groups[@]:i:batch_size}")
    local query_id
    query_id=$(aws logs start-query \
      --log-group-names "${batch[@]}" \
      --start-time "${LAST_DOWNLOAD_SEC}" \
      --end-time "${NOW_SEC}" \
      --query-string "${query}" \
      --limit 1000 \
      "${AWS_COMMON_ARGS[@]}" \
      --output text --query 'queryId' 2>/dev/null) || continue

    # Poll until complete
    local status="Running"
    while [[ "${status}" == "Running" || "${status}" == "Scheduled" ]]; do
      sleep 1
      local result
      result=$(aws logs get-query-results --query-id "${query_id}" "${AWS_COMMON_ARGS[@]}" --output json 2>/dev/null) || break
      status=$(echo "${result}" | jq -r '.status' 2>/dev/null)
      if [[ "${status}" == "Complete" ]]; then
        echo "${result}" > "${batch_dir}/batch_${batch_idx}.json"
      fi
    done
    batch_idx=$((batch_idx + 1))
  done

  # Merge batch results: Insights returns results as arrays of field/value pairs.
  # Convert to a flat array of objects.
  if ls "${batch_dir}"/batch_*.json &>/dev/null; then
    jq -s '[
      .[].results[] |
      [.[] | {(.field): .value}] | add
    ]' "${batch_dir}"/batch_*.json > "${output_file}" 2>/dev/null || echo "[]" > "${output_file}"
  else
    echo "[]" > "${output_file}"
  fi
  rm -rf "${batch_dir}"

  local count
  count=$(jq 'length' "${output_file}" 2>/dev/null || echo 0)
  echo "  ${label}: ${count} event(s)"
}

# Query 1: Avatar-reported issues
run_insights_query \
  'fields @timestamp, @message, @logStream, @log | filter @message like /avatar_reported_issue/ | sort @timestamp desc' \
  "Issues" \
  "${ISSUES_DIR}/insights_issues.json" \
  "${LOG_GROUPS[@]}" &

# Query 2: Avatar-reported feedback
run_insights_query \
  'fields @timestamp, @message, @logStream, @log | filter @message like /avatar_reported_feedback/ | sort @timestamp desc' \
  "Feedback" \
  "${ISSUES_DIR}/insights_feedback.json" \
  "${LOG_GROUPS[@]}" &

# Query 3: Runtime errors (only if --errors flag is set)
if [[ -n "${SCAN_ERRORS}" ]]; then
  run_insights_query \
    'fields @timestamp, @message, @logStream, @log | filter @message like /Task timed out|Runtime\.ExitError|Runtime\.UnhandledPromiseRejection|Runtime\.HandlerNotFound|"errorType"/ | sort @timestamp desc' \
    "Runtime errors" \
    "${ISSUES_DIR}/insights_errors.json" \
    "${LOG_GROUPS[@]}" &
else
  echo "[]" > "${ISSUES_DIR}/insights_errors.json"
fi

wait || true

# ============================================================================
# Legacy paginated search (kept for fallback / context fetching)
# ============================================================================

paginated_filter_log_events() {
  local log_group="$1"
  local filter_pattern="$2"
  local output_file="$3"
  local tag="$4"

  local token=""
  local page_dir
  page_dir=$(mktemp -d)
  local page_idx=0

  while true; do
    local token_arg=()
    if [[ -n "${token}" ]]; then
      token_arg=(--next-token "${token}")
    fi

    local raw_output
    raw_output=$(aws logs filter-log-events \
      --log-group-name "${log_group}" \
      --start-time "$((LAST_DOWNLOAD_SEC * 1000))" \
      --filter-pattern "${filter_pattern}" \
      "${AWS_COMMON_ARGS[@]}" \
      "${token_arg[@]}" \
      --output json 2>/dev/null) || break

    echo "${raw_output}" \
      | jq --arg lg "${tag}" '.events // [] | map(. + {logGroupName: $lg})' \
      > "${page_dir}/page_${page_idx}.json" 2>/dev/null || true

    token=$(echo "${raw_output}" | jq -r '.nextToken // empty' 2>/dev/null || true)
    page_idx=$((page_idx + 1))

    if [[ -z "${token}" ]]; then
      break
    fi
  done

  if [[ ${page_idx} -eq 0 ]]; then
    echo "[]" > "${output_file}"
  else
    jq -s 'add // []' "${page_dir}"/*.json > "${output_file}" 2>/dev/null || echo "[]" > "${output_file}"
  fi
  rm -rf "${page_dir}"
}

fetch_context_logs_for_groups() {
  local start_time="$1"
  local end_time="$2"
  shift 2
  local groups=("$@")

  local context_dir
  context_dir=$(mktemp -d)

  local idx=0
  for lg in "${groups[@]}"; do
    while [[ $(jobs -rp | wc -l | tr -d ' ') -ge "${MAX_PARALLEL_CONTEXT}" ]]; do
      sleep 0.1
    done
    aws logs filter-log-events \
      --log-group-name "${lg}" \
      --start-time "${start_time}" \
      --end-time "${end_time}" \
      "${AWS_COMMON_ARGS[@]}" \
      --query 'events[*].{timestamp: timestamp, message: message, logStream: logStreamName}' \
      --output json 2>/dev/null > "${context_dir}/ctx_${idx}.json" || echo "[]" > "${context_dir}/ctx_${idx}.json" &
    idx=$((idx + 1))
  done

  wait || true

  jq -s 'add | sort_by(.timestamp)' "${context_dir}"/*.json 2>/dev/null || echo "[]"
  rm -rf "${context_dir}"
}

# ============================================================================
# Normalize Insights results into a common format
# ============================================================================
# Insights returns: [{"@timestamp": "...", "@message": "...", "@logStream": "...", "@log": "account:group"}]
# Normalize to: [{"timestamp": ms, "message": "...", "logStreamName": "...", "logGroupName": "..."}]
normalize_insights() {
  local input_file="$1"
  jq '[
    .[] | {
      timestamp: (if (."@timestamp" | test("^[0-9]+$")) then (."@timestamp" | tonumber)
                 else ((."@timestamp" // "" | sub("\\.[0-9]+$"; "") | sub(" "; "T") + "Z") | fromdateiso8601 * 1000) end),
      message: (."@message" // ""),
      logStreamName: (."@logStream" // ""),
      logGroupName: ((."@log" // "") | split(":") | if length > 1 then .[1] else .[0] end),
      eventId: (."@ptr" // (."@timestamp" + (."@message" | .[0:32])))
    }
  ]' "${input_file}" 2>/dev/null || echo "[]"
}

MERGED_ISSUES=$(normalize_insights "${ISSUES_DIR}/insights_issues.json")
MERGED_FEEDBACK=$(normalize_insights "${ISSUES_DIR}/insights_feedback.json")
RUNTIME_ERRORS=$(normalize_insights "${ISSUES_DIR}/insights_errors.json")

ISSUE_COUNT=$(echo "${MERGED_ISSUES}" | jq 'length // 0' 2>/dev/null || echo "0")
FEEDBACK_COUNT=$(echo "${MERGED_FEEDBACK}" | jq 'length // 0' 2>/dev/null || echo "0")
ERROR_COUNT=$(echo "${RUNTIME_ERRORS}" | jq 'length // 0' 2>/dev/null || echo "0")

if [[ "${ISSUE_COUNT}" -eq 0 && "${FEEDBACK_COUNT}" -eq 0 && "${ERROR_COUNT}" -eq 0 ]]; then
  echo -e "${GREEN}No new issues/feedback/errors found.${NC}"
  # Update state file
  echo "{\"lastDownload\": ${NOW}, \"issuesDownloaded\": 0, \"feedbackDownloaded\": 0, \"errorsDownloaded\": 0}" > "${STATE_FILE}"
  exit 0
fi

echo -e "${YELLOW}Found ${ISSUE_COUNT} issue(s), ${FEEDBACK_COUNT} feedback event(s), and ${ERROR_COUNT} runtime error(s). Downloading with context...${NC}"

process_event() {
  local EVENT="$1"

  # Parse issue details
  local TIMESTAMP
  local MESSAGE
  local LOG_STREAM
  local EVENT_ID
  local EVENT_LOG_GROUP
  TIMESTAMP=$(echo "${EVENT}" | jq -r '.timestamp')
  MESSAGE=$(echo "${EVENT}" | jq -r '.message')
  LOG_STREAM=$(echo "${EVENT}" | jq -r '.logStreamName')
  EVENT_ID=$(echo "${EVENT}" | jq -r '.eventId // ""')
  EVENT_LOG_GROUP=$(echo "${EVENT}" | jq -r '.logGroupName // ""')
  
  # Parse the JSON message
  local DATA
  DATA=$(echo "${MESSAGE}" | grep -o '{.*}' | head -1)
  if [[ -z "${DATA}" ]]; then
    return
  fi

  local EVENT_NAME
  EVENT_NAME=$(echo "${DATA}" | jq -r '.event // ""')

  if [[ "${EVENT_NAME}" == "avatar_reported_issue" ]]; then
    local AVATAR_ID SEVERITY CATEGORY TITLE
    AVATAR_ID=$(echo "${DATA}" | jq -r '.avatarId // .agentId // "unknown"')
    SEVERITY=$(echo "${DATA}" | jq -r '.issue.severity // "unknown"')
    CATEGORY=$(echo "${DATA}" | jq -r '.issue.category // "unknown"')
    TITLE=$(echo "${DATA}" | jq -r '.issue.title // "No title"')

    local SHORT_ID
    SHORT_ID=$(echo -n "${EVENT_ID}" | md5 2>/dev/null || echo -n "${EVENT_ID}" | md5sum | cut -d' ' -f1)
    SHORT_ID=${SHORT_ID:0:12}
    local ISSUE_FILE
    ISSUE_FILE="${OUTPUT_DIR}/issue-${TIMESTAMP}-${AVATAR_ID}-${SHORT_ID}-${SEVERITY}.json"

    local SEVERITY_UPPER
    SEVERITY_UPPER=$(echo "${SEVERITY}" | tr '[:lower:]' '[:upper:]')
    echo -e "  ${BLUE}[${SEVERITY_UPPER}]${NC} ${TITLE} (${AVATAR_ID})"
  
  # Calculate time window for context logs
    local CONTEXT_MS START_TIME END_TIME
    CONTEXT_MS=$((CONTEXT_MINUTES * 60 * 1000))
    START_TIME=$((TIMESTAMP - CONTEXT_MS))
    END_TIME=$((TIMESTAMP + CONTEXT_MS))

    # Fetch + combine context logs (parallel, bounded)
    local CONTEXT
    if [[ "${CONTEXT_SCOPE}" == "all" || -z "${EVENT_LOG_GROUP}" ]]; then
      CONTEXT=$(fetch_context_logs_for_groups "${START_TIME}" "${END_TIME}" "${LOG_GROUPS[@]}")
    else
      CONTEXT=$(fetch_context_logs_for_groups "${START_TIME}" "${END_TIME}" "${EVENT_LOG_GROUP}")
    fi
  
  # Build full issue report
    jq -n \
      --argjson issue "${DATA}" \
      --argjson context "${CONTEXT}" \
      --arg timestamp "$(date -r $((TIMESTAMP / 1000)) '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo "${TIMESTAMP}")" \
      --arg logStream "${LOG_STREAM}" \
      --arg logGroup "${EVENT_LOG_GROUP}" \
      --arg eventId "${EVENT_ID}" \
      '{
        downloadedAt: (now | todate),
        originalTimestamp: $timestamp,
        logStream: $logStream,
        logGroup: $logGroup,
        eventId: $eventId,
        issue: $issue,
        contextLogs: $context,
        contextWindow: {
          before: "'${CONTEXT_MINUTES}' minutes",
          after: "'${CONTEXT_MINUTES}' minutes"
        }
      }' > "${ISSUE_FILE}"

    return
  fi

  if [[ "${EVENT_NAME}" == "avatar_reported_feedback" ]]; then
    local AVATAR_ID SENTIMENT FEATURE CONTENT
    AVATAR_ID=$(echo "${DATA}" | jq -r '.avatarId // .agentId // "unknown"')
    SENTIMENT=$(echo "${DATA}" | jq -r '.feedback.sentiment // "unknown"')
    FEATURE=$(echo "${DATA}" | jq -r '.feedback.feature // "unknown"')
    CONTENT=$(echo "${DATA}" | jq -r '.feedback.content // ""')

    local SHORT_ID
    SHORT_ID=$(echo -n "${EVENT_ID}" | md5 2>/dev/null || echo -n "${EVENT_ID}" | md5sum | cut -d' ' -f1)
    SHORT_ID=${SHORT_ID:0:12}
    local FEEDBACK_FILE
    FEEDBACK_FILE="${OUTPUT_DIR}/feedback-${TIMESTAMP}-${AVATAR_ID}-${SHORT_ID}-${SENTIMENT}.json"

    local SENTIMENT_UPPER
    SENTIMENT_UPPER=$(echo "${SENTIMENT}" | tr '[:lower:]' '[:upper:]')
    echo -e "  ${BLUE}[FEEDBACK:${SENTIMENT_UPPER}]${NC} ${FEATURE} (${AVATAR_ID})"

    local CONTEXT_MS START_TIME END_TIME
    CONTEXT_MS=$((CONTEXT_MINUTES * 60 * 1000))
    START_TIME=$((TIMESTAMP - CONTEXT_MS))
    END_TIME=$((TIMESTAMP + CONTEXT_MS))

    # Fetch + combine context logs (parallel, bounded)
    local CONTEXT
    if [[ "${CONTEXT_SCOPE}" == "all" || -z "${EVENT_LOG_GROUP}" ]]; then
      CONTEXT=$(fetch_context_logs_for_groups "${START_TIME}" "${END_TIME}" "${LOG_GROUPS[@]}")
    else
      CONTEXT=$(fetch_context_logs_for_groups "${START_TIME}" "${END_TIME}" "${EVENT_LOG_GROUP}")
    fi

    jq -n \
      --argjson feedback "${DATA}" \
      --argjson context "${CONTEXT}" \
      --arg timestamp "$(date -r $((TIMESTAMP / 1000)) '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo "${TIMESTAMP}")" \
      --arg logStream "${LOG_STREAM}" \
      --arg logGroup "${EVENT_LOG_GROUP}" \
      --arg eventId "${EVENT_ID}" \
      --arg feature "${FEATURE}" \
      --arg content "${CONTENT}" \
      '{
        downloadedAt: (now | todate),
        originalTimestamp: $timestamp,
        logStream: $logStream,
        logGroup: $logGroup,
        eventId: $eventId,
        feedback: $feedback,
        contextLogs: $context,
        contextWindow: {
          before: "'${CONTEXT_MINUTES}' minutes",
          after: "'${CONTEXT_MINUTES}' minutes"
        }
      }' > "${FEEDBACK_FILE}"

    return
  fi
}

# Process a runtime error event (not avatar-reported, but a Lambda crash/timeout/exception)
process_runtime_error() {
  local EVENT="$1"

  local TIMESTAMP MESSAGE LOG_STREAM EVENT_ID EVENT_LOG_GROUP
  TIMESTAMP=$(echo "${EVENT}" | jq -r '.timestamp')
  MESSAGE=$(echo "${EVENT}" | jq -r '.message')
  LOG_STREAM=$(echo "${EVENT}" | jq -r '.logStreamName')
  EVENT_ID=$(echo "${EVENT}" | jq -r '.eventId // ""')
  EVENT_LOG_GROUP=$(echo "${EVENT}" | jq -r '.logGroupName // ""')

  # Classify the error severity based on the message content
  local SEVERITY="high"
  local ERROR_TYPE="runtime_error"
  if echo "${MESSAGE}" | grep -q "Task timed out"; then
    ERROR_TYPE="timeout"
    SEVERITY="high"
  elif echo "${MESSAGE}" | grep -q "Runtime.ExitError"; then
    ERROR_TYPE="crash"
    SEVERITY="critical"
  elif echo "${MESSAGE}" | grep -q "Runtime.UnhandledPromiseRejection"; then
    ERROR_TYPE="unhandled_rejection"
    SEVERITY="critical"
  elif echo "${MESSAGE}" | grep -q "Runtime.HandlerNotFound"; then
    ERROR_TYPE="handler_not_found"
    SEVERITY="critical"
  fi

  # Derive a short label from the log group name
  local SOURCE
  SOURCE=$(echo "${EVENT_LOG_GROUP}" | sed 's|.*/||')

  # Truncate message for display
  local SHORT_MSG
  SHORT_MSG=$(echo "${MESSAGE}" | head -c 120 | tr '\n' ' ')

  local SEVERITY_UPPER
  SEVERITY_UPPER=$(echo "${SEVERITY}" | tr '[:lower:]' '[:upper:]')
  echo -e "  ${RED}[${SEVERITY_UPPER}:${ERROR_TYPE}]${NC} ${SHORT_MSG} (${SOURCE})"

  local SHORT_ID
  SHORT_ID=$(echo -n "${EVENT_ID}" | md5 2>/dev/null || echo -n "${EVENT_ID}" | md5sum | cut -d' ' -f1)
  SHORT_ID=${SHORT_ID:0:12}
  local ERROR_FILE
  ERROR_FILE="${OUTPUT_DIR}/error-${TIMESTAMP}-${SOURCE}-${SHORT_ID}-${SEVERITY}.json"

  local CONTEXT_MS START_TIME END_TIME
  CONTEXT_MS=$((CONTEXT_MINUTES * 60 * 1000))
  START_TIME=$((TIMESTAMP - CONTEXT_MS))
  END_TIME=$((TIMESTAMP + CONTEXT_MS))

  local CONTEXT
  if [[ "${CONTEXT_SCOPE}" == "all" || -z "${EVENT_LOG_GROUP}" ]]; then
    CONTEXT=$(fetch_context_logs_for_groups "${START_TIME}" "${END_TIME}" "${LOG_GROUPS[@]}")
  else
    CONTEXT=$(fetch_context_logs_for_groups "${START_TIME}" "${END_TIME}" "${EVENT_LOG_GROUP}")
  fi

  jq -n \
    --arg message "${MESSAGE}" \
    --arg errorType "${ERROR_TYPE}" \
    --arg severity "${SEVERITY}" \
    --argjson context "${CONTEXT}" \
    --arg timestamp "$(date -r $((TIMESTAMP / 1000)) '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo "${TIMESTAMP}")" \
    --arg logStream "${LOG_STREAM}" \
    --arg logGroup "${EVENT_LOG_GROUP}" \
    --arg eventId "${EVENT_ID}" \
    --arg source "${SOURCE}" \
    '{
      downloadedAt: (now | todate),
      originalTimestamp: $timestamp,
      logStream: $logStream,
      logGroup: $logGroup,
      eventId: $eventId,
      source: $source,
      error: {
        type: $errorType,
        severity: $severity,
        message: $message
      },
      contextLogs: $context,
      contextWindow: {
        before: "'${CONTEXT_MINUTES}' minutes",
        after: "'${CONTEXT_MINUTES}' minutes"
      }
    }' > "${ERROR_FILE}"
}

# Process avatar-reported issues
while read -r EVENT; do
  while [[ $(jobs -rp | wc -l | tr -d ' ') -ge "${MAX_PARALLEL_EVENTS}" ]]; do
    sleep 0.1
  done
  process_event "${EVENT}" &
done < <(echo "${MERGED_ISSUES}" | jq -c '.[]' 2>/dev/null)

# Process avatar-reported feedback
while read -r EVENT; do
  while [[ $(jobs -rp | wc -l | tr -d ' ') -ge "${MAX_PARALLEL_EVENTS}" ]]; do
    sleep 0.1
  done
  process_event "${EVENT}" &
done < <(echo "${MERGED_FEEDBACK}" | jq -c '.[]' 2>/dev/null)

# Process runtime errors (deduped)
while read -r EVENT; do
  while [[ $(jobs -rp | wc -l | tr -d ' ') -ge "${MAX_PARALLEL_EVENTS}" ]]; do
    sleep 0.1
  done
  process_runtime_error "${EVENT}" &
done < <(echo "${RUNTIME_ERRORS}" | jq -c '.[]' 2>/dev/null)

wait || true

# Update state file (store millis for backward compat)
echo "{\"lastDownload\": ${NOW}, \"issuesDownloaded\": ${ISSUE_COUNT}, \"feedbackDownloaded\": ${FEEDBACK_COUNT}, \"errorsDownloaded\": ${ERROR_COUNT}}" > "${STATE_FILE}"

echo ""
echo -e "${GREEN}Downloaded ${ISSUE_COUNT} issue(s), ${FEEDBACK_COUNT} feedback event(s), and ${ERROR_COUNT} runtime error(s) to ${OUTPUT_DIR}/${NC}"
echo ""

# Summary by severity (avatar-reported issues)
echo -e "${BLUE}Summary by severity (avatar-reported issues):${NC}"
for SEV in critical high medium low; do
  COUNT=$(ls -1 "${OUTPUT_DIR}"/issue-*-${SEV}.json 2>/dev/null | wc -l | tr -d ' ')
  if [[ "${COUNT}" -gt 0 ]]; then
    case "${SEV}" in
      critical) echo -e "  ${RED}CRITICAL: ${COUNT}${NC}" ;;
      high) echo -e "  ${YELLOW}HIGH: ${COUNT}${NC}" ;;
      medium) echo -e "  ${BLUE}MEDIUM: ${COUNT}${NC}" ;;
      low) echo -e "  ${GREEN}LOW: ${COUNT}${NC}" ;;
    esac
  fi
done

echo ""
echo -e "${BLUE}Summary by severity (runtime errors):${NC}"
for SEV in critical high medium low; do
  COUNT=$(ls -1 "${OUTPUT_DIR}"/error-*-${SEV}.json 2>/dev/null | wc -l | tr -d ' ')
  if [[ "${COUNT}" -gt 0 ]]; then
    case "${SEV}" in
      critical) echo -e "  ${RED}CRITICAL: ${COUNT}${NC}" ;;
      high) echo -e "  ${YELLOW}HIGH: ${COUNT}${NC}" ;;
      medium) echo -e "  ${BLUE}MEDIUM: ${COUNT}${NC}" ;;
      low) echo -e "  ${GREEN}LOW: ${COUNT}${NC}" ;;
    esac
  fi
done

echo ""
echo -e "${BLUE}Summary by feedback sentiment:${NC}"
for S in positive negative neutral unknown; do
  COUNT=$(ls -1 "${OUTPUT_DIR}"/feedback-*-${S}.json 2>/dev/null | wc -l | tr -d ' ')
  if [[ "${COUNT}" -gt 0 ]]; then
    echo "  ${S}: ${COUNT}"
  fi
done

echo ""
echo "Results saved to: ${OUTPUT_DIR}/"
echo "To view an issue:  cat ${OUTPUT_DIR}/issue-*.json | jq"
echo "To view an error:  cat ${OUTPUT_DIR}/error-*.json | jq"
