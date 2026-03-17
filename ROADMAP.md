# AWS Swarm Roadmap

This roadmap focuses on product and platform milestones. It is a **directional overlay** on top of the GitHub issue queue, which is the canonical execution backlog.

**Last reviewed:** 2026-03-16

> **Issue-indexed execution model.** Every actionable item in this document links to one or more GitHub issues or milestone queries. Items without issue references are narrative goals -- they describe strategic direction but are not scheduled for execution until decomposed into issues.

## How to read this document

| Section | GitHub milestone | Meaning |
|---------|-----------------|---------|
| **Now** | `Roadmap: Now` | Active work with assigned owners. Query: `milestone:"Roadmap: Now" is:open` |
| **Next** | `Roadmap: Next` | Scheduled and scoped. Will be pulled into Now at next triage. Query: `milestone:"Roadmap: Next" is:open` |
| **Later** | `Roadmap: Later` | Directional. Issues exist for tracking but are not yet scheduled. Query: `milestone:"Roadmap: Later" is:open` |

The issue queue is always more current than this document. When they conflict, the issue queue wins.

## Current focus (late Feb 2026)

- **M1 is complete (v1.0.1).** All items shipped: auth/onboarding, entitlements, energy unification, Orb-holder auto-boost, ascension->Pro, memory delete/export/TTL, deploy audit logging, correlation IDs, CloudWatch dashboards/alarms, Telegram canary, smoke tests, operational runbook.
- Focus shifting to M2 planning, governance hardening, and operational discipline.
- Portfolio-informed feature direction now lives in [docs/PORTFOLIO-INSPIRED-ROADMAP.md](docs/PORTFOLIO-INSPIRED-ROADMAP.md).

For the execution-level active plan, see:
- [PLAN.md](PLAN.md)

Historical M1 planning snapshots are intentionally not kept as live docs; use git history when you need the retired M1 plan.

## Now (milestone: `Roadmap: Now`)

All `Roadmap: Now` issues are closed. The milestone is complete.

Completed work (M1: Paid Telegram MVP):
- ~~Billing and entitlements with runtime enforcement.~~ **Done.** Manual entitlements + atomic enforcement + Orb-holder auto-boost + energy as burst pool.
- ~~Memory opt-in with retention and management.~~ **Done.** Schema, gating, retention TTL, delete, and export endpoints shipped.
- ~~Deploy or activate from admin UI and API.~~ **Done.** Readiness gates + activation endpoints + audit logging shipped.
- ~~Authentication improvements (wallet + Crossmint).~~ **Done.** Full onboarding overhaul (SWARM-011 through SWARM-020).
- ~~Structured logging with correlation IDs.~~ **Done.** Correlation ID propagation across webhook->SQS->handler chain. CloudWatch dashboards and ops dashboard shipped.
- ~~End-to-end Telegram canary and operational runbook.~~ **Done.** Canary script, smoke tests (20 tests), and operational runbook shipped.

## Next (milestone: `Roadmap: Next`)

Milestone M2: Multi-platform parity and execution model hardening.

### Active issues

Query: `milestone:"Roadmap: Next" is:open` (0 open as of 2026-03-16)

There are currently no open issues in `Roadmap: Next`. Use the milestone query above when the milestone is refilled, and use [PLAN.md](PLAN.md) plus [docs/OPERATING-MODEL.md](docs/OPERATING-MODEL.md) for the current execution rules.

### M2 platform objectives (narrative -- not yet decomposed into issues)

The following are directional goals for M2. They are **not executable** until broken into issues with acceptance criteria and assigned to the `Roadmap: Next` milestone. Prior M2 platform issues ([#183](https://github.com/cenetex/aws-swarm/issues/183), [#184](https://github.com/cenetex/aws-swarm/issues/184), [#185](https://github.com/cenetex/aws-swarm/issues/185)) are closed.

- Discord and X adapters reach feature parity with Telegram.
- Unified tool registry shared across admin API and handlers.
- Usage metering surfaced in admin UI.
- SQS payload offload for large media and DLQ management.

See [PLAN.md](PLAN.md) for the current execution overlay and [docs/PORTFOLIO-INSPIRED-ROADMAP.md](docs/PORTFOLIO-INSPIRED-ROADMAP.md) for longer-horizon candidate lanes.

## Later (milestone: `Roadmap: Later`)

Milestone M3: Persistent swarm platform. These items are **narrative goals** tracked for strategic direction. They will not be scheduled until decomposed into issues.

### Tracked issues

Query: `milestone:"Roadmap: Later" is:open` (0 open as of 2026-03-16)

There are currently no open issues in `Roadmap: Later`. Treat this section as directional only until new issues are explicitly promoted into that milestone.

### Strategic direction (narrative -- no issues yet)

- Multi-avatar coordination and cross-avatar policies.
- Durable memory tiers (ephemeral, durable, archival) with export and delete.
- Marketplace-ready templates and persona packs.
- SaaS reliability and cost optimization for scale.

Longer-horizon strategic direction, positioning inputs, and candidate investment lanes live in [docs/PORTFOLIO-INSPIRED-ROADMAP.md](docs/PORTFOLIO-INSPIRED-ROADMAP.md).

## Risk-first sequencing

Reliability and security work is scheduled before feature expansion by default. This principle governs how items move between milestones and how competing priorities are resolved within a milestone.

### Sequencing order

When the backlog has competing priorities, apply this order:

1. **P0 -- Incidents**: Production outages, confirmed security vulnerabilities.
2. **P1 -- Reliability**: DLQ growth, error rate breaches, alarm fatigue.
3. **P2 -- Security hardening**: Access review findings, exception expiries, audit gaps.
4. **P3 -- Feature delivery**: Roadmap features for the current milestone.
5. **P4 -- Tech debt / quality**: Refactoring, test coverage, documentation.

A RED weekly health review blocks promoting any P3/P4 items from Next to Now until platform health returns to YELLOW or GREEN. Active CloudWatch alarms trigger immediate incident response per the [docs/RUNBOOK.md](docs/RUNBOOK.md).

The priority order (P0-P4) is defined in [CLAUDE.md](CLAUDE.md).

### Active WIP cap

A maximum of **8** issues may carry the `status:in-progress` label at any time. When the cap is reached, existing items must be completed, unblocked, or returned to the backlog before new items are pulled into Now. See WIP caps in [CLAUDE.md](CLAUDE.md).

## Portfolio allocation policy

Engineering effort is allocated across four buckets:

| Bucket | Target | Issue label mapping |
|--------|--------|---------------------|
| Reliability + Security | >= 30% | `type:bug` + `priority:high`, `type:security`, `type:infra` (when reliability-focused) |
| Feature Delivery | 40-50% | `type:feature` |
| Tech Debt + Quality | 10-20% | `type:tech-debt`, `type:docs`, `type:refactor` |
| Operational Tooling | 5-10% | `type:infra` (when tooling-focused), `ci` scope commits |

During incidents (scorecard health grade RED), feature delivery capacity is reallocated to reliability until the grade returns to YELLOW or GREEN.

Allocation assumptions are reviewed quarterly during roadmap review using the active issue labels and milestone queues as the measurement source.

## Triage and review cadence

Issue reprioritization follows the repo execution rules in [AGENTS.md](AGENTS.md), [CLAUDE.md](CLAUDE.md), and [docs/OPERATING-MODEL.md](docs/OPERATING-MODEL.md):

| Cadence | Activity | Owner |
|---------|----------|-------|
| **Weekly** | Triage new issues, review in-progress work, apply aging policy, act on scorecard recommendations. | Project lead |
| **Biweekly** | Review milestone progress. Promote issues from Next to Now or demote stale items. Decide whether narrative goals should be decomposed into issues. | Project lead |
| **Monthly** | Full roadmap review. Update this document. Archive completed milestones. | Project lead |

### Promotion and demotion rules

- An issue moves from **Next to Now** when: it has an assigned owner, acceptance criteria are defined, a triage review approves the promotion, AND the active WIP cap (8 in-progress items) is not exceeded.
- An issue moves from **Later to Next** when: it is decomposed into actionable scope with acceptance criteria and the biweekly review approves it.
- A **narrative goal** becomes executable when: it is decomposed into one or more issues with acceptance criteria, package labels, and priority labels.
- An issue is **demoted or closed** during weekly or biweekly review when it no longer meets active backlog criteria or loses scope clarity.
- **Risk-first gate**: P3 (feature) and P4 (tech debt) issues cannot be promoted to Now while any P0 or P1 issue is unresolved.
- **Queue overflow demotion**: When the in-progress count exceeds the WIP cap, the lowest-priority in-progress items are returned to backlog.

## Legacy

Prior planning snapshots are intentionally not kept as separate files; use git history for older iterations.
