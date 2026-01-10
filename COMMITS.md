# Commit Plan

This file outlines the recommended commits for the current changes. Execute these in order.

## Commit 1: Documentation - Architecture Plan

```bash
git add PLAN.md
git commit -m "$(cat <<'EOF'
docs(plan): comprehensive update with admin interface and domain setup

- Add implementation status tracking with checkboxes
- Document admin interface architecture (admin-api, admin-ui)
- Add Cloudflare Access configuration guide
- Add admin.rati.chat domain setup instructions
- Update file structure to reflect new packages
- Add CDK resources documentation
- Update next steps with deployment priorities

This establishes the foundation for the admin interface deployment.
EOF
)"
```

## Commit 2: Documentation - Development Guide

```bash
git add CLAUDE.md
git commit -m "$(cat <<'EOF'
docs: add CLAUDE.md development guide

- Define conventional commit format and scopes
- Document GitHub issue management workflow
- Add branching strategy guidelines
- Document CI/CD pipeline
- Add security guidelines
- Include common tasks and troubleshooting

This guide ensures consistent development practices.
EOF
)"
```

## Commit 3: CI - Issue Templates

```bash
git add .github/ISSUE_TEMPLATE/ .github/pull_request_template.md
git commit -m "$(cat <<'EOF'
ci: add GitHub issue and PR templates

- Add feature request template (feature_request.yml)
- Add bug report template (bug_report.yml)
- Add task/chore template (task.yml)
- Add PR template with checklist
- Configure issue template options

Enables consistent issue tracking and PR reviews.
EOF
)"
```

## Commit 4: CI - Issue Management Workflow

```bash
git add .github/workflows/issue-management.yml
git commit -m "$(cat <<'EOF'
ci: add automated issue management workflow

- Auto-label issues based on title keywords
- Mark issues as in-progress when assigned
- Link PRs to issues automatically
- Close issues when PRs are merged
- Add status tracking labels

Automates issue lifecycle management.
EOF
)"
```

## Commit 5: Feature - Admin API Package

```bash
git add packages/admin-api/
git commit -m "$(cat <<'EOF'
feat(admin-api): add conversational admin interface backend

Add @swarm/admin-api package with:
- Cloudflare Access JWT authentication
- LLM-powered chat handler with 20 admin tools
- Write-only secrets service (KMS encrypted)
- Wallet generation service (Solana + Ethereum)
- Agent CRUD operations

Tools include:
- Agent management (create, list, update, delete)
- Platform configuration (Telegram, Twitter, Discord)
- Secret storage (write-only, never readable)
- Wallet generation (keys stay in Lambda)
- LLM configuration
- Deployment triggers

Security: Admin can SET secrets but never READ values.
EOF
)"
```

## Commit 6: Feature - Admin UI Package

```bash
git add packages/admin-ui/
git commit -m "$(cat <<'EOF'
feat(admin-ui): add React chat interface for admin

Add @swarm/admin-ui package with:
- React 18 + TypeScript + Vite
- Tailwind CSS dark theme
- Zustand state management
- Chat message components
- API client for admin-api

Features:
- Real-time chat with admin agent
- Message history management
- Loading states and error handling
- Responsive design

To be deployed to S3 + CloudFront behind Cloudflare Access.
EOF
)"
```

## Commit 7: Feature - Admin Infrastructure

```bash
git add packages/infra/src/constructs/admin-api.ts packages/infra/src/constructs/index.ts
git commit -m "$(cat <<'EOF'
feat(infra): add AdminApiConstruct for admin deployment

Add CDK construct for admin interface:
- KMS key for secret encryption (with rotation)
- DynamoDB table for admin data (with GSI)
- HTTP API Gateway with CORS
- Lambda function for chat handler
- Health check endpoint
- Proper IAM permissions (write-only for secrets)

Outputs: API endpoint, table name, KMS key ARN

Deploy with: cdk deploy SwarmAdminStack
EOF
)"
```

## Commit 8: Chore - Lock File Update

```bash
git add pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
chore: update pnpm lock file

Add dependencies for new packages:
- @swarm/admin-api
- @swarm/admin-ui
EOF
)"
```

## Execute All Commits

Run this script to execute all commits:

```bash
#!/bin/bash
set -e

echo "Creating commits..."

# Commit 1: Plan
git add PLAN.md
git commit -m "docs(plan): comprehensive update with admin interface and domain setup"

# Commit 2: CLAUDE.md
git add CLAUDE.md
git commit -m "docs: add CLAUDE.md development guide"

# Commit 3: Issue templates
git add .github/ISSUE_TEMPLATE/ .github/pull_request_template.md
git commit -m "ci: add GitHub issue and PR templates"

# Commit 4: Issue workflow
git add .github/workflows/issue-management.yml
git commit -m "ci: add automated issue management workflow"

# Commit 5: Admin API
git add packages/admin-api/
git commit -m "feat(admin-api): add conversational admin interface backend"

# Commit 6: Admin UI
git add packages/admin-ui/
git commit -m "feat(admin-ui): add React chat interface for admin"

# Commit 7: Admin infra
git add packages/infra/src/constructs/admin-api.ts packages/infra/src/constructs/index.ts
git commit -m "feat(infra): add AdminApiConstruct for admin deployment"

# Commit 8: Lock file
git add pnpm-lock.yaml
git commit -m "chore: update pnpm lock file"

echo "All commits created successfully!"
echo "Review with: git log --oneline -10"
echo "Push with: git push origin main"
```

## After Committing

1. Push to GitHub: `git push origin main`
2. Create GitHub issues for remaining work:
   - Issue: "Improve Ethereum wallet generation with ethers.js"
   - Issue: "Add audit logging service"
   - Issue: "Implement wallet balance checking tool"
   - Issue: "Setup admin.rati.chat domain on Cloudflare"
   - Issue: "Deploy admin interface to production"

3. Delete this file: `rm COMMITS.md`
