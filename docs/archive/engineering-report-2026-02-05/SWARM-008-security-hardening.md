# SWARM-008: Security Hardening

**Priority:** P2 — Integrated on mainline (validation pass)
**Package:** `@swarm/infra`

## Worker Assignment

- **Assigned Worker:** `worker-008`
- **Branch:** `feat/swarm-008`
- **Worktree:** `/Users/ratimics/develop/aws-swarm-swarm-008`
- **Current Lane Status:** `integrated on mainline (validation pass)` (`33762c8` for infra hardening, `5c1c25d` for deploy workflow cleanup)
- **Core Mission:** Close known infra security gaps with additive, auditable controls that reduce exposure without disrupting existing traffic paths.

## Items

### 1. Add WAF to CloudFront and API Gateway
Currently no AWS WAF is attached. The system relies on Cloudflare Access, but API Gateway URLs are directly accessible.

- Attach WAF WebACL with rate limiting and IP reputation rules
- Apply to Admin API HTTP API and all CloudFront distributions

### 2. Scope Bedrock IAM Policies
`bedrock:InvokeModel` uses `Resource: *`. Scope to specific model ARNs:
`arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-*`

### 3. Encrypt Per-Avatar SQS Queues
Shared handler queues use `SQS_MANAGED` encryption. Per-avatar queues do not.
Add `encryption: sqs.QueueEncryption.SQS_MANAGED` to all per-avatar queue constructs.

### 4. Remove Disabled Dangerous Code
Deploy workflow contains disabled S3 bucket deletion code. Remove entirely.

## Validation Evidence

- `33762c8` (`feat(infra): add onboarding CDK construct updates`)
  - Added shared WAF utility and attached WebACLs to CloudFront distributions and Admin API stage associations.
  - Scoped Bedrock invoke permissions from wildcard to `arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-*`.
  - Enabled `sqs.QueueEncryption.SQS_MANAGED` on per-avatar queue resources.
- `5c1c25d` (`chore(ci): remove disabled cleanup script block (SWARM-008)`)
  - Removed disabled destructive cleanup block from `.github/workflows/deploy.yml`.
- Local validation command:
  - `pnpm --filter @swarm/infra build`

## Acceptance Criteria

- [x] WAF WebACL deployed on admin API and CloudFront distributions
- [x] Bedrock IAM scoped to specific model ARN patterns
- [x] All SQS queues encrypted
- [x] Dangerous disabled code removed from deploy workflow
