# AWS Swarm Plan: Next Milestone (M2 Multi-Platform Hardening)

Goal: deliver a stable post-M1 platform with reliable admin UX, complete account identity
flows, and production-grade multi-platform parity (Telegram, X, Discord, Web).

**Last reviewed:** 2026-02-20

## Milestone definition
- Critical admin chat surfaces are reliable and test-covered (plan/usage, preview, auth flows).
- Account identity model is fully usable in UI (including linking additional wallets).
- Memory retrieval quality improves through semantic retrieval integration.
- Platform parity gaps are tracked and executed with production hardening criteria.
- Backlog and execution tracking are GitHub-first (issues, milestones, project statuses).

## Current execution queue

### In flight
- [ ] `#167` parent tracker for wallet-link UX completion.
- [ ] `#181` expose wallet-link flow in admin UI.
- [ ] `#182` add wallet-link integration/regression coverage.
- [ ] `#180` fix media URL handling when `CDN_URL` is unset in split stacks.

### Next to schedule (M2 core)
- [ ] `#183` semantic search integration into memory retrieval path.
- [ ] `#184` Discord production hardening beyond base adapter coverage.
- [ ] `#185` X/Twitter parity hardening for remaining functionality gaps.

## Workstreams

### 1) Admin UX reliability
- Keep chat-first interaction model while removing dead or confusing surfaces.
- Add component/integration tests for high-traffic UI panels to prevent regressions.
- Ensure API error paths always return user-actionable failures.

### 2) Identity and account UX
- Expose full link-vs-switch behavior in UI.
- Surface linked identities and account-level gating state clearly.
- Enforce conflict-safe flows for multi-wallet users.

### 3) Memory relevance
- Integrate semantic retrieval into main memory query path.
- Add benchmarks and regression tests for retrieval quality and latency.

### 4) Platform parity and runtime hardening
- Track parity as concrete capability matrix, not a broad theme.
- Close remaining reliability/operational gaps per adapter (rate limits, diagnostics, tests).
- Keep queue-based runtime behavior deterministic and observable.

### 5) Operational posture
- Keep dependency/security baseline green in CI.
- Maintain issue/PR lifecycle automation and project drift reconciliation.
- Keep runbooks aligned with currently deployed behavior.

## Not in this milestone
- Marketplace templates and persona packs.
- Large speculative protocol redesigns.
- Step Functions runtime re-architecture.

## References
- `ROADMAP.md`
- `docs/BILLING-STRATEGY.md`
- `docs/AUTHENTICATION-IMPROVEMENTS.md`
- `issues/README.md`
