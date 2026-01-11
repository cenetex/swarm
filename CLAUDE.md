# Claude Code Development Guide

This document describes the development workflow, commit conventions, and GitHub issue management for the AWS Swarm project.

## Project Overview

AWS Swarm is a multi-tenant social media agent platform that runs on AWS serverless infrastructure. Key components:

- **Core** (`packages/core/`) - Shared types, adapters, processors, services
- **Handlers** (`packages/handlers/`) - Lambda handlers for webhooks and processing
- **Admin API** (`packages/admin-api/`) - Conversational admin interface backend
- **Admin UI** (`packages/admin-ui/`) - React chat frontend
- **Infra** (`packages/infra/`) - CDK infrastructure as code

## Commit Convention

We follow [Conventional Commits](https://www.conventionalcommits.org/) with scope for the package being modified.

### Format

```
<type>(<scope>): <description>

[optional body]

[optional footer(s)]
```

### Types

| Type | Description |
|------|-------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `style` | Code style (formatting, semicolons, etc.) |
| `refactor` | Code change that neither fixes a bug nor adds a feature |
| `perf` | Performance improvement |
| `test` | Adding or updating tests |
| `build` | Build system or external dependencies |
| `ci` | CI/CD configuration |
| `chore` | Other changes that don't modify src or test files |

### Scopes

| Scope | Package |
|-------|---------|
| `core` | `packages/core/` |
| `handlers` | `packages/handlers/` |
| `admin-api` | `packages/admin-api/` |
| `admin-ui` | `packages/admin-ui/` |
| `infra` | `packages/infra/` |
| `plan` | `PLAN.md` |
| `ci` | `.github/` |
| `docs` | Documentation files |

### Examples

```bash
# New feature
feat(admin-api): add wallet balance checking tool

# Bug fix with issue reference
fix(core): correct DynamoDB query for listAgents

Closes #42

# Documentation update
docs(plan): add domain setup instructions for admin.rati.chat

# Multiple scopes
feat(admin-api,infra): add audit logging service
```

## GitHub Issue Management

### Issue Labels

| Label | Color | Description |
|-------|-------|-------------|
| `type:feature` | `#1D76DB` | New feature request |
| `type:bug` | `#D73A4A` | Bug report |
| `type:docs` | `#0075CA` | Documentation |
| `type:infra` | `#7057FF` | Infrastructure changes |
| `type:security` | `#B60205` | Security related |
| `priority:high` | `#D93F0B` | High priority |
| `priority:medium` | `#FBCA04` | Medium priority |
| `priority:low` | `#0E8A16` | Low priority |
| `status:in-progress` | `#EDEDED` | Currently being worked on |
| `status:blocked` | `#000000` | Blocked by something |
| `package:core` | `#C5DEF5` | Affects core package |
| `package:admin` | `#C5DEF5` | Affects admin packages |
| `package:infra` | `#C5DEF5` | Affects infrastructure |

### Issue Templates

Use the issue templates in `.github/ISSUE_TEMPLATE/` for consistent issue creation.

### Linking Commits to Issues

Always reference issues in commits:

```bash
# Close an issue
git commit -m "feat(core): implement retry logic for LLM service

Implements exponential backoff with jitter for API calls.

Closes #15"

# Reference without closing
git commit -m "refactor(handlers): improve error handling

Related to #23"
```

### PR Workflow

1. Create issue describing the work
2. Create branch from `main`: `git checkout -b feat/issue-42-wallet-balance`
3. Make changes with conventional commits
4. Push and create PR referencing the issue
5. PR title should match commit convention
6. Squash merge to main

## Development Workflow

### Setup

```bash
# Clone repository
git clone https://github.com/ratimics/aws-swarm.git
cd aws-swarm

# Install dependencies
pnpm install

# Build all packages
pnpm build
```

### Local Development

```bash
# Watch mode for a specific package
cd packages/core
pnpm dev

# Run tests
pnpm test

# Type check
pnpm typecheck

# Lint
pnpm lint
```

### Before Committing

```bash
# Build everything
pnpm -r build

# Run checks
pnpm -r lint
pnpm -r typecheck
pnpm -r test
```

## CI/CD Pipeline

### Workflows

| Workflow | Trigger | Description |
|----------|---------|-------------|
| `ci.yml` | Push/PR to main | Build, lint, test, CDK synth |
| `deploy.yml` | Push to main, manual | Deploy infra and admin UI |
| `deploy-agent.yml` | Manual | Deploy specific agent |

### Environments

- **staging** - Auto-deploys on merge to main
- **production** - Requires manual approval

### Secrets Required

```yaml
AWS_ROLE_ARN: arn:aws:iam::ACCOUNT:role/aws-swarm-github-actions
ADMIN_API_URL: https://xxx.execute-api.region.amazonaws.com
ADMIN_UI_BUCKET: swarm-admin-ui-bucket
CLOUDFRONT_DISTRIBUTION_ID: EXXXXXXXXXX
```

## Branching Strategy

```
main (protected)
  │
  ├── feat/issue-42-wallet-balance
  ├── fix/issue-43-dynamo-query
  ├── docs/update-plan
  └── chore/dependency-updates
```

- `main` is protected, requires PR and CI pass
- Feature branches follow pattern: `<type>/issue-<number>-<short-description>`
- Keep branches short-lived (< 1 week)
- Squash merge to main

## Code Review Checklist

- [ ] Code follows project style
- [ ] Tests added/updated (when applicable)
- [ ] Documentation updated
- [ ] No secrets in code
- [ ] Error handling is appropriate
- [ ] Commit messages follow convention
- [ ] Issue is referenced

## Common Tasks

### Creating a New Agent

```bash
# Via Admin UI
1. Go to admin.rati.chat
2. Chat: "Create a new agent called myagent"
3. Configure platforms and set secrets
4. Deploy via GitHub Actions

# Via CLI
cp -r agents/.template agents/myagent
# Edit agents/myagent/config.yaml
# Edit agents/myagent/persona.md
```

### Deploying

**All deployments happen through GitHub Actions by pushing to main.** Do NOT run `cdk deploy` locally.

```bash
# Commit and push to trigger deployment
git add .
git commit -m "feat(infra): your change description"
git push origin main

# GitHub Actions will:
# 1. Build all packages
# 2. Deploy infra to staging automatically
# 3. Deploy admin UI to staging automatically
# 4. Production requires manual approval
```

To deploy manually via GitHub Actions:
1. Go to Actions > Deploy Staging (or Deploy Production)
2. Click "Run workflow"
3. Select branch and confirm

### Adding a New Tool to Admin Agent

1. Add tool definition in `packages/admin-api/src/handlers/chat.ts`
2. Implement tool execution in the switch statement
3. Add any new services in `packages/admin-api/src/services/`
4. Update types in `packages/admin-api/src/types.ts`
5. Test locally, then deploy

## Troubleshooting

### Build Failures

```bash
# Clean and rebuild
pnpm -r clean
rm -rf node_modules
pnpm install
pnpm -r build
```

### CDK Issues

```bash
# Bootstrap CDK (first time)
cd packages/infra
npx cdk bootstrap

# Diff to see changes
npx cdk diff

# Synth to validate
npx cdk synth
```

### Lambda Issues

```bash
# View logs
aws logs tail /aws/lambda/function-name --follow

# Test locally with SAM
sam local invoke -e event.json
```

## Security Guidelines

1. **Never commit secrets** - Use Secrets Manager
2. **Write-only secrets** - Admin can SET but not READ secret values
3. **KMS encryption** - All secrets encrypted with CMK
4. **Cloudflare Access** - Zero-trust authentication for admin
5. **Least privilege IAM** - Lambda roles have minimal permissions
6. **Audit logging** - All admin actions are logged

### Telegram Webhook Security

The Telegram webhook handler implements multiple security layers:

1. **Secret Token Verification** - Each agent has a unique `telegram_webhook_secret` stored in Secrets Manager. Telegram sends this in the `X-Telegram-Bot-Api-Secret-Token` header, which we verify using timing-safe comparison.

2. **IP Verification** - Requests are checked against Telegram's official IP ranges (149.154.160.0/20, 91.108.4.0/22). This is a secondary check and can be disabled for proxied setups.

3. **No Information Disclosure** - All error cases return 200 OK to prevent enumeration of valid agent IDs.

4. **Sanitized Logging** - Message content is never logged; only metadata (chat ID, message ID, text length) is recorded.

### Structured Logging

Handlers emit structured JSON logs with fields like `level`, `subsystem`, `event`, `agentId`, and `requestId`. Avoid logging raw message content or secrets; log counts, lengths, and IDs instead.

## Resources

- [PLAN.md](./PLAN.md) - Detailed architecture and implementation plan
- [.github/README.md](./.github/README.md) - CI/CD setup instructions
- [Conventional Commits](https://www.conventionalcommits.org/)
- [AWS CDK Docs](https://docs.aws.amazon.com/cdk/v2/guide/)
