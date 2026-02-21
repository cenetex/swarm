# Branch Protection Policy for `main`

This document records the required branch protection settings for the `main` branch
of `cenetex/aws-swarm`. Settings are configured in the GitHub UI under
**Settings > Branches > Branch protection rules > `main`**.

Reference issue: #289

## Required Settings Checklist

### Pull Request Reviews
- [x] **Require a pull request before merging**
  - [x] Require approvals: **minimum 1**
  - [x] Require review from Code Owners
  - [x] Dismiss stale pull request approvals when new commits are pushed

### Conversation Resolution
- [x] **Require conversation resolution before merging**

### Status Checks
- [x] **Require status checks to pass before merging**
  - [x] Require branches to be up to date before merging
  - Required checks:
    - `build` (CI workflow)
    - `lint` (CI workflow)
    - `test` (CI workflow)

### Commit Signatures
- [ ] **Require signed commits** -- evaluate feasibility; document exception if not enabled

### Additional Recommendations
- [x] Do not allow bypassing the above settings (applies to admins too)
- [x] Restrict who can push to matching branches (limit to maintainers)
- [x] Block force pushes
- [x] Block branch deletion

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
