# Claude Code Development Guide

This document describes the development workflow, commit conventions, and GitHub issue management for the AWS Swarm project.

## Project Overview

AWS Swarm is a multi-tenant social media avatar platform that runs on AWS serverless infrastructure. Key components:

- **Core** (`packages/core/`) - Shared types, adapters, processors, services
- **Handlers** (`packages/handlers/`) - Lambda handlers for webhooks and processing
- **Admin API** (`packages/admin-api/`) - Conversational admin interface backend
- **Admin UI** (`packages/admin-ui/`) - React chat frontend
- **Infra** (`packages/infra/`) - CDK infrastructure as code
- **MCP Server** (`packages/mcp-server/`) - Model Context Protocol tool server
- **Layer** (`packages/layer/`) - Lambda layer with shared dependencies
- **Profile Page** (`packages/profile-page/`) - Public avatar profile pages
- **Claude Code Worker** (`packages/claude-code-worker/`) - Claude Code agent worker
- **Plan Tests** (`packages/plan-tests/`) - Integration tests for the plan system (run with `RUN_PLAN_TESTS=1`)

## Design Philosophy

This product is **chat-first**. All user actions must be initiated and completed inside the chat experience.

- Use inline chat prompts and buttons for actions (inhabitation, settings, confirmations, etc.).
- Do **not** add standalone settings pages, modals, or separate configuration flows.
- If a workflow needs input, render it as an inline chat tool prompt or button-driven action.

See `docs/design-philosophy.md` for the canonical UI rules.

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
| `mcp-server` | `packages/mcp-server/` |
| `profile-page` | `packages/profile-page/` |
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
docs(plan): add domain setup instructions for swarm.rati.chat

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
| `type:tech-debt` | `#FFA500` | Technical debt cleanup |
| `priority:high` | `#D93F0B` | High priority |
| `priority:medium` | `#FBCA04` | Medium priority |
| `priority:low` | `#0E8A16` | Low priority |
| `status:in-progress` | `#EDEDED` | Currently being worked on |
| `status:blocked` | `#000000` | Blocked by something |
| `package:core` | `#C5DEF5` | Affects core package |
| `package:handlers` | `#C5DEF5` | Affects handlers package |
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

1. Create issue describing the work (or assign to Copilot)
2. Create branch from `main`: `git checkout -b feat/issue-42-wallet-balance`
3. Make changes with conventional commits
4. Push and create PR referencing the issue (`Closes #42`)
5. PR title should match commit convention
6. Squash merge to main
7. Clean up: `git branch -d feat/issue-42-wallet-balance && git push origin --delete feat/issue-42-wallet-balance`

## Development Workflow

### Setup

```bash
git clone https://github.com/atimics/aws-swarm.git
cd aws-swarm
pnpm install
pnpm build
```

### Local Development

```bash
# Run tests (bun is the test runner, not vitest)
bun test                              # all tests
bun test packages/core/               # single package
bun test path/to/file.test.ts         # single file

# Build / lint / typecheck
pnpm build                            # all packages
pnpm lint                             # all packages
pnpm typecheck                        # all packages

# Plan tests (gated behind env var)
RUN_PLAN_TESTS=1 bun test packages/plan-tests
```

### Git Hooks (Husky)

Pre-commit and pre-push hooks run automatically — you rarely need to run checks manually.

| Hook | What it does | Skip with |
|------|-------------|-----------|
| **pre-commit** | Lockfile check, `pnpm lint`, issue scan (blocks on unreviewed critical issues) | `SKIP_PRECOMMIT=1` |
| **pre-push** | `pnpm lint`, `pnpm build`, admin-ui build, Privy smoke test, `bun test` | `SKIP_PREPUSH=1` |

## CI/CD Pipeline

### Workflows

| Workflow | Trigger | Description |
|----------|---------|-------------|
| `ci.yml` | Push/PR to main | Build, lint, test (bun v1.3.9 in CI) |
| `deploy.yml` | Push to main, manual | Deploy CDK infra and admin UI |
| `fast-deploy.yml` | Manual | Fast-path deploy (skip build) |
| `internal-issues-sync.yml` | Schedule/manual | Sync runtime errors to GitHub issues |
| `release-notes.yml` | Tag push | Generate release notes |

### Environments

- **staging** - Auto-deploys on merge to main
- **production** - Requires manual approval

### Secrets Required

```yaml
AWS_ROLE_ARN: arn:aws:iam::ACCOUNT:role/aws-swarm-github-actions
AWS_ACCOUNT_ID: "123456789012"  # set per GitHub environment (staging vs production)
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

### Parallel Development with Worktrees

For working on multiple independent issues simultaneously, use git worktrees:

```bash
# Create worktrees for parallel work (one per issue)
git worktree add ../aws-swarm-042 -b fix/issue-42-dynamo-query main
git worktree add ../aws-swarm-043 -b fix/issue-43-adapter-bug main

# Install deps in each worktree
(cd ../aws-swarm-042 && pnpm install)
(cd ../aws-swarm-043 && pnpm install)

# Work independently in each, then push and create PRs
# Clean up after merge
git worktree remove ../aws-swarm-042
git branch -d fix/issue-42-dynamo-query
```

### Worktree Lifecycle Hooks

When agents work in local worktrees, the GitHub project board has no visibility until a PR is opened. These scripts bridge the gap:

```bash
# Signal "In progress" when starting work on an issue
# Pushes branch to origin + adds status:in-progress label
# This triggers project-sync to move the issue to "In progress"
scripts/worktree-start.sh <issue-number>

# Finalize completed worktrees: commit, rebase, push, create PRs
# Processes all worktrees in /private/tmp/aws-swarm-*
scripts/worktree-finalize.sh

# Finalize specific issues only
scripts/worktree-finalize.sh --issues 310,297,287

# Preview what would happen
scripts/worktree-finalize.sh --dry-run
```

**IMPORTANT:** When orchestrating parallel agent work in worktrees, you MUST:
1. After creating each worktree, run `scripts/worktree-start.sh <issue-number>` to push the branch and label the issue. This makes work visible on the project board.
2. After an agent finishes, run `scripts/worktree-finalize.sh --issues <issue-number>` to commit, push, and create the PR.
3. If dispatching multiple agents at once, run `worktree-start.sh` for each issue immediately — don't wait until agents finish.

### Copilot Coding Agent

Some issues can be delegated to GitHub Copilot's coding agent. It autonomously creates a PR from the issue description.

```bash
# Create issue and assign to Copilot in one step
scripts/gh-create-issue.sh \
  --title "fix(core): convert vitest tests to bun:test" \
  --body "Details..." \
  --labels "type:bug,priority:high,package:core" \
  --copilot

# Or assign Copilot to an existing issue
scripts/gh-assign-copilot.sh 80
```

> The REST API cannot assign bot actors. These scripts use GraphQL internally.

## Code Review Checklist

- [ ] Code follows project style
- [ ] Tests added/updated (when applicable)
- [ ] Documentation updated
- [ ] No secrets in code
- [ ] Error handling is appropriate
- [ ] Commit messages follow convention
- [ ] Issue is referenced

## Common Tasks

### Creating a New Avatar

```bash
# Via Admin UI
1. Go to swarm.rati.chat
2. Chat: "Create a new avatar called myagent"
3. Configure platforms and set secrets
4. Deploy via GitHub Actions

# Via CLI
cp -r avatars/.template avatars/myagent
# Edit avatars/myagent/config.yaml
# Edit avatars/myagent/persona.md
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

### Versioning

We follow [Semantic Versioning](https://semver.org/) with GitHub Releases as the sole version source. There is no `version` field in `package.json`.

| Bump | When | Examples |
|------|------|----------|
| **Patch** (`0.3.1`) | Bug fixes, config changes, removing broken features, dependency updates | Disable broken Lambda, fix CORS, update deps |
| **Minor** (`0.4.0`) | New features, new platform adapters, significant refactors that change behavior | Add generic heartbeat, add wallet linking, semantic memory |
| **Major** (`1.0.0`) | Breaking API changes, data model migrations, architectural rewrites | Change DynamoDB schema, remove/rename public API endpoints |

**Rules:**
- All version tags live on `main` — never tag a feature branch
- Tags trigger the `deploy.yml` production workflow and `release-notes.yml`
- Group related PRs into a single release when merged close together
- Pre-1.0: minor bumps are fine for any non-trivial feature batch; patch for fixes

### Releasing

```bash
# Create a patch release (default)
./scripts/release.sh

# Create a minor or major release
./scripts/release.sh minor
./scripts/release.sh major

# Explicit version
./scripts/release.sh v1.0.0
```

This creates a GitHub Release and tag on `main` via the `gh` CLI. The `release-notes.yml` workflow then overwrites the release body with AI-polished notes.

### Adding a New Tool to Admin Avatar

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

1. **Secret Token Verification** - Each avatar has a unique `telegram_webhook_secret` stored in Secrets Manager. Telegram sends this in the `X-Telegram-Bot-Api-Secret-Token` header, which we verify using timing-safe comparison.

2. **IP Verification** - Requests are checked against Telegram's official IP ranges (149.154.160.0/20, 91.108.4.0/22). This is a secondary check and can be disabled for proxied setups.

3. **No Information Disclosure** - All error cases return 200 OK to prevent enumeration of valid avatar IDs.

4. **Sanitized Logging** - Message content is never logged; only metadata (chat ID, message ID, text length) is recorded.

### Structured Logging

Handlers emit structured JSON logs with fields like `level`, `subsystem`, `event`, `avatarId`, and `requestId`. Avoid logging raw message content or secrets; log counts, lengths, and IDs instead.

## Resources

- [PLAN.md](./PLAN.md) - Detailed architecture and implementation plan
- [.github/README.md](./.github/README.md) - CI/CD setup instructions
- [Conventional Commits](https://www.conventionalcommits.org/)
- [AWS CDK Docs](https://docs.aws.amazon.com/cdk/v2/guide/)
