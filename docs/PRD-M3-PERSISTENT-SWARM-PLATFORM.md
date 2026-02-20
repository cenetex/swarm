# PRD: M3 Persistent Swarm Platform

**Status:** Draft
**Last reviewed:** 2026-02-20
**Milestone window:** 9-18 months (post-M2)

## 1. Milestone Intent
M3 turns AWS Swarm from a reliable multi-platform bot system into a persistent avatar platform where memory quality, multi-avatar coordination, and repeatable outcomes are core product value.

M3 is successful when operators trust avatar memory over time, can run more than one avatar with clear role boundaries, and can launch proven templates with low setup overhead.

## 2. Product Context
M1 established paid Telegram MVP and operational baselines. M2 is focused on parity and hardening. M3 builds on both by emphasizing durable user value instead of isolated feature completion.

This PRD aligns to:
- `VISION.md`
- `ROADMAP.md`
- `PLAN.md`
- `docs/BILLING-STRATEGY.md`

## 3. Problems M3 Must Solve
1. Persistent memory quality is inconsistent and hard to reason about for operators.
2. Multi-avatar operation exists conceptually but lacks a clean product model and policy controls.
3. New users still face high setup burden to achieve consistent outcomes.
4. Reliability and cost controls are mostly operator/internal experiences, not clear product surfaces.

## 4. Target Users
1. Individual creator/operator
Needs one to three avatars that retain context reliably and can be managed without deep technical knowledge.
2. Small team or agency operator
Needs multiple avatars with role separation, safe handoffs, and predictable governance.
3. Platform operator/admin
Needs auditable controls, rollout safety, and fast diagnosis for persistent systems.

## 5. Jobs To Be Done
1. "I want this avatar to remember useful things and forget appropriately without manual cleanup."
2. "I want multiple avatars to coordinate without conflicting behavior."
3. "I want to start from a proven template and get to production quickly."
4. "I want to know when reliability/cost/policy risk is rising before users are impacted."

## 6. Goals and Non-Goals
### Goals
1. Make memory trustworthy, explainable, and controllable.
2. Ship a usable multi-avatar coordination model with guardrails.
3. Reduce setup-to-value through curated templates.
4. Expose reliability and spend controls as product features.

### Non-Goals
1. Fully open third-party marketplace economics.
2. Unbounded autonomy without approvals/guardrails.
3. Large runtime architecture rewrites not tied to customer outcomes.

## 7. Scope (Detailed)
### 7.1 Memory Trust Layer
**Outcome:** users trust persistence decisions.

Requirements:
1. Memory tier model is explicit in product surfaces (ephemeral/durable/archival semantics are understandable).
2. Operators can inspect why a memory was recalled and from which tier.
3. Operators can pin, suppress, delete, and export memory with deterministic behavior.
4. Retrieval path integrates semantic relevance by default and degrades gracefully when embeddings are absent.
5. Retention policy actions are auditable.

Delivery anchors:
- Semantic retrieval integration and quality instrumentation.
- Memory explainability and controls in admin UX.
- Clear retention and export workflows.

Acceptance criteria:
1. Operators can identify recall source/tier for recent memory hits from product UI/API.
2. Memory control actions (pin/suppress/delete/export) are auditable and idempotent.
3. Retrieval quality and latency dashboards exist with baseline vs post-change comparison.

### 7.2 Multi-Avatar Coordination
**Outcome:** users run avatar teams, not isolated bots.

Requirements:
1. Avatar role model exists (for example coordinator, specialist, broadcaster).
2. Cross-avatar handoff model preserves minimal required context.
3. Coordination policies prevent unsafe loops and runaway tool cascades.
4. Operators can observe active coordination flows and intervene.
5. Governance events are recorded for audit/debug use.

Delivery anchors:
- Role/policy schema.
- Handoff UX and runtime contract.
- Coordination observability views.

Acceptance criteria:
1. Coordination policies prevent uncontrolled handoff/tool loops in production defaults.
2. Operator can pause or disable a coordination flow without service-wide disruption.
3. Coordination events are queryable by avatar, role, and request correlation ID.

### 7.3 Templates and Packaged Value
**Outcome:** setup friction drops and outcomes become repeatable.

Requirements:
1. Curated template library for top use cases with clear expected outcomes.
2. Template application flow includes validation checklist before go-live.
3. Template versioning and upgrade path are explicit.
4. Templates include recommended policy defaults, not only prompts.

Delivery anchors:
- Template catalog and onboarding path.
- Validation/readiness checks.
- Versioning and migration behavior.

Acceptance criteria:
1. Top launch templates include expected outcomes, limits, and policy defaults.
2. Template readiness check blocks activation until critical dependencies are satisfied.
3. Template upgrades preserve operator intent (or provide explicit migration prompts).

### 7.4 Reliability and Cost Surfaces
**Outcome:** operators can manage persistent systems proactively.

Requirements:
1. Product-visible indicators for health, queue pressure, tool failure rates, and cost pressure.
2. Early warning and suggested remediation for policy/reliability regressions.
3. Safe controls for rollback/deactivate/throttle at avatar and group levels.
4. Unified event timeline for major operational actions.

Delivery anchors:
- Operational status panel(s).
- Alerting/remediation UX.
- Action history and audit surface.

Acceptance criteria:
1. Operators can see health, failure-rate, and spend-pressure signals at avatar and group scope.
2. Suggested mitigations are available for common regressions (tool failures, queue pressure).
3. Rollback/deactivate/throttle controls create traceable action events.

## 8. User Journeys (M3)
### Journey A: Persistent Creator
1. Creates avatar from a template.
2. Enables durable memory with retention defaults.
3. Sees memory recall explanations in live chat.
4. Adjusts one memory rule and verifies behavior.

### Journey B: Multi-Avatar Team
1. Operator sets up three avatars with explicit roles.
2. Coordinator routes tasks and receives specialist outputs.
3. Operator reviews handoff log and policy decisions.
4. Operator intervenes to stop a noisy flow and resumes safely.

### Journey C: Reliability Incident Prevention
1. Platform signals rising media/tool failure trend.
2. Operator gets guided actions (throttle, retry policy, fallback mode).
3. Operator executes mitigation and confirms recovery in timeline.

## 9. Success Metrics and Targets
### Adoption and Value
1. Increase accounts with 2+ active avatars.
2. Reduce median time from avatar creation to first successful production workflow.
3. Increase template-driven activations.

### Quality and Trust
1. Improve memory recall usefulness score (operator/user feedback).
2. Reduce memory-related support incidents.
3. Increase percentage of users using memory controls intentionally.

### Reliability and Ops
1. Decrease P1/P2 incidents tied to orchestration/tool failure loops.
2. Improve mean time to diagnose and recover.
3. Reduce surprise spend events per active avatar.

## 10. Delivery Phasing
### M3-A (Foundation)
1. Semantic memory integration and instrumentation.
2. Memory controls and explainability primitives.
3. Initial role schema for multi-avatar coordination.

### M3-B (Productization)
1. Coordination UX and policy controls.
2. Template catalog with readiness checks.
3. Operational health and cost surfaces in admin experience.

### M3-C (Scale Readiness)
1. Governance hardening and audit completeness.
2. Template versioning/migration model.
3. Reliability optimization under multi-avatar load.

## 11. Dependencies
1. M2 parity/hardening outcomes as baseline.
2. Identity/account UX completion (multi-wallet, account clarity).
3. Observability consistency (request correlation and structured logging).
4. Data instrumentation for memory, coordination, and reliability KPIs.

## 12. Risks and Mitigations
1. Risk: memory distrust due to opaque retrieval behavior.
Mitigation: explainability, deterministic controls, explicit retention UX.
2. Risk: coordination complexity overwhelms non-technical users.
Mitigation: constrained presets and safe defaults before advanced controls.
3. Risk: template sprawl with uneven quality.
Mitigation: curated launch set, versioning, strict quality gates.
4. Risk: operational UI complexity becomes noisy.
Mitigation: progressive disclosure and role-based views.

## 13. Exit Criteria for M3
1. Memory trust and control surfaces meet adoption and quality thresholds.
2. Multi-avatar coordination is used in production with acceptable incident rates.
3. Template workflows materially improve setup-to-value metrics.
4. Reliability/cost controls are actively used and reduce operational escalations.

## 14. Open Questions
1. What minimum memory-quality benchmark is required for M3 GA?
2. Which coordination policy model is simple enough for first release?
3. Which template categories are mandatory for launch?
4. Which operational controls should be self-serve versus admin-only?

## 15. Initial Execution Backlog Seeds
### M3-A Foundation Candidates
1. Integrate semantic retrieval into default memory path with tier-aware tracing.
2. Add memory explainability payload (recall source, tier, relevance summary) to chat diagnostics.
3. Implement memory control endpoints for pin/suppress/delete/export with audit events.
4. Define multi-avatar role schema and policy defaults for first coordination release.

### M3-B Productization Candidates
1. Build coordination flow UI with pause/resume and loop-protection visibility.
2. Launch curated template catalog with readiness checklist and activation gates.
3. Add template version metadata and upgrade compatibility contract.
4. Add admin reliability/cost panel for queue pressure, tool error trend, and spend indicators.

### M3-C Scale Readiness Candidates
1. Harden governance/audit queryability across memory, coordination, and operational controls.
2. Validate coordination behavior under load and multi-avatar contention scenarios.
3. Finalize template migration playbooks and rollback safety for large installs.
