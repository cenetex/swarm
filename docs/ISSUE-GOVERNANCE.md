# Issue Governance

This document defines priority criteria, triage cadence, and agent-ready issue requirements for the AWS Swarm project. It complements the issue templates in `.github/ISSUE_TEMPLATE/` and the commit conventions in `CLAUDE.md`.

## Priority Governance

Priority labels drive scheduling, agent assignment, and on-call response. To prevent label inflation (where everything becomes `priority:high`), use the objective criteria below.

### Priority Criteria

| Label | Criteria | Examples | SLA |
|-------|----------|----------|-----|
| `priority:high` | Production is degraded, revenue/users are blocked, or a security vulnerability is confirmed. Requires action within 24 hours. | Webhook handler 500s in prod; auth bypass; paid feature returns errors for all users; data loss in production | Fix or mitigate within 24h |
| `priority:medium` | Feature is partially broken or a planned milestone is at risk. Does not block production users right now but will if left unaddressed. | Staging deploy fails; flaky test blocking CI merges; missing error handling on a shipped endpoint; dependency with known CVE (no exploit path) | Address within 1 week |
| `priority:low` | Quality-of-life improvement, tech debt, or cosmetic issue. No user-facing impact today. | Code style inconsistency; unused import cleanup; documentation gap; developer tooling enhancement | Address within 1 month or deprioritize |

### Rules for `priority:high`

Before applying `priority:high`, the issue MUST meet at least one of these conditions:

1. **Production impact** -- Users are experiencing errors, data loss, or degraded service right now.
2. **Security vulnerability** -- A confirmed exploit path exists (not theoretical risk).
3. **Revenue blocker** -- A paid feature is broken for paying users or a launch date is within 48 hours.
4. **Cascade risk** -- The issue blocks 3 or more other in-progress issues.

If none of these apply, use `priority:medium` or `priority:low`. When in doubt, start at `priority:medium` and escalate after triage review.

### Severity vs. Priority

Severity describes impact magnitude. Priority describes scheduling urgency. They are related but not identical:

- A **critical severity** bug in a feature nobody uses yet may be `priority:medium`.
- A **low severity** cosmetic bug on the payment page may be `priority:high` if it erodes user trust.

Both the `severity` field (on bug reports) and the `priority` label should be set independently based on their own criteria.

## Priority Promotion and Demotion Criteria

Objective criteria for moving issues between priority tiers (P0-P4). These map to the risk-first sequencing order defined in [STRATEGY-OPERATIONS.md -- Risk-First Sequencing](./STRATEGY-OPERATIONS.md#1-risk-first-sequencing).

### Promotion criteria (escalating priority)

| From | To | Trigger | Example |
|------|----|---------|---------|
| Any | **P0** (Incident) | Production outage confirmed OR active security exploit OR data loss in progress. | Lambda 500 rate >50% for 5 minutes; credential exposure. |
| P2/P3/P4 | **P1** (Reliability) | Error rate breaches scorecard threshold (>5%) OR DLQ depth >0 OR alarm fires. | CloudWatch alarm triggers; DLQ messages accumulating. |
| P3/P4 | **P2** (Security) | Security exception approaching expiry (<14 days) OR audit finding requires remediation. | Expired exception auto-creates blocking issue. |
| P4 | **P3** (Feature) | Milestone deadline is at risk AND the item is on the critical path for the current milestone. | M2 parity feature needed for design-partner commitment. |

### Demotion criteria (reducing priority)

| From | To | Trigger | Example |
|------|----|---------|---------|
| **P0** | P1 or P2 | Incident mitigated (workaround in place, user impact resolved). Root cause fix is tracked but not urgent. | Hotfix deployed; follow-up hardening issue created at P1. |
| **P1** | P2 or P3 | Error rate returns below threshold for 48 hours. Alarm resolves. No user reports for 7 days. | Flaky Lambda stabilizes after config fix. |
| `priority:high` | `priority:medium` | Issue no longer meets any of the 4 `priority:high` criteria (see Priority Criteria above). Reassessed during weekly triage. | Feature launch delayed; "48h launch deadline" criterion no longer applies. |
| `priority:medium` | `priority:low` | No activity for 28 days (aging policy). OR milestone deprioritizes the workstream. | Stale medium-priority issue with no owner. |

### Queue overflow demotion

When the active WIP cap (8 `status:in-progress` items) is exceeded, the following demotion rules apply during triage:

1. **Identify excess.** Count all `status:in-progress` issues. If count > 8, the overflow = count - 8.
2. **Sort by priority then age.** Rank in-progress items by priority tier (P4 lowest) then by most recent activity (least recent first).
3. **Demote from the bottom.** Return the lowest-ranked items to backlog by removing `status:in-progress`. Add a comment: "Returned to backlog -- WIP cap exceeded. Will be re-queued at next triage."
4. **Never demote P0.** P0 items are never returned to backlog through this process. If all in-progress items are P0, escalate to leadership for additional capacity or scope reduction.
5. **Blocked items demote first.** Any `status:blocked` item without progress in 7 days is returned to backlog before non-blocked items are considered.

This protocol is consistent with the overflow rules in [STRATEGY-OPERATIONS.md -- Constrained Active Queue](./STRATEGY-OPERATIONS.md#2-constrained-active-queue-wip-cap).

## Agent-Ready Issue Requirements

Issues assigned to coding agents (Copilot, Claude Code workers, or worktree subagents) need more structure than issues for human developers. An "agent-ready" issue includes enough context for autonomous execution without back-and-forth clarification.

### Required Fields

Every agent-assigned issue MUST include:

| Field | Purpose | Template Section |
|-------|---------|-----------------|
| **Business Outcome** (features) or **Bug Description** (bugs) | Why this work matters | `business-outcome` / `description` |
| **Acceptance Criteria** | Concrete, verifiable done conditions | `acceptance-criteria` / `acceptance` |
| **Package** | Which package(s) are affected | `package` dropdown |

### Strongly Recommended Fields

These fields significantly reduce agent drift and rework:

| Field | Purpose | Template Section |
|-------|---------|-----------------|
| **Scope Boundaries** | Files and services in/out of scope | `scope-boundaries` |
| **Non-Goals** | What this issue explicitly does NOT cover | `non-goals` |
| **Validation Commands** | Exact commands to verify completion | `validation-commands` |

### Writing Good Acceptance Criteria

Acceptance criteria should be:

- **Verifiable** -- Can be checked with a command, test, or observable behavior (not "code is clean").
- **Specific** -- References exact files, endpoints, or behaviors (not "works correctly").
- **Complete** -- Covers happy path, error cases, and edge cases relevant to the change.

Good example:
```
- [ ] `bun test packages/core/src/services/memory.test.ts` passes
- [ ] Memory entries expire after TTL seconds (verified with integration test)
- [ ] Expired entries return 404, not stale data
- [ ] No new lint warnings introduced (`pnpm lint` clean)
```

Bad example:
```
- [ ] Feature works
- [ ] Tests pass
- [ ] Code is clean
```

### Writing Good Scope Boundaries

Scope boundaries tell agents what they CAN and CANNOT touch:

```
**In scope:**
- packages/core/src/services/memory.ts (add TTL parameter)
- packages/core/src/services/memory.test.ts (add TTL test cases)
- packages/core/src/types/memory.ts (update MemoryEntry type)

**Out of scope:**
- Do not modify DynamoDB table definitions (infra package)
- Do not change the public admin API contract
- Do not refactor unrelated memory service methods
```

Without scope boundaries, agents may:
- Refactor adjacent code that was not requested
- Modify shared types that break other packages
- Change infrastructure when only application code was intended

## Triage Process

### Weekly Triage Cadence

Triage runs weekly (or more frequently during active sprints). The triage review covers:

0. **Leadership scorecard review** -- Download the latest [Leadership Operating Scorecard](./LEADERSHIP-SCORECARD.md) artifact from GitHub Actions. Review the health grade and any threshold breach recommendations before proceeding with issue-level triage. Act on RED-grade recommendations first.
1. **New issues** -- Validate priority label, ensure agent-ready fields are present, assign owner or agent.
2. **In-progress issues** -- Check for blockers, verify branch exists, confirm PR is progressing.
3. **Stale issues** -- Apply aging policy (see below).
4. **Scorecard-driven reprioritization** -- For each recommendation in the scorecard, decide whether to adjust issue priorities, reassign work, or create new issues. Record decisions as comments on affected issues.
5. **WIP cap check** -- Count `status:in-progress` issues. If count exceeds 8, apply the [queue overflow demotion](#queue-overflow-demotion) rules. Apply [promotion/demotion criteria](#priority-promotion-and-demotion-criteria) to any issues whose conditions have changed since last triage.

### Aging Policy

| Age | Action |
|-----|--------|
| 14 days without activity | Add `status:stale` label. Comment asking for update. |
| 28 days without activity | If `priority:low`, close with "stale -- reopen if still relevant" comment. |
| 28 days without activity | If `priority:medium`, downgrade to `priority:low` and add `status:stale`. |
| 28 days without activity | If `priority:high`, escalate in triage review. High-priority issues should never go stale without explanation. |

"Activity" means any of: commit on linked branch, PR update, comment with substantive update, or label change.

### Blocked Issues

Issues with the `status:blocked` label must include a comment explaining:
1. What is blocking the issue.
2. A link to the blocking issue or external dependency.
3. When the blocker is expected to resolve.

Blocked issues are reviewed every triage cycle. If the blocker has not progressed in 14 days, escalate or re-scope the issue to remove the dependency.

### Closing Criteria

An issue can be closed when:
- All acceptance criteria checkboxes are checked.
- The linked PR is merged to `main`.
- Validation commands pass on `main`.

If an issue is closed without a PR (e.g., won't fix, duplicate, stale), the closing comment must explain why.

## Label Hygiene

### Applying Labels

- Every issue gets exactly one `type:*` label and one `priority:*` label at creation.
- `package:*` labels are added based on the package dropdown selection.
- `status:*` labels are managed during triage and development.

### Label Audit

During triage, check for:
- Issues with no `priority:*` label (assign one).
- Multiple `priority:*` labels on the same issue (pick one, remove others).
- `priority:high` issues that no longer meet the high-priority criteria (downgrade).
- `status:in-progress` issues with no linked branch or PR (follow up with assignee).
