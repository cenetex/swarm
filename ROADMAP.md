# AWS Swarm Roadmap

This roadmap focuses on product and platform direction. It is a **directional overlay** on top of the GitHub issue queue, which is the canonical execution backlog.

**Last reviewed:** 2026-03-24

> **Issue-indexed execution model.** Every actionable item starts as a GitHub issue. Execution is pull-driven from the open issue queue, not push-driven by milestones. Active work is identified by labels (`type:*`, `priority:*`), not milestone assignment. See [CLAUDE.md](CLAUDE.md) for WIP caps, execution rules, and the issue-readiness checklist. When the issue queue and this document conflict, the issue queue wins.

## How to read this document

The GitHub issue queue is the authoritative execution backlog. This roadmap describes the strategic themes and candidate work that feed that queue.

**Current execution:**
- Active work: `is:open is:issue -milestone:*` filtered by `status:in-progress` or `priority:high` labels
- See [PLAN.md](PLAN.md) and [docs/OPERATING-MODEL.md](docs/OPERATING-MODEL.md) for execution rules and workflows
- Portfolio-informed candidate lanes: [docs/PORTFOLIO-INSPIRED-ROADMAP.md](docs/PORTFOLIO-INSPIRED-ROADMAP.md)

## Current state (as of 2026-03-24)

- **M1 shipped (v1.0.1) and verified in staging.** All platform foundations complete: auth/onboarding, entitlements, Telegram full parity, memory management, audit logging, operational infrastructure.
- **M2+ work is issue-driven, not milestone-driven.** Milestones (`Roadmap: Now`, `Roadmap: Next`, `Roadmap: Later`) are no longer the execution queue. Active work lives as labeled, open GitHub issues.
- **Execution discipline.** Issue-first intake (acceptance criteria, scope, package labels, priority), WIP caps (max 8 in-progress), and P0-P4 sequencing. See [CLAUDE.md](CLAUDE.md).

Historical M1 planning snapshots are intentionally not kept as separate live docs; use git history when you need the retired M1 plan.

## Active work queues

The following queries surface the active execution state:

| Queue | Query | Purpose |
|-------|-------|---------|
| **In Progress** | `is:open is:issue status:in-progress` | Work actively being executed. Max 8 concurrent. |
| **Prioritized Backlog** | `is:open is:issue priority:high -status:in-progress` | High-priority work awaiting capacity. |
| **General Backlog** | `is:open is:issue priority:medium priority:low` | Lower-priority or speculative work. |
| **Candidates** | See [docs/OPERATING-MODEL.md](docs/OPERATING-MODEL.md) and `AWS Swarm Roadmap` project | Not yet approved for issue slots; draft items only. |

When the in-progress count exceeds the WIP cap (8), no new issues may be pulled from backlog until the count drops.

## Risk-first sequencing

Reliability and security work is prioritized before feature expansion by default. This principle governs which issues move into the in-progress queue and how competing priorities are resolved.

### Priority sequencing

When the backlog has competing priorities, apply this order:

1. **P0 -- Incidents**: Production outages, confirmed security vulnerabilities.
2. **P1 -- Reliability**: DLQ growth, error rate breaches, alarm fatigue.
3. **P2 -- Security hardening**: Access review findings, exception expiries, audit gaps.
4. **P3 -- Feature delivery**: Roadmap features aligned with current direction.
5. **P4 -- Tech debt / quality**: Refactoring, test coverage, documentation.

A RED weekly health review blocks pulling new P3/P4 issues into `status:in-progress` until platform health returns to YELLOW or GREEN. Active CloudWatch alarms trigger immediate incident response per the [docs/RUNBOOK.md](docs/RUNBOOK.md).

### In-progress cap

A maximum of **8** issues may carry the `status:in-progress` label at any time. When the cap is reached, existing items must be completed, unblocked, or returned to the backlog before new items can be pulled into active work. See WIP caps in [CLAUDE.md](CLAUDE.md).

## Portfolio allocation policy

Engineering effort is balanced across four buckets:

| Bucket | Target | Managed by |
|--------|--------|-----------|
| Reliability + Security | >= 30% | Priority (P0/P1/P2) labels in issue queue |
| Feature Delivery | 40-50% | `type:feature` and P3 priority |
| Tech Debt + Quality | 10-20% | `type:tech-debt`, `type:docs`, `type:refactor` with P3/P4 |
| Operational Tooling | 5-10% | `type:infra` tooling-focused, CI scope |

During incidents (scorecard health RED), feature delivery capacity is reallocated by demoting P3 issues and focusing available capacity on P0/P1/P2 until health returns to YELLOW or GREEN.

Allocation assumptions are reviewed quarterly using the active issue queue (`status:in-progress` + backlog labels) as the measurement source.

## Triage and review cadence

Issue curation and work intake follows the repo execution rules in [AGENTS.md](AGENTS.md), [CLAUDE.md](CLAUDE.md), and [docs/OPERATING-MODEL.md](docs/OPERATING-MODEL.md):

| Cadence | Activity | Owner |
|---------|----------|-------|
| **Weekly** | Triage new issues, review in-progress work, apply aging policy, monitor scorecard signals. | Project lead |
| **Biweekly** | Promote draft roadmap candidates from the Project into issues. Decompose narrative goals into executable scope. Demote stale backlog items. | Project lead |
| **Monthly** | Full roadmap review. Update this document. Reconcile Project and issue backlog with portfolio direction. | Project lead |

### Issue intake and promotion

- An issue is **opened** when: narrative goals are decomposed into scope with acceptance criteria, assigned owners, package labels, and priority labels. See [docs/OPERATING-MODEL.md](docs/OPERATING-MODEL.md).
- An issue moves to **`status:in-progress`** when: it has an assigned owner, meets the readiness checklist in [CLAUDE.md](CLAUDE.md), passes weekly triage, AND the in-progress cap (8 items) is not exceeded.
- An issue is **closed** when: acceptance criteria are met and the PR is merged, or when it no longer meets backlog criteria and is archived.
- **Risk-first gate**: P3 (feature) and P4 (tech debt) issues cannot enter `status:in-progress` while any P0 or P1 issue is unresolved.
- **Queue overflow demotion**: When in-progress count exceeds the WIP cap, the lowest-priority in-progress items are returned to backlog with labels (`status:blocked` or `priority:low`) to unblock new work.

## Legacy

Prior planning snapshots are intentionally not kept as separate files; use git history for older iterations.
