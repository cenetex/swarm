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
 * Admission rule for this file:
 *   A type belongs here only if Phase 1 code will consume it — wrapping a
 *   mutation, recording a decision, or checking an invariant. Types that
 *   anticipate future phases belong in the manifesto until they have a
 *   first consumer.
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
  | 'policy_decision';

// =============================================================================
// STATUS LADDER (adjudicable claims/results only)
// =============================================================================

/**
 * Admissibility status for adjudicable domain events.
 *
 * Applies to: transition proposals, tool executions, state transitions,
 * response decisions.
 *
 * Does NOT apply to: raw SwarmEnvelopes, storage rows, caches, internal DTOs.
 */
export type TransitionStatus =
  | 'observed'
  | 'proposed'
  | 'accepted'
  | 'finalized'
  | 'rejected'
  | 'superseded';

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
 * Union of transition records that Phase 1 produces.
 */
export type TransitionRecord =
  | TransitionProposal
  | AcceptedTransition;

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
  scope: PolicyScope;
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
  [key: string]: unknown;
}

export interface PolicyCheckResult {
  policyId: string;
  passed: boolean;
  message?: string;
}

// =============================================================================
// TRANSITION LEDGER (storage-agnostic interface)
// =============================================================================

/**
 * Append-only ledger for constitutional records.
 *
 * Phase 1 implementation: DynamoDB append-only table.
 * The interface abstracts storage so backends can migrate later.
 *
 * Operational tables remain writable implementation surfaces; constitutional
 * legitimacy derives only from ledgered transitions and their associated
 * decisions.
 */
export interface TransitionLedger {
  append(transition: TransitionRecord): Promise<AppendResult>;
  recordDecision(decision: DecisionRecord): Promise<void>;
  getByTransition(transitionId: string): Promise<TransitionRecord[]>;
  getLineage(lineageId: string): Promise<TransitionRecord[]>;
}

export interface AppendResult {
  success: boolean;
  transitionId: string;
  sequenceNumber?: number;
}
