# Issue-Only Operating Model

This document defines the canonical operating model for the `cenetex/aws-swarm` project. All strategic direction flows through GitHub Issues; all execution flows through branches and pull requests linked to those issues. No work happens outside this loop.

Related docs:
- [Issue Governance](./ISSUE-GOVERNANCE.md) -- priority criteria, triage cadence, agent-ready requirements
- [GitHub Permissions & Access Model](./GITHUB-PERMISSIONS.md) -- role definitions and permission matrix
- [Branch Protection Policy](./branch-protection.md) -- `main` branch settings and enforcement
- [Leadership Operating Scorecard](./LEADERSHIP-SCORECARD.md) -- automated metrics and reprioritization
- [Access Review Process](./ACCESS-REVIEW.md) -- quarterly privileged access audit
- [CLAUDE.md](../CLAUDE.md) -- development workflow, commit conventions, CI/CD
- [AGENTS.md](../AGENTS.md) -- AI agent guidelines and working rules
- [PLAN.md](../PLAN.md) -- current milestone execution queue
- [ROADMAP.md](../ROADMAP.md) -- product milestones and strategic direction
- [issues/README.md](../issues/README.md) -- issue lifecycle and local mirror policy

---

## Core Principle

**Issues are the only command surface.** Leadership directs what gets built by creating, prioritizing, and closing GitHub Issues. Agents and engineers execute by writing code in branches and opening PRs that reference those issues. Nothing else is an accepted entry point for work.

This means:

1. Every line of code merged to `main` traces back to a GitHub Issue.
2. Leadership never needs to touch code, branches, or CI to direct strategy.
3. Agents never act without an issue assignment.
4. Progress is visible to everyone through the project board, not through Slack threads or ad-hoc status calls.

---

## Execution Flow

```
Leadership                    GitHub                         Agents / Engineers
-----------                   ------                         ------------------

Create issue          --->    Issue opened
  (outcome, criteria,         (type/priority labels,
   priority, scope)            milestone, assignee)
                                     |
                                     v
                              Triage validates
                              (agent-readiness,
                               priority check)
                                     |
                                     v
                              Issue assigned       --->      Create feature branch
                              status:in-progress             <type>/issue-<N>-<desc>
                                                                    |
                                                                    v
                                                             Write code, run tests
                                                                    |
                                                                    v
                                                             Open PR (Closes #N)
                                                                    |
                                                                    v
                              CI runs (lint,       <---      Push to branch
                              build, test)
                                     |
                                     v
                              CODEOWNERS review
                              + approval
                                     |
                                     v
                              Squash merge to main
                                     |
                                     v
Review closed issue   <---    Issue auto-closed
  (via project board,         (by "Closes #N" ref)
   scorecard, triage)
```

### Key constraints

| Rule | Enforcement |
|------|-------------|
| Every PR references an issue | PR template `Closes #` field; review convention |
| No direct pushes to `main` | Branch protection ([branch-protection.md](./branch-protection.md)) |
| CI must pass before merge | Required status checks: `build`, `lint`, `test` |
| CODEOWNERS must approve | Required CODEOWNERS review |
| No ad-hoc execution | Agents check for issue assignment before starting work |
| Branch names include issue number | `<type>/issue-<N>-<description>` convention |

---

## Roles and Responsibilities

Three roles operate within this model. Full permission details are in [GITHUB-PERMISSIONS.md](./GITHUB-PERMISSIONS.md).

### Leadership (GitHub Role: Triage)

Leaders own **what** and **when**. They never touch code directly.

| Responsibility | Mechanism |
|----------------|-----------|
| Define work outcomes | Create issues with business outcome and acceptance criteria |
| Set priority and scheduling | Apply `priority:*` labels; assign to milestones |
| Assign executors | Assign issues to agents, engineers, or Copilot |
| Review progress | Project board, scorecard artifacts, PR/issue activity |
| Triage and reprioritize | Weekly triage cadence per [ISSUE-GOVERNANCE.md](./ISSUE-GOVERNANCE.md) |
| Accept or reject results | Close issues when acceptance criteria are met |

Leadership does NOT: push code, approve PRs, merge branches, or run deployments.

### Implementation (GitHub Role: Write)

Engineers and coding agents own **how**. They execute within the scope defined by their assigned issue.

| Responsibility | Mechanism |
|----------------|-----------|
| Execute issue scope | Create branch, write code, open PR referencing the issue |
| Stay within scope boundaries | Follow `In scope` / `Out of scope` in the issue body |
| Validate before requesting review | Run lint, build, test locally; pass CI |
| Respond to review feedback | Address comments, push fixes, re-request review |
| Signal blockers | Add `status:blocked` label and comment explaining the blocker |

Implementation does NOT: change issue priority, close issues without a merged PR, or work on anything without an assigned issue.

### Admin (GitHub Role: Admin)

Administrators own **infrastructure and access**. This role is held by 1-2 individuals.

| Responsibility | Mechanism |
|----------------|-----------|
| Manage branch protections and repo settings | GitHub Settings |
| Manage secrets and environments | GitHub Actions secrets, AWS IAM |
| Grant and revoke access | Quarterly audit per [ACCESS-REVIEW.md](./ACCESS-REVIEW.md) |
| Maintain CI/CD pipelines | `.github/workflows/` |

---

## Issue Lifecycle

Every unit of work follows this lifecycle:

```
  Created  -->  Triaged  -->  In Progress  -->  In Review  -->  Closed
     |             |               |                |              |
  Leadership    Triage          Agent/Eng        PR open +      PR merged,
  creates       validates       starts work      CI passing     issue auto-
  issue         readiness                                       closed
```

### Issue requirements

Issues must meet the agent-ready standard defined in [ISSUE-GOVERNANCE.md](./ISSUE-GOVERNANCE.md):

- **Required:** Business outcome (or bug description), acceptance criteria, package label.
- **Recommended:** Scope boundaries, non-goals, validation commands.

### Epic and sub-issue structure

Large initiatives use an epic (umbrella issue) that tracks sub-issues:

- The epic defines the overall objective and lists sub-issues in its body.
- Sub-issues are independently assignable and closeable.
- The epic is closed when all sub-issues are closed.
- Milestones group related epics and standalone issues for scheduling.

---

## Project Board

The GitHub Projects board provides a single view of all work. Issues move through columns that mirror the lifecycle:

| Column | Entry Criteria | Exit Criteria |
|--------|---------------|---------------|
| **Backlog** | Issue created with type and priority labels | Triaged and validated as agent-ready |
| **Ready** | Triaged, agent-ready, assigned to milestone | Assigned to an executor |
| **In Progress** | `status:in-progress` label; branch exists | PR opened |
| **In Review** | PR open, CI passing | PR approved and merged |
| **Done** | PR merged, issue auto-closed | -- |

### Automation

- `status:in-progress` is applied when an agent starts work (via `scripts/worktree-start.sh` or manually).
- Issues move to Done automatically when the closing PR merges.
- The [Leadership Scorecard](./LEADERSHIP-SCORECARD.md) workflow reports queue health metrics weekly.
- The ticket health workflow flags stale and unlabeled issues.

---

## Milestones and Roadmap Alignment

Every item in [ROADMAP.md](../ROADMAP.md) and [PLAN.md](../PLAN.md) must map to one or more GitHub Issues.

| Document | Purpose | Issue linkage |
|----------|---------|---------------|
| **ROADMAP.md** | Strategic direction and milestone definitions | Each milestone corresponds to a GitHub Milestone |
| **PLAN.md** | Current execution queue and workstreams | Each line item references a `#<issue-number>` |
| **GitHub Milestones** | Scheduling and progress tracking | Every in-scope issue is assigned to a milestone |

### Rules

1. **No phantom work.** If something is in PLAN.md but has no GitHub Issue, it does not get executed.
2. **Milestones are the scheduling unit.** A milestone is complete when all its issues are closed.
3. **Roadmap updates follow issues.** When priorities shift, update issue labels and milestones first; then update ROADMAP.md to reflect the new state.

---

## Agent Execution Protocol

AI coding agents (Copilot, Claude Code workers, worktree subagents) follow additional constraints beyond the general Implementation role.

### Before starting work

1. Confirm an issue is assigned to the agent.
2. Read the issue body for acceptance criteria, scope boundaries, and validation commands.
3. Read relevant `CLAUDE.md` and `AGENTS.md` sections for project conventions.

### During execution

1. Create a branch following the naming convention: `<type>/issue-<N>-<description>`.
2. If using worktrees, run `scripts/worktree-start.sh <issue-number>` to push the branch and label the issue.
3. Stay within scope boundaries. Do not refactor adjacent code or modify out-of-scope packages.
4. Commit with conventional commit messages referencing the issue.

### After execution

1. Open a PR with `Closes #<N>` in the body.
2. Verify CI passes (lint, build, test).
3. If using worktrees, run `scripts/worktree-finalize.sh --issues <issue-number>` to push and create the PR.

### Parallel agent work

Multiple agents can work simultaneously on independent issues using git worktrees:

```bash
# Create worktree for each issue
git worktree add ../aws-swarm-042 -b fix/issue-42-dynamo-query main
scripts/worktree-start.sh 42

# Agent works independently in the worktree
# ...

# Finalize when done
scripts/worktree-finalize.sh --issues 42
```

See [CLAUDE.md](../CLAUDE.md) for full worktree lifecycle details.

---

## What Is Not Allowed

| Anti-pattern | Why it is prohibited | What to do instead |
|-------------|---------------------|-------------------|
| Pushing code without an issue | Breaks traceability; invisible to leadership | Create an issue first, even for small fixes |
| Working on unassigned issues | Causes conflicts; no accountability | Request assignment or self-assign before starting |
| Closing issues without a merged PR | Breaks audit trail | Close only via `Closes #N` in a merged PR, or document why in a closing comment |
| Ad-hoc Slack/chat-driven work | Not tracked; not auditable | Convert the request into a GitHub Issue |
| Changing priority without triage | Undermines governance | Follow the triage cadence in [ISSUE-GOVERNANCE.md](./ISSUE-GOVERNANCE.md) |
| Agents acting beyond issue scope | Scope creep; unreviewed changes | Follow scope boundaries; open a new issue for additional work |

---

## Governance Sub-Issues

This operating model is established by the following coordinated issues:

| Issue | Scope |
|-------|-------|
| **#246** (this document) | Top-level operating model definition |
| **#247** | Subagent charter and issue-only execution protocol in CLAUDE.md |
| **#248** | Agent intake, scope gating, and Definition of Done in AGENTS.md |
| **#249** | Roadmap/plan issue-indexed execution model |
| **#250** | Agent-ready issue templates and priority governance |
| **#251** | GitHub permissions for issue-only leadership model |

---

## Compliance and Auditing

### Weekly triage

The triage cadence (defined in [ISSUE-GOVERNANCE.md](./ISSUE-GOVERNANCE.md)) enforces this model:

1. Review the [Leadership Scorecard](./LEADERSHIP-SCORECARD.md) for threshold breaches.
2. Validate new issues for agent-readiness.
3. Check in-progress issues for branch/PR activity.
4. Apply the aging policy to stale issues.

### Quarterly access review

The [Access Review](./ACCESS-REVIEW.md) verifies:

- Role assignments match the three-role model (Leadership, Implementation, Admin).
- No access drift has occurred.
- Branch protections and CODEOWNERS are current.

### Issue workflow compliance

Sample checks (from the quarterly audit in [GITHUB-PERMISSIONS.md](./GITHUB-PERMISSIONS.md)):

- Every merged PR references a GitHub Issue.
- Every closed issue was closed by a merged PR (or has a documented exception).
- No `status:in-progress` issues exist without a linked branch or PR.

---

## Revision History

| Date | Change | Author |
|------|--------|--------|
| 2026-02-23 | Initial version -- issue-only operating model | @cenetex |

---

*Last updated: 2026-02-23*
