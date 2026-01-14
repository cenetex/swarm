#!/bin/bash
#
# Test API endpoints directly via API Gateway (bypassing Cloudflare)
#
# Usage:
#   ./scripts/test-api.sh staging chat '{"message":"hello","history":[]}'
#   ./scripts/test-api.sh staging agents
#   ./scripts/test-api.sh dev chat '{"message":"hi","history":[],"agent":{"id":"my-agent"}}'
#

set -e

ENV=${1:-staging}
ENDPOINT=${2:-chat}
BODY=${3:-'{}'}
METHOD=${4:-POST}

# Get the API Gateway URL
API_URL=$(aws apigatewayv2 get-apis --output json | jq -r ".Items[] | select(.Name | contains(\"$ENV\")) | select(.Name | contains(\"Admin\")) | .ApiEndpoint")

if [ -z "$API_URL" ]; then
  echo "Error: Could not find API Gateway for environment: $ENV"
  exit 1
fi

# Get the internal test key from Lambda environment
# Use CloudFormation to find the function name (more reliable and requires fewer permissions)
STACK_NAME="SwarmStack-$ENV"
FUNCTION_NAME=$(aws cloudformation describe-stack-resources \
  --stack-name "$STACK_NAME" \
  --query "StackResources[?ResourceType=='AWS::Lambda::Function' && contains(LogicalResourceId, 'ChatHandler')].PhysicalResourceId" \
  --output text 2>/dev/null | head -1)

if [ -z "$FUNCTION_NAME" ]; then
  echo "Error: Could not find ChatHandler Lambda in stack: $STACK_NAME"
  exit 1
fi

INTERNAL_TEST_KEY=$(aws lambda get-function-configuration --function-name "$FUNCTION_NAME" --query "Environment.Variables.INTERNAL_TEST_KEY" --output text)

if [ -z "$INTERNAL_TEST_KEY" ] || [ "$INTERNAL_TEST_KEY" == "None" ]; then
  echo "Error: INTERNAL_TEST_KEY not set for $FUNCTION_NAME"
  echo "This might be a production environment (internal testing disabled)"
  exit 1
fi

echo "Testing $ENV API: $API_URL/$ENDPOINT"
echo "Method: $METHOD"
echo "Body: $BODY"
echo ""

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

echo "Status: $HTTP_CODE"

# Try to pretty-print as JSON, fall back to plain text
if echo "$BODY_RESPONSE" | jq . 2>/dev/null; then
  : # Already printed by jq
else
  echo "Response: $BODY_RESPONSE"
fi

# Exit with error if non-2xx status
if [[ "$HTTP_CODE" -lt 200 ]] || [[ "$HTTP_CODE" -ge 300 ]]; then
  exit 1
fi
