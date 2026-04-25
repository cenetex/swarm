#!/bin/bash
# Audit secrets in Secrets Manager against active avatars.
#
# Outputs a JSON list with: { name, lastAccessed, ageDays, hasMatchingAvatar }
# for every secret matching the swarm/* prefix. No deletions.
#
# Usage:
#   scripts/audit-secrets.sh staging
#   scripts/audit-secrets.sh prod
#   AWS_PROFILE=prod scripts/audit-secrets.sh prod
#   AWS_REGION=us-west-2 scripts/audit-secrets.sh staging

set -euo pipefail

ENV="${1:-staging}"
REGION="${AWS_REGION:-us-east-1}"
PROFILE="${AWS_PROFILE:-}"

if [[ "$ENV" != "staging" && "$ENV" != "prod" ]]; then
  echo "Usage: $0 <staging|prod>" >&2
  exit 1
fi

# Determine AWS CLI options
AWS_OPTS=("--region" "$REGION")
if [[ -n "$PROFILE" ]]; then
  AWS_OPTS+=("--profile" "$PROFILE")
fi

# Determine which account and table based on environment
if [[ "$ENV" == "staging" ]]; then
  STATE_TABLE="swarm-state-staging"
elif [[ "$ENV" == "prod" ]]; then
  STATE_TABLE="swarm-state-prod"
fi

# Function to get current date in seconds since epoch
now_timestamp=$(date +%s)

# Fetch all avatars from DynamoDB state table
echo "Fetching avatars from $STATE_TABLE..." >&2
avatar_ids=$(aws dynamodb scan \
  "${AWS_OPTS[@]}" \
  --table-name "$STATE_TABLE" \
  --projection-expression "id" \
  --output json | jq -r '.Items[].id.S' | sort || echo "" | sort)

echo "Found $(echo "$avatar_ids" | grep -c . || echo 0) avatars" >&2

# Convert to a set for O(1) lookup
declare -A avatar_set
while read -r avatar_id; do
  if [[ -n "$avatar_id" ]]; then
    avatar_set["$avatar_id"]=1
  fi
done <<< "$avatar_ids"

# Fetch all secrets, including LastAccessedDate
echo "Fetching secrets from Secrets Manager..." >&2
secrets=$(aws secretsmanager list-secrets \
  "${AWS_OPTS[@]}" \
  --output json \
  --filters Key=name,Values=swarm | jq '.SecretList[]')

# Process each secret
echo "Processing secrets..." >&2
result="[]"

while IFS= read -r secret; do
  if [[ -z "$secret" ]]; then
    continue
  fi

  name=$(echo "$secret" | jq -r '.Name')
  last_accessed_date=$(echo "$secret" | jq -r '.LastAccessedDate // empty')

  # Calculate age in days
  if [[ -n "$last_accessed_date" ]]; then
    # Convert ISO 8601 timestamp to seconds since epoch
    accessed_timestamp=$(date -d "$last_accessed_date" +%s 2>/dev/null || echo "$now_timestamp")
    age_days=$(( (now_timestamp - accessed_timestamp) / 86400 ))
  else
    age_days=-1  # Never accessed
  fi

  # Extract avatar ID from secret name (e.g., "swarm/agent-1-abc/..." -> "agent-1-abc")
  # Pattern: swarm/<avatarId>/...
  avatar_id=$(echo "$name" | sed -n 's/^swarm\/\([^/]*\)\/.*$/\1/p' || echo "")

  # Check if avatar exists
  has_matching_avatar=false
  if [[ -n "$avatar_id" && -n "${avatar_set[$avatar_id]:-}" ]]; then
    has_matching_avatar=true
  fi

  # Build entry
  entry=$(cat <<EOF
{
  "name": $(printf '%s\n' "$name" | jq -R .),
  "lastAccessed": $(printf '%s\n' "${last_accessed_date:-null}" | jq -R .),
  "ageDays": $age_days,
  "hasMatchingAvatar": $has_matching_avatar,
  "extractedAvatarId": $(printf '%s\n' "${avatar_id:-null}" | jq -R .)
}
EOF
)

  result=$(echo "$result" | jq ". += [$entry]")
done <<< "$(echo "$secrets")"

echo "$result" | jq '.'
