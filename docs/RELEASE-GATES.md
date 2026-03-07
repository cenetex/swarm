# Release Gates and Rollback Readiness Standard

> **Owner**: Leadership
> **Last reviewed**: 2026-02-23
> **Status**: Active
> **Canonical source**: This document is the authoritative reference for release gate policy. The summary in [STRATEGY-OPERATIONS.md -- Section 3](./STRATEGY-OPERATIONS.md) defers to this document for full detail.
> **Related**: [STRATEGY-OPERATIONS.md](./STRATEGY-OPERATIONS.md) | [PRODUCTION-DEPLOYMENT-CHECKLIST.md](./PRODUCTION-DEPLOYMENT-CHECKLIST.md) | [SECURITY.md](./SECURITY.md) | [branch-protection.md](./branch-protection.md) | [CLAUDE.md](../CLAUDE.md)

---

## Purpose

Every change merged to `main` and every release tagged for production must pass a defined quality gate. This document specifies:

1. The mandatory checks that constitute the gate.
2. How each check is enforced (automated vs. manual).
3. The rollback readiness requirements for every release.
4. The change-risk annotation scheme for PRs.
5. The minimal evidence that must be present in PRs and issues before merge.

**Core rule: No gate, no ship.**

---

## 1. Mandatory Release Gate Checklist

A PR may only be merged to `main` -- and a release tag (`v*`) may only be created on `main` -- when ALL of the following gates pass.

### 1.1 Automated Gates (CI-enforced)

These gates are enforced by the `ci.yml` workflow and GitHub branch protection. They cannot be bypassed without explicitly skipping branch protection (which is blocked for all users including admins per [branch-protection.md](./branch-protection.md)).

| ID | Gate | What It Checks | Enforcement |
|----|------|----------------|-------------|
| G1 | **Lint** | ESLint across all packages, circular dependency check, security exception validation. | `ci.yml` > `lint` job: `pnpm -r run lint`, `pnpm check:circular`, `node scripts/validate-security-exceptions.mjs --ci`. |
| G2 | **Build** | All packages compile. Build artifacts (`dist/`) exist for every package that should produce them. | `ci.yml` > `build-and-test` job: `pnpm -r build` + artifact validation step. |
| G3 | **Test** | All unit tests pass. Test coverage meets or exceeds the threshold (currently 40%). | `ci.yml` > `build-and-test` job: `bun test --coverage` + `scripts/check-coverage.sh`. |
| G4 | **Security audit** | No high or critical severity CVEs in production dependencies. | `ci.yml` > `audit` job: `pnpm audit --prod --audit-level=high`. |

The `ci` summary job aggregates G1-G4 into a single required status check (`CI`). If any sub-job fails, the unified gate fails, and the PR cannot be merged.

### 1.2 Branch Protection Gates

These are enforced by GitHub branch protection rules on `main` (configured per [branch-protection.md](./branch-protection.md)):

| ID | Gate | Enforcement |
|----|------|-------------|
| G5 | **PR required** | Direct pushes to `main` are blocked. All changes go through PRs. |
| G6 | **Review required** | Minimum 1 approval from a code owner. Stale approvals are dismissed on new commits. |
| G7 | **Conversations resolved** | All review comments must be resolved before merge. |
| G8 | **Branch up-to-date** | The PR branch must be current with `main` before merging. |

### 1.3 Manual Gates (Pre-Release)

These gates apply before creating a release tag (`v*`) for production deployment. They are verified by a human (typically leadership) before tagging.

| ID | Gate | Criterion | How to Verify |
|----|------|-----------|---------------|
| G9 | **Scorecard health** | Latest leadership scorecard is not RED. | Download the most recent artifact from the `leadership-scorecard.yml` workflow run. Confirm the overall grade is YELLOW or GREEN. |
| G10 | **No expired security exceptions** | `security-exceptions.yml` workflow shows zero EXPIRED entries. | Check the latest Monday run of `security-exceptions.yml`. |
| G11 | **Staging verified** | Critical flows pass on staging. | Run the staging verification checklist (see [Section 4](#4-staging-verification-checklist)). |
| G12 | **No unresolved P0/P1 incidents** | All active incidents are resolved or have documented workarounds. | Check the `priority:high` + `type:bug`/`type:security` issue list. |
| G13 | **Changelog reviewed** | Release notes accurately reflect included changes. | Review auto-generated notes from `release-notes.yml` or draft manually. |

### 1.4 Gate Summary

```
PR Merge Gate:       G1 + G2 + G3 + G4 (CI) + G5 + G6 + G7 + G8 (branch protection)
Production Release:  All PR gates + G9 + G10 + G11 + G12 + G13 (manual pre-tag)
```

---

## 2. Rollback Readiness

Every production release must be rollback-ready. This means the team can revert to the previous known-good state within the target time without data loss.

### 2.1 Rollback Target

| Metric | Target |
|--------|--------|
| Time to initiate rollback | < 15 minutes from decision |
| Time to complete rollback | < 30 minutes (CDK deploy of previous version) |
| Data loss on rollback | Zero (DynamoDB data is not affected by Lambda/CloudFront rollback) |

### 2.2 Rollback Mechanisms

| Component | Rollback Method | Notes |
|-----------|----------------|-------|
| **Lambda functions** | Redeploy previous CDK state via `deploy-lambda-hotpatch.yml` or full `deploy.yml` from a prior commit/tag. | Lambda versions are immutable. Redeploying the previous code restores prior behavior. |
| **CDK infrastructure** | Redeploy from the prior release tag: `git checkout v<previous>` then trigger `deploy.yml`. | CDK stacks use `RETAIN` for data resources. Infrastructure rollback does not delete DynamoDB tables or S3 buckets. |
| **Admin UI (CloudFront + S3)** | Redeploy from prior tag via `deploy-admin-ui-reusable.yml`. CloudFront invalidation propagates in ~5 minutes. | Static assets are versioned in S3. |
| **DynamoDB schema changes** | Forward-fix only. Schema migrations must be backward-compatible (see [Section 2.4](#24-backward-compatibility-rule)). | Rollback of Lambda code must work against both old and new schema. |
| **Secrets Manager** | Manual restore from version history. | Secrets Manager retains version history by default. |

### 2.3 Rollback Procedure

1. **Identify** the last known-good release tag (e.g., `v0.3.12`).
2. **Trigger** the deploy workflow manually:
   - Go to Actions > Deploy > Run workflow.
   - Select environment: `production`.
   - The workflow will deploy the CDK and Admin UI from the current `main` state.
   - If `main` has moved forward, use `deploy-lambda-hotpatch.yml` to patch individual Lambdas from a known-good commit, or check out the prior tag and push a revert commit.
3. **Verify** using the [production smoke checks](#4-staging-verification-checklist) (adapted for production).
4. **Communicate** the rollback in the release issue/PR and in any active incident thread.

### 2.4 Backward Compatibility Rule

DynamoDB schema changes and API contract changes MUST be backward-compatible for at least one release cycle. This means:

- **Adding a new field**: OK. Old code ignores unknown fields.
- **Removing a field**: First release marks the field as deprecated and stops writing it. Second release (after rollback window closes) removes the read path.
- **Renaming a field**: Treat as add-new + deprecate-old. Both field names must be supported during the transition.
- **Changing field type**: Not allowed in a single release. Use the add/deprecate pattern.

This rule ensures that rolling back Lambda code after a schema change does not cause runtime errors.

### 2.5 Rollback Evidence in PRs

Every PR that changes deployed code (Lambda, CDK infra, Admin UI) must include a rollback statement in the PR description. See [Section 5.2](#52-pr-evidence-requirements).

---

## 3. Change-Risk Annotation

Every PR must be annotated with a risk level to help reviewers calibrate their review depth and to flag changes that require extra rollback preparation.

### 3.1 Risk Levels

| Level | Label | Criteria | Review Requirements |
|-------|-------|----------|-------------------|
| **Low** | `risk:low` | Documentation, test-only changes, config tweaks with no runtime effect. | Standard review (1 approval). |
| **Medium** | `risk:medium` | New features, non-breaking refactors, dependency updates, changes to a single package. | Standard review. Reviewer should verify test coverage for changed paths. |
| **High** | `risk:high` | Breaking changes, DynamoDB schema changes, IAM policy changes, multi-package changes, new infrastructure resources, security-sensitive changes. | Careful review. PR must include a rollback plan. CDK diff output should be attached. |
| **Critical** | `risk:critical` | Data migrations, removal of infrastructure resources, authentication/authorization changes, billing logic changes. | Leadership approval required. PR must include rollback plan, CDK diff, and a staged deployment plan (staging verified before production). |

### 3.2 Applying Risk Annotations

The PR author sets the risk label when opening the PR. Reviewers may escalate the risk level during review. The risk label is informational (not a CI gate) but is required for all PRs touching deployed code.

### 3.3 Risk-Specific Requirements

| Risk Level | Rollback Plan Required | CDK Diff Required | Staged Deploy Required | Leadership Approval |
|------------|----------------------|-------------------|----------------------|-------------------|
| Low | No | No | No | No |
| Medium | No | If infra changes | No | No |
| High | Yes | Yes | Recommended | No |
| Critical | Yes | Yes | Yes | Yes |

---

## 4. Staging Verification Checklist

Before tagging a production release, the following flows must be verified on staging. This checklist is a subset of [PRODUCTION-DEPLOYMENT-CHECKLIST.md](./PRODUCTION-DEPLOYMENT-CHECKLIST.md) Section 5-6.

| Check | How | Pass Criteria |
|-------|-----|---------------|
| Admin UI loads | Visit `https://staging-swarm.rati.chat` | Page renders without console errors. |
| API responds | `curl https://staging-swarm.rati.chat/api` | Returns HTTP 200 or 401 (authenticated endpoint). |
| Authentication flow | Log in via Privy/Cloudflare Access | Session cookie set, user context available. |
| Avatar creation | Chat: "Create a test avatar" | Avatar created, visible in list. |
| Telegram webhook (if applicable) | Send a message to the staging bot | Response received within 30 seconds. |
| E2E tests pass | Automated: `e2e` job in `deploy.yml` for staging | Both Telegram and Web E2E pass. |

If any check fails, the production release is blocked until the failure is resolved.

---

## 5. PR and Issue Evidence Requirements

### 5.1 Issue Evidence Requirements

Every issue that results in a merged PR must have:

| Evidence | Where | Required? |
|----------|-------|-----------|
| Acceptance criteria with checkboxes | Issue body | Yes (all issues) |
| Validation commands | Issue body | Recommended (required for agent-assigned issues per [ISSUE-GOVERNANCE.md](./ISSUE-GOVERNANCE.md)) |
| Package label | Issue labels | Yes |
| Priority label | Issue labels | Yes |

### 5.2 PR Evidence Requirements

Every PR merged to `main` must include the following in its description:

| Evidence | Required For | Example |
|----------|-------------|---------|
| **Issue reference** | All PRs | `Closes #265` or `Related to #265` |
| **Summary of changes** | All PRs | 1-3 bullet points describing what changed and why. |
| **Risk label** | PRs touching deployed code | `risk:medium` |
| **Test evidence** | All PRs with code changes | "All existing tests pass. Added `memory-ttl.test.ts` covering expiry and deletion." |
| **Rollback plan** | `risk:high` and `risk:critical` PRs | "Rollback: redeploy previous Lambda version. No schema changes; rollback is safe." |
| **CDK diff** | PRs changing `packages/infra/` | Paste or attach the output of `npx cdk diff`. |
| **Staging verification** | `risk:critical` PRs | "Verified on staging: avatar creation, Telegram webhook, and auth flow all pass." |

### 5.3 Commit Message Evidence

All commits follow the [Conventional Commits](https://www.conventionalcommits.org/) format with a scope matching the affected package (see [CLAUDE.md](../CLAUDE.md) for the full scope table). The commit message footer must reference the governing issue:

```
feat(core): add memory TTL support

Adds configurable TTL for memory entries with automatic expiry.

Closes #150
```

---

## 6. Gate Override Protocol

A gate may be overridden only when ALL of the following conditions are met:

1. The override is documented in the release issue/PR with:
   - The specific gate ID being overridden (e.g., "Overriding G10").
   - The justification for the override.
   - The risk assessment of shipping without this gate.
2. A second team member (or leadership) explicitly approves the override in a PR comment.
3. A follow-up issue is created to remediate the skipped gate within 7 days.
4. The override is noted in the release notes.

Gate overrides for G1-G4 (CI automated gates) require disabling branch protection, which is restricted to repository admins and strongly discouraged. Prefer fixing the issue over overriding.

---

## 7. Enforcement Map

This table maps each gate to its enforcement mechanism, making it auditable whether the documented gates match actual CI/CD behavior.

| Gate | Enforcement Mechanism | Configuration Location |
|------|----------------------|----------------------|
| G1 Lint | `ci.yml` > `lint` job | `.github/workflows/ci.yml` |
| G2 Build | `ci.yml` > `build-and-test` job | `.github/workflows/ci.yml` |
| G3 Test | `ci.yml` > `build-and-test` job | `.github/workflows/ci.yml` |
| G4 Security audit | `ci.yml` > `audit` job | `.github/workflows/ci.yml` |
| G5 PR required | GitHub branch protection | Settings > Branches > `main` ([branch-protection.md](./branch-protection.md)) |
| G6 Review required | GitHub branch protection (CODEOWNERS) | `.github/CODEOWNERS` + branch protection |
| G7 Conversations resolved | GitHub branch protection | Settings > Branches > `main` |
| G8 Branch up-to-date | GitHub branch protection | Settings > Branches > `main` |
| G9 Scorecard health | Manual check before tagging | `.github/workflows/leadership-scorecard.yml` |
| G10 Security exceptions | Manual check + weekly automation | `.github/workflows/security-exceptions.yml` |
| G11 Staging verified | Manual + E2E in `deploy.yml` | `.github/workflows/deploy.yml` > `e2e` job |
| G12 No P0/P1 incidents | Manual triage review | Issue tracker |
| G13 Changelog reviewed | Manual + `release-notes.yml` | `.github/workflows/release-notes.yml` |

### Local Enforcement (Git Hooks)

In addition to CI, developers have local gates via Husky:

| Hook | Gates Covered | Skip With |
|------|--------------|-----------|
| `pre-commit` | Branch guard, issue hygiene, lockfile sync, lint (subset of G1) | `SKIP_PRECOMMIT=1` |
| `pre-push` | Lint, build, admin-ui build, Privy smoke test, tests (G1+G2+G3) | `SKIP_PREPUSH=1` |

Skipping local hooks does not bypass CI gates. CI is the authoritative enforcement layer.

---

## 8. Workflow Alignment Audit

To verify that this document remains aligned with actual CI/CD behavior, perform this audit quarterly (or whenever workflows change):

1. Compare each gate in Section 1 against the corresponding workflow file.
2. Verify that branch protection settings match Section 1.2 by reviewing Settings > Branches.
3. Confirm that the `ci` summary job in `ci.yml` aggregates all expected sub-jobs.
4. Run a test PR to verify that failing any single gate blocks merge.
5. Document any discrepancies as issues with `type:docs` + `priority:medium`.

---

*Last updated: 2026-02-23*
