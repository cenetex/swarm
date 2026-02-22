# GitHub Actions Setup for AWS Swarm

This directory contains GitHub Actions workflows and supporting infrastructure for CI/CD.

> **Note:** For development guidelines, commit conventions, and issue management, see [CLAUDE.md](../CLAUDE.md) in the project root.

## Workflows

### CI/CD (automatic)

**CI** (`ci.yml`) — Push to `main` and `v*` tags:
- Dependency security audit, lint, build, test
- PRs are validated by `release-gate.yml` instead (see below)

**Release Gate** (`release-gate.yml`) — Every PR to `main`:
- Security audit, lint, typecheck, build (with artifact validation), test
- PR evidence (risk level, rollback plan, validation plan)
- Release notes check (for release PRs only)
- Sole required status check for branch protection (see `.github/policy/release-gate-policy.md`)

**Deploy** (`deploy.yml`) — Push to `main` (staging) or `v*` tags (production):
- CDK infrastructure deploy, Admin UI to S3/CloudFront
- E2E smoke tests (staging) or HTTP health checks (production)
- Calls `deploy-cdk-reusable.yml` and `deploy-admin-ui-reusable.yml`

**Release Notes** (`release-notes.yml`) — On `v*` tags:
- Generates GitHub release with changelog
- Optionally polishes with OpenRouter AI

### Deploy (manual trigger)

**Deploy Lambda Hotpatch** (`deploy-lambda-hotpatch.yml`):
- Bypasses CDK — directly updates Lambda function code via AWS API
- For emergency patches only; does not update infra, layers, or env vars

### Project management (automatic)

**Project Sync** (`project-sync.yml`):
- Syncs issues/PRs to GitHub Project board on open/close/label events
- Moves linked issues to "Done" on PR merge
- Nightly reconciliation to fix drift; enforces one priority label per issue

**Sync Runtime Issues** (`sync-runtime-issues.yml`) — Hourly:
- Pulls runtime errors from AWS into GitHub Issues
- Scheduled runs execute in apply mode (writes issues) with API-only sourcing; manual `workflow_dispatch` supports dry-run for audit/report-only checks (with optional file fallback)
- Policy config: `.github/policy/internal-issue-sync-policy.json`

### Reusable (called by deploy.yml, not invoked directly)

- `deploy-cdk-reusable.yml` — CDK diff, deploy, domain association
- `deploy-admin-ui-reusable.yml` — Build React app, sync to S3, invalidate CloudFront

## Setup Instructions

### 1. Create the OIDC Role in AWS

Deploy the CloudFormation template to create the GitHub Actions IAM role:

```bash
aws cloudformation deploy \
  --template-file .github/cloudformation/github-oidc-role.yml \
  --stack-name github-actions-swarm \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    GitHubOrg=cenetex \
    GitHubRepo=aws-swarm
```

After deployment, get the role ARN:

```bash
aws cloudformation describe-stacks \
  --stack-name github-actions-swarm \
  --query "Stacks[0].Outputs[?OutputKey=='RoleArn'].OutputValue" \
  --output text
```

### 2. Configure GitHub Repository Secrets

Go to **Settings > Secrets and variables > Actions** in your GitHub repository and add:

| Secret Name | Description |
|-------------|-------------|
| `AWS_ROLE_ARN` | ARN of the IAM role from step 1 (recommended: set per-environment, see below) |
| `AWS_ACCOUNT_ID` | Expected AWS account ID for the environment (used as a safety guard in workflows) |
| `ADMIN_API_URL` | URL of the deployed Admin API (after first deploy) |
| `ADMIN_UI_BUCKET` | S3 bucket name for Admin UI static files |
| `CLOUDFRONT_DISTRIBUTION_ID` | (Optional) CloudFront distribution ID for cache invalidation |
| `OPENROUTER_API_KEY` | (Optional) Enables AI-polished release notes in `release-notes.yml` |

### 3. Configure GitHub Environments

Create two environments in **Settings > Environments**:
- `staging` - For testing deployments
- `production` - For production deployments (add required reviewers)

For multi-account setups (recommended):
- Set `AWS_ROLE_ARN` and `AWS_ACCOUNT_ID` as **environment secrets** on each environment.
  - `staging` → role/account in the staging AWS account
  - `production` → role/account in the production AWS account

This prevents accidental production deploys into the staging account.

### 4. Bootstrap CDK

Before the first deployment, bootstrap CDK in your AWS account:

```bash
cd packages/infra
npx cdk bootstrap aws://ACCOUNT_ID/us-east-1
```

## Required Secrets Summary

```yaml
# Recommended: set these as GitHub *environment secrets* (staging vs production)
AWS_ROLE_ARN: arn:aws:iam::ACCOUNT_ID:role/aws-swarm-github-actions
AWS_ACCOUNT_ID: "123456789012"

# Required for Admin UI deployment
ADMIN_API_URL: https://xxx.execute-api.us-east-1.amazonaws.com
ADMIN_UI_BUCKET: swarm-admin-ui-production

# Optional
CLOUDFRONT_DISTRIBUTION_ID: EXXXXXXXXXX
OPENROUTER_API_KEY: sk-or-... # optional, for AI release notes
```

### Optional Repository Variable

Set `OPENROUTER_MODEL` as a repository variable to choose the model used for AI-polished release notes.
If unset, workflow defaults to `openai/gpt-4o-mini`.

## Security Notes

1. **OIDC Authentication**: Uses GitHub's OIDC provider for secure, keyless authentication
2. **Least Privilege**: IAM role is scoped to only resources prefixed with `swarm` or `Swarm`
3. **Environment Protection**: Production environment can require manual approval
4. **Concurrency Control**: Deployment workflows prevent concurrent runs
5. **Dependency Audits**: Automated security audits run on PRs (release gate) and pushes to main (CI) (see [SECURITY.md](../docs/SECURITY.md))

## Troubleshooting

### "Could not assume role" error
- Verify the OIDC provider is created in your AWS account
- Check the role trust policy includes your repository
- Ensure `AWS_ROLE_ARN` secret is set correctly

### "CDK bootstrap required" error
Run CDK bootstrap:
```bash
npx cdk bootstrap aws://ACCOUNT_ID/REGION
```

### "Stack not found" error
The stack may not exist yet. Deployments will create stacks automatically.
