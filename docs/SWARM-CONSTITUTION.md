# Swarm Constitution: Recoverable Compositional Legitimacy

> Design every subsystem so that a stranger could later determine not only
> what happened, but why it was allowed to count.

This document defines the constitutional architecture for the aws-swarm
platform. It establishes the principles that govern how agents compose, how
state is managed, and how the system maintains coherence under delay,
disagreement, partial knowledge, and repair.

These principles are aspirational targets — the system will grow into them
incrementally. Each principle notes where the current codebase already aligns
and where gaps remain.

---

## Core Premise

A swarm is not "many agents doing things." A swarm is a system where local
actions must remain globally admissible under delay, disagreement, partial
knowledge, and repair.

The architecture optimizes for: **composability, auditability, checkpointed
legitimacy, and structured repair.**

---

## Architectural Decisions

These five decisions were resolved before the type skeleton was written. They
govern how the principles map to concrete implementation.

### Key Definitions

Before the decisions, a shared glossary:

- **correlationId / traceId** — request/thread tracing across services.
  Maps to `SwarmEnvelope.traceId`.
- **causationId** — the immediately preceding constitutional act.
- **lineageId** — the long-running chain this act belongs to.
- **branchId** — a divergent sub-lineage with merge/expiry semantics.
  Reserved for Phase 4; not used in Phase 1.
- **checkpointId** — a ratified snapshot/finality marker.
- **projection** — a derived operational view built from accepted history.
  It is useful, fast, mutable, and non-authoritative. `ChannelState` is
  already a projection.
- **invariant** — a structural rule that must always hold for the system to
  remain coherent. Violation is a system error.
- **policy** — a contingent rule that may vary by avatar, environment, or
  mode. Violation is a rejection, not a system error.

One sentence that protects the architecture:

> `SwarmEnvelope` is an ingress/transport normalization object, not itself a
> constitutional record. Transitions are the constitutional record.
> `ChannelState` is a projection — useful and operational, but not the
> constitutional truth source. Operational tables remain writable
> implementation surfaces; constitutional legitimacy derives only from
> ledgered transitions and their associated decisions.

### Decision 1: Two-Tier Transition Granularity

Not every mutation is a constitutional event.

**Tier A — Constitutional transitions** enter the audit history as first-class
records. These are domain-significant acts:

- State machine changes
- Message commits
- Tool execution requests and results
- Branch/fork creation
- Merge/reconcile decisions
- Policy/adjudication decisions
- Checkpoint/finalization events
- Externally visible side effects

**Tier B — Storage mutations** are ordinary writes, correlated to a transition
ID but not themselves constitutional objects. A DynamoDB upsert is an
implementation detail; a transition is a domain claim.

**Test:** If a human debugging the swarm would care about this as a meaningful
system act, it is a transition. If only an infra engineer would care, it is a
write.

Every Tier A transition may produce several Tier B writes. Every Tier B write
that matters should reference its parent transition ID. Some Tier B writes are
purely operational and do not deserve first-class lineage.

### Decision 2: Split Adjudication

Adjudication is **inline first, deferred second**.

**Inline adjudication** runs in the same SQS consumer that handles the
proposal/result:

- Schema validation
- Invariant checks that only need local state
- Auth/policy checks
- Idempotency
- Status progression validity
- Envelope completeness

**Deferred adjudication** runs asynchronously for heavier or cross-cutting
checks:

- Merge resolution
- Conflict reconciliation
- Cross-message consistency
- Checkpoint creation
- Quorum/corroboration logic
- Replay-driven repair

The deferred layer is another SQS queue plus Lambda consumer, or a stream
processor over append-only events.

**Primary adjudication is NOT placed in DynamoDB Streams.** Streams are good
for projection and aftermath, but acceptance must be an explicit act in the
application flow, not an emergent side effect of persistence.

Flow: `proposal enters SQS consumer -> inline adjudication -> append decision
+ event -> projections update -> optional deferred reconciler`

### Decision 3: DynamoDB-Backed Append-Only History

Start with **DynamoDB as the system of record plus Streams as the
projection/repair feed**.

A dedicated append-only event table in DynamoDB provides:

- Explicit event IDs
- Transition IDs
- Lineage
- Replayable history
- Checkpoint records
- Decision records

DynamoDB Streams from that event table drive:

- Projection building
- Deferred adjudication triggers
- Repair/reconciliation workers

**Avoid for now:** EventBridge (weak as constitutional ledger) and Kinesis
(operational surface too early). The main win needed first is **typed
admissible history**, not perfect stream theology.

Design the ledger interface so storage can swap later:

```typescript
interface TransitionLedger {
  append(event: TransitionEvent): Promise<AppendResult>;
  getByTransition(id: string): Promise<TransitionEvent[]>;
  getLineage(rootId: string): Promise<TransitionEvent[]>;
  createCheckpoint(input: CheckpointRequest): Promise<CheckpointRecord>;
}
```

### Decision 4: Selective Envelope Weight

Not every domain object gets a maximal envelope. Three classes:

**Full envelope** — for constitutional records: proposals, accepted decisions,
tool execution records, message commits, state transitions, checkpoints, repair
actions. Carries provenance, correlationId, causationId, lineage/root IDs,
schema version, timestamp, confidence, scope/authority, status.

**Lite envelope** — for high-volume operational objects: observations,
intermediate tool chunks, derived projection updates, ephemeral coordination
records. Carries only correlationId, causationId, schema version, timestamp,
and optionally a provenance reference.

**Reference envelope** — for large payloads or repeated metadata: store the
heavy provenance/lineage once and point to it.

**Rule:** Full envelopes on acts that may later need justification. Lite
envelopes on acts that only need traceability.

### Decision 5: Status Ladder on Claims and Results

The status ladder applies to **adjudicable claims and outcomes that compete for
legitimacy**, not every entity uniformly.

Applies to:
- Messages when they are meaningful swarm acts (not raw transport)
- Tool executions/results
- Transition proposals
- State transitions
- Decisions/checkpoints

Does NOT apply to:
- Raw storage rows
- Caches
- Internal DTOs
- Transport-level message objects

A status ladder is about **admissibility**, not mere existence.

---

## The 15 Principles

### 1. Every Action Is a Typed State Transition

Agents should not "do work." They should propose or execute transitions from
one explicit state to another.

- All important mutations have declared preconditions.
- All outputs declare what changed.
- Transitions are machine-checkable.
- Side effects are wrapped, not smeared through business logic.

**Current state:** `ChannelState` has a state machine (`IDLE -> ACTIVE ->
COOLDOWN`). Most other mutations are imperative DynamoDB writes without
declared pre/postconditions.

**Target:** A `Transition<I, O, Ctx>` primitive with `precondition`, `execute`,
`postcondition`, and `effects` fields. Only Tier A (domain-significant)
mutations become typed transitions.

---

### 2. Separate Execution from Adjudication

Never let the same component both act and decide whether its own action counts.

**Execution layer** — fast, local, optimistic, specialized agents.
**Adjudication layer** — slower, invariant-checking, conflict-resolving,
legitimacy-granting.

- Worker agents produce candidates.
- Validators check policy, schema, dependencies, consistency.
- Reconcilers decide whether to merge, retry, fork, or reject.

**Current state:** `MessageProcessor` both evaluates response triggers and
executes LLM calls — it acts and adjudicates in the same pipeline.

**Target:** Inline adjudication for cheap deterministic checks in the SQS
consumer. Deferred adjudication for cross-cutting concerns via a separate
queue/processor.

---

### 3. Treat Accepted History as Append-Only

Do not model the swarm as "current mutable truth." Model it as:

- Event log
- Checkpoints
- Derived views

This gives replayability, rollback by compensation (not deletion), forensic
debugging, and alternate interpretations from the same base history.

**Current state:** DynamoDB stores mutable current state. Audit logging exists
but is not structured as a replayable event log.

**Target:** A dedicated DynamoDB append-only event table alongside operational
tables. Streams feed projections and deferred adjudication. The ledger
interface abstracts storage so backends can swap later.

---

### 4. Local Knowledge Is Allowed; Global Claims Are Earned

Any agent can hold a partial view. Very few components should assert global
truth.

- Label outputs with provenance and confidence.
- Distinguish `local_observation` from `global_commit`.
- Require aggregation before system-wide consequences.

**Status ladder** (applies to adjudicable claims/results, not every object):

```
observed -> proposed -> accepted -> finalized
```

Plus terminal states: `rejected`, `superseded`, `quarantined`.

`corroborated` is defined conceptually (multi-source agreement) but omitted
from Phase 1 runtime types. It enters when multi-source evidence or quorum
logic exists.

**Current state:** `SwarmEnvelope` carries provenance (sender, platform,
traceId). No formal status ladder for claims.

---

### 5. Make Interpretation Explicit

Most swarm failures are semantic drift — different agents using the same words
for different things.

- Define canonical domain vocabulary.
- Use schemas for intents, tasks, claims, evidence, decisions.
- Version contracts between agent classes.
- Build translation adapters as first-class modules.

**Current state:** Platform adapters normalize messages to `SwarmEnvelope` —
this is good. Tool definitions have typed schemas. But inter-agent
communication relies on free-form LLM context.

---

### 6. Build Around Invariants, Not Workflows

Workflows change. Invariants are the real constitution.

Examples:
- Every committed task has exactly one responsible lineage.
- No resource allocation exceeds policy limits.
- Every final decision traces back to evidence.
- Every externally visible action is attributable.
- Every fork must have a merge, expiry, or explicit abandonment rule.

Code these invariants centrally and ruthlessly.

**Current state:** Some invariants exist (idempotency keys, per-avatar
isolation, rate limits) but are scattered through handler code rather than
declared centrally.

---

### 7. Forks Are Normal; Undefined Forks Are Fatal

Disagreement is not failure. Untracked divergence is failure.

Allow: branch-specific plans, competing hypotheses, speculative execution,
sandboxed alternatives.

Require: branch identity, parent lineage, merge criteria, expiration
conditions, winner-selection or coexistence rules.

**Current state:** No fork/branch semantics exist. Each message is processed
independently.

---

### 8. Repair Is a First-Class Operation

Do not treat reconciliation as an edge case.

Design explicit repair operators:
- Retry, compensate, merge, supersede
- Quarantine, escalate
- Invalidate checkpoint, rebuild projection from log

Every critical subsystem should answer: "How does this fail gracefully without
pretending it never happened?"

**Current state:** DLQ exists for failed messages. Circuit breaker in
`circuit-breaker.ts`. But no structured compensation or replay operators.

---

### 9. Authority Must Be Compositional

Avoid god-agents. Instead of a single all-powerful orchestrator, define narrow
forms of authority:

- Planning authority
- Validation authority
- Scheduling authority
- Policy authority
- Commit authority
- Emergency stop authority

Each authority should have explicit jurisdiction, emit signed decisions, be
reviewable, and be replaceable without collapsing the whole system.

**Current state:** The Lambda handler pipeline is the single authority. Avatar
config controls tool availability, which is a primitive form of scoped
authority.

---

### 10. Every Important Decision Needs a Proof Object

For any ratified action, preserve:
- Who proposed it
- What evidence supported it
- What policies/invariants were checked
- What alternatives were rejected
- What made it admissible now

**Current state:** Audit logging captures who/what/when. No structured
`DecisionRecord` with evidence, checks, and rationale.

---

### 11. Use Monotonic Data Where Possible

Prefer models where new information refines prior state instead of invalidating
it.

Good candidates: sets of facts, evidence accumulation, status promotion
ladders, append-only observations, derived commitments from stable predicates.

Use destructive overwrite only where truly necessary.

**Current state:** `ChannelState.recentMessages` is a sliding window (not
monotonic). `fact-store.ts` exists — worth examining for monotonic patterns.

---

### 12. Distinguish Soft Consensus from Hard Finality

Not everything needs the same level of commitment.

| Level | Meaning |
|-------|---------|
| **Soft consensus** | Enough agreement to continue locally |
| **Operational commit** | Enough agreement to trigger dependent work |
| **Hard finality** | Irreversible or externally binding |

This prevents over-coordination and under-legitimation.

**Current state:** All state transitions are treated uniformly. No tiered
commitment model.

---

### 13. Make Failure Domains Small and Named

Partition the system so damage stays local.

Good boundaries: per mission, per workspace, per resource class, per agent
cohort, per branch/checkpoint lineage.

Each boundary should support isolation, kill switch, replay, and repair without
global halt.

**Current state:** Multi-tenant isolation by `avatarId` is strong. Per-channel
state isolation exists. But no mission-level or branch-level failure domains.

---

### 14. Observability Must Follow Lineage, Not Just Services

You need to answer:
- What chain of proposals produced this act?
- Which branch did it come from?
- Which checkpoint ratified it?
- What evidence was available then?
- What repair path followed failure?

Trace: transition lineage, agent causality, branch ancestry, checkpoint
adoption, decision proofs.

**Current state:** Correlation IDs (`traceId`) thread through webhook -> SQS ->
processor -> sender. Structured JSON logging exists. But no lineage-aware
tracing beyond request correlation.

---

### 15. Policies Belong in Declarative Form

Do not bury the constitution in imperative code.

Keep policies: versioned, inspectable, testable, hot-swappable where safe,
separable from execution code.

Examples: authorization rules, merge criteria, escalation thresholds, budget
limits, trust weights, finalization conditions.

**Current state:** Entitlement rules, rate limits, and tool availability are
configured per-avatar but enforced imperatively in handler code. Not
introspectable as standalone policy objects.

---

## Compact Maxims

- No mutation without a named transition.
- No transition without provenance.
- No global claim without adjudication.
- No fork without lineage.
- No commit without invariant checks.
- No finality without checkpoint semantics.
- No failure without a repair path.
- No authority without jurisdiction.
- No policy hidden in glue code.
- No history rewritten — only superseded.

---

## Target Module Layout

```
/swarm
  /domain
    types/           # Transition, Envelope, DecisionRecord, PolicyRule
    invariants/      # Centrally declared system invariants
    transitions/     # Named state transitions with pre/postconditions
    policies/        # Declarative policy definitions
  /agents
    planner/         # Planning authority
    executor/        # Execution layer
    observer/        # Observation and evidence gathering
    critic/          # Validation authority
    reconciler/      # Fork/merge resolution
    governor/        # Emergency stop, escalation
  /protocols
    task_protocol/   # Task lifecycle
    commit_protocol/ # Checkpoint and finalization
    fork_merge/      # Branch management
    escalation/      # Escalation paths
  /ledger
    event_store/     # Append-only event log (DynamoDB table)
    checkpoint/      # Checkpoint snapshots
    decisions/       # Decision records with proofs
    projections/     # Materialized views from Streams
  /adjudication
    inline/          # Schema, invariant, policy checks (in-consumer)
    deferred/        # Cross-cutting reconciliation (separate queue)
    finalizers/      # Finalization logic
  /repair
    compensators/    # Compensation transactions
    replayers/       # Event log replay
    quarantines/     # Isolation of failed state
    rewriters/       # Branch rewriting
  /telemetry
    lineage/         # Transition and decision lineage
    audit/           # Audit trail
    traces/          # Distributed tracing
    health/          # Health checks
  /interfaces
    api/             # External API surface
    cli/             # CLI tools
    connectors/      # Platform adapters (existing)
```

---

## Agent Interface

Every agent implements:

```typescript
interface SwarmAgent {
  id: string
  role: string
  observe(input: ObservationEnvelope): Promise<Proposal[]>
  act(proposal: AcceptedProposal): Promise<TransitionResult[]>
  explain(ref: string): Promise<Explanation>
}
```

No agent directly mutates shared truth. They emit observations, proposals,
evidence, and transition results. The adjudication layer ratifies.

---

## The Constitutional Loop

Every serious swarm operation passes through this cycle:

1. **Observe** — gather evidence
2. **Propose** — emit candidate transition
3. **Validate** — inline adjudication (cheap checks in consumer)
4. **Fork or merge** — handle divergence (deferred if cross-cutting)
5. **Commit** — append to ledger at appropriate checkpoint tier
6. **Project** — materialize to operational DynamoDB tables
7. **Monitor** — watch invariants
8. **Repair** — compensate when violated

---

## Implementation Consequences

### 1. Selective envelopes, not universal wrappers

Full envelopes on constitutional records (proposals, decisions, tool
executions, state transitions, checkpoints, repairs). Lite envelopes on
high-volume operational objects. Reference envelopes for large payloads.

`SwarmEnvelope` already does this for messages. Extend the pattern selectively
— not universally.

### 2. The "database" is really two systems

- A dedicated DynamoDB append-only event table (constitutional source of truth)
- Existing DynamoDB operational tables (derived projections for speed)

DynamoDB Streams connects them. The ledger interface abstracts storage so
backends can migrate later if volume demands it.

### 3. The hardest code is not agent logic

It is: schema evolution, invariant enforcement, branch management,
replay/repair, policy versioning, checkpoint semantics. That is where the true
architecture lives.

---

## Incremental Adoption Path

This constitution does not require a rewrite. The existing codebase can grow
into it:

1. **Phase 0 (now):** Establish types and interfaces. No runtime changes.
2. **Phase 1:** Wrap domain-significant mutations (Tier A) in `Transition`
   objects. Add `DecisionRecord` to audit logging. Introduce inline
   adjudication checks alongside existing validation.
3. **Phase 2:** Extract policies from handler code into declarative form.
   Add status ladder to adjudicable domain objects.
4. **Phase 3:** Deploy dedicated DynamoDB event table. Build projections via
   Streams. Introduce deferred adjudication queue.
5. **Phase 4:** Implement fork/merge semantics for multi-agent coordination.
   Add repair operators.

Each phase delivers standalone value without requiring completion of later
phases.

---

## Type Skeleton Families

The companion TypeScript skeleton (`packages/core/src/types/constitution.ts`)
will define these top-level type families:

- **Envelope types:** `FullEnvelope`, `LiteEnvelope`, `EnvelopeRef`
- **Transition types:** `TransitionKind`, `TransitionProposal`,
  `AcceptedTransition`, `FinalizedTransition`
- **Storage types:** `StorageMutationMeta` (Tier B correlation)
- **Decision types:** `DecisionRecord` with evidence and checks
- **Checkpoint types:** `CheckpointRecord`
- **Adjudicable interface:** shared `Status` and `Adjudicable` base
- **Ledger interface:** `TransitionLedger` (storage-agnostic)
- **Repair types:** `RepairAction`, `CompensationRecord`
- **Policy types:** `PolicyRule`, `InvariantCheck`, `AuthorityScope`

---

*This document is the constitutional reference for swarm architecture
decisions. The companion TypeScript skeleton
(`packages/core/src/types/constitution.ts`) will provide the concrete type
definitions.*
