# Release Gate Policy

> Canonical reference for the CI-enforced release gate and branch protection rules.
> Workflow: `.github/workflows/release-gate.yml`

## Overview

Every pull request targeting `main` must pass the **Release Gate** status check
before merge. The gate is a single GitHub Actions job (`release-gate`) that
aggregates six sub-checks. Branch protection is configured to require this single
job, simplifying the required-checks list to one entry.

## Required Checks

| # | Check | What it verifies | Blocks merge on |
|---|-------|-----------------|-----------------|
| 1 | **Security Audit** | `pnpm audit --audit-level=high` with documented exceptions | Any new high/critical CVE |
| 2 | **Lint & Typecheck** | `pnpm lint`, `check:circular`, `pnpm typecheck` | Lint errors, circular deps, type errors |
| 3 | **Build** | `pnpm -r build` + artifact validation | Build failure or missing `dist/` output |
| 4 | **Test** | `bun test --coverage` + 40% threshold | Test failure or coverage regression |
| 5 | **PR Evidence** | PR body contains risk level, rollback plan, validation plan | Missing required sections |
| 6 | **Release Notes** | Changelog section present (release PRs only) | Missing changelog on release PRs |

## Branch Protection Configuration

Apply these settings to the `main` branch in **Settings > Branches > Branch protection rules**:

```
Branch name pattern: main

[x] Require a pull request before merging
    [x] Require approvals: 1
    [x] Dismiss stale pull request approvals when new commits are pushed

[x] Require status checks to pass before merging
    [x] Require branches to be up to date before merging
    Required status checks:
      - "Release Gate"

[x] Require conversation resolution before merging

[x] Do not allow bypassing the above settings
    (except for repository admins during incidents — see bypass section)
```

### Why a Single Required Check

GitHub evaluates required status checks by exact job name. If individual jobs
(`lint`, `test`, etc.) were listed, renaming or adding a job would silently
unblock merges until the branch protection rule is updated. The `release-gate`
aggregation job insulates branch protection from workflow refactors.

## PR Evidence Requirements

The PR template (`.github/pull_request_template.md`) includes three sections
that the `pr-evidence` job validates:

1. **Risk Level** -- Author must check exactly one of:
   - Low, Medium, High, Critical
2. **Rollback Plan** -- Free text describing how to revert the change.
3. **Validation / Test Plan** -- Steps reviewers can follow to verify correctness.

The CI check scans the PR body for these markers. If any are missing the gate
fails with a descriptive error message.

## Release Notes Enforcement

PRs that are labeled `release` or whose title starts with a version string
(`v1.2.3`) must include a **Changelog** or **Release Notes** section in the body.
Regular PRs skip this check.

## Incident Bypass Process

During a production incident where the fix must bypass the release gate:

### Who Can Bypass

Only **repository admins** may bypass branch protection. The bypass is logged by
GitHub in the repository audit log.

### Procedure

1. **Acknowledge the incident** in the team channel (Slack/Discord).
2. **Create the fix PR** as normal, noting in the body:
   ```
   INCIDENT BYPASS: <link to incident thread or issue>
   ```
3. An admin merges the PR using **"Merge without waiting for requirements"**
   (the admin bypass button in the GitHub UI).
4. **Post-incident** (within 24 hours):
   - File a follow-up issue documenting why the bypass was needed.
   - Label it `type:incident-followup`.
   - Ensure the fix is covered by tests in a subsequent PR.
   - Add the bypass to the next retrospective agenda.

### Audit Trail

Every admin bypass is visible in:
- **GitHub Audit Log**: `Settings > Audit log > Filter: "protected_branch.policy_override"`
- **PR timeline**: GitHub annotates the merge with a "merged without required checks" badge.

## Relationship to Existing CI

The `release-gate.yml` workflow is the sole required check for branch protection
on PRs. `ci.yml` runs only on pushes to `main` and tag pushes, providing
post-merge validation and artifact generation. The release gate covers all PR
quality checks (security audit, lint, typecheck, build, test) plus additional
PR-specific gates (PR evidence, release notes).

## Modifying This Policy

Changes to the release gate (adding/removing checks, adjusting thresholds)
should be proposed via a PR that modifies both the workflow file and this
policy document. The PR itself must pass the existing gate before merge.
