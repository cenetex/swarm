# GTM Strategy: M2 Multi-Platform Hardening

Status: Draft v1
Date: 2026-02-21
Horizon: M2 (next 90 days)
Primary owner: Product + Engineering

## 1) Objective

Turn AWS Swarm from a technically strong platform into a repeatable go-to-market motion that drives:
1. Predictable activation from signup to first live avatar outcome.
2. Clear conversion path from free to paid plans.
3. Early expansion motion for team and enterprise use.

This strategy complements:
- `VISION.md`
- `ROADMAP.md`
- `PLAN.md`
- `docs/BILLING-STRATEGY.md`
- `docs/PRIVY-STRIPE-MIGRATION.md`

## 2) Strategic Context

What is true now:
1. M1 shipped core foundations (auth, entitlement model, runtime safety/observability).
2. M2 scope is parity + hardening + billing/usage visibility.
3. Product direction is credible, but GTM is not yet systematized.

Implication:
1. The next bottleneck is not only feature delivery.
2. The next bottleneck is positioning, packaging, activation clarity, and conversion instrumentation.

## 3) ICP Prioritization (Beachhead First)

### P1: Creator-Operator (Primary)
Profile:
- Solo operator managing 1-3 avatars.
- Telegram-first, with intent to expand to Discord/X.
- Comfortable with light technical setup, not deep infra work.

Why P1 first:
1. Fastest time to first value with current product shape.
2. Strong fit with chat-first admin model.
3. Best learning loop for activation and pricing.

### P2: Small Team / Agency Operator (Secondary)
Profile:
- 2-10 person team managing multiple client or community avatars.
- Needs reliability, role separation, and account clarity.

Why P2 second:
1. Natural expansion from P1 once multi-avatar flows are stable.
2. Higher ARPU potential with Pro/Enterprise packaging.

### P3: Enterprise Program (Design Partners Only)
Profile:
- Governance-sensitive orgs requiring auditability and controls.

Why P3 limited in M2:
1. Enterprise motion depends on M3/M4 governance depth.
2. Premature scaling here would overfit roadmap before proof.

## 4) Positioning

Category:
- Reliable multi-platform AI avatar operations platform.

Positioning statement:
- AWS Swarm helps operators run persistent AI avatars across Telegram, Discord, X, and web with governance, observability, and cost controls built in.

Differentiation pillars:
1. Reliability by design: queue-based runtime, deterministic processing, operational guardrails.
2. Safe autonomy: tool gating, entitlement enforcement, spend controls.
3. Persistent identity: memory model + multi-platform continuity.
4. Chat-first operations: configure and operate through conversational admin workflows.

## 5) Packaging and Offer Strategy

Free:
- Purpose: prove first value quickly.
- Success event: avatar reaches first successful live interaction.

Pro:
- Purpose: unlock sustained operational use.
- Trigger: repeated usage, memory/value reliance, multi-platform needs.

Enterprise:
- Purpose: governance-heavy multi-seat deployments.
- Trigger: compliance and organizational control requirements.

Commercial notes:
1. Keep entitlements as operational source of truth.
2. Keep Stripe lifecycle synced via webhook-based entitlement updates.
3. Keep web3 benefits as augmentation, not required path.

## 6) Activation Strategy

North-star activation event:
- `A1`: account creates avatar and gets first successful live response in a production channel.

Activation flow priorities:
1. Reduce setup ambiguity in admin chat prompts.
2. Provide guided "first outcome" playbooks per ICP.
3. Make failure states explicit and actionable.
4. Ensure usage/plan visibility appears before hard limit friction.

## 7) Channel Strategy (M2)

Owned channels:
1. Product docs and README narrative refresh.
2. Demo clips and step-by-step launch playbooks.
3. Release notes tied to customer outcomes, not only technical changes.

Product-led channels:
1. Template-driven setup flows that produce visible output quickly.
2. In-product upgrade prompts tied to concrete usage events.

Partner/community channels:
1. Telegram/Discord operator communities.
2. Web3-native communities where identity and ownership narratives resonate.

## 8) Messaging Matrix (v1)

### Creator-Operator
Problem:
- Bot setups are brittle and hard to sustain.

Promise:
- Launch a persistent avatar with predictable behavior and clear limits.

Proof:
- Runtime guardrails, entitlement enforcement, channel-aware processing, operational diagnostics.

Primary CTA:
- Launch first avatar and reach first live response.

### Small Team / Agency
Problem:
- Scaling from one bot to many creates reliability and governance drift.

Promise:
- Operate multiple avatars with clear control and visibility.

Proof:
- Shared runtime patterns, account model, observability and issue workflows.

Primary CTA:
- Move from single-avatar to multi-avatar managed operations.

### Enterprise Design Partner
Problem:
- Autonomous systems are risky without governance and audit.

Promise:
- Controlled automation with explicit policy and operational visibility.

Proof:
- Auditability direction, policy-first architecture, roadmap to org governance.

Primary CTA:
- Join design partner program for governance-focused workloads.

## 9) Funnel and KPI Framework

### Funnel definition
1. `F0`: qualified visitor/session.
2. `F1`: authenticated account.
3. `F2`: avatar created.
4. `F3`: first live response delivered.
5. `F4`: day-7 active avatar.
6. `F5`: paid conversion.
7. `F6`: expansion event (2+ active avatars or team usage).

### M2 KPI targets (initial)
1. `F1->F2` conversion >= 60%.
2. `F2->F3` conversion >= 70%.
3. `F3->F4` retention >= 35%.
4. `F4->F5` paid conversion >= 10% for active operators.
5. Median time `F2->F3` <= 10 minutes.

### Operational guardrail KPIs
1. Activation failure rate by step.
2. Time-to-resolution for activation-blocking failures.
3. Cost per active avatar and cost per successful response.

## 10) 30/60/90 Plan

### Days 0-30
1. Publish canonical GTM narrative + messaging matrix.
2. Instrument funnel events and KPI dashboard baseline.
3. Build three operator playbooks with reproducible setup paths.

### Days 31-60
1. Launch conversion experiments (pricing presentation, upgrade timing, plan copy).
2. Launch activation experiments (prompt flow wording, error recovery, guided tasks).
3. Start design partner pipeline for governance-heavy teams.

### Days 61-90
1. Standardize winning messaging and onboarding prompts.
2. Package top playbooks into templates with readiness checks.
3. Publish first monthly GTM review with funnel and conversion trends.

## 11) Experiment Backlog (M2)

1. Pricing message test: capability framing vs limit framing.
2. Upgrade prompt timing: first limit hit vs pre-limit threshold.
3. Activation prompt design: linear setup script vs outcome-driven checklist.
4. Template-first launch vs blank-avatar launch.
5. Usage visibility format in admin chat: compact summary vs detailed breakdown.
6. ICP-specific landing copy variants for creator vs team operator.

## 12) Risks and Mitigations

Risk: technical-first messaging fails to communicate business outcome.
Mitigation: enforce outcome-first copy for all public assets.

Risk: funnel blind spots block optimization.
Mitigation: treat funnel instrumentation as a release-gating requirement.

Risk: pricing confusion due to hybrid web2/web3 model.
Mitigation: present entitlement plans as primary, web3 as optional augmentation.

Risk: enterprise interest arrives before governance readiness.
Mitigation: restrict enterprise motion to design-partner model until M3 controls mature.

## 13) Execution Cadence

Weekly:
1. Funnel review and blocked-step diagnosis.
2. Experiment readout and next iteration decisions.
3. Cross-functional GTM + engineering dependency check.

Monthly:
1. KPI trend report.
2. Positioning and pricing review.
3. Next-month experiment and asset plan.

## 14) Exit Criteria for M2 GTM

1. Documented ICP and messaging are used consistently in product and docs.
2. Funnel instrumentation supports weekly optimization without manual stitching.
3. Conversion and activation metrics show sustained improvement over baseline.
4. Design-partner pipeline is active with clear qualification criteria.
