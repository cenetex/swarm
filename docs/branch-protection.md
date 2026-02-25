# Branch Protection Policy for `main`

This document records the required branch protection settings for the `main` branch
of `cenetex/aws-swarm`. Settings are configured in the GitHub UI under
**Settings > Branches > Branch protection rules > `main`**.

Reference issue: #289

## Current Settings (active)

### Pull Request Reviews
- [x] **Require a pull request before merging**
  - Approvals: **0** (solo dev — no reviewers available yet)

### Status Checks
- [x] **Require status checks to pass before merging**
  - [x] Require branches to be up to date before merging
  - Required checks: `CI`

### Push Restrictions
- [x] Block force pushes
- [x] Block branch deletion

### Local Enforcement (git hooks)
- [x] **pre-commit**: blocks commits on `main` and validates branch name matches `<type>/issue-<number>-*`
- [x] **pre-push**: validates branch name + runs lint/build/test

## Deferred Settings (enable when team grows)

These settings are documented for when additional developers join:

- [ ] Require approvals: **minimum 1**
- [ ] Require review from Code Owners
- [ ] Dismiss stale pull request approvals when new commits are pushed
- [ ] Require conversation resolution before merging
- [ ] Do not allow bypassing the above settings (applies to admins too)
- [ ] Require signed commits

## CODEOWNERS

The `.github/CODEOWNERS` file maps ownership so that PRs touching protected paths
automatically request review from the designated owners. Current mappings:

| Path | Owner |
|------|-------|
| `*` (default) | @cenetex |
| `packages/core/` | @cenetex |
| `packages/handlers/` | @cenetex |
| `packages/admin-api/` | @cenetex |
| `packages/admin-ui/` | @cenetex |
| `packages/infra/` | @cenetex |
| `.github/` | @cenetex |

## Drift Detection

A future automation check (scheduled workflow or script) should verify these
settings have not regressed. Track this under issue #289 or a follow-up issue.
