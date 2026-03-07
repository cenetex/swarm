/**
 * Constitutional types for the swarm framework.
 *
 * These types define the constitutional layer that sits above the existing
 * transport/operational types. They do NOT replace SwarmEnvelope, ChannelState,
 * or queue types — they extend the system with typed transitions, decision
 * records, and adjudication primitives.
 *
 * Key architectural rule:
 *   SwarmEnvelope is an ingress/transport normalization object, not itself
 *   a constitutional record. Transitions are the constitutional record.
 *   ChannelState is a projection — useful, fast, mutable, non-authoritative.
 *
 * See docs/SWARM-CONSTITUTION.md for the full manifesto.
 *
 * @module constitution
 */

import type { Platform } from './platform.js';

// =============================================================================
// GLOSSARY
//
// correlationId / traceId — request/thread tracing across services.
//                           Maps to SwarmEnvelope.traceId.
// causationId            — the immediately preceding constitutional act.
// lineageId              — the long-running chain this act belongs to.
// branchId               — a divergent sub-lineage with merge/expiry semantics.
//                           Reserved for Phase 4; not used in Phase 1.
// checkpointId           — a ratified snapshot/finality marker.
// =============================================================================

// =============================================================================
// TRANSITION KINDS (Tier A — domain-significant acts)
// =============================================================================

/**
 * Domain-significant acts that enter the constitutional audit history.
 *
 * These are Tier A transitions. Tier B storage mutations (ordinary DynamoDB
 * writes) are NOT transitions — they correlate to a transition via
 * StorageMutationMeta.transitionId.
 *
 * Test: if a human debugging the swarm would care about this as a meaningful
 * system act, it is a transition. If only an infra engineer would care, it is
 * a storage mutation.
 */
export type TransitionKind =
  | 'message_observed'
  | 'response_proposed'
  | 'tool_call_requested'
  | 'tool_result_received'
  | 'channel_state_changed'
  | 'response_committed'
  | 'external_effect_recorded'
  | 'policy_decision'
  | 'checkpoint_created';

// =============================================================================
// STATUS LADDER (adjudicable claims/results only)
// =============================================================================

/**
 * Admissibility status for adjudicable domain events.
 *
 * Applies to: transition proposals, tool executions, state transitions,
 * response decisions, checkpoints.
 *
 * Does NOT apply to: raw SwarmEnvelopes, storage rows, caches, internal DTOs.
 *
 * "corroborated" is defined in the manifesto but omitted from Phase 1.
 * It will be introduced when multi-source evidence or quorum logic exists.
 */
export type TransitionStatus =
  | 'observed'
  | 'proposed'
  | 'accepted'
  | 'finalized'
  | 'rejected'
  | 'superseded'
  | 'quarantined';

// =============================================================================
// TRANSITION METADATA (constitutional envelope)
// =============================================================================

/**
 * Constitutional metadata for Tier A transitions.
 *
 * This is the "full envelope" for constitutional records. It does NOT go on
 * SwarmEnvelope or operational objects — those already carry their own
 * traceability fields.
 */
export interface TransitionMeta {
  /** Unique ID for this transition */
  transitionId: string;
  /** Request/thread trace — maps to SwarmEnvelope.traceId */
  traceId?: string;
  /** ID of the immediately preceding constitutional act */
  causationId?: string;
  /** Long-running chain this act belongs to */
  lineageId: string;
  /** Schema version for forward compatibility */
  schemaVersion: number;
  /** Unix timestamp (ms) */
  createdAt: number;
}

// =============================================================================
// ENVELOPE REFERENCE (lightweight pointer to transport objects)
// =============================================================================

/**
 * Lightweight reference back to a SwarmEnvelope.
 *
 * Transitions reference their originating envelope by ID fields rather than
 * embedding the full envelope. This keeps constitutional records light while
 * maintaining traceability.
 */
export interface EnvelopeRef {
  avatarId: string;
  messageId: string;
  conversationId: string;
  platform: Platform;
}

// =============================================================================
// STORAGE MUTATION META (Tier B — correlated writes)
// =============================================================================

/**
 * Metadata for Tier B storage mutations (ordinary DynamoDB writes).
 *
 * Every Tier B write that matters should reference its parent transition ID.
 * Some writes are purely operational and may omit transitionId.
 */
export interface StorageMutationMeta {
  /** Parent Tier A transition, if this write was produced by one */
  transitionId?: string;
  /** Request/thread trace */
  correlationId: string;
  /** Classification of the storage write */
  mutationClass: 'projection' | 'cache' | 'index' | 'operational';
}

// =============================================================================
// TRANSITION RECORDS
// =============================================================================

/**
 * Base shape shared by all transition lifecycle stages.
 */
export interface TransitionBase {
  kind: TransitionKind;
  status: TransitionStatus;
  meta: TransitionMeta;
  /** Reference to the originating SwarmEnvelope, if applicable */
  envelopeRef?: EnvelopeRef;
  /** Domain-specific payload — typed per TransitionKind by consumers */
  payload: unknown;
}

/**
 * A proposed transition awaiting inline adjudication.
 */
export interface TransitionProposal extends TransitionBase {
  status: 'proposed';
}

/**
 * A transition that passed inline adjudication checks.
 */
export interface AcceptedTransition extends TransitionBase {
  status: 'accepted';
  /** The decision that accepted this transition */
  decisionId: string;
}

/**
 * A transition that has reached hard finality (sent externally,
 * checkpointed, or otherwise irreversible).
 */
export interface FinalizedTransition extends TransitionBase {
  status: 'finalized';
  decisionId: string;
  finalizedAt: number;
}

/**
 * Union of all constitutional transition records.
 */
export type TransitionRecord =
  | TransitionProposal
  | AcceptedTransition
  | FinalizedTransition;

// =============================================================================
// DECISION RECORDS (proof objects)
// =============================================================================

/**
 * Why a transition was allowed (or denied).
 *
 * Every ratified action should have an associated DecisionRecord so that
 * a stranger can later determine not only what happened, but why it was
 * allowed to count.
 */
export interface DecisionRecord {
  decisionId: string;
  transitionId: string;
  /** Whether the transition was accepted */
  accepted: boolean;
  /** Invariant checks that were evaluated */
  invariantChecks: InvariantCheckResult[];
  /** Policy rules that were evaluated */
  policyChecks: PolicyCheckResult[];
  /** Human-readable rationale (optional, for complex decisions) */
  rationale?: string;
  /** Who or what made this decision */
  decidedBy: string;
  /** Unix timestamp (ms) */
  decidedAt: number;
}

// =============================================================================
// CHECKPOINT RECORDS (finality markers)
// =============================================================================

/**
 * A ratified snapshot/finality marker.
 *
 * Checkpoints define the boundary between soft consensus and hard finality.
 * Once a checkpoint is created, the transitions it covers are considered
 * durable and should only be superseded, never deleted.
 */
export interface CheckpointRecord {
  checkpointId: string;
  /** Transition IDs covered by this checkpoint */
  transitionIds: string[];
  /** Lineage this checkpoint belongs to */
  lineageId: string;
  /** Unix timestamp (ms) */
  createdAt: number;
  /** What triggered checkpoint creation */
  reason: string;
}

// =============================================================================
// INVARIANTS vs POLICIES (distinct adjudication concerns)
// =============================================================================

/**
 * An invariant that must always hold for the system to remain coherent.
 *
 * Invariants are structural — they do not vary by avatar, environment, or
 * mode. Violation of an invariant is a system error.
 *
 * Examples:
 *   - "Every final decision traces back to evidence"
 *   - "Every externally visible action is attributable"
 *   - "No transition may regress status (proposed -> observed)"
 */
export interface InvariantCheck {
  invariantId: string;
  name: string;
  description: string;
  /** Evaluates the invariant against a transition */
  check: (transition: TransitionBase) => InvariantCheckResult;
}

export interface InvariantCheckResult {
  invariantId: string;
  passed: boolean;
  message?: string;
}

/**
 * A contingent rule that may vary by avatar, environment, or mode.
 *
 * Policies are configuration — they can be versioned, swapped, or overridden.
 * Violation of a policy is a rejection, not a system error.
 *
 * Examples:
 *   - "This avatar may call image generation tools"
 *   - "Rate limit: max 20 media credits per avatar"
 *   - "Responses in this channel require cool-down"
 */
export interface PolicyRule {
  policyId: string;
  name: string;
  version: number;
  /** Scope: which avatars/platforms this policy applies to */
  scope: PolicyScope;
  /** Evaluates the policy against a transition */
  check: (transition: TransitionBase, context: PolicyContext) => PolicyCheckResult;
}

export interface PolicyScope {
  /** Apply to specific avatars, or '*' for all */
  avatarIds: string[] | '*';
  /** Apply to specific platforms, or '*' for all */
  platforms: Platform[] | '*';
}

export interface PolicyContext {
  avatarId: string;
  platform: Platform;
  /** Additional context the policy may need */
  [key: string]: unknown;
}

export interface PolicyCheckResult {
  policyId: string;
  passed: boolean;
  message?: string;
}

// =============================================================================
// AUTHORITY SCOPE
// =============================================================================

/**
 * Narrow jurisdiction for a component that can make decisions.
 *
 * Authority is compositional — no single component should hold all authority.
 * Each authority has explicit jurisdiction and is replaceable.
 */
export interface AuthorityScope {
  authorityId: string;
  name: string;
  kind: AuthorityKind;
  /** What transition kinds this authority may adjudicate */
  jurisdiction: TransitionKind[];
}

export type AuthorityKind =
  | 'planning'
  | 'validation'
  | 'scheduling'
  | 'policy'
  | 'commit'
  | 'emergency_stop';

// =============================================================================
// TRANSITION LEDGER (storage-agnostic interface)
// =============================================================================

/**
 * Append-only ledger for constitutional records.
 *
 * Phase 1 implementation: DynamoDB append-only table.
 * The interface abstracts storage so backends can migrate later.
 *
 * This is NOT a replacement for existing operational DynamoDB tables.
 * Operational tables remain writable implementation surfaces; constitutional
 * legitimacy derives only from ledgered transitions and their associated
 * decisions.
 */
export interface TransitionLedger {
  /** Append a transition record to the ledger */
  append(transition: TransitionRecord): Promise<AppendResult>;
  /** Record a decision for a transition */
  recordDecision(decision: DecisionRecord): Promise<void>;
  /** Retrieve all events for a transition */
  getByTransition(transitionId: string): Promise<TransitionRecord[]>;
  /** Retrieve all transitions in a lineage chain */
  getLineage(lineageId: string): Promise<TransitionRecord[]>;
  /** Create a finality checkpoint */
  createCheckpoint(checkpoint: CheckpointRecord): Promise<void>;
}

export interface AppendResult {
  success: boolean;
  transitionId: string;
  /** Sequence number in the ledger (for ordering) */
  sequenceNumber?: number;
}

// =============================================================================
// REPAIR ACTIONS
// =============================================================================

/**
 * Structured repair operations.
 *
 * Repair is first-class — failures are compensated, not hidden.
 * Each repair action references the transition it is correcting.
 */
export type RepairAction =
  | RetryAction
  | CompensateAction
  | SupersedeAction
  | QuarantineAction
  | EscalateAction;

interface RepairBase {
  repairId: string;
  /** Transition being repaired */
  targetTransitionId: string;
  reason: string;
  createdAt: number;
}

export interface RetryAction extends RepairBase {
  type: 'retry';
  attempt: number;
  maxAttempts: number;
}

export interface CompensateAction extends RepairBase {
  type: 'compensate';
  /** The compensating transition that undoes the effect */
  compensatingTransitionId: string;
}

export interface SupersedeAction extends RepairBase {
  type: 'supersede';
  /** The new transition that replaces the target */
  replacementTransitionId: string;
}

export interface QuarantineAction extends RepairBase {
  type: 'quarantine';
  /** How long to quarantine (ms), or undefined for indefinite */
  durationMs?: number;
}

export interface EscalateAction extends RepairBase {
  type: 'escalate';
  /** Who/what to escalate to */
  escalateTo: string;
}

// =============================================================================
// ADJUDICABLE INTERFACE (shared base for status-bearing domain objects)
// =============================================================================

/**
 * Marker interface for domain objects that carry constitutional status.
 *
 * Any object implementing Adjudicable participates in the status ladder
 * and can be the subject of DecisionRecords.
 */
export interface Adjudicable {
  id: string;
  status: TransitionStatus;
  transitionKind: TransitionKind;
  /** Reference to the transition in the ledger */
  transitionId: string;
}

// =============================================================================
// TRANSITION DEFINITION (typed state transition primitive)
// =============================================================================

/**
 * A named, typed state transition with pre/postconditions.
 *
 * This is the Transition<I, O, Ctx> primitive from the manifesto.
 * Only Tier A (domain-significant) mutations should be wrapped in this.
 *
 * @template I - Input type
 * @template O - Output type
 * @template Ctx - Context type
 */
export interface TransitionDefinition<I, O, Ctx = void> {
  name: string;
  kind: TransitionKind;
  precondition: (input: I, ctx: Ctx) => TransitionCheckResult;
  execute: (input: I, ctx: Ctx) => Promise<O>;
  postcondition?: (output: O, ctx: Ctx) => TransitionCheckResult;
  /** Declarative description of side effects this transition may produce */
  effects?: EffectDescriptor[];
}

export interface TransitionCheckResult {
  passed: boolean;
  message?: string;
}

export interface EffectDescriptor {
  type: 'storage_write' | 'queue_enqueue' | 'external_api' | 'notification';
  target: string;
  description: string;
}

// =============================================================================
// PROJECTION (non-authoritative derived view)
// =============================================================================

/**
 * Metadata for a projection — a derived operational view built from accepted
 * history.
 *
 * Projections are useful, fast, mutable, and non-authoritative. ChannelState
 * is already this kind of thing. This interface makes the pattern explicit
 * for new projections.
 */
export interface ProjectionMeta {
  /** Which transition was last applied to build this projection */
  lastTransitionId: string;
  /** When this projection was last rebuilt */
  projectedAt: number;
  /** Whether the projection may be stale */
  stale: boolean;
}
