# GitHub Actions Setup for AWS Swarm

This directory contains GitHub Actions workflows and supporting infrastructure for CI/CD.

> **Note:** For development guidelines, commit conventions, and issue management, see [CLAUDE.md](../CLAUDE.md) in the project root.

## Workflows

### CI (`ci.yml`)
Runs on every push and pull request to `main`:
- Runs dependency security audit (`pnpm audit --audit-level=high`)
- Installs dependencies with pnpm
- Builds all packages
- Runs linting and type checking
- Runs tests (when available)
- Performs CDK synth to validate infrastructure

### Deploy (`deploy.yml`)
Runs on push to `main` or manual trigger:
- Builds all packages
- Deploys CDK stacks to AWS
- Deploys Admin UI to S3/CloudFront

### Deploy Agent (`deploy-agent.yml`)
Manual workflow to deploy individual agents:
- Validates agent configuration exists
- Deploys agent-specific CDK stack
- Outputs webhook URLs for configuration

### Release Notes (`release-notes.yml`)
Generates and publishes GitHub release notes:
- Auto-runs on `v*` tags
- Supports manual regeneration for any tag via `workflow_dispatch`
- Uses deterministic git-based notes by default
- Optionally polishes notes with OpenRouter when `OPENROUTER_API_KEY` is configured

## Setup Instructions

### 1. Create the OIDC Role in AWS

Deploy the CloudFormation template to create the GitHub Actions IAM role:

```bash
aws cloudformation deploy \
  --template-file .github/cloudformation/github-oidc-role.yml \
  --stack-name github-actions-swarm \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    GitHubOrg=atimics \
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
5. **Dependency Audits**: Automated security audits run on every PR/push (see [SECURITY.md](../docs/SECURITY.md))

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
