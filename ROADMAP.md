# AWS Swarm Roadmap

This roadmap focuses on product and platform milestones.

**Last reviewed:** 2026-02-20

## Current focus (early Feb 2026)
- **M1 is complete (v1.0.1).** All items shipped: auth/onboarding, entitlements, energy unification, Orb-holder auto-boost, ascension→Pro, memory delete/export/TTL, deploy audit logging, correlation IDs, CloudWatch dashboards/alarms, Telegram canary, smoke tests, operational runbook.
- Focus shifting to M2 planning and operational hardening.
- See [docs/BILLING-STRATEGY.md](docs/BILLING-STRATEGY.md) for the unified web3+web2 billing model.

For the execution-level active plan, see:
- [PLAN.md](PLAN.md)

Historical M1 execution reference:
- [docs/ROADMAP-M1-PAID-TELEGRAM-MVP.md](docs/ROADMAP-M1-PAID-TELEGRAM-MVP.md)

## Near (0-3 months)
Milestone M1: Paid Telegram MVP
- ~~Billing and entitlements with runtime enforcement.~~ **Done.** Manual entitlements + atomic enforcement + Orb-holder auto-boost + energy as burst pool.
- ~~Memory opt-in with retention and management.~~ **Done.** Schema, gating, retention TTL, delete, and export endpoints shipped.
- ~~Deploy or activate from admin UI and API.~~ **Done.** Readiness gates + activation endpoints + audit logging shipped.
- ~~Authentication improvements (wallet + Crossmint).~~ **Done.** Full onboarding overhaul (SWARM-011 through SWARM-020).
- ~~Structured logging with correlation IDs.~~ **Done.** Correlation ID propagation across webhook→SQS→handler chain. CloudWatch dashboards and ops dashboard shipped.
- ~~End-to-end Telegram canary and operational runbook.~~ **Done.** Canary script, smoke tests (20 tests), and operational runbook shipped.

## Medium (3-9 months)
Milestone M2: Multi-platform parity
- Discord and X adapters reach feature parity with Telegram.
- Unified tool registry shared across admin API and handlers.
- Usage metering surfaced in admin UI.
- SQS payload offload for large media and DLQ management.

## Far (9-18 months)
Milestone M3: Persistent swarm platform
- Multi-avatar coordination and cross-avatar policies.
- Durable memory tiers (ephemeral, durable, archival) with export and delete.
- Marketplace-ready templates and persona packs.
- SaaS reliability and cost optimization for scale.

Strategic PRDs:
- [docs/PRD-M3-PERSISTENT-SWARM-PLATFORM.md](docs/PRD-M3-PERSISTENT-SWARM-PLATFORM.md)
- [docs/PRD-M4-ECOSYSTEM-AUTONOMOUS-OPERATIONS.md](docs/PRD-M4-ECOSYSTEM-AUTONOMOUS-OPERATIONS.md)

## Legacy
Prior planning snapshots are intentionally not kept as separate files; use git history for older iterations.
