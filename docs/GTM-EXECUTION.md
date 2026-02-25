# M2 GTM Execution Tracker

Status: Active
Date: 2026-02-23
Horizon: M2 (90-day rolling)
Source strategy: [GTM-STRATEGY-M2.md](GTM-STRATEGY-M2.md)

## Purpose

This document converts the M2 GTM strategy into issue-backed execution tasks with dependency sequencing, delivery phases, and a monthly review cadence. It is the canonical tracker for GTM workstream progress.

## Child Issues

| # | Title | Type | Status | Phase |
|---|-------|------|--------|-------|
| [#271](https://github.com/cenetex/aws-swarm/issues/271) | Messaging matrix and positioning | docs | Open | Days 0-30 |
| [#272](https://github.com/cenetex/aws-swarm/issues/272) | Funnel instrumentation and KPI schema | feat | **Done** | Days 0-30 |
| [#273](https://github.com/cenetex/aws-swarm/issues/273) | Activation checkpoints and recovery UX | feat | **Done** | Days 0-30 |
| [#274](https://github.com/cenetex/aws-swarm/issues/274) | ICP playbooks and demo checklists | docs | Open | Days 31-60 |
| [#275](https://github.com/cenetex/aws-swarm/issues/275) | Weekly GTM KPI automation | feat | **Done** | Days 0-30 |
| [#276](https://github.com/cenetex/aws-swarm/issues/276) | Design-partner program rubric | docs | Open | Days 31-60 |

## Dependency Graph

```
#272 Funnel instrumentation (DONE)
  |
  +---> #275 Weekly KPI automation (DONE)
  |       |
  |       +---> Monthly GTM review artifact (Days 61-90)
  |
  +---> Conversion experiments (Days 31-60)

#271 Messaging matrix (Open)
  |
  +---> #274 ICP playbooks (Open)
  |       |
  |       +---> Template packaging (Days 61-90)
  |
  +---> Public narrative refresh (Days 31-60)

#273 Activation checkpoints (DONE)
  |
  +---> Activation experiments (Days 31-60)
  |       |
  |       +---> Standardize winning prompts (Days 61-90)

#276 Design-partner program (Open)
  |
  +---> Partner pipeline launch (Days 31-60)
  |       |
  |       +---> Partner qualification and review (Days 61-90)
```

## 30/60/90 Execution Plan

### Days 0-30: Foundation

Goal: Establish instrumentation, messaging baseline, and activation improvements.

| Deliverable | Issue | Owner | Status | Notes |
|------------|-------|-------|--------|-------|
| Funnel event schema and emission (F0-F6) | #272 | Engineering | Done | Event schema covers auth, avatar creation, first response, retention, conversion |
| Activation checkpoints in admin chat | #273 | Engineering | Done | Reduced median avatar-to-first-response time |
| Weekly KPI automation workflow | #275 | Engineering | Done | Scheduled + manual dispatch, markdown + JSON output |
| Canonical messaging matrix by ICP | #271 | Product | Open | Problem/promise/proof/CTA for creator, team, enterprise |
| Baseline KPI snapshot | -- | Product | Pending | First weekly report run establishes baseline targets |

Exit criteria:
- Funnel events emitting in staging and production.
- Weekly KPI report running on schedule.
- Messaging matrix committed and referenced by planning docs.

### Days 31-60: Experimentation

Goal: Run conversion and activation experiments, launch playbooks and partner pipeline.

| Deliverable | Issue | Owner | Status | Notes |
|------------|-------|-------|--------|-------|
| ICP launch playbooks (3 scenarios) | #274 | Product | Open | Creator, team operator, design partner |
| Design-partner rubric and program guide | #276 | Product | Open | Qualification criteria, engagement model, success metrics |
| Conversion experiments | -- | Product + Eng | Pending | Pricing presentation, upgrade timing, plan copy |
| Activation experiments | -- | Product + Eng | Pending | Prompt flow wording, error recovery, guided tasks |
| Public narrative refresh | -- | Product | Pending | README/docs/launch copy updated to outcome-first messaging |
| Partner pipeline launch | -- | Product | Pending | Depends on #276 |

Experiment backlog (from strategy Section 11):
1. Pricing message test: capability framing vs limit framing.
2. Upgrade prompt timing: first limit hit vs pre-limit threshold.
3. Activation prompt design: linear setup script vs outcome-driven checklist.
4. Template-first launch vs blank-avatar launch.
5. Usage visibility format: compact summary vs detailed breakdown.
6. ICP-specific landing copy variants for creator vs team operator.

Exit criteria:
- At least 2 conversion experiments launched with measurable instrumentation.
- At least 2 activation experiments launched.
- Three playbooks published under `docs/`.
- Design-partner qualification criteria documented.

### Days 61-90: Standardization

Goal: Codify winning patterns, package templates, publish first monthly review.

| Deliverable | Issue | Owner | Status | Notes |
|------------|-------|-------|--------|-------|
| Standardize winning messaging and prompts | -- | Product | Pending | Based on experiment results |
| Package top playbooks into templates | -- | Product + Eng | Pending | Add readiness checks |
| First monthly GTM review | -- | Product | Pending | Funnel KPIs + experiment outcomes |
| Partner qualification review | -- | Product | Pending | Assess pipeline quality and feedback |

Exit criteria:
- Documented ICP and messaging used consistently in product and docs.
- Funnel instrumentation supports weekly optimization without manual stitching.
- Conversion and activation metrics show sustained improvement over baseline.
- Design-partner pipeline active with clear qualification criteria.

## KPI Framework

### Funnel Definition

| Stage | Description | Source |
|-------|-------------|--------|
| F0 | Qualified visitor/session | Analytics |
| F1 | Authenticated account | Auth events |
| F2 | Avatar created | Admin API |
| F3 | First live response delivered | Message processor |
| F4 | Day-7 active avatar | Retention query |
| F5 | Paid conversion | Stripe webhook |
| F6 | Expansion (2+ avatars or team) | Account query |

### M2 Targets

| Metric | Target | Measurement |
|--------|--------|-------------|
| F1 to F2 conversion | >= 60% | Weekly KPI report |
| F2 to F3 conversion | >= 70% | Weekly KPI report |
| F3 to F4 retention | >= 35% | Weekly KPI report |
| F4 to F5 paid conversion | >= 10% | Weekly KPI report |
| Median time F2 to F3 | <= 10 min | Weekly KPI report |

### Operational Guardrails

| Metric | Description |
|--------|-------------|
| Activation failure rate by step | Percentage of users failing at each funnel stage |
| Time-to-resolution for blockers | Median time to resolve activation-blocking failures |
| Cost per active avatar | Infrastructure cost divided by active avatars |
| Cost per successful response | Infrastructure cost divided by successful responses |

## Review Cadence

### Weekly

Audience: Product + Engineering
Inputs: Automated KPI report (#275)

Agenda:
1. Funnel conversion review and blocked-step diagnosis.
2. Active experiment readout and next iteration decisions.
3. GTM + engineering dependency check (blockers, upcoming releases).

### Monthly

Audience: Product + Engineering + Stakeholders
Output: Monthly GTM review artifact (committed to `docs/release-notes/`)

Agenda:
1. KPI trend report: funnel conversion, activation latency, paid conversion.
2. Experiment outcomes: what was tested, what won, what to kill.
3. Positioning and pricing review: any adjustments based on data.
4. Next-month experiment and asset plan.

Template for monthly review:

```markdown
# GTM Monthly Review - [Month Year]

## Funnel Performance
- F1->F2: X% (target: 60%)
- F2->F3: X% (target: 70%)
- F3->F4: X% (target: 35%)
- F4->F5: X% (target: 10%)
- Median F2->F3 time: X min (target: 10 min)

## Experiments Completed
| Experiment | Hypothesis | Result | Decision |
|-----------|-----------|--------|----------|
| ... | ... | ... | Ship / Iterate / Kill |

## Key Decisions
- ...

## Next Month Plan
- Experiments: ...
- Assets: ...
- Dependencies: ...
```

## Risk Register

| Risk | Likelihood | Impact | Mitigation | Owner |
|------|-----------|--------|------------|-------|
| Technical messaging fails to communicate business outcome | Medium | High | Enforce outcome-first copy for all public assets | Product |
| Funnel blind spots block optimization | Medium | High | Treat funnel instrumentation as release-gating | Engineering |
| Pricing confusion from hybrid web2/web3 model | Low | Medium | Present entitlement plans as primary, web3 as augmentation | Product |
| Enterprise interest before governance readiness | Low | High | Restrict to design-partner model until M3 controls | Product |

## References

- [GTM-STRATEGY-M2.md](GTM-STRATEGY-M2.md) -- source strategy
- [BILLING-STRATEGY.md](BILLING-STRATEGY.md) -- pricing and entitlement model
- [MARKETING-STRATEGY-M2.md](MARKETING-STRATEGY-M2.md) -- marketing complement (if exists)
- [ROADMAP-M2-MULTI-PLATFORM.md](ROADMAP-M2-MULTI-PLATFORM.md) -- M2 roadmap
- [PLAYBOOK-M2-MULTI-PLATFORM.md](PLAYBOOK-M2-MULTI-PLATFORM.md) -- M2 execution playbook
- [PLAYBOOK-TELEGRAM-QUICKSTART.md](PLAYBOOK-TELEGRAM-QUICKSTART.md) -- existing quickstart playbook
