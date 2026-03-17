# Operating Model

This document defines how planning artifacts should be used in `aws-swarm` without weakening the repository's issue-first execution model.

## Principle

GitHub Issues remain the source of truth for execution.

GitHub Projects provide the planning layer above the issue queue:

- draft roadmap candidates
- strategic grouping
- promotion flow from idea to executable issue
- portfolio context that does not belong in issue labels

The active roadmap Project is:

- `AWS Swarm Roadmap`
- `https://github.com/orgs/cenetex/projects/4`

## What Lives Where

| Artifact | System of record | Why |
| --- | --- | --- |
| Execution scope, labels, assignees, milestones, PR linkage | GitHub Issues | Issues drive work, CI, PRs, and WIP policy |
| Future roadmap ideas not yet approved for execution | GitHub Project draft items | They should not consume issue slots |
| Strategic grouping by lane, horizon, and portfolio source | GitHub Project custom fields | These are planning dimensions, not delivery labels |
| Narrative roadmap framing | `ROADMAP.md`, `PLAN.md`, `docs/PORTFOLIO-INSPIRED-ROADMAP.md` | These explain intent and sequencing |

## Non-Negotiable Rules

1. Do not open GitHub issues just to remember future work.
2. Keep speculative or not-yet-approved roadmap items as Project draft items.
3. Convert a draft item into a real issue only when it is approved for execution and backlog capacity exists.
4. Once an item becomes an issue, the issue is the execution source of truth.
5. Draft items do not count against the strict open-issue or in-progress issue caps.

## Project Fields

Use these fields on the `AWS Swarm Roadmap` Project:

| Field | Purpose |
| --- | --- |
| `Readiness` | Tracks promotion from `Candidate` to `Ready for Issue` to `In Delivery` |
| `Artifact Type` | Distinguishes `Draft`, `Epic`, `Issue`, `Bug`, and `PR` |
| `Horizon` | `Now`, `Next`, `Later`, `Labs` |
| `Lane` | `Core Platform`, `Productization`, `Identity & Memory`, `Shared-Room Presence`, `Labs` |
| `Inspired By` | `swarm-native`, `firehorse`, `kyro`, `cosyworld`, `multiple` |
| `Packages` | Likely implementation scope before issue decomposition |

## Recommended Views

Start with these views:

1. `00 Roadmap`
   Filter: draft items and epics that are not done or archived
   Group by `Horizon`
2. `01 Ready for Issue`
   Filter: `Readiness` is `Approved` or `Ready for Issue`
3. `02 Active Delivery`
   Filter: real issues and bugs that are not done
   Group by `Status`
4. `03 WIP Guardrail`
   Filter: real issues with `status:in-progress`
5. `04 By Lane`
   Group by `Lane`
6. `05 Portfolio Signals`
   Filter: non-`swarm-native` items
   Group by `Inspired By`
7. `06 Labs`
   Filter: `Horizon = Labs`

## Lifecycle

Use this lifecycle:

1. Create a Project draft item when a roadmap candidate is worth tracking but not yet approved.
2. Set `Readiness = Candidate`.
3. During roadmap review, promote to `Approved` or `Ready for Issue`.
4. Only then create a GitHub issue with scope, constraints, acceptance criteria, milestone, and labels.
5. Add the real issue to the Project and update the Project item to `Issue Created` or replace the draft item entirely.
6. Use the issue and PR lifecycle for execution. Update Project fields only for planning context.

## Relationship To The Portfolio Roadmap

The Project is where ideas from [docs/PORTFOLIO-INSPIRED-ROADMAP.md](PORTFOLIO-INSPIRED-ROADMAP.md) become visible and rankable without turning them into open issues too early.

Use the portfolio roadmap to decide what should be promoted.
Use the Project to hold and sort those candidates.
Use GitHub Issues to execute the promoted work.

## CLI Examples

Create an issue and add it to the roadmap project:

```bash
gh issue create \
  -R cenetex/aws-swarm \
  -t "feat(core): scoped memory tiers with retrieval policy" \
  -b "..." \
  -l type:feature \
  -l priority:medium \
  -m "Roadmap: Next" \
  -p "AWS Swarm Roadmap"
```

Add an existing issue to the roadmap project:

```bash
gh project item-add 4 --owner cenetex \
  --url https://github.com/cenetex/aws-swarm/issues/123
```

## Decision Test

Before opening an issue, ask:

- Is this approved for execution soon?
- Does it have scope, constraints, acceptance criteria, and a milestone?
- Do we have capacity under the issue backlog and WIP caps?

If the answer to any of those is "no", it belongs in the Project as a draft item, not in the issue backlog.
