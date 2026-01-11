#!/bin/bash
#
# Download Agent-Reported Issues
#
# Downloads issues reported by agents via report_issue tool,
# includes surrounding logs for context, and tracks which
# issues have been downloaded.
#
# Usage:
#   ./scripts/download-issues.sh [staging|prod] [--all]
#
# Options:
#   staging|prod  Environment to query (default: staging)
#   --all         Download all issues, not just new ones
#

set -e

ENV="${1:-staging}"
DOWNLOAD_ALL="${2:-}"

# Configuration
REGION="us-east-1"
STATE_FILE=".issues-downloaded-${ENV}.json"
OUTPUT_DIR="issues/${ENV}"
CONTEXT_MINUTES=2  # Minutes of logs to include before/after each issue

# Log groups to search
LOG_GROUPS=(
  "/aws/lambda/SwarmStack-${ENV}-AdminApiChatHandler374CF7F7-BqVhrni2NojN"
  "/aws/lambda/SwarmStack-${ENV}-AdminApiTelegramWebhookHandler4-CnE3CZEem1aA"
)

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== Agent Issue Downloader ===${NC}"
echo "Environment: ${ENV}"

# Create output directory
mkdir -p "${OUTPUT_DIR}"

# Get last download timestamp
LAST_DOWNLOAD=0
if [[ -f "${STATE_FILE}" && -z "${DOWNLOAD_ALL}" ]]; then
  LAST_DOWNLOAD=$(jq -r '.lastDownload // 0' "${STATE_FILE}" 2>/dev/null || echo "0")
  echo "Last download: $(date -r $((LAST_DOWNLOAD / 1000)) 2>/dev/null || echo 'never')"
else
  echo "Downloading all issues..."
fi

# Current timestamp
NOW=$(($(date +%s) * 1000))

# Temporary directory for collecting issues
ISSUES_DIR=$(mktemp -d)
trap "rm -rf ${ISSUES_DIR}" EXIT

echo -e "${YELLOW}Searching for issues...${NC}"

# Search each log group for issues
GROUP_INDEX=0
for LOG_GROUP in "${LOG_GROUPS[@]}"; do
  echo "  Checking ${LOG_GROUP}..."
  
  # Use a simpler text-based filter pattern that works with CloudWatch Logs
  # The JSON filter pattern syntax can be finicky
  aws logs filter-log-events \
    --log-group-name "${LOG_GROUP}" \
    --start-time "${LAST_DOWNLOAD}" \
    --filter-pattern '"agent_reported_issue"' \
    --region "${REGION}" \
    --query 'events[*]' \
    --output json 2>/dev/null > "${ISSUES_DIR}/group_${GROUP_INDEX}.json" || echo "[]" > "${ISSUES_DIR}/group_${GROUP_INDEX}.json"
  GROUP_INDEX=$((GROUP_INDEX + 1))
done

# Merge all JSON files into one array
MERGED_ISSUES=$(jq -s 'add // []' "${ISSUES_DIR}"/*.json 2>/dev/null || echo "[]")

# Parse and deduplicate issues - filter to only actual issue events
ISSUE_COUNT=$(echo "${MERGED_ISSUES}" | jq 'map(select(.message | contains("agent_reported_issue"))) | length // 0' 2>/dev/null || echo "0")

if [[ "${ISSUE_COUNT}" -eq 0 ]]; then
  echo -e "${GREEN}No new issues found.${NC}"
  # Update state file
  echo "{\"lastDownload\": ${NOW}, \"issuesDownloaded\": 0}" > "${STATE_FILE}"
  exit 0
fi

echo -e "${YELLOW}Found ${ISSUE_COUNT} issue(s). Downloading with context...${NC}"

# Process each issue - filter to only actual issue events
DOWNLOADED=0
echo "${MERGED_ISSUES}" | jq -c 'map(select(.message | contains("agent_reported_issue"))) | .[]' 2>/dev/null | while read -r EVENT; do
  # Parse issue details
  TIMESTAMP=$(echo "${EVENT}" | jq -r '.timestamp')
  MESSAGE=$(echo "${EVENT}" | jq -r '.message')
  LOG_STREAM=$(echo "${EVENT}" | jq -r '.logStreamName')
  
  # Parse the JSON message
  ISSUE_DATA=$(echo "${MESSAGE}" | grep -o '{.*}' | head -1)
  if [[ -z "${ISSUE_DATA}" ]]; then
    continue
  fi
  
  AGENT_ID=$(echo "${ISSUE_DATA}" | jq -r '.agentId // "unknown"')
  SEVERITY=$(echo "${ISSUE_DATA}" | jq -r '.issue.severity // "unknown"')
  CATEGORY=$(echo "${ISSUE_DATA}" | jq -r '.issue.category // "unknown"')
  TITLE=$(echo "${ISSUE_DATA}" | jq -r '.issue.title // "No title"')
  
  # Create issue filename
  ISSUE_FILE="${OUTPUT_DIR}/issue-${TIMESTAMP}-${AGENT_ID}-${SEVERITY}.json"
  
  # Display with uppercase severity
  SEVERITY_UPPER=$(echo "${SEVERITY}" | tr '[:lower:]' '[:upper:]')
  echo -e "  ${BLUE}[${SEVERITY_UPPER}]${NC} ${TITLE} (${AGENT_ID})"
  
  # Calculate time window for context logs
  CONTEXT_MS=$((CONTEXT_MINUTES * 60 * 1000))
  START_TIME=$((TIMESTAMP - CONTEXT_MS))
  END_TIME=$((TIMESTAMP + CONTEXT_MS))
  
  # Fetch context logs
  CONTEXT_LOGS=$(mktemp)
  for LOG_GROUP in "${LOG_GROUPS[@]}"; do
    aws logs filter-log-events \
      --log-group-name "${LOG_GROUP}" \
      --start-time "${START_TIME}" \
      --end-time "${END_TIME}" \
      --region "${REGION}" \
      --query 'events[*].{timestamp: timestamp, message: message, logStream: logStreamName}' \
      --output json 2>/dev/null >> "${CONTEXT_LOGS}" || true
  done
  
  # Combine context logs
  CONTEXT=$(jq -s 'add | sort_by(.timestamp)' "${CONTEXT_LOGS}" 2>/dev/null || echo "[]")
  rm -f "${CONTEXT_LOGS}"
  
  # Build full issue report
  jq -n \
    --argjson issue "${ISSUE_DATA}" \
    --argjson context "${CONTEXT}" \
    --arg timestamp "$(date -r $((TIMESTAMP / 1000)) '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo "${TIMESTAMP}")" \
    --arg logStream "${LOG_STREAM}" \
    '{
      downloadedAt: (now | todate),
      originalTimestamp: $timestamp,
      logStream: $logStream,
      issue: $issue,
      contextLogs: $context,
      contextWindow: {
        before: "'${CONTEXT_MINUTES}' minutes",
        after: "'${CONTEXT_MINUTES}' minutes"
      }
    }' > "${ISSUE_FILE}"
  
  DOWNLOADED=$((DOWNLOADED + 1))
done

# Update state file
echo "{\"lastDownload\": ${NOW}, \"issuesDownloaded\": ${ISSUE_COUNT}}" > "${STATE_FILE}"

echo ""
echo -e "${GREEN}Downloaded ${ISSUE_COUNT} issue(s) to ${OUTPUT_DIR}/${NC}"
echo ""

# Summary by severity
echo -e "${BLUE}Summary by severity:${NC}"
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
echo "Issues saved to: ${OUTPUT_DIR}/"
echo "To view an issue: cat ${OUTPUT_DIR}/issue-*.json | jq"
