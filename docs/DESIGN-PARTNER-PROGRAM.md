# Design Partner Program: M2 Governance-Sensitive Teams

**Status:** Draft v1
**Date:** 2026-02-24
**Owner:** Product + GTM
**Horizon:** M2 (active) through M3 handoff
**Related:** [GTM-STRATEGY-M2.md](./GTM-STRATEGY-M2.md) | [PRD-M3-PERSISTENT-SWARM-PLATFORM.md](./PRD-M3-PERSISTENT-SWARM-PLATFORM.md) | [PRD-M4-ECOSYSTEM-AUTONOMOUS-OPERATIONS.md](./PRD-M4-ECOSYSTEM-AUTONOMOUS-OPERATIONS.md) | [BILLING-STRATEGY.md](./BILLING-STRATEGY.md)

---

## 1. Purpose

This document defines the M2 design-partner program for governance-sensitive teams. The program exists to:

1. Validate enterprise governance features with real workloads before broad release.
2. Generate concrete product feedback that shapes M3/M4 governance and packaging priorities.
3. Build early reference accounts that demonstrate platform readiness for regulated and compliance-driven buyers.

Design partners are not beta testers. They are production-intent teams whose governance requirements exceed what the current product surface exposes. Their engagement produces binding product signal, not just usage data.

---

## 2. Target Profile

Design partners are governance-sensitive teams that match the P3 ICP defined in [GTM-STRATEGY-M2.md](./GTM-STRATEGY-M2.md). They share a common set of organizational constraints:

- They operate in environments where auditability, access control, and policy enforcement are mandatory rather than optional.
- They need to run multiple avatars with clear role boundaries and delegated administration.
- They have integration requirements that go beyond out-of-the-box platform and channel support.
- They have internal approval processes that require vendor security and compliance posture documentation.

### Typical Profiles

| Profile | Example | Why They Fit |
|---------|---------|--------------|
| Agency managing client avatars | Digital marketing agency running branded AI presences for 5+ clients | Needs multi-tenant isolation, per-client audit trails, role-based access for client teams |
| Regulated enterprise team | Financial services or healthcare internal comms team | Needs data retention controls, audit logging, model routing constraints, compliance documentation |
| Government or public-sector team | Municipal communications or constituent engagement | Needs strict access controls, audit trails, data residency awareness, procurement-ready security posture |
| Platform operator building on top | SaaS company embedding avatar capabilities into their own product | Needs API access, custom model routing, usage metering, white-label or headless operation |

---

## 3. Qualification Rubric

Every prospective design partner is scored against five dimensions. A team must score **Qualified** or higher on at least four of five dimensions to enter the program.

### 3.1 Scoring Dimensions

| Dimension | Qualified (2) | Strong (3) | Exceptional (4) |
|-----------|---------------|------------|------------------|
| **Governance need** | Has stated compliance or audit requirements for AI operations | Has documented internal policies that constrain AI tool deployment | Subject to external regulatory framework (financial, healthcare, government) |
| **Production intent** | Plans to go live within 90 days of program start | Has budget allocated and internal sponsor identified | Has existing bot/avatar operations to migrate or augment |
| **Scale signal** | Will operate 3+ avatars across 2+ platforms | Will operate 5+ avatars with multi-team access | Will operate 10+ avatars or embed into their own product |
| **Feedback capacity** | Can attend biweekly check-in calls | Has designated point of contact with authority to prioritize feedback | Will commit engineering resources to integration testing and structured feedback |
| **Reference potential** | Willing to provide private case study | Willing to provide named reference for sales conversations | Willing to co-present at events or publish joint content |

### 3.2 Minimum Thresholds

- Total score >= 10 (out of 20 maximum).
- No dimension scored below Qualified (2).
- At least one dimension scored Exceptional (4).

### 3.3 Disqualifiers

The following conditions disqualify a prospect regardless of score:

- No production deployment intent within 90 days.
- Requires features that conflict with platform architecture or security model.
- Cannot commit a named point of contact for the engagement.
- Primary motivation is free access rather than governance capability validation.

---

## 4. Engagement Model

### 4.1 Program Structure

| Phase | Duration | Focus |
|-------|----------|-------|
| **Onboarding** | Weeks 1-2 | Account setup, governance requirements intake, success criteria alignment |
| **Build** | Weeks 3-8 | Configuration, integration, iterative feature validation |
| **Operate** | Weeks 9-12 | Production operation, metrics collection, feedback synthesis |
| **Review** | Week 13 | Graduation assessment, case study capture, transition planning |

Total program duration: 13 weeks (one quarter).

### 4.2 What Design Partners Receive

| Benefit | Details |
|---------|---------|
| Enterprise-tier entitlements | Full Enterprise plan access for program duration at no cost |
| Dedicated support channel | Private Telegram or Slack channel with product and engineering access |
| Priority feature influence | Governance-related feature requests reviewed in weekly product triage |
| Early access | Pre-release access to governance features (audit exports, RBAC, policy controls) as they ship |
| Architecture review | One architecture review session to align avatar deployment with partner's compliance requirements |

### 4.3 What Design Partners Commit

| Commitment | Details |
|------------|---------|
| Named point of contact | Single accountable person with decision authority |
| Biweekly feedback sessions | 30-minute structured check-in every two weeks (6 sessions total) |
| Structured feedback deliverables | Written governance requirements doc (week 2), mid-program assessment (week 8), exit survey (week 13) |
| Production deployment | At least one avatar operating in a production channel by week 8 |
| Reference participation | Agreement to provide at minimum a private case study at program end |

### 4.4 Feedback Cadence

| Cadence | Activity | Owner |
|---------|----------|-------|
| Weekly | Async check-in via support channel (partner flags blockers, product shares updates) | Partner POC + Product |
| Biweekly | 30-minute structured call: progress against success criteria, feature request review, blocker resolution | Product + Engineering lead |
| Month 1 end | Governance requirements document reviewed and translated into product backlog items | Product |
| Month 2 end | Mid-program assessment: are success criteria on track? Adjust scope if needed | Product + Partner POC |
| Month 3 end | Exit review: graduation assessment, case study interview, transition to standard enterprise plan | Product + GTM |

### 4.5 Escalation Path

| Level | Trigger | Response | SLA |
|-------|---------|----------|-----|
| L1: Support channel | Any question or non-blocking issue | Product team responds in support channel | 1 business day |
| L2: Engineering escalation | Blocking bug or integration failure | Engineering allocates time in current sprint | 3 business days |
| L3: Product escalation | Missing capability that blocks production deployment | Product reviews in weekly triage, commits to roadmap position or workaround | 5 business days |
| L4: Leadership escalation | Fundamental misalignment on scope, timeline, or program terms | Leadership review and resolution | 10 business days |

---

## 5. Pilot Success Metrics

Success metrics are divided into two categories: partner-level metrics (does this engagement work?) and program-level metrics (does the program produce useful signal?).

### 5.1 Partner-Level Metrics

These are assessed per design partner at the end of the 13-week engagement.

| Metric | Target | Measurement |
|--------|--------|-------------|
| Production deployment | At least 1 avatar live in production channel | Platform telemetry: avatar with >= 100 production messages processed |
| Governance feature utilization | Partner actively uses >= 3 governance features | Feature usage logs: audit log access, RBAC configuration, secret management, model routing, memory controls, entitlement management |
| Feedback quality | >= 5 actionable product insights captured | Tracked in product backlog: insights tagged `design-partner` with clear product action |
| Partner satisfaction | NPS >= 8 (on 0-10 scale) | Exit survey |
| Time to production | First production message within 8 weeks of program start | Platform telemetry |

### 5.2 Program-Level Metrics

These are assessed across all design partners at program end to determine whether the program should continue, expand, or restructure.

| Metric | Target | Measurement |
|--------|--------|-------------|
| Partner completion rate | >= 75% of admitted partners complete the 13-week program | Program tracking |
| Graduation rate | >= 50% of completing partners convert to paid Enterprise plan | Billing system |
| Product signal density | >= 15 unique governance-related backlog items from the cohort | Product backlog tagged `design-partner` |
| M3/M4 roadmap influence | >= 5 backlog items from the program prioritized into M3 scope | Product roadmap review |
| Reference conversion | >= 50% of completing partners agree to named reference or case study | GTM tracking |

### 5.3 Product Readiness Signals

Design partner engagement produces specific signals that gate M3/M4 governance scope decisions.

| Signal | What It Proves | Feeds Into |
|--------|---------------|------------|
| Partners can configure RBAC without engineering support | Self-service governance is viable | M3: Multi-avatar coordination scope |
| Partners rely on audit logs for internal compliance | Audit infrastructure meets real compliance workflows | M3: Memory trust layer audit requirements |
| Partners request org-level policy management | Single-account governance is insufficient for enterprise | M4: Organization and governance layer scope |
| Partners integrate via API rather than chat-only admin | API surface must be first-class, not secondary | M3/M4: API packaging and metering |
| Partners need custom model routing for compliance reasons | Model routing is a governance feature, not just a cost feature | M3: Model routing as governance control |

---

## 6. Graduation Criteria

At the end of the 13-week program, each design partner is assessed for graduation. Graduation means the partner transitions from the design-partner program into a standard enterprise engagement.

### 6.1 Graduation Decision Matrix

| Outcome | Criteria | Next Step |
|---------|----------|-----------|
| **Graduate to Enterprise** | Met >= 4 of 5 partner-level metric targets AND willing to convert to paid plan | Transition to Enterprise tier with standard pricing; capture case study |
| **Extend** | Met >= 3 of 5 targets but needs more time due to integration complexity or internal timelines | Extend program by up to 6 weeks with revised success criteria |
| **Exit with reference** | Met < 3 targets but engagement produced useful product signal and partner is willing to provide reference | Capture learnings, maintain relationship for future re-engagement |
| **Exit** | Met < 3 targets, limited product signal, or partner disengaged | Document learnings, close engagement cleanly |

### 6.2 Graduation Review Process

1. Product owner compiles partner metrics dashboard one week before the week-13 review.
2. Partner POC completes exit survey and final feedback deliverable.
3. Joint 45-minute graduation review covers: metric outcomes, product insights summary, case study capture, transition terms.
4. Product owner documents graduation decision and rationale in program tracking.
5. If graduating: GTM introduces partner to standard enterprise account management within 2 weeks.
6. If extending: revised success criteria and timeline documented and agreed within 1 week.

---

## 7. Cohort Management

### 7.1 Cohort Size

- M2 cohort: **3-5 design partners** maximum.
- Rationale: small enough for high-touch engagement, large enough to produce diverse signal.
- Do not exceed 5 partners until program operations are proven and support capacity is confirmed.

### 7.2 Cohort Timing

- Intake window: rolling, but partners are grouped into quarterly cohorts for structured feedback synthesis.
- First cohort target: begin onboarding within 30 days of program launch.
- Cohort retrospective: conducted within 2 weeks of last partner's graduation review.

### 7.3 Pipeline Management

| Stage | Description | Owner |
|-------|-------------|-------|
| Prospect | Identified as potential fit; initial conversation scheduled | GTM |
| Qualifying | Rubric scoring in progress; requirements intake | Product + GTM |
| Accepted | Scored, approved, program terms agreed | Product |
| Onboarding | Account setup, requirements alignment | Product + Engineering |
| Active | In build or operate phase | Product |
| Review | In graduation assessment | Product + GTM |
| Graduated / Exited | Program complete | GTM |

---

## 8. Program Outputs and M3/M4 Feed-Forward

The design-partner program is not a standalone sales motion. Its primary output is product signal that shapes future milestones.

### 8.1 Required Program Outputs

At the end of each cohort, the product owner produces:

1. **Governance requirements synthesis**: consolidated view of governance needs across all partners, ranked by frequency and severity.
2. **Feature gap analysis**: features requested by partners mapped to current roadmap, with gaps highlighted.
3. **Packaging signal**: data on which governance features drive conversion and which are table-stakes expectations.
4. **Operational learnings**: support burden, common failure modes, onboarding friction points.

### 8.2 Feed-Forward to M3

| M3 Scope Area | Design Partner Signal Expected |
|---------------|-------------------------------|
| Memory trust layer | Which memory controls do partners actually use? What audit/export formats do their compliance teams require? |
| Multi-avatar coordination | How do partners structure avatar teams? What role boundaries do they need enforced? |
| Template system | Which setup patterns repeat across partners? What should become a packaged template? |
| Reliability surfaces | Which operational metrics do partners need exposed in their own dashboards? |

### 8.3 Feed-Forward to M4

| M4 Scope Area | Design Partner Signal Expected |
|---------------|-------------------------------|
| Organization governance layer | Do partners need org-level policies? How do they model delegated administration? |
| Enterprise packaging | What SLA and support expectations do partners have? What is their willingness to pay? |
| API and integration | What integration patterns emerge? What API surface is missing? |
| Compliance surfaces | What external compliance frameworks are partners subject to? What evidence do they need from the platform? |

---

## 9. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Partners demand features outside M2 scope | Roadmap distortion, over-commitment | Qualification rubric filters for alignment; escalation path explicitly scopes what is in/out for M2 |
| Low partner engagement after onboarding | Wasted program capacity, poor signal quality | Biweekly cadence and production deployment commitment enforce ongoing engagement; exit at mid-program review if disengaged |
| Enterprise expectations exceed platform maturity | Partner dissatisfaction, negative reference risk | Program framing is explicit: design partners help shape governance features, not consume finished enterprise product |
| Support burden exceeds team capacity | Engineering velocity impact | Cohort size capped at 5; L2/L3 escalation SLAs protect sprint capacity; program paused if support load exceeds threshold |
| Partners churn before graduation | Lost signal, incomplete metrics | Extension option preserves engagement; exit-with-reference path captures partial signal |

---

## 10. Appendix: Intake Questionnaire

The following questions are used during the qualifying stage to score the rubric dimensions.

### Governance Need

1. What compliance or regulatory frameworks apply to your AI operations?
2. Do you have documented internal policies that constrain how AI tools are deployed?
3. Who in your organization must approve new AI tooling? What do they require?

### Production Intent

4. What is your target timeline for first production deployment?
5. Is budget allocated for this engagement? Is there an internal sponsor?
6. Do you have existing bot or avatar operations that this would replace or augment?

### Scale Signal

7. How many avatars do you expect to operate in the first 90 days?
8. Which platforms (Telegram, Discord, X, web, API) do you need?
9. How many team members will need access to the admin interface?

### Feedback Capacity

10. Who will be the named point of contact for this program?
11. Can you commit to biweekly 30-minute check-in calls for 13 weeks?
12. Are you able to commit engineering resources to integration testing?

### Reference Potential

13. Are you open to providing a private case study at program end?
14. Would you be willing to serve as a named reference for future enterprise prospects?
15. Would you consider co-presenting at an event or publishing joint content about your experience?
