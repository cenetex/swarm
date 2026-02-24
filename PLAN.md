# AWS Swarm Plan: Next Milestone (M2 Multi-Platform Hardening)

Goal: deliver a stable post-M1 platform with reliable admin UX, complete account identity
flows, and production-grade multi-platform parity (Telegram, X, Discord, Web).

**Last reviewed:** 2026-02-23

> **Issue-indexed execution model.** This plan is a directional overlay on top of the GitHub issue queue. The issue queue (`milestone:"Roadmap: Next" is:open`) is the canonical execution backlog. Items in this document that lack issue references are narrative goals -- they describe desired outcomes but are not scheduled until decomposed into issues with acceptance criteria. See [docs/ISSUE-GOVERNANCE.md](docs/ISSUE-GOVERNANCE.md) for triage cadence and priority criteria.

## Milestone definition

- Critical admin chat surfaces are reliable and test-covered (plan/usage, preview, auth flows).
- Account identity model is fully usable in UI (including linking additional wallets).
- Memory retrieval quality improves through semantic retrieval integration.
- Platform parity gaps are tracked and executed with production hardening criteria.
- Backlog and execution tracking are GitHub-first (issues, milestones, project statuses).

## Execution queue

The execution queue is sourced from GitHub issues. Query: `milestone:"Roadmap: Next" is:open`.

### Completed (prior M2 issues -- all closed)

- [x] [#167](https://github.com/cenetex/aws-swarm/issues/167) parent tracker for wallet-link UX completion.
- [x] [#180](https://github.com/cenetex/aws-swarm/issues/180) fix media URL handling when `CDN_URL` is unset in split stacks.
- [x] [#181](https://github.com/cenetex/aws-swarm/issues/181) expose wallet-link flow in admin UI.
- [x] [#182](https://github.com/cenetex/aws-swarm/issues/182) add wallet-link integration/regression coverage.
- [x] [#183](https://github.com/cenetex/aws-swarm/issues/183) semantic search integration into memory retrieval path.
- [x] [#184](https://github.com/cenetex/aws-swarm/issues/184) Discord production hardening beyond base adapter coverage.
- [x] [#185](https://github.com/cenetex/aws-swarm/issues/185) X/Twitter parity hardening for remaining functionality gaps.

### Open issues (Roadmap: Next)

As of 2026-02-23 there are 11 open issues in the `Roadmap: Next` milestone. Grouped by theme:

#### Execution model and governance
| Issue | Title | Priority |
|-------|-------|----------|
| [#249](https://github.com/cenetex/aws-swarm/issues/249) | Convert roadmap/milestone docs to issue-indexed execution model | `priority:medium` |
| [#246](https://github.com/cenetex/aws-swarm/issues/246) | Issue-only operating model for leadership-directed subagent execution | `priority:medium` |
| [#247](https://github.com/cenetex/aws-swarm/issues/247) | Codify subagent charter and issue-only execution protocol | `priority:medium` |
| [#248](https://github.com/cenetex/aws-swarm/issues/248) | Enforce issue intake, scope gating, and DoD for subagents | `priority:medium` |
| [#263](https://github.com/cenetex/aws-swarm/issues/263) | Operationalize leadership strategy in core execution docs | `priority:medium` |
| [#264](https://github.com/cenetex/aws-swarm/issues/264) | Codify risk-first sequencing and active P0 WIP cap | `priority:medium` |
| [#265](https://github.com/cenetex/aws-swarm/issues/265) | Define mandatory release gate and rollback readiness standard | `priority:medium` |
| [#268](https://github.com/cenetex/aws-swarm/issues/268) | Define weekly leadership operating scorecard and reprioritization triggers | `priority:medium` |

#### Operational hardening
| Issue | Title | Priority |
|-------|-------|----------|
| [#266](https://github.com/cenetex/aws-swarm/issues/266) | Establish vulnerability exception governance (owner + expiry + review) | `priority:medium` |
| [#267](https://github.com/cenetex/aws-swarm/issues/267) | Codify cost KPI targets and weekly corrective-action cadence | `priority:medium` |
| [#269](https://github.com/cenetex/aws-swarm/issues/269) | Codify portfolio allocation policy and rebalancing rules | `priority:medium` |

## Workstreams

Each workstream describes a theme. Items under each workstream are **narrative goals** unless linked to an issue. Narrative goals must be decomposed into issues before they are scheduled for execution.

### 1) Admin UX reliability

*No open issues for this workstream.* The following are narrative goals awaiting issue decomposition:

- Keep chat-first interaction model while removing dead or confusing surfaces.
- Add component/integration tests for high-traffic UI panels to prevent regressions.
- Ensure API error paths always return user-actionable failures.

### 2) Identity and account UX

Prior issues completed: [#167](https://github.com/cenetex/aws-swarm/issues/167), [#181](https://github.com/cenetex/aws-swarm/issues/181), [#182](https://github.com/cenetex/aws-swarm/issues/182).

*No open issues for this workstream.* The following are narrative goals awaiting issue decomposition:

- Expose full link-vs-switch behavior in UI.
- Surface linked identities and account-level gating state clearly.
- Enforce conflict-safe flows for multi-wallet users.

### 3) Memory relevance

Prior issues completed: [#183](https://github.com/cenetex/aws-swarm/issues/183).

*No open issues for this workstream.* The following are narrative goals awaiting issue decomposition:

- Add benchmarks and regression tests for retrieval quality and latency.

### 4) Platform parity and runtime hardening

Prior issues completed: [#184](https://github.com/cenetex/aws-swarm/issues/184), [#185](https://github.com/cenetex/aws-swarm/issues/185).

*No open issues for this workstream.* The following are narrative goals awaiting issue decomposition:

- Track parity as concrete capability matrix, not a broad theme.
- Close remaining reliability/operational gaps per adapter (rate limits, diagnostics, tests).
- Keep queue-based runtime behavior deterministic and observable.

### 5) Operational posture

Active issues: [#266](https://github.com/cenetex/aws-swarm/issues/266), [#267](https://github.com/cenetex/aws-swarm/issues/267), [#269](https://github.com/cenetex/aws-swarm/issues/269).

Narrative goals (awaiting issue decomposition):

- Keep dependency/security baseline green in CI.
- Maintain issue/PR lifecycle automation and project drift reconciliation.
- Keep runbooks aligned with currently deployed behavior.

### 6) Execution model and governance (new)

Active issues: [#246](https://github.com/cenetex/aws-swarm/issues/246), [#247](https://github.com/cenetex/aws-swarm/issues/247), [#248](https://github.com/cenetex/aws-swarm/issues/248), [#249](https://github.com/cenetex/aws-swarm/issues/249), [#263](https://github.com/cenetex/aws-swarm/issues/263), [#264](https://github.com/cenetex/aws-swarm/issues/264), [#265](https://github.com/cenetex/aws-swarm/issues/265), [#268](https://github.com/cenetex/aws-swarm/issues/268).

This workstream hardens the execution model itself: issue-indexed planning, subagent governance, and leadership operating cadence.

## Risk-first sequencing and WIP cap

This plan follows the risk-first sequencing principle: reliability and security work is scheduled before feature expansion.

### Sequencing within M2

Workstreams are prioritized in this order when resources are constrained:

1. **Operational hardening** (#266, #267, #269) -- P1/P2 work that protects platform reliability.
2. **Execution model and governance** (#246-#249, #263-#265, #268) -- P2/P3 work that improves delivery predictability.
3. **Platform parity and feature delivery** (narrative goals) -- P3 work pulled only when P0-P2 queue is clear.
4. **Admin UX, identity, memory** (narrative goals) -- P4 quality improvements scheduled when capacity allows.

A RED health grade on the [Leadership Scorecard](docs/LEADERSHIP-SCORECARD.md) blocks starting new feature or governance work until the grade returns to YELLOW or GREEN.

### Active WIP cap

A maximum of **8** issues may carry `status:in-progress` at any time across all M2 workstreams. When the cap is reached, items must be completed or returned to backlog before new work begins. See [docs/STRATEGY-OPERATIONS.md -- Constrained Active Queue](docs/STRATEGY-OPERATIONS.md#2-constrained-active-queue-wip-cap) for the full protocol.

When pulling issues from the execution queue into active work, apply the promotion and demotion criteria in [docs/ISSUE-GOVERNANCE.md -- Priority Promotion and Demotion Criteria](docs/ISSUE-GOVERNANCE.md#priority-promotion-and-demotion-criteria).

## Triage and prioritization cadence

This plan is reviewed and updated as part of the triage cadence defined in [docs/ISSUE-GOVERNANCE.md](docs/ISSUE-GOVERNANCE.md):

| Cadence | Activity |
|---------|----------|
| **Weekly** | Triage new issues, check in-progress work for blockers, apply aging policy, review [Leadership Scorecard](docs/LEADERSHIP-SCORECARD.md) recommendations. |
| **Biweekly** | Review milestone progress. Promote issues from Next to Now or demote stale items. Decide whether narrative goals in this document should be decomposed into issues. Update the execution queue above. |
| **Monthly** | Full roadmap review. Update ROADMAP.md. Archive completed milestones. |

### Keeping this document current

- After each triage cycle, update the "Open issues" table to reflect the current state of `milestone:"Roadmap: Next" is:open`.
- Move newly closed issues to the "Completed" section.
- Do not add items to the execution queue without a corresponding GitHub issue. If a workstream narrative goal becomes urgent, decompose it into an issue first.

## Not in this milestone

- Marketplace templates and persona packs.
- Large speculative protocol redesigns.
- Step Functions runtime re-architecture.

These items live in `Roadmap: Later` or have no milestone. They will be scheduled if and when a biweekly review promotes them.

## References

- [ROADMAP.md](ROADMAP.md) -- directional roadmap with Now/Next/Later milestone mapping.
- [docs/ISSUE-GOVERNANCE.md](docs/ISSUE-GOVERNANCE.md) -- triage cadence, priority criteria, aging policy.
- [docs/LEADERSHIP-SCORECARD.md](docs/LEADERSHIP-SCORECARD.md) -- automated weekly scorecard driving reprioritization.
- [docs/PLAYBOOK-M2-MULTI-PLATFORM.md](docs/PLAYBOOK-M2-MULTI-PLATFORM.md) -- M2 execution playbook.
- [docs/BILLING-STRATEGY.md](docs/BILLING-STRATEGY.md) -- billing model.
- [docs/AUTHENTICATION-IMPROVEMENTS.md](docs/AUTHENTICATION-IMPROVEMENTS.md) -- auth improvements reference.
