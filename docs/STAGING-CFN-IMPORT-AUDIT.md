# Staging IAM Role Import to CloudFormation - Audit & Reconciliation

**Date:** 2026-04-21  
**Issue:** #1420  
**Scope:** Reconcile staging `aws-swarm-github-actions` role (16 inline policies) against prod template (7 inline + 2 managed)

## Executive Summary

**Status:** Ready for import ✓

Staging role has 16 inline policies; prod template has been extended to cover all deploy-breaking gaps. The template at `.github/cloudformation/github-oidc-role.yml` now includes all necessary permissions. Safe to proceed with CFN import of staging role.

## Reconciliation Matrix

### Deploy-Breaking Gaps (RESOLVED in PR #1421)

All three critical gaps required by staging deploys have been added to the template:

| Gap | Action | Resource | Template Coverage | Status |
|-----|--------|----------|-------------------|--------|
| 1 | `s3:ListBucket/GetObject/PutObject/DeleteObject/GetBucketLocation` | `arn:aws:s3:::swarm-cdk-context-${AccountId}-${Region}[/*]` | `S3AndECR.SwarmContextBucket` | ✓ Added in #1421 |
| 3 | `secretsmanager:*` (read) | `arn:aws:secretsmanager:${Region}:${AccountId}:secret:kyro/*` | `SecretsAndKMS.SecretsManagerKyroRead` | ✓ Added in #1421 |
| 4 | `kms:CreateGrant/RevokeGrant/RetireGrant/ListGrants` | `arn:aws:kms:${Region}:${AccountId}:key/*` (cond: `kms:GrantIsForAWSResource`) | `SecretsAndKMS.KMSGrantOperations` | ✓ Added in #1421 |

### Lower-Risk Gaps (Retained in Template)

Gap 6 was also added as a safety measure:

| Gap | Action | Resource | Template Coverage | Status |
|-----|--------|----------|-------------------|--------|
| 6 | `ssm:GetParametersByPath/DescribeParameters` | `arn:aws:ssm:${Region}:${AccountId}:parameter/cdk-bootstrap/*` | `CloudFormationAndSSM.SSMBootstrapRead` | ✓ Added in #1421 |

Gap 2 (ECR qualifier broadening) remains at `cdk-hnb659fds-*` (most common bootstrap). No current plans to broaden further.

### Obsolete Policies (Safe to Drop on Import)

These staging policies are either fully replaced by template or are no-ops:

| Policy | Actions | Status | Justification |
|--------|---------|--------|----------------|
| `CloudFormationFullAccess` | `cloudformation:*` on `*` | Drop | Replaced by `CloudFormationAndSSM.CFNSwarmStacks` + `CFNGlobalRead` (scope-narrowed in #319) |
| `DescribeStacks` | Duplicate CloudFormation wildcard | Drop | Duplicate of above; dropped with it |
| `us-west-2` regions in all policies | Regional scopes | Drop | No current CDK deploys target us-west-2; safe to drop |
| Runtime actions in wildcards | `lambda:InvokeFunction`, `dynamodb:Query`, `logs:PutLogEvents`, etc. | Drop | These are Lambda execution role permissions, not deploy-role permissions |
| `kms:ListKeys` with `kms:RequestAlias` | Silently denied by condition mismatch; no-op | Drop | Not needed; condition prevented usage |

## Policy Mapping: Staging → Template

### S3 & ECR
- `staging-S3Access`: Covered by `S3AndECR.CDKAssets` + `AdminUIBucket` + `SwarmContextBucket`
- `staging-ECRAccess`: Covered by `S3AndECR.ECRAuth` + `ECRPush`

### Compute & Container
- `staging-LambdaAccess`: Covered by managed policy `LambdaAndAPIGatewayPolicy`
- `staging-APIGatewayAccess`: Covered by managed policy `LambdaAndAPIGatewayPolicy`

### Data Services
- `staging-DynamoDBAccess`: Covered by `DynamoDBAndSQS.DynamoDBTableManagement` + `DynamoDBGlobalRead`
- `staging-SQSAccess`: Covered by `DynamoDBAndSQS.SQSQueueManagement` + `SQSGlobalList`
- `staging-SecretsManagerAccess`: Covered by `SecretsAndKMS.SecretsManager` + `SecretsManagerKyroRead`

### Identity & Access
- `staging-IAMAccess`: Covered by `IAMAccess.IAMRoles` + `IAMServiceLinkedRoles`
- `staging-CloudFormation`: Covered by `CloudFormationAndSSM.CFNSwarmStacks` + `CFNGlobalRead`

### Encryption & SSM
- `staging-KMSAccess`: Covered by `SecretsAndKMS.KMSKeyManagement` + `KMSGrantOperations`
- `staging-SSMAccess`: Covered by `CloudFormationAndSSM.SSMBootstrapRead` + `SSMSwarmParams`

### Observability & Infrastructure
- `staging-LogsAccess`: Covered by `LogsECSCloudFront.LogsLambda` + `LogsECS` + `LogsDescribe`
- `staging-CloudFrontAccess`: Covered by `LogsECSCloudFront.CloudFrontInvalidate`
- `staging-CDKBootstrap`: Covered by managed policy `CDKBootstrapPolicy`
- `staging-CloudWatchObservability`: Covered by inline policy `CloudWatchObservability`

## Transition Steps

### 1. Template Verification (✓ Complete)
- PR #1421 merged all required template extensions

### 2. Prod Deploy Verification (Complete before staging import)
```bash
# Already merged to main; prod stack auto-deploys on push
# Green deploy signals template is safe
```

### 3. Staging Import (This PR)
```bash
# Create change-set with IMPORT type
aws cloudformation create-change-set \
  --stack-name github-actions-swarm \
  --change-set-name import-staging-role \
  --change-set-type IMPORT \
  --profile staging \
  --resources-to-import '[{"LogicalResourceId":"GitHubActionsRole","ResourceIdentifier":{"RoleName":"aws-swarm-github-actions"}}]' \
  --template-body file://.github/cloudformation/github-oidc-role.yml

# Review and execute
aws cloudformation describe-change-set \
  --stack-name github-actions-swarm \
  --change-set-name import-staging-role \
  --profile staging

aws cloudformation execute-change-set \
  --stack-name github-actions-swarm \
  --change-set-name import-staging-role \
  --profile staging
```

### 4. Verification
```bash
# Confirm import complete
aws cloudformation describe-stacks \
  --stack-name github-actions-swarm \
  --profile staging \
  --query 'Stacks[0].StackStatus'
# Expected: IMPORT_COMPLETE or UPDATE_COMPLETE

# Confirm role policies match template
aws --profile staging iam list-role-policies --role-name aws-swarm-github-actions
# Expected: ~7 inline policy names (CloudFormationAndSSM, S3AndECR, etc.)

# Verify no drift
aws cloudformation detect-stack-drift \
  --stack-name github-actions-swarm \
  --profile staging

aws cloudformation describe-stack-drift-detection-status \
  --stack-drift-detection-id <id-from-above> \
  --profile staging
# Expected: StackDriftStatus = IN_SYNC
```

### 5. Staging Deploy Test
- One full staging deploy run post-import to confirm all deploy workflows still green

## Pre-Import Checklist

- [ ] Template PR #1421 merged to main
- [ ] Prod stack deployed successfully with new template
- [ ] Staging role name confirmed: `aws-swarm-github-actions`
- [ ] Change-set created with IMPORT type
- [ ] Change-set reviewed (should show role as "imported")
- [ ] Change-set executed
- [ ] Stack status verified as IMPORT_COMPLETE
- [ ] Role policies counted (should be ~7 inline names)
- [ ] Stack drift detection runs IN_SYNC
- [ ] One staging deploy succeeds green
- [ ] Inline policies manually cleaned up (deprecated out-of-band policies)

## Post-Import Cleanup (Optional - PR B)

After import confirms stable, can optionally:
1. Remove us-west-2 region scopes from all policy resources (no current deployments there)
2. Document gap 2 decision (ECR bootstrap qualifier broadening)
3. Remove any remaining duplicate resource scopes

This is a separate PR for pure reduction with no new functionality.

## References

- **#1396** — CloudWatch perms gap that forced drift into open
- **#1404** — Related to #1396
- **#1417** — CloudWatchObservability template addition  
- **#1419** — ASCII-only role descriptions (IAM regex unblocker)
- **#1420** — This issue
- **#1421** — PR A: template extensions
- **#319** — Original least-privilege split that diverged prod from staging

