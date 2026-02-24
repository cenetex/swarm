# Strategy Operations

> **Owner**: Leadership
> **Last reviewed**: 2026-02-23
> **Status**: Active
> **Related**: [RELEASE-GATES.md](./RELEASE-GATES.md) | [ISSUE-GOVERNANCE.md](./ISSUE-GOVERNANCE.md) | [LEADERSHIP-SCORECARD.md](./LEADERSHIP-SCORECARD.md) | [SECURITY.md](./SECURITY.md) | [COST-CONTROLS-PLAYBOOK.md](./COST-CONTROLS-PLAYBOOK.md)

This document encodes leadership strategy into executable rules that govern prioritization, release gating, cost governance, security exceptions, and weekly operating cadence. It is the canonical source for how strategic principles translate into day-to-day execution constraints.

Sub-issues covering deeper implementation of each area:
- **#264** -- Risk-first sequencing enforcement
- **#265** -- WIP cap and constrained active queue
- **#266** -- Release gate contract
- **#267** -- Cost governance KPI cadence
- **#268** -- Security exception governance
- **#269** -- Leadership operating metrics and portfolio allocation

---

## 1. Risk-First Sequencing

**Principle**: Reliability and security work is scheduled before feature expansion. An unreliable platform cannot support growth.

### Rules

| Rule | Enforcement |
|------|-------------|
| R1. Any issue labeled `priority:high` + `type:security` or `type:bug` is worked before any `type:feature` issue of equal or lower priority. | Validated during weekly triage (see [ISSUE-GOVERNANCE.md](./ISSUE-GOVERNANCE.md)). |
| R2. A RED health grade on the [Leadership Scorecard](./LEADERSHIP-SCORECARD.md) blocks starting new feature work until the grade returns to YELLOW or GREEN. | Scorecard reviewed as triage step 0. |
| R3. Active CloudWatch alarms (`alarms_in_alarm > 0`) trigger an immediate shift to incident response per the [RUNBOOK.md](./RUNBOOK.md). Feature PRs may continue in-flight but no new feature branches are started. | Automated via scorecard RELIABILITY recommendations. |
| R4. Dependency CVEs at high/critical severity block merge via CI (`pnpm audit --audit-level=high`). See [SECURITY.md](./SECURITY.md). | Enforced in CI pipeline. |

### Sequencing Order

When the backlog has competing priorities, apply this order:

1. **P0 -- Incidents**: Production outages, confirmed security vulnerabilities.
2. **P1 -- Reliability**: DLQ growth, error rate breaches, alarm fatigue.
3. **P2 -- Security hardening**: Access review findings, exception expiries, audit gaps.
4. **P3 -- Feature delivery**: Roadmap features for the current milestone.
5. **P4 -- Tech debt / quality**: Refactoring, test coverage, documentation.

This order is consistent with the priority criteria in [ISSUE-GOVERNANCE.md](./ISSUE-GOVERNANCE.md) and the severity thresholds in the [Leadership Scorecard](./LEADERSHIP-SCORECARD.md).

**Sub-issue**: #264

---

## 2. Constrained Active Queue (WIP Cap)

**Principle**: Limiting work-in-progress reduces context switching, prevents stale branches, and makes delivery predictable.

### Rules

| Rule | Limit | Enforcement |
|------|-------|-------------|
| W1. Maximum issues with `status:in-progress` label. | **8** | Checked during weekly triage; excess items must be either completed, blocked (with documented blocker), or returned to backlog. |
| W2. Maximum open PRs per contributor (human or agent). | **3** | Reviewed during triage. Stale PRs (>7 days without activity) count toward the limit. |
| W3. Maximum parallel agent worktrees. | **5** | Enforced by orchestrator scripts. Each worktree must have `worktree-start.sh` run at creation. |
| W4. Maximum `priority:high` issues open simultaneously. | **5** | If exceeded, the oldest high-priority issue must be resolved or downgraded before new high-priority issues are created. |

### Overflow Protocol

When the WIP cap is reached:

1. Review in-progress items for blockers (see [ISSUE-GOVERNANCE.md -- Blocked Issues](./ISSUE-GOVERNANCE.md)).
2. Items blocked for >7 days are returned to backlog with `status:blocked`.
3. Items without a linked branch or PR within 3 days of `status:in-progress` are returned to backlog.
4. Only after freeing a slot can a new item be pulled into progress.

**Sub-issue**: #265

---

## 3. Release Gate Contract

**Principle**: Every release to production passes a defined quality gate. No gate, no ship.

> **Full specification**: [RELEASE-GATES.md](./RELEASE-GATES.md) is the canonical reference for gate definitions, rollback readiness, change-risk annotation, and PR evidence requirements. The summary below is provided for quick reference; defer to RELEASE-GATES.md for enforcement details and edge cases.

### Gate Summary

| Category | Gates | Enforcement |
|----------|-------|-------------|
| CI automated (PR merge) | Lint, Build, Test, Security audit (G1-G4) | `ci.yml` + branch protection |
| Branch protection (PR merge) | PR required, review required, conversations resolved, branch up-to-date (G5-G8) | GitHub branch protection settings |
| Manual pre-release (production tag) | Scorecard health, security exceptions, staging verification, no P0/P1 incidents, changelog (G9-G13) | Human verification before tagging |

### Rollback Readiness

Every production release must be rollback-ready within 30 minutes. PRs labeled `risk:high` or `risk:critical` must include an explicit rollback plan. DynamoDB schema changes must be backward-compatible for at least one release cycle. See [RELEASE-GATES.md -- Section 2](./RELEASE-GATES.md#2-rollback-readiness) for the full rollback mechanism inventory and backward-compatibility rules.

### Change-Risk Annotation

PRs are labeled `risk:low`, `risk:medium`, `risk:high`, or `risk:critical` based on blast radius. Higher risk levels require additional evidence (rollback plan, CDK diff, staging verification, leadership approval). See [RELEASE-GATES.md -- Section 3](./RELEASE-GATES.md#3-change-risk-annotation) for criteria and requirements per level.

### Gate Override

A gate may be overridden only when all of these conditions are met:

1. The override is documented in the release issue/PR with the specific gate ID being overridden and the justification.
2. A second team member (or leadership) explicitly approves the override.
3. A follow-up issue is created to remediate the skipped gate within 7 days.
4. The override is noted in the release notes.

Gate overrides for CI automated gates (G1-G4) require disabling branch protection and are strongly discouraged.

**Sub-issue**: #266

---

## 4. Cost Governance KPI Cadence

**Principle**: Cost is a first-class operational metric, reviewed on a defined cadence with escalation thresholds.

### Cadence

| Frequency | Activity | Owner | Source |
|-----------|----------|-------|--------|
| **Daily** | Automated cost + activity report generated. | CI (GitHub Actions) | [OPERATIONS-REPORTS.md](./OPERATIONS-REPORTS.md) |
| **Daily** | Signal evaluation: cost jump, cost-per-message jump, spend-rise-activity-flat, projected month-end breach. | Automated | [COST-CONTROLS-PLAYBOOK.md](./COST-CONTROLS-PLAYBOOK.md) |
| **Weekly** | Review cost trends in leadership scorecard. Act on any COST or RELIABILITY recommendations. | Leadership | [LEADERSHIP-SCORECARD.md](./LEADERSHIP-SCORECARD.md) |
| **Monthly** | Budget vs. actual reconciliation. Update `MONTHLY_BUDGET_USD` if needed. Evaluate unit cost assumptions. | Leadership | AWS Cost Explorer + report JSON |
| **Quarterly** | Review portfolio cost allocation. Decide whether to adjust tier pricing or infrastructure sizing. | Leadership | Billing strategy review vs. [BILLING-STRATEGY.md](./BILLING-STRATEGY.md) |

### Escalation Thresholds

| Signal | Threshold | Response | Playbook |
|--------|-----------|----------|----------|
| Day-over-day AWS cost jump | >= 30% AND >= $15 absolute | Fast triage within 15 min | [COST-CONTROLS-PLAYBOOK.md](./COST-CONTROLS-PLAYBOOK.md) section 2 |
| Cost per message spike | >= 2x vs. 7-day baseline | Investigate top avatars | [COST-CONTROLS-PLAYBOOK.md](./COST-CONTROLS-PLAYBOOK.md) section 2 |
| Projected month-end breach | >= 20% over budget | Containment action | [COST-CONTROLS-PLAYBOOK.md](./COST-CONTROLS-PLAYBOOK.md) section 3 |
| AWS Budget alarm fires | Budget threshold crossed | Review CDK budget guardrails | `packages/infra/` budget construct |

### KPIs

| KPI | Target | Measurement |
|-----|--------|-------------|
| Cost per active avatar per day | Track trend (no fixed target pre-scale) | `awsCost.totalUsd / usage.activeAvatarCount` from daily report |
| Cost per message | Track trend | `awsCost.totalUsd / usage.totals.messagesProcessed` |
| Infrastructure baseline cost (zero-activity) | Minimize; track monthly | AWS cost on zero-traffic days |
| Orphaned secret count | 0 | `cleanup-orphaned-secrets.ts` dry run |

**Sub-issue**: #267

---

## 5. Security Exception Governance

**Principle**: Security exceptions are temporary, tracked, and expire. No permanent waivers.

### Rules

| Rule | Description |
|------|-------------|
| S1. Every exception has an expiry date. | Enforced by the exception registry schema (`.audit-exceptions.schema.json`). |
| S2. Exceptions are reviewed weekly. | `security-exceptions.yml` runs every Monday at 09:00 UTC. |
| S3. Expired exceptions create blocking issues. | Automated: the workflow creates `type:security` issues for expired entries. |
| S4. Exceptions approaching expiry (within 14 days) trigger warnings. | `--warn-days 14` flag in the validation script. |
| S5. New exceptions require a justification, an owner, and a remediation plan. | Documented in the exception entry per the schema. |
| S6. Exception count is tracked as a scorecard metric. | Cross-referenced in weekly triage. |

### Exception Lifecycle

```
Request --> Review --> Approve (with expiry) --> Registry --> Weekly check --> Renew or Remediate
```

1. **Request**: Open a `type:security` issue with the exception details, justification, and proposed expiry.
2. **Review**: Security-aware reviewer validates the risk assessment.
3. **Approve**: Exception is added to the registry with an expiry date.
4. **Monitor**: Weekly workflow validates all exceptions.
5. **Expire**: On expiry, a blocking issue is auto-created. The exception must be remediated or renewed with a new justification.

See also: [SECURITY.md -- Document Exceptions](./SECURITY.md), [DATA-RETENTION-MATRIX.md -- Retention Exception Requests](./DATA-RETENTION-MATRIX.md).

**Sub-issue**: #268

---

## 6. Leadership Operating Metrics and Portfolio Allocation

**Principle**: Leadership decisions are driven by metrics, not intuition. Portfolio allocation follows explicit rules.

### Weekly Operating Cadence

| Day | Activity | Owner | Inputs |
|-----|----------|-------|--------|
| **Monday 08:00 UTC** | Leadership scorecard generated. | Automated | `.github/workflows/leadership-scorecard.yml` |
| **Monday 09:00 UTC** | Security exception review generated. | Automated | `.github/workflows/security-exceptions.yml` |
| **Monday 09:00 UTC** | Ticket health report generated. | Automated | `.github/workflows/ticket-health.yml` |
| **Monday (triage)** | Triage review. Review scorecard, exception report, and ticket health. Reprioritize backlog. | Leadership | [ISSUE-GOVERNANCE.md](./ISSUE-GOVERNANCE.md), [LEADERSHIP-SCORECARD.md](./LEADERSHIP-SCORECARD.md) |
| **Daily 06:20 UTC** | Cost + activity report generated. | Automated | [OPERATIONS-REPORTS.md](./OPERATIONS-REPORTS.md) |
| **Quarterly (Jan, Apr, Jul, Oct)** | Privileged access review. | Automated + reviewer | [ACCESS-REVIEW.md](./ACCESS-REVIEW.md) |

### Operating Metrics

These metrics are reviewed weekly. Thresholds drive action, not just awareness.

| Metric | Source | Threshold | Action on Breach |
|--------|--------|-----------|-----------------|
| Health grade | Scorecard | RED | Block new feature starts. Focus on reliability/security. |
| Lambda error rate | CloudWatch via scorecard | >5% | Incident response per [RUNBOOK.md](./RUNBOOK.md). |
| DLQ depth | CloudWatch via scorecard | >0 | DLQ triage per [RUNBOOK.md](./RUNBOOK.md). |
| CI failure rate | Scorecard | >20% | Create issue to fix CI. Block new PRs if >50%. |
| Stale issue percentage | Scorecard | >25% | Apply aging policy per [ISSUE-GOVERNANCE.md](./ISSUE-GOVERNANCE.md). |
| Unassigned high-priority issues | Scorecard | >0 | Assign immediately during triage. |
| In-progress issues | Scorecard | >WIP cap (8) | Enforce overflow protocol (section 2). |
| Security exception count | Exception workflow | >0 approaching expiry | Prioritize remediation. |
| Cost trend | Daily report | Any triggered signal | Follow [COST-CONTROLS-PLAYBOOK.md](./COST-CONTROLS-PLAYBOOK.md). |

### Portfolio Allocation Rules

Allocation targets for engineering effort across categories. Reviewed monthly and adjusted based on milestone phase.

| Category | Target Allocation | Rationale |
|----------|------------------|-----------|
| **Reliability + Security** | >= 30% | Non-negotiable floor. Platform trust is the foundation. |
| **Feature Delivery** | 40-50% | Primary growth driver. Adjusted per milestone. |
| **Tech Debt + Quality** | 10-20% | Prevents compounding maintenance burden. |
| **Operational Tooling** | 5-10% | CI/CD, monitoring, developer experience. |

Rules:
- If the scorecard health grade is RED, reallocate feature delivery capacity to reliability until YELLOW is restored.
- If stale issue percentage exceeds 25%, allocate one sprint slot to backlog grooming.
- Portfolio allocation is reviewed at the start of each milestone (M2, M3, M4).

**Sub-issue**: #269

---

## Agent Behavior Constraints

These rules apply to all coding agents (Copilot, Claude Code workers, worktree subagents) and are enforced through issue templates, workflow checks, and pre-commit hooks.

| Constraint | Mechanism |
|------------|-----------|
| Agents must not start work on issues without acceptance criteria. | Issue templates require `acceptance-criteria` field ([ISSUE-GOVERNANCE.md](./ISSUE-GOVERNANCE.md)). |
| Agents must not merge PRs that fail CI. | Branch protection on `main` requires CI pass. |
| Agents must not introduce high/critical CVEs. | `pnpm audit --audit-level=high` in CI. |
| Agents must not exceed scope boundaries defined in the issue. | Scope boundaries field in issue templates. |
| Agent worktrees must be registered via `worktree-start.sh`. | Documented in `CLAUDE.md` worktree lifecycle hooks. |
| Agents must follow conventional commits with scope. | Pre-commit lint hook. |
| Agents must not deploy directly. | All deploys go through GitHub Actions (`deploy.yml`). |
| Agents must not commit secrets. | Pre-commit checks + structured logging policy ([SECURE-LOGGING.md](./SECURE-LOGGING.md)). |

---

## Cross-References

| Topic | Location |
|-------|----------|
| Release gates, rollback readiness, change-risk annotation | [RELEASE-GATES.md](./RELEASE-GATES.md) |
| Issue triage and priority criteria | [ISSUE-GOVERNANCE.md](./ISSUE-GOVERNANCE.md) |
| Leadership scorecard metrics and thresholds | [LEADERSHIP-SCORECARD.md](./LEADERSHIP-SCORECARD.md) |
| Incident response and DLQ recovery | [RUNBOOK.md](./RUNBOOK.md) |
| Monitoring and alarm triage | [MONITORING-OPERATOR-GUIDE.md](./MONITORING-OPERATOR-GUIDE.md) |
| Cost anomaly triage and containment | [COST-CONTROLS-PLAYBOOK.md](./COST-CONTROLS-PLAYBOOK.md) |
| Daily cost and activity reports | [OPERATIONS-REPORTS.md](./OPERATIONS-REPORTS.md) |
| Security policy and dependency audits | [SECURITY.md](./SECURITY.md) |
| Privileged access review | [ACCESS-REVIEW.md](./ACCESS-REVIEW.md) |
| Data retention and deletion controls | [DATA-RETENTION-MATRIX.md](./DATA-RETENTION-MATRIX.md) |
| Security exception registry | [`.github/workflows/security-exceptions.yml`](../.github/workflows/security-exceptions.yml) |
| Production deployment checklist | [PRODUCTION-DEPLOYMENT-CHECKLIST.md](./PRODUCTION-DEPLOYMENT-CHECKLIST.md) |
| Billing strategy | [BILLING-STRATEGY.md](./BILLING-STRATEGY.md) |
| Commit conventions and dev workflow | [`CLAUDE.md`](../CLAUDE.md) |
| M2 roadmap | [ROADMAP-M2-MULTI-PLATFORM.md](./ROADMAP-M2-MULTI-PLATFORM.md) |
| GTM strategy | [GTM-STRATEGY-M2.md](./GTM-STRATEGY-M2.md) |

---

*Last updated: 2026-02-23*
