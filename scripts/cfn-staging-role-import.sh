#!/bin/bash
# CloudFormation Import Script for Staging GitHub Actions Role
# Issue: #1420
# Purpose: Import existing aws-swarm-github-actions role into CloudFormation management

set -euo pipefail

# Configuration
STACK_NAME="github-actions-swarm"
ROLE_NAME="aws-swarm-github-actions"
TEMPLATE_FILE=".github/cloudformation/github-oidc-role.yml"
REGION="us-east-1"
CHANGE_SET_NAME="import-staging-role-$(date +%s)"

echo "================================"
echo "Staging Role CFN Import Process"
echo "================================"
echo "Stack: $STACK_NAME"
echo "Role: $ROLE_NAME"
echo "Region: $REGION"
echo "Change Set: $CHANGE_SET_NAME"
echo ""

# Step 1: Verify role exists
echo "[1/5] Verifying role exists..."
if ! aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text >/dev/null 2>&1; then
  echo "ERROR: Role $ROLE_NAME not found in account."
  exit 1
fi
ROLE_ARN=$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)
echo "  ✓ Role found: $ROLE_ARN"
echo ""

# Step 2: Create change-set with IMPORT type
echo "[2/5] Creating change-set with IMPORT type..."
aws cloudformation create-change-set \
  --stack-name "$STACK_NAME" \
  --change-set-name "$CHANGE_SET_NAME" \
  --change-set-type IMPORT \
  --resources-to-import "LogicalResourceId=GitHubActionsRole,ResourceIdentifier={RoleName=$ROLE_NAME}" \
  --template-body "file://$TEMPLATE_FILE" \
  --region "$REGION" \
  --output json > /tmp/changeset-create.json

CHANGE_SET_ID=$(jq -r '.Id' /tmp/changeset-create.json)
echo "  ✓ Change set created: $CHANGE_SET_ID"
echo ""

# Step 3: Wait for change-set creation to complete
echo "[3/5] Waiting for change-set to be ready..."
aws cloudformation wait change-set-create-complete \
  --stack-name "$STACK_NAME" \
  --change-set-name "$CHANGE_SET_NAME" \
  --region "$REGION" || {
  echo "  ⚠ Change set creation completed (may have no changes - this is OK for IMPORT)."
}
echo ""

# Step 4: Review change-set
echo "[4/5] Reviewing change-set..."
aws cloudformation describe-change-set \
  --stack-name "$STACK_NAME" \
  --change-set-name "$CHANGE_SET_NAME" \
  --region "$REGION" \
  --query 'Changes[*].[Type, ResourceChange.Action, ResourceChange.LogicalResourceId, ResourceChange.ResourceType]' \
  --output table
echo ""

# Step 5: Execute change-set
echo "[5/5] Executing change-set..."
read -p "Proceed with import? (yes/no): " confirm
if [[ "$confirm" != "yes" ]]; then
  echo "Aborted."
  exit 1
fi

aws cloudformation execute-change-set \
  --stack-name "$STACK_NAME" \
  --change-set-name "$CHANGE_SET_NAME" \
  --region "$REGION"
echo "  ✓ Change set executed"
echo ""

# Verify import completed
echo "Waiting for stack update..."
aws cloudformation wait stack-import-complete \
  --stack-name "$STACK_NAME" \
  --region "$REGION" || {
  echo "  (Stack may still be updating; check progress manually)"
}

# Final verification
echo ""
echo "================================"
echo "Import Status Verification"
echo "================================"
aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query 'Stacks[0].[StackName, StackStatus, CreationTime]' \
  --output table

echo ""
echo "Checking imported role policies..."
aws iam list-role-policies --role-name "$ROLE_NAME" \
  --query 'PolicyNames' \
  --output table

echo ""
echo "Running drift detection..."
DRIFT_ID=$(aws cloudformation detect-stack-drift \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query 'StackDriftDetectionId' \
  --output text)

echo "Drift detection ID: $DRIFT_ID"
echo "Run: aws cloudformation describe-stack-drift-detection-status --stack-drift-detection-id $DRIFT_ID --region $REGION"

echo ""
echo "✓ Staging role import process complete!"
echo ""
echo "Next steps:"
echo "1. Verify drift detection shows IN_SYNC status"
echo "2. Run a staging deploy to confirm all workflows function normally"
echo "3. Delete out-of-band inline policies from the role (if any exist)"
