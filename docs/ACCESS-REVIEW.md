# Privileged Access Review Process

This document describes the recurring privileged-access review control for the `cenetex/aws-swarm` repository and its associated AWS infrastructure.

Related docs:
- [GitHub Permissions & Access Model](./GITHUB-PERMISSIONS.md) -- role definitions, permission matrix
- [Branch Protection Policy](./branch-protection.md) -- `main` branch settings
- [Security Policy](./SECURITY.md) -- dependency audits, vulnerability handling

---

## Purpose

Privileged access -- GitHub admin roles, deployment IAM roles, admin email/wallet lists, environment secrets, and deploy keys -- must be reviewed on a recurring schedule to ensure:

1. **Least privilege** -- No one has more access than their role requires.
2. **No orphaned accounts** -- Former contributors, stale deploy keys, and unused bot accounts are removed.
3. **Audit trail** -- Evidence of each review cycle is retained for compliance.
4. **Accountability** -- Every privileged principal has an identified owner.

---

## Privileged Access Inventory

The review covers the following sources:

| Source | What is Reviewed | How it is Collected |
|--------|-----------------|---------------------|
| GitHub collaborators | User login, role (Admin/Write/Triage) | `gh api repos/{owner}/{repo}/collaborators` |
| GitHub teams | Team name, permission level | `gh api repos/{owner}/{repo}/teams` |
| Deploy keys | Key title, read/write access, creation date | `gh api repos/{owner}/{repo}/keys` |
| GitHub environments | Environment name, protection rules | `gh api repos/{owner}/{repo}/environments` |
| CDK context (admin emails) | Admin email addresses in `cdk.context.json` | Parsed from `adminEmails` field |
| CDK context (admin wallets) | Admin wallet addresses in `cdk.context.json` | Parsed from `adminWallets` field |
| AWS IAM roles | Role name, ARN, creation date (roles matching `*swarm*`) | `aws iam list-roles` |
| AWS OIDC providers | Provider ARN | `aws iam list-open-id-connect-providers` |

---

## Review Schedule

| Frequency | Trigger | Mechanism |
|-----------|---------|-----------|
| **Quarterly** (Jan, Apr, Jul, Oct) | Automated | GitHub Actions cron: `0 9 1 1,4,7,10 *` |
| **On-demand** | Manual | `workflow_dispatch` on the `access-review.yml` workflow |
| **After security incident** | Manual | Run immediately after any access-related incident |

---

## Workflow

### Automated Steps (GitHub Actions)

The `access-review.yml` workflow performs the following:

1. **Collect inventory** -- Runs `scripts/access-review.sh` to query all privileged-access sources.
2. **Generate evidence** -- Produces both a human-readable Markdown report and a machine-readable JSON artifact.
3. **Upload artifact** -- Stores the evidence packet as a GitHub Actions artifact with 400-day retention (exceeds annual audit window).
4. **Create review issue** -- Opens a GitHub issue titled `chore(governance): Q<N> <YEAR> privileged access review` with the full report and a review checklist.
5. **Flag findings** -- If stale, unknown, or policy-violating principals are detected, creates separate blocking issues labeled `type:security`.

### Manual Steps (Reviewer)

After the workflow runs, the designated reviewer must:

1. **Open the review issue** created by the workflow.
2. **Download the evidence artifact** from the linked workflow run.
3. **For each principal** in the report, record a decision:

   | Decision | Meaning |
   |----------|---------|
   | **Retain** | Access is appropriate and still needed |
   | **Modify** | Access level should be changed (e.g., Admin to Write) |
   | **Revoke** | Access should be removed |
   | **Investigate** | Ownership/purpose unclear; needs follow-up |

4. **Execute changes** -- Remove revoked access, modify roles as decided, create issues for investigations.
5. **Resolve findings** -- Close any auto-created finding issues once addressed.
6. **Sign off** -- Check the sign-off box in the review issue and close it.

---

## Break-Glass Accounts

Break-glass (emergency access) accounts bypass normal access controls and must be documented and audited with extra scrutiny.

### Current Break-Glass Configuration

| Principal | Type | Purpose | Access Level |
|-----------|------|---------|-------------|
| Repository owner (`@cenetex`) | GitHub user | Emergency admin access | GitHub Admin |
| `aws-swarm-github-actions` IAM role | AWS IAM role | CI/CD deployment via OIDC | CDK deploy, Lambda update, S3 write |

### Break-Glass Rules

1. **Documentation** -- Each break-glass account must be listed in this table with its purpose.
2. **Minimal count** -- No more than 2 break-glass accounts per system (GitHub, AWS).
3. **Usage logging** -- All break-glass usage must be documented in a GitHub issue within 24 hours.
4. **Quarterly review** -- Break-glass accounts are included in the standard quarterly review.
5. **Rotation** -- Break-glass credentials (if any) must be rotated at least annually.

### Using Break-Glass Access

When break-glass access is needed:

1. Create a GitHub issue documenting the emergency and the access used.
2. Perform only the minimum actions needed to resolve the emergency.
3. Within 24 hours, update the issue with: what was done, why, and any follow-up actions.
4. Tag the issue with `type:security` and `priority:high`.

---

## Automated Findings

The review script detects the following conditions and creates GitHub issues:

| Finding | Severity | Threshold |
|---------|----------|-----------|
| Too many GitHub admins | High | More than 2 admin users |
| Deploy keys with write access | Medium | Any deploy key with `read_only: false` |
| No GitHub environments | Medium | Zero environments configured |

These issues are created with the `type:security` label and an appropriate priority label. They serve as blocking follow-ups that must be resolved before the review cycle is considered complete.

---

## Evidence Retention

| Artifact | Format | Retention | Location |
|----------|--------|-----------|----------|
| Access review report | Markdown + JSON | 400 days | GitHub Actions artifacts |
| Review issue | GitHub issue | Permanent | GitHub Issues |
| Finding issues | GitHub issues | Permanent | GitHub Issues |
| Decision log | Issue comments | Permanent | Review issue thread |

The 400-day artifact retention exceeds the standard annual audit window, ensuring evidence is available for any audit period.

---

## Running the Review Manually

```bash
# Generate a human-readable report
./scripts/access-review.sh

# Generate a machine-readable JSON report
./scripts/access-review.sh --json

# Write evidence files to a directory
./scripts/access-review.sh --output-dir ./evidence

# Run with AWS credentials for full IAM inventory
aws-vault exec swarm -- ./scripts/access-review.sh
```

The script requires `gh` CLI authentication (`GH_TOKEN` or `gh auth login`). AWS credentials are optional but recommended for complete coverage.

---

## Quarterly Recertification Process

### Timeline

| Week | Activity |
|------|----------|
| Week 1 | Automated workflow runs, creates review issue |
| Week 1-2 | Reviewer examines report, records decisions |
| Week 2-3 | Execute access changes (revoke, modify) |
| Week 3-4 | Resolve all finding issues, sign off |

### Responsibilities

| Role | Responsibility |
|------|---------------|
| **Admin** (GitHub Admin role holder) | Execute access changes, sign off on review |
| **Leadership** (Triage role holders) | Validate business need for each privileged principal |

### Completion Criteria

A quarterly review is complete when:

- [ ] All principals in the report have a recorded decision (Retain/Modify/Revoke/Investigate)
- [ ] All "Revoke" decisions have been executed
- [ ] All "Modify" decisions have been executed
- [ ] All "Investigate" items have follow-up issues
- [ ] All auto-created finding issues are resolved or have documented exceptions
- [ ] The review issue is signed off and closed

---

## Revision History

| Date | Change | Author |
|------|--------|--------|
| 2026-02-23 | Initial version -- process definition, automation, break-glass documentation | @cenetex |

---

*Last updated: 2026-02-23*
