#!/bin/bash
#
# Test API endpoints directly via API Gateway (bypassing upstream auth/CDN layers)
#
# Usage:
#   ./scripts/test-api.sh staging chat '{"message":"hello","history":[]}'
#   ./scripts/test-api.sh staging avatars
#   ./scripts/test-api.sh dev chat '{"message":"hi","history":[],"agent":{"id":"my-avatar"}}'
#

set -euo pipefail

ENV=${1:-staging}
ENDPOINT=${2:-chat}
BODY=${3:-'{}'}
METHOD=${4:-POST}

TEST_API_QUIET=${TEST_API_QUIET:-}
STACK_HASH=${STACK_HASH:-${SWARM_STACK_HASH:-}}

STACK_SUFFIX=""
if [ -n "$STACK_HASH" ]; then
  STACK_SUFFIX="-$STACK_HASH"
fi

# Optional override for environments where AWS discovery isn't available (e.g. CI)
# Example:
#   SWARM_ADMIN_API_URL="https://xxxx.execute-api.us-east-1.amazonaws.com" ./scripts/test-api.sh staging chat '{"message":"hi","history":[]}'
SWARM_ADMIN_API_URL=${SWARM_ADMIN_API_URL:-${API_URL:-}}
SWARM_INTERNAL_TEST_KEY=${SWARM_INTERNAL_TEST_KEY:-${INTERNAL_TEST_KEY:-}}

STACK_NAME=${STACK_NAME:-"SwarmStack-$ENV$STACK_SUFFIX"}

function _warn() {
  echo "[test-api] $1" >&2
}

function _has_aws_creds() {
  aws sts get-caller-identity --output json >/dev/null 2>&1
}

API_URL=""

# If provided explicitly, trust the override.
if [ -n "$SWARM_ADMIN_API_URL" ]; then
  API_URL="$SWARM_ADMIN_API_URL"
fi

# Get the API URL.
# Prefer the raw API Gateway endpoint (bypasses custom domains and edge layers).
if [ -z "$API_URL" ]; then
  if ! _has_aws_creds; then
    _warn "AWS credentials not available; cannot auto-discover API URL."
    _warn "Set SWARM_ADMIN_API_URL (or API_URL) to the Admin API base URL."
  fi
fi

AWS_REGION_EFFECTIVE=${AWS_REGION:-${AWS_DEFAULT_REGION:-""}}
if [ -z "$API_URL" ] && [ -z "$AWS_REGION_EFFECTIVE" ]; then
  _warn "AWS region not set; set AWS_REGION (or AWS_DEFAULT_REGION) for discovery."
fi

if [ -z "$API_URL" ] && _has_aws_creds && [ -n "$AWS_REGION_EFFECTIVE" ]; then
  API_ID=$(aws cloudformation describe-stack-resources \
    --stack-name "$STACK_NAME" \
    --query "StackResources[?ResourceType=='AWS::ApiGatewayV2::Api' && contains(LogicalResourceId, 'AdminApi')].PhysicalResourceId | [0]" \
    --output text 2>/dev/null || true)

  if [ -n "$API_ID" ] && [ "$API_ID" != "None" ]; then
    API_URL=$(aws apigatewayv2 get-api \
      --api-id "$API_ID" \
      --query "ApiEndpoint" \
      --output text 2>/dev/null || true)
  fi
fi

if [ -z "$API_URL" ] && _has_aws_creds && [ -n "$AWS_REGION_EFFECTIVE" ]; then
  # Fallback: CloudFormation output export (may be a custom domain)
  API_URL=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query "Stacks[0].Outputs[?ExportName=='swarm-admin-api-url-${ENV}${STACK_SUFFIX}'].OutputValue | [0]" \
    --output text 2>/dev/null || true)
fi

if [ -z "$API_URL" ] && _has_aws_creds && [ -n "$AWS_REGION_EFFECTIVE" ]; then
  # Last resort: legacy name-matching on APIGW list
  API_URL=$(aws apigatewayv2 get-apis --output json 2>/dev/null | \
    jq -r ".Items[] | select(.Name | contains(\"$ENV\")) | select(.Name | contains(\"Admin\")) | .ApiEndpoint" | head -1)
fi

if [ -z "$API_URL" ] || [ "$API_URL" = "None" ] || [ "$API_URL" = "null" ]; then
  echo "Error: Could not find API URL for environment: $ENV"
  echo "Hint: Ensure stack '$STACK_NAME' is deployed and includes an Admin API (AWS::ApiGatewayV2::Api)."
  if ! _has_aws_creds; then
    echo "Hint: AWS credentials are not available in this environment."
  fi
  if [ -z "$AWS_REGION_EFFECTIVE" ]; then
    echo "Hint: AWS region not set (AWS_REGION/AWS_DEFAULT_REGION)."
  fi
  echo "Hint: You can bypass discovery by setting SWARM_ADMIN_API_URL=https://..."
  exit 1
fi

# Get the internal test key from Lambda environment
# Use CloudFormation to find the function name (more reliable and requires fewer permissions)
if [ -n "$SWARM_INTERNAL_TEST_KEY" ]; then
  INTERNAL_TEST_KEY="$SWARM_INTERNAL_TEST_KEY"
else
  if ! _has_aws_creds; then
    echo "Error: AWS credentials not available to fetch INTERNAL_TEST_KEY from Lambda."
    echo "Hint: Provide SWARM_INTERNAL_TEST_KEY to bypass Lambda lookup, or configure AWS credentials."
    exit 1
  fi

  # Get the internal test key from Lambda environment
  # Use CloudFormation to find the function name (more reliable and requires fewer permissions)
  FUNCTION_NAME=$(aws cloudformation describe-stack-resources \
    --stack-name "$STACK_NAME" \
    --query "StackResources[?ResourceType=='AWS::Lambda::Function' && contains(LogicalResourceId, 'ChatHandler')].PhysicalResourceId" \
    --output text 2>/dev/null | head -1)

  if [ -z "$FUNCTION_NAME" ]; then
    echo "Error: Could not find ChatHandler Lambda in stack: $STACK_NAME"
    exit 1
  fi

  INTERNAL_TEST_KEY=$(aws lambda get-function-configuration --function-name "$FUNCTION_NAME" --query "Environment.Variables.INTERNAL_TEST_KEY" --output text)
fi

if [ -z "$INTERNAL_TEST_KEY" ] || [ "$INTERNAL_TEST_KEY" == "None" ]; then
  echo "Error: INTERNAL_TEST_KEY not set for $FUNCTION_NAME"
  echo "This might be a production environment (internal testing disabled)"
  exit 1
fi

if [ -z "$TEST_API_QUIET" ]; then
  echo "Testing $ENV API: $API_URL/$ENDPOINT"
  echo "Method: $METHOD"
  echo "Body: $BODY"
  echo ""
fi

# Make request and capture response
if [ "$METHOD" == "GET" ]; then
  RESPONSE=$(curl -s -w "\n%{http_code}" "$API_URL/$ENDPOINT" \
    -H "Content-Type: application/json" \
    -H "x-internal-test-key: $INTERNAL_TEST_KEY")
else
  RESPONSE=$(curl -s -w "\n%{http_code}" "$API_URL/$ENDPOINT" \
    -X "$METHOD" \
    -H "Content-Type: application/json" \
    -H "x-internal-test-key: $INTERNAL_TEST_KEY" \
    -d "$BODY")
fi

# Split response body and status code
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY_RESPONSE=$(echo "$RESPONSE" | sed '$d')

if [ -z "$TEST_API_QUIET" ]; then
  echo "Status: $HTTP_CODE"
fi

# Try to pretty-print as JSON, fall back to plain text
if [ -z "$TEST_API_QUIET" ]; then
  if echo "$BODY_RESPONSE" | jq . 2>/dev/null; then
    : # Already printed by jq
  else
    echo "Response: $BODY_RESPONSE"
  fi
else
  if echo "$BODY_RESPONSE" | jq . 2>/dev/null; then
    : # Already printed by jq
  else
    echo "$BODY_RESPONSE"
  fi
fi

# Exit with error if non-2xx status
if [[ "$HTTP_CODE" -lt 200 ]] || [[ "$HTTP_CODE" -ge 300 ]]; then
  echo ""
  echo "::error::API request failed with status $HTTP_CODE"
  echo "=========================================="
  echo "ERROR DETAILS FOR DEBUGGING"
  echo "=========================================="
  echo "Environment: $ENV"
  echo "Endpoint: $API_URL/$ENDPOINT"
  echo "Method: $METHOD"
  echo "Request Body: $BODY"
  echo "Response Status: $HTTP_CODE"
  echo "Response Body: $BODY_RESPONSE"
  echo ""
  
  # Common error explanations
  case "$HTTP_CODE" in
    400)
      echo "Hint: 400 Bad Request - Check request body format (Zod validation)"
      ;;
    401)
      echo "Hint: 401 Unauthorized - Invalid webhook signature or missing auth"
      ;;
    403)
      echo "Hint: 403 Forbidden - IP validation failed (not from Telegram) or missing x-internal-test-key"
      echo "      For webhooks, ensure INTERNAL_TEST_KEY is set and matches header"
      ;;
    404)
      echo "Hint: 404 Not Found - Avatar doesn't exist or endpoint path is wrong"
      ;;
    500)
      echo "Hint: 500 Internal Server Error - Check Lambda logs for stack trace"
      echo "      Run: aws logs filter-log-events --log-group-name '/aws/lambda/SwarmStack-$ENV-AdminApiTelegramWebhookHandler*' --limit 20"
      ;;
    502|503|504)
      echo "Hint: $HTTP_CODE - Lambda timeout or API Gateway issue"
      echo "      Check CloudWatch metrics and Lambda duration"
      ;;
  esac
  echo "=========================================="
  exit 1
fi
