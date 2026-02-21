# M2 Multi-Platform Execution Playbook

**Status:** Active execution guide

**Last reviewed:** 2026-02-21

**Primary roadmap:** [ROADMAP-M2-MULTI-PLATFORM.md](ROADMAP-M2-MULTI-PLATFORM.md)

This playbook turns the M2 roadmap into an execution loop with clear ownership, quality gates, and rollback criteria.

---

## 1) Scope and Outcomes

This playbook covers M2 work across:
- platform parity (Telegram, Discord, X/Twitter),
- tool registry/runtime integration,
- semantic memory retrieval operational hardening (wiring shipped; see [SEMANTIC-MEMORY-DESIGN.md](SEMANTIC-MEMORY-DESIGN.md)),
- usage metering and billing foundations,
- SQS offload and DLQ operations.

Expected outcomes:
1. Platform changes ship in small slices with explicit entry/exit gates.
2. Operational regressions are caught before broad rollout.
3. Semantic retrieval is production-hardened with embedding coverage tracking, a benchmark harness, and regression tests -- without regressing latency budgets.
4. Each completed M2 task has an evidence pack that can be audited.

---

## 2) Workstream Ownership

Use four lanes in parallel:

| Lane | Primary backlog IDs | Owner package focus | Exit condition |
|---|---|---|---|
| Platform parity | M2-001, M2-002, M2-020..M2-029, M2-048..M2-050, M2-053 | `core`, `handlers`, `infra` | Discord and X parity gaps closed or explicitly deferred with decision log |
| Runtime plumbing | M2-003..M2-008, M2-040..M2-047, M2-051 | `handlers`, `core`, `mcp-server`, `admin-api` | Shared registry/runtime wiring is complete and DLQ tooling is operational |
| Memory relevance | M2-054..M2-056 | `admin-api`, `core`, `infra`, `docs` | Embedding coverage is tracked and automated, benchmark harness validates relevance/latency, and regression suite guards ranking stability |
| Billing and metering | M2-010..M2-019, M2-030..M2-031, M2-044, M2-052 | `infra`, `handlers`, `admin-api`, `mcp-server` | Usage visibility and entitlement sync are production-ready |

---

## 3) Weekly Operating Cadence

### Monday: commit queue and risk review
1. Confirm top 3-5 tasks by dependency order from `ROADMAP-M2-MULTI-PLATFORM.md`.
2. Mark each task as one of: `ready`, `blocked`, `at-risk`.
3. Capture unblock actions and owners in the PR/issue thread.

### Daily: small-slice merge cycle
1. Keep changes package-scoped and test in smallest meaningful scope first.
2. Require runnable repro + validation commands in each PR description.
3. If a change touches runtime handlers, include log evidence from staging.

### Wednesday: integration checkpoint
1. Run a cross-lane pass in staging:
   - direct API check: `./scripts/test-api.sh staging chat '{"message":"debug","history":[]}'`
   - log scan: `./scripts/avatar-logs.sh staging <avatarId> --since 2h --level ERROR`
2. Confirm no unresolved P1/P2 incidents before continuing rollout.

### Friday: release gate review
1. Validate all completed tasks include an evidence pack.
2. Verify rollback path exists for every new runtime-facing change.
3. Promote only slices that pass all required gates in section 4.

---

## 4) Readiness Gates (Per Slice)

Every M2 slice must pass all applicable gates before merge.

| Gate ID | Applies to | Pass criteria | Evidence |
|---|---|---|---|
| `gate.build.green` | All | `pnpm build`, `pnpm lint`, `pnpm typecheck` succeed in current branch | Command output summary in PR |
| `gate.tests.targeted` | All code changes | Smallest meaningful tests pass first (single file/package where possible) | Exact test command + result |
| `gate.runtime.ingest` | Adapter/runtime changes | Incoming platform messages are accepted and enqueued | Staging logs showing ingest path events |
| `gate.runtime.respond` | Adapter/runtime changes | Bot response path succeeds end-to-end | API check + logs with same request flow |
| `gate.tools.bridge` | MCP/registry changes | Tool is callable from intended context (admin/runtime) without fallback errors | Tool invocation transcript or test |
| `gate.memory.quality` | Memory retrieval changes | Embedding coverage >= 90% for affected avatars, MRR/nDCG does not regress on benchmark fixture set, and p95 retrieval latency remains within agreed budget | Benchmark before/after summary + coverage metric + targeted regression tests |
| `gate.usage.integrity` | Metering/billing changes | Usage counters and entitlement checks update consistently | Before/after usage output sample |
| `gate.ops.rollback` | Infra/runtime changes | Rollback command/procedure documented and tested in staging | Rollback steps + verification result |

---

## 5) Platform-Specific Go/No-Go Checklist

Run this checklist before enabling new behavior for a platform in production.

| Check | Telegram | Discord | X/Twitter |
|---|:---:|:---:|:---:|
| Adapter ingest path stable in staging | Y | Y | Y |
| Adapter send path stable in staging | Y | Y | Y |
| Platform-specific diagnostics available | `diagnose_telegram` | `discord_status` | `twitter_status` |
| Error rate acceptable in last 24h | Y | Y | Y |
| Rollback path documented | Y | Y | Y |

No-go triggers:
1. Any P1 incident unresolved in current platform path.
2. DLQ depth continuously rising for 30 minutes without operator explanation.
3. Reproducible authentication/integration failure with no safe workaround.

---

## 6) Incident Triage for M2 Rollouts

When a rollout fails, classify by failing path first:

| Failure path | First check | Primary script/command |
|---|---|---|
| Ingest failures | Are platform events reaching handler logs? | `./scripts/avatar-logs.sh staging <avatarId> --since 30m --level ERROR` |
| Tool/runtime failures | Is tool wiring broken or missing service adapter bridge? | Targeted package tests + tool invocation in staging |
| Queue backpressure | Are queues or DLQ growing and aging? | CloudWatch queue alarms + `inspect_dlq` once available |
| Billing/metering mismatch | Are counters and entitlement state drifting? | Admin API usage queries and entitlement logs |

Escalation:
1. P1/P2 incidents follow `docs/RUNBOOK.md`.
2. Open a linked issue with repro input, failing component, and rollback status.
3. Block new rollouts in the affected lane until root cause is confirmed.

---

## 7) Required Evidence Pack (Task Closure)

For each completed M2 task, capture:
1. Reproduction steps (command + payload).
2. Root cause files/functions touched.
3. Validation commands with short result summary.
4. Staging evidence (logs/API behavior) for runtime-facing changes.
5. Documentation/runbook updates, if behavior changed.

This matches the repository requirement for fix PR evidence and keeps M2 closure auditable.

---

## 8) Immediate Next Slices

Use this order unless dependencies force changes:
1. M2-003 + M2-004 (platform-MCP bridge completion),
2. M2-005..M2-008 (SQS offload baseline),
3. M2-054 + M2-055 + M2-056 (semantic retrieval hardening, benchmark harness, and regression coverage -- all three are independent and can run in parallel since wiring is shipped),
4. M2-017 + M2-018 + M2-019 (usage visibility backbone),
5. M2-040..M2-043 (DLQ operational tools),
6. Remaining platform parity gaps by highest user impact.

> **Note on memory lane:** The semantic retrieval path (`searchMemories`, `createMemory` with embedding generation, `backfill_embeddings` tool) is already live. M2-054..056 focus on operational hardening: production coverage metrics, automated backfill, a benchmark harness with MRR/nDCG scoring, and regression tests with latency budget assertions. See the [SEMANTIC-MEMORY-DESIGN.md](SEMANTIC-MEMORY-DESIGN.md) status update for implementation details.
