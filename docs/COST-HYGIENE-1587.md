# Cost Hygiene Sweep (#1587) — Findings & Actions

## Summary

Cost-reduction initiative targeting staging/prod spend differential. Staging is running 5× prod despite being a test environment.

## Changes Made

### 1. Log Retention Settings (✅ Completed)

**Goal:** Reduce CloudWatch costs by implementing appropriate retention policies.

**Changes:**
- Updated all swarm-* Lambda log groups to use:
  - **Prod:** 30 days (ONE_MONTH) — from TWO_WEEKS/ONE_MONTH mix
  - **Staging:** 7 days (ONE_WEEK) — from THREE_DAYS
  
**Files modified:**
- `packages/infra/src/constructs/shared-handlers.ts`
- `packages/infra/src/constructs/admin-api.ts`
- `packages/infra/src/constructs/discord-gateway-worker.ts`
- `packages/infra/src/constructs/claude-code-worker.ts`

**Rationale:** Access log retention in admin-api was already properly configured (30d prod, 7d staging). Main log group retention is now uniform and intentional.

**Estimated savings:** $30–40/mo on staging CloudWatch, smaller impact on prod.

### 2. Secrets Manager Audit (✅ Completed)

**Script created:** `scripts/audit-secrets.sh <env>`

**Output format:**
```json
[
  {
    "name": "swarm/agent-1-abc/telegram_bot_token",
    "lastAccessed": "2026-04-25T10:30:00Z",
    "ageDays": 2,
    "hasMatchingAvatar": true,
    "extractedAvatarId": "agent-1-abc"
  }
]
```

**Usage:**
```bash
scripts/audit-secrets.sh staging
scripts/audit-secrets.sh prod
AWS_PROFILE=prod scripts/audit-secrets.sh prod
```

**Scope:** Lists all `swarm/*` secrets with LastAccessedDate and avatar matching. **No deletions** — human review required.

**Estimated cost:** Staging has 78+ secrets @ $0.40/mo = $31+/mo. Prod 100+ @ $40+/mo.

### 3. Staging Cost Drift Investigation

#### 3a. EC2-Other ($7.15/mo)
**Finding:** Unexpected in a serverless stack. Likely orphaned EBS volume(s) or NAT gateway/ENI.

**Action needed:** Manual AWS CLI audit:
```bash
aws ec2 describe-volumes --region us-east-1 --profile staging
aws ec2 describe-nat-gateways --region us-east-1 --profile staging
```
Look for unattached/unused resources from archived projects (telegram, cloudflare-swarm, cosyworld8, signal-old).

#### 3b. WorkMail ($6.40/mo)
**Finding:** Staging has `rati`, `cometocq`, and `lollipop-phone` orgs.

- `rati` org: **ACTIVE** → Leave as-is (business resource)
- `cometocq` org: Deleted state → No action (already deleted)
- `lollipop-phone` org: Deleted state → No action (already deleted)

**Action:** None. Confirm billing has stopped for deleted orgs via AWS Billing report.

#### 3c. Bedrock Usage ($2.71/mo total; $1.68 Haiku, $1.03 Sonnet)
**Finding:** Unexpected on staging (platform default is Anthropic-direct, not AWS Bedrock).

**Action needed:** Search codebase for Bedrock calls:
```bash
grep -r "bedrock" . --include="*.ts" --include="*.js" | grep -v node_modules | grep -v dist
grep -r "InvokeModel" . --include="*.ts" --include="*.js" | grep -v node_modules | grep -v dist
```

**Root causes to investigate:**
- A/B test or experiment (check handlers, admin-api, core services)
- Leftover code from Bedrock eval
- Avatar-specific Bedrock setup (check avatar configs)

## Out of Scope (per issue)

- WAF rule pruning ($11/mo prod, $18/mo staging)
- ECS task right-sizing ($11/mo prod)
- Cross-account Cost Anomaly Detection

## Follow-up Actions (Separate Issues)

1. **Secret cleanup flow:** Implement avatar-delete path that revokes and removes secrets.
   - Update: `docs/SECURITY.md` or `docs/OPERATING-MODEL.md`
   - Rule: "When an avatar is deleted, all secrets under `swarm/<avatarId>/*` must be revoked and removed within 30 days."

2. **Bedrock caller identification:** File follow-up if intentional A/B is found; clean up if experiment.

3. **Orphaned EC2 cleanup:** After manual audit, file follow-up with specific volume/gateway IDs for removal.

## Verification

Before merge:
- [ ] Run `pnpm build` to ensure CDK construct syntax is valid
- [ ] Verify `scripts/audit-secrets.sh staging` runs without error
- [ ] Confirm log retention settings compile correctly

## Tracking

**Issue:** #1587  
**Labels:** priority:low, package:infra, type:tech-debt  
**Date:** 2026-04-25
