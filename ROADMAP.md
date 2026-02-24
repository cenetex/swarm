# AWS Swarm Roadmap

This roadmap focuses on product and platform milestones. It is a **directional overlay** on top of the GitHub issue queue, which is the canonical execution backlog.

**Last reviewed:** 2026-02-23

> **Issue-indexed execution model.** Every actionable item in this document links to one or more GitHub issues or milestone queries. Items without issue references are narrative goals -- they describe strategic direction but are not scheduled for execution until decomposed into issues. See [docs/ISSUE-GOVERNANCE.md](docs/ISSUE-GOVERNANCE.md) for triage cadence, priority criteria, and aging policy.

## How to read this document

| Section | GitHub milestone | Meaning |
|---------|-----------------|---------|
| **Now** | `Roadmap: Now` | Active work with assigned owners. Query: `milestone:"Roadmap: Now" is:open` |
| **Next** | `Roadmap: Next` | Scheduled and scoped. Will be pulled into Now at next triage. Query: `milestone:"Roadmap: Next" is:open` |
| **Later** | `Roadmap: Later` | Directional. Issues exist for tracking but are not yet scheduled. Query: `milestone:"Roadmap: Later" is:open` |

The issue queue is always more current than this document. When they conflict, the issue queue wins.

## Current focus (late Feb 2026)

- **M1 is complete (v1.0.1).** All items shipped: auth/onboarding, entitlements, energy unification, Orb-holder auto-boost, ascension->Pro, memory delete/export/TTL, deploy audit logging, correlation IDs, CloudWatch dashboards/alarms, Telegram canary, smoke tests, operational runbook.
- Focus shifting to M2 planning and operational hardening.
- See [docs/BILLING-STRATEGY.md](docs/BILLING-STRATEGY.md) for the unified web3+web2 billing model.

For the execution-level active plan, see:
- [PLAN.md](PLAN.md)

Historical M1 execution reference:
- [docs/ROADMAP-M1-PAID-TELEGRAM-MVP.md](docs/ROADMAP-M1-PAID-TELEGRAM-MVP.md)

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

Query: `milestone:"Roadmap: Next" is:open` (11 open as of 2026-02-23)

#### Execution model and governance
- [#249](https://github.com/cenetex/aws-swarm/issues/249) -- Convert roadmap and milestone docs to issue-indexed execution model (this work).
- [#246](https://github.com/cenetex/aws-swarm/issues/246) -- Issue-only operating model for leadership-directed subagent execution.
- [#247](https://github.com/cenetex/aws-swarm/issues/247) -- Codify subagent charter and issue-only execution protocol.
- [#248](https://github.com/cenetex/aws-swarm/issues/248) -- Enforce issue intake, scope gating, and DoD for subagents.
- [#263](https://github.com/cenetex/aws-swarm/issues/263) -- Operationalize leadership strategy in core execution docs.
- [#264](https://github.com/cenetex/aws-swarm/issues/264) -- Codify risk-first sequencing and active P0 WIP cap.
- [#265](https://github.com/cenetex/aws-swarm/issues/265) -- Define mandatory release gate and rollback readiness standard.
- [#268](https://github.com/cenetex/aws-swarm/issues/268) -- Define weekly leadership operating scorecard and reprioritization triggers.

#### Operational hardening
- [#266](https://github.com/cenetex/aws-swarm/issues/266) -- Establish vulnerability exception governance (owner + expiry + review).
- [#267](https://github.com/cenetex/aws-swarm/issues/267) -- Codify cost KPI targets and weekly corrective-action cadence.
- [#269](https://github.com/cenetex/aws-swarm/issues/269) -- Codify portfolio allocation policy and rebalancing rules.

### M2 platform objectives (narrative -- not yet decomposed into issues)

The following are directional goals for M2. They are **not executable** until broken into issues with acceptance criteria and assigned to the `Roadmap: Next` milestone. Prior M2 platform issues ([#183](https://github.com/cenetex/aws-swarm/issues/183), [#184](https://github.com/cenetex/aws-swarm/issues/184), [#185](https://github.com/cenetex/aws-swarm/issues/185)) are closed.

- Discord and X adapters reach feature parity with Telegram.
- Unified tool registry shared across admin API and handlers.
- Usage metering surfaced in admin UI.
- SQS payload offload for large media and DLQ management.

See [docs/PLAYBOOK-M2-MULTI-PLATFORM.md](docs/PLAYBOOK-M2-MULTI-PLATFORM.md) for the full execution playbook.

## Later (milestone: `Roadmap: Later`)

Milestone M3: Persistent swarm platform. These items are **narrative goals** tracked for strategic direction. They will not be scheduled until decomposed into issues.

### Tracked issues

Query: `milestone:"Roadmap: Later" is:open` (4 open as of 2026-02-23)

- [#208](https://github.com/cenetex/aws-swarm/issues/208) -- Break up admin-api monolith (60K LOC, 50% of codebase).
- [#270](https://github.com/cenetex/aws-swarm/issues/270) -- M2 GTM execution epic.
- [#271](https://github.com/cenetex/aws-swarm/issues/271) -- Operationalize ICP positioning and messaging matrix.
- [#274](https://github.com/cenetex/aws-swarm/issues/274) -- Publish ICP launch playbooks and demo checklists.
- [#276](https://github.com/cenetex/aws-swarm/issues/276) -- Define M2 design-partner program and qualification rubric.

### Strategic direction (narrative -- no issues yet)

- Multi-avatar coordination and cross-avatar policies.
- Durable memory tiers (ephemeral, durable, archival) with export and delete.
- Marketplace-ready templates and persona packs.
- SaaS reliability and cost optimization for scale.

Strategic PRDs:
- [docs/PRD-M3-PERSISTENT-SWARM-PLATFORM.md](docs/PRD-M3-PERSISTENT-SWARM-PLATFORM.md)
- [docs/PRD-M4-ECOSYSTEM-AUTONOMOUS-OPERATIONS.md](docs/PRD-M4-ECOSYSTEM-AUTONOMOUS-OPERATIONS.md)

## Triage and review cadence

Issue reprioritization follows the cadence defined in [docs/ISSUE-GOVERNANCE.md](docs/ISSUE-GOVERNANCE.md):

| Cadence | Activity | Owner |
|---------|----------|-------|
| **Weekly** | Triage new issues, review in-progress work, apply aging policy, act on scorecard recommendations. | Project lead |
| **Biweekly** | Review milestone progress. Promote issues from Next to Now or demote stale items. Decide whether narrative goals should be decomposed into issues. | Project lead |
| **Monthly** | Full roadmap review. Update this document. Archive completed milestones. | Project lead |

### Promotion and demotion rules

- An issue moves from **Next to Now** when: it has an assigned owner, acceptance criteria are defined, and a triage review approves the promotion.
- An issue moves from **Later to Next** when: it is decomposed into actionable scope with acceptance criteria and the biweekly review approves it.
- A **narrative goal** becomes executable when: it is decomposed into one or more issues with acceptance criteria, package labels, and priority labels.
- An issue is **demoted or closed** per the aging policy in [docs/ISSUE-GOVERNANCE.md](docs/ISSUE-GOVERNANCE.md).

## Legacy

Prior planning snapshots are intentionally not kept as separate files; use git history for older iterations.
