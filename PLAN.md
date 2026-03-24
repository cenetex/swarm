# AWS Swarm Plan: Active Execution (M2+ Issue-Driven)

Goal: deliver a stable platform with reliable admin UX, complete account identity flows, and production-grade multi-platform parity. Execution is entirely issue-driven, not milestone-driven.

**Last reviewed:** 2026-03-24

> **Issue-indexed execution model.** This plan is a directional overlay on top of the GitHub issue queue. The issue queue (`is:open is:issue` sorted by priority/labels) is the canonical execution backlog. Items in this document that lack issue references are narrative goals -- they describe desired outcomes but are not scheduled until decomposed into issues with acceptance criteria. See [AGENTS.md](AGENTS.md), [CLAUDE.md](CLAUDE.md), and [docs/OPERATING-MODEL.md](docs/OPERATING-MODEL.md) for the current execution rules.

## Current focus (M2+ post-shipped baseline)

- Critical admin chat surfaces are reliable and test-covered (plan/usage, preview, auth flows).
- Account identity model is fully usable in UI (including linking additional wallets).
- Memory retrieval quality improves through semantic retrieval integration and benchmarks.
- Platform parity gaps (Discord, X) are tracked with concrete capability matrices.
- Execution tracking is GitHub-first: issues, labels, status, and in-progress caps.
- Governance hardening: issue-first intake, WIP enforcement, and regular triage cadence.

## Active execution queue

The execution queue is sourced from GitHub issues. Primary query: `is:open is:issue -milestone:*` (issues without `Roadmap:*` milestones).

### Filtering for active work

Use labels to identify work state:

- **In progress:** `status:in-progress` (max 8 concurrent)
- **High priority, awaiting capacity:** `priority:high -status:in-progress`
- **Ready to triage:** `type:feature -priority:* -status:in-progress` or `type:bug` unlabeled

### Recent completions (M2 platform foundation)

- [x] [#167](https://github.com/cenetex/aws-swarm/issues/167) wallet-link UX completion.
- [x] [#180](https://github.com/cenetex/aws-swarm/issues/180) media URL handling with split stacks.
- [x] [#181](https://github.com/cenetex/aws-swarm/issues/181) wallet-link flow in admin UI.
- [x] [#182](https://github.com/cenetex/aws-swarm/issues/182) wallet-link integration/regression coverage.
- [x] [#183](https://github.com/cenetex/aws-swarm/issues/183) semantic search integration into memory retrieval.
- [x] [#184](https://github.com/cenetex/aws-swarm/issues/184) Discord production hardening.
- [x] [#185](https://github.com/cenetex/aws-swarm/issues/185) X/Twitter parity hardening.

## Workstreams and narrative goals

Each workstream describes a theme. Items under each workstream are **narrative goals** unless linked to an existing issue. Narrative goals must be decomposed into issues before they are scheduled for execution.

### 1) Admin UX reliability

Goals awaiting issue decomposition:

- Keep chat-first interaction model while removing dead or confusing surfaces.
- Add component/integration tests for high-traffic UI panels to prevent regressions.
- Ensure API error paths always return user-actionable failures.

### 2) Identity and account UX

Completed: [#167](https://github.com/cenetex/aws-swarm/issues/167), [#181](https://github.com/cenetex/aws-swarm/issues/181), [#182](https://github.com/cenetex/aws-swarm/issues/182).

Goals awaiting issue decomposition:

- Expose full link-vs-switch behavior in UI.
- Surface linked identities and account-level gating state clearly.
- Enforce conflict-safe flows for multi-wallet users.

### 3) Memory relevance

Completed: [#183](https://github.com/cenetex/aws-swarm/issues/183).

Goals awaiting issue decomposition:

- Add benchmarks and regression tests for retrieval quality and latency.

### 4) Platform parity and runtime hardening

Completed: [#184](https://github.com/cenetex/aws-swarm/issues/184), [#185](https://github.com/cenetex/aws-swarm/issues/185).

Goals awaiting issue decomposition:

- Track parity as concrete capability matrix (Discord, X, Telegram baseline comparison).
- Close remaining reliability/operational gaps per adapter (rate limits, diagnostics, tests).
- Keep queue-based runtime behavior deterministic and observable.

### 5) Operational and execution posture

Goals awaiting issue decomposition:

- Keep dependency/security baseline green in CI.
- Maintain issue/PR lifecycle automation and project drift reconciliation.
- Keep runbooks aligned with currently deployed behavior.
- Harden execution model: issue-indexed planning, subagent governance, triage enforcement.

## Priority sequencing and WIP cap

This plan follows the risk-first sequencing principle: reliability (P0/P1) and security (P2) work is prioritized before features (P3) and tech debt (P4).

### How work flows into execution

1. Narrative goals above are decomposed into GitHub issues by the project lead during biweekly review.
2. New issues enter the backlog with scope, acceptance criteria, priority, package labels, and owner.
3. Issues are pulled from backlog into `status:in-progress` when: issue-readiness checklist is met, priority allows the pull, and in-progress count < 8.
4. A RED weekly health review blocks pulling new P3/P4 work when P0/P1 work is unresolved.

### In-progress cap

A maximum of **8** issues may carry `status:in-progress` at any time across all workstreams. When the cap is reached, items must be completed or returned to backlog before new work begins. See WIP caps in [CLAUDE.md](CLAUDE.md).

## Triage and execution cadence

This plan is reviewed as part of the triage cadence defined in [AGENTS.md](AGENTS.md), [CLAUDE.md](CLAUDE.md), and [docs/OPERATING-MODEL.md](docs/OPERATING-MODEL.md):

| Cadence | Activity |
|---------|----------|
| **Weekly** | Triage new issues, check in-progress work for blockers, review health signals and open P0/P1 issues. |
| **Biweekly** | Decompose narrative goals into issues. Review backlog and demote stale items. Reconcile portfolio candidates with current capacity. |
| **Monthly** | Full roadmap review. Update ROADMAP.md, PLAN.md. Reconcile Project with issue queue. |

### Keeping this document current

- After each biweekly triage, add newly decomposed issues to the appropriate workstream.
- Move newly closed issues to the "Completed" section.
- Do not add items to the execution queue without a corresponding GitHub issue. If a narrative goal becomes urgent, decompose it into an issue first.

## Candidate work (not yet issued)

The following thematic areas are under consideration but have not been decomposed into issues:

- Marketplace templates and repeatable tenant launch patterns.
- Persistent multi-avatar coordination and cross-avatar policies.
- Step Functions runtime observability and cost optimization.
- Durable memory tier expansion (ephemeral, durable, archival).

These will be promoted to issues during quarterly roadmap reviews or when capacity becomes available. See [docs/PORTFOLIO-INSPIRED-ROADMAP.md](docs/PORTFOLIO-INSPIRED-ROADMAP.md) for longer-horizon strategic direction.

## References

- [ROADMAP.md](ROADMAP.md) -- directional platform roadmap and sequencing principles.
- [AGENTS.md](AGENTS.md) -- issue intake, scope gates, test expectations, and definition of done.
- [CLAUDE.md](CLAUDE.md) -- WIP caps, execution checklists, and branch rules.
- [docs/OPERATING-MODEL.md](docs/OPERATING-MODEL.md) -- GitHub Projects planning and issue promotion lifecycle.
- [docs/PORTFOLIO-INSPIRED-ROADMAP.md](docs/PORTFOLIO-INSPIRED-ROADMAP.md) -- portfolio-informed candidate lanes and long-horizon themes.
- [docs/RUNBOOK.md](docs/RUNBOOK.md) -- operational playbooks and incident handling.
- [docs/SECURITY.md](docs/SECURITY.md) -- production and security guardrails.
