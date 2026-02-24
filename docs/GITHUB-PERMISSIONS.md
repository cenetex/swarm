# GitHub Permissions & Access Model

This document defines the role-based access model for the `cenetex/aws-swarm` repository. It supports an **issue-first workflow** where leadership drives strategy through GitHub Issues and Projects while implementation is carried out by agents and engineers through branches and pull requests.

Related docs:
- [Branch Protection Policy](./branch-protection.md) -- required `main` branch settings
- [Issue Governance](./ISSUE-GOVERNANCE.md) -- priority criteria, triage cadence, agent-ready requirements
- [Security Policy](./SECURITY.md) -- dependency audits, vulnerability handling

## Design Principles

1. **Least privilege** -- Each role gets the minimum permissions needed for its function.
2. **Issue-first** -- All work originates from a GitHub Issue. No PR should exist without a linked issue.
3. **Separation of direction and execution** -- Leadership sets priorities and acceptance criteria; implementation roles write and merge code.
4. **Auditability** -- Permission grants are documented and reviewed quarterly.

---

## Role Definitions

### 1. Leadership (GitHub Role: `Triage`)

Leaders direct strategy, create issues, manage projects, and review progress. They have **read-only access to code** and cannot push commits, approve PRs, or merge branches.

**Intended for:** Project owners, product leads, stakeholders who operate exclusively through issues and project boards.

**GitHub Permissions:**

| Capability | Allowed |
|------------|---------|
| View repository code, branches, commits | Yes |
| Clone / pull repository | Yes |
| Create, edit, close, reopen issues | Yes |
| Apply and manage labels | Yes |
| Manage GitHub Projects (boards, views, fields) | Yes |
| Assign issues to users or agents | Yes |
| Comment on issues and PRs | Yes |
| Create or approve pull requests | No |
| Push to any branch | No |
| Merge pull requests | No |
| Manage repository settings | No |
| Manage webhooks or deploy keys | No |

**How to grant:** Add user to the repository with the **Triage** role. Triage provides read access to code plus full issue/project management rights without any write access to code.

### 2. Implementation (GitHub Role: `Write`)

Engineers and coding agents (Copilot, Claude Code workers, worktree subagents) execute work by creating branches, pushing code, and opening pull requests. They operate within the guardrails defined by branch protections.

**Intended for:** Human developers, CI bots, and AI coding agents.

**GitHub Permissions:**

| Capability | Allowed |
|------------|---------|
| View repository code, branches, commits | Yes |
| Clone / pull repository | Yes |
| Create, edit, close, reopen issues | Yes |
| Create feature branches | Yes |
| Push to feature branches | Yes |
| Push directly to `main` | No (blocked by branch protection) |
| Open pull requests | Yes |
| Approve pull requests (non-own) | Yes |
| Merge pull requests (after approval + CI) | Yes |
| Manage repository settings | No |
| Manage webhooks or deploy keys | No |

**How to grant:** Add user to the repository with the **Write** role. Branch protections prevent direct pushes to `main` regardless of role.

### 3. Admin (GitHub Role: `Admin`)

Administrators manage repository settings, branch protections, secrets, and CI/CD configuration. This role should be held by as few people as possible.

**Intended for:** Repository owner and designated infrastructure maintainers only.

**GitHub Permissions:**

| Capability | Allowed |
|------------|---------|
| All capabilities from Leadership and Implementation | Yes |
| Manage branch protection rules | Yes |
| Manage repository settings | Yes |
| Manage webhooks and deploy keys | Yes |
| Manage GitHub Actions secrets and environments | Yes |
| Transfer or delete repository | Yes |
| Grant/revoke access to other users | Yes |

**How to grant:** Add user to the repository with the **Admin** role. Limit to 1-2 individuals.

---

## Permission Matrix Summary

| Capability | Leadership (Triage) | Implementation (Write) | Admin |
|------------|:-------------------:|:---------------------:|:-----:|
| Read code | Yes | Yes | Yes |
| Create/manage issues | Yes | Yes | Yes |
| Manage project boards | Yes | Yes | Yes |
| Apply labels | Yes | Yes | Yes |
| Push to feature branches | -- | Yes | Yes |
| Open pull requests | -- | Yes | Yes |
| Approve pull requests | -- | Yes | Yes |
| Merge PRs (with CI pass) | -- | Yes | Yes |
| Push to `main` directly | -- | -- | -- (*) |
| Manage branch protections | -- | -- | Yes |
| Manage repo settings | -- | -- | Yes |
| Manage secrets/environments | -- | -- | Yes |

(*) Branch protections block direct pushes to `main` for all roles, including Admin. The "Do not allow bypassing the above settings" rule is enabled (see [branch-protection.md](./branch-protection.md)).

---

## Branch Protection Rules

The following protections are enforced on `main` to support the issue-first workflow. Full details are in [branch-protection.md](./branch-protection.md).

### Required Protections

| Protection | Setting | Purpose |
|------------|---------|---------|
| Require pull request before merging | Enabled | All changes must go through PR review |
| Minimum approvals | 1 | At least one reviewer must approve |
| Require review from CODEOWNERS | Enabled | Package owners must review changes to their areas |
| Dismiss stale approvals on new commits | Enabled | Re-review required after changes |
| Require conversation resolution | Enabled | All review comments must be resolved |
| Require status checks to pass | `build`, `lint`, `test` | CI must be green before merge |
| Require branch up to date | Enabled | No stale merges |
| Block force pushes | Enabled | Preserve commit history |
| Block branch deletion | Enabled | Protect `main` from accidental deletion |
| Do not allow bypassing settings | Enabled | Admins follow the same rules |

### Branch Naming Convention

Feature branches must follow the pattern: `<type>/issue-<number>-<short-description>`

Examples:
- `feat/issue-42-wallet-balance`
- `fix/issue-43-dynamo-query`
- `docs/issue-251-github-permissions`

This convention enforces traceability from branch to issue.

---

## Issue-First Workflow Requirements

All work in this repository follows the issue-first model. This ensures that leadership can direct strategy entirely through GitHub Issues and Projects without needing code access.

### Workflow Steps

1. **Leadership creates an issue** with business outcome, acceptance criteria, and priority label (see [Issue Governance](./ISSUE-GOVERNANCE.md)).
2. **Issue is triaged** during the weekly triage cadence -- priority validated, agent-readiness checked, assignee designated.
3. **Implementation creates a feature branch** following the naming convention (`<type>/issue-<number>-<description>`).
4. **Implementation opens a PR** referencing the issue (`Closes #<number>` in the PR body or commit message).
5. **CI runs** -- lint, build, and test must pass.
6. **CODEOWNERS review** -- at least one designated owner approves.
7. **PR is merged** via squash merge to `main`.
8. **Issue is auto-closed** by the `Closes #<number>` reference.

### Enforcement

| Rule | Mechanism |
|------|-----------|
| Every PR must reference an issue | PR template includes `Closes #` field; enforced by review convention |
| No direct pushes to `main` | Branch protection rule |
| CI must pass | Required status checks |
| At least one approval | Required reviews |
| CODEOWNERS must review | Required CODEOWNERS review |
| Conversations must be resolved | Required conversation resolution |

### PR Template Reminder

The PR template (`.github/PULL_REQUEST_TEMPLATE.md`) should include:

```markdown
## Linked Issue

Closes #<issue-number>

## Summary

<!-- Brief description of changes -->

## Test Plan

<!-- How were these changes verified? -->
```

---

## Quarterly Permission Audit Checklist

Run this audit every quarter (Q1: January, Q2: April, Q3: July, Q4: October) to verify the access model has not drifted.

### 1. User Access Review

- [ ] List all collaborators: `gh api repos/cenetex/aws-swarm/collaborators --jq '.[].login'`
- [ ] Verify each user's role matches their function (Leadership = Triage, Implementation = Write, Admin = Admin)
- [ ] Remove collaborators who no longer need access
- [ ] Confirm Admin role is limited to 1-2 individuals
- [ ] Verify no personal accounts have been granted Admin that should only have Write or Triage

### 2. Bot and Agent Access Review

- [ ] List all GitHub Apps with repository access
- [ ] Verify Copilot coding agent permissions are scoped correctly
- [ ] Verify GitHub Actions OIDC role ARN matches `cenetex/aws-swarm` patterns
- [ ] Review deploy keys -- remove any that are unused or expired
- [ ] Confirm no orphaned bot accounts have elevated permissions

### 3. Branch Protection Verification

- [ ] Run branch protection drift check (see [branch-protection.md](./branch-protection.md) Drift Detection section)
- [ ] Verify `main` branch protection rules match the Required Protections table above
- [ ] Confirm "Do not allow bypassing" is still enabled
- [ ] Verify required status checks list is current (`build`, `lint`, `test`)
- [ ] Confirm CODEOWNERS file is up to date with current package owners

### 4. Secrets and Environment Review

- [ ] List GitHub Actions secrets: verify no stale or unused entries
- [ ] Verify environment protection rules (staging: auto-deploy, production: manual approval)
- [ ] Confirm AWS IAM role trust policy is scoped to `cenetex/aws-swarm`
- [ ] Rotate any secrets older than 90 days

### 5. Issue Workflow Compliance

- [ ] Sample 10 recent merged PRs -- verify each references a GitHub issue
- [ ] Sample 5 recent closed issues -- verify each was closed by a merged PR (not manually closed without code change, unless documented)
- [ ] Verify weekly triage cadence is being followed (check issue activity)
- [ ] Review aging policy compliance (stale labels applied as documented in [Issue Governance](./ISSUE-GOVERNANCE.md))

### 6. Audit Record

After completing the checklist, record the audit:

- Create a GitHub issue titled `chore(governance): Q<N> <YEAR> permission audit` with the completed checklist
- Label with `type:infra` and `priority:low`
- Assign to Admin role holder
- Close when all items are verified or remediation is complete

---

## Revision History

| Date | Change | Author |
|------|--------|--------|
| 2026-02-23 | Initial version -- role definitions, permission matrix, audit checklist | @cenetex |

---

*Last updated: 2026-02-23*
