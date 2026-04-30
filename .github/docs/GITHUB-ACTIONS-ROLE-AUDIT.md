# GitHub Actions Role Audit & Staging CFN Import (Issue #1420)

## Objective
Bring the staging `aws-swarm-github-actions` IAM role under CloudFormation management so it tracks `.github/cloudformation/github-oidc-role.yml` — the same as production.

**Current state:**
- **Prod** (332730082708): role managed by CFN stack `github-actions-swarm` — 7 inline policies + 2 managed policies
- **Staging** (022118847419): role exists but is ORPHAN (no CFN stack) — 16 inline policies, 0 managed policies

## Staged Import Plan

### Phase 1: Audit Staging Policies Against Template

The staging role's 16 inline policies must be mapped to the template's inline + managed policies:

| # | Staging Policy | Actions | Coverage in Template | Notes |
|----|----------------|---------|----------------------|-------|
| 1 | `APIGatewayAccess` | apigateway:* on `arn:aws:apigateway:region::/*` | ✅ `LambdaAndAPIGatewayPolicy` MSI → `APIGatewayManagement` | Covered |
| 2 | `CDKBootstrap` | iam/s3/ecr/ssm/kms actions for `cdk-*` resources | ✅ `CDKBootstrapPolicy` MSI | Covered |
| 3 | `CloudFormation` | cloudformation:* on Swarm/swarm stacks | ✅ `GitHubActionsRole` → `CloudFormationAndSSM` inline | Covered |
| 4 | `CloudFrontAccess` | cloudfront:* on all resources | ✅ `GitHubActionsRole` → `LogsECSCloudFront` inline → `CloudFrontInvalidate` | Covered |
| 5 | `CloudWatchObservability` | cloudwatch:* (alarms, dashboards) on swarm resources | ✅ `GitHubActionsRole` → `CloudWatchObservability` inline | ✅ **Added 2026-04-19 per #1417** |
| 6 | `DynamoDBAccess` | dynamodb:* on Swarm/swarm tables | ✅ `GitHubActionsRole` → `DynamoDBAndSQS` inline | Covered |
| 7 | `ECRAccess` | ecr:* on `cdk-*` repositories | ✅ `GitHubActionsRole` → `S3AndECR` inline | Covered |
| 8 | `IAMAccess` | iam:Create/Delete/Attach/PassRole on Swarm/swarm resources | ✅ `GitHubActionsRole` → `IAMAccess` inline | Covered |
| 9 | `KMSAccess` | kms:Create/Describe/Enable/Get/Put/Tag on `alias/swarm/*` | ✅ `GitHubActionsRole` → `SecretsAndKMS` inline | Covered |
| 10 | `LambdaAccess` | lambda:* on Swarm/swarm functions | ✅ `LambdaAndAPIGatewayPolicy` MSI → `LambdaSwarmManagement` | Covered |
| 11 | `LogsAccess` | logs:* on `/aws/lambda/Swarm/*` and `/ecs/swarm-*` | ✅ `GitHubActionsRole` → `LogsECSCloudFront` inline | Covered |
| 12 | `S3Access` | s3:* on `cdk-*-assets-*`, `swarm-admin-ui-*` | ✅ `GitHubActionsRole` → `S3AndECR` inline | Covered |
| 13 | `SecretsManagerAccess` | secretsmanager:* on `secret/swarm/*` | ✅ `GitHubActionsRole` → `SecretsAndKMS` inline | Covered |
| 14 | `SQSAccess` | sqs:* on Swarm/swarm queues | ✅ `GitHubActionsRole` → `DynamoDBAndSQS` inline | Covered |
| 15 | `SSMAccess` | ssm:GetParameter/Put/Delete on `cdk-bootstrap/*`, `swarm/*` | ✅ `GitHubActionsRole` → `CloudFormationAndSSM` inline | Covered |
| 16 | `SwarmCdkContextBucketAccess` | s3:* on `swarm-cdk-context-*` | ✅ `GitHubActionsRole` → `S3AndECR` inline → `SwarmContextBucket` | ✅ **Pre-existed in staging; now in template** |

**Audit Result:** All 16 staging policies are covered by the template. No gaps detected.

### Phase 2: Pre-Import Validation

Before running `create-change-set --change-set-type IMPORT`, verify:

```bash
# Staging context
export AWS_PROFILE=staging

# 1. Confirm role exists and is orphan (no CFN stack owns it)
aws iam get-role --role-name aws-swarm-github-actions
aws cloudformation describe-stacks --stack-name github-actions-swarm 2>&1 | grep -i "does not exist" || echo "Stack found"

# 2. Dump current staging policies for audit reference
mkdir -p /tmp/role-audit/{staging,prod}-before
for p in $(aws iam list-role-policies --role-name aws-swarm-github-actions --query 'PolicyNames[]' --output text); do
  aws iam get-role-policy --role-name aws-swarm-github-actions --policy-name "$p" \
    --query PolicyDocument --output json > "/tmp/role-audit/staging-before/$p.json"
done

# 3. Verify prod template for reference
export AWS_PROFILE=prod
for p in $(aws iam list-role-policies --role-name aws-swarm-github-actions --query 'PolicyNames[]' --output text); do
  aws iam get-role-policy --role-name aws-swarm-github-actions --policy-name "$p" \
    --query PolicyDocument --output json > "/tmp/role-audit/prod-reference/$p.json"
done
```

### Phase 3: Create and Execute Change Set

```bash
export AWS_PROFILE=staging
export AWS_REGION=us-east-1

# Prepare template with staging parameters
aws cloudformation create-change-set \
  --stack-name github-actions-swarm \
  --change-set-name import-staging-role-$(date +%s) \
  --change-set-type IMPORT \
  --resources-to-import file://role-import-resources.json \
  --template-body file://.github/cloudformation/github-oidc-role.yml \
  --parameters ParameterKey=GitHubOrg,ParameterValue=cenetex \
               ParameterKey=GitHubRepo,ParameterValue=aws-swarm \
  --capabilities CAPABILITY_NAMED_IAM

# Review change set
aws cloudformation describe-change-set \
  --stack-name github-actions-swarm \
  --change-set-name <NAME>

# Execute (only after review)
aws cloudformation execute-change-set \
  --stack-name github-actions-swarm \
  --change-set-name <NAME>
```

Where `role-import-resources.json` contains:
```json
[
  {
    "LogicalResourceId": "GitHubActionsRole",
    "PhysicalResourceId": "aws-swarm-github-actions"
  }
]
```

### Phase 4: Post-Import Reconciliation

After `StackStatus: IMPORT_COMPLETE`:

```bash
# Verify CFN now owns the role
aws iam list-role-policies --role-name aws-swarm-github-actions --query 'PolicyNames[]'
# Should return only 7 inline policies (the template's policies)

# Confirm inline policies match prod
diff <(aws --profile staging iam list-role-policies --role-name aws-swarm-github-actions --query 'PolicyNames[]' --output text | tr ' ' '\n' | sort) \
     <(aws --profile prod    iam list-role-policies --role-name aws-swarm-github-actions --query 'PolicyNames[]' --output text | tr ' ' '\n' | sort)

# Check drift
aws cloudformation detect-stack-drift --stack-name github-actions-swarm
aws cloudformation describe-stack-resource-drifts --stack-name github-actions-swarm
# Should return StackDriftStatus: IN_SYNC
```

### Phase 5: Delete Orphan Out-of-Band Policies

After CFN import, the 16 old inline policies are replaced by CFN-managed ones. **Do NOT delete** the old policies before import completes, as that would break the role immediately.

Once `IN_SYNC` is confirmed:

```bash
# If any old policies remain (should not), delete them:
aws iam delete-role-policy --role-name aws-swarm-github-actions --policy-name "OldPolicyName"
```

### Phase 6: Validate Staging Deploy

Run a full deploy against staging to confirm assume-role and all API calls work:

```bash
# Merge or push a branch that triggers a staging deploy
# Monitor the GitHub Actions workflow for any new permission errors
```

## Rollback Plan

If the import fails or causes breakage:

1. **Before import:** CFN import is atomic. If it fails, the role remains orphan — re-run import or troubleshoot the change set.
2. **After import, pre-IN_SYNC:** Run `update-stack` with the same template to re-normalize, or `delete-stack` to orphan the role again. **⚠️ Do not delete the stack without orphaning the role first, or the role will be destroyed.**

## Template Changes Required

None identified. The current template already covers all staging policies.

## References
- Issue #1396 / #1404: CloudWatch perms gap that forced this audit
- Issue #1417: CloudWatchObservability template addition
- Issue #1419: ASCII-only role descriptions (IAM regex unblocker)
- Issue #319: Least-privilege split that diverged prod from staging
- `docs/COORDINATION-OWNERSHIP.md`: Role ownership and CFN governance
