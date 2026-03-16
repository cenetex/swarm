/**
 * Raticross Protocol Types
 *
 * Shared message envelope and actor types for inter-agent communication
 * via the raticross bridge. These types define the wire format used
 * between Swarm, Kyro, and any future bridge partners.
 *
 * Protocol version: 0.1
 */

// =============================================================================
// PROTOCOL VERSION
// =============================================================================

/** Current raticross protocol version */
export const RATICROSS_PROTOCOL_VERSION = '0.1';

// =============================================================================
// ACTOR IDENTIFICATION
// =============================================================================

/**
 * Identifies an agent participating in cross-system communication.
 * The combination of system + agentId is globally unique.
 */
export interface RaticrossActor {
  /** System identifier (e.g., 'swarm', 'kyro') */
  system: string;
  /** Agent identifier within the system (e.g., avatar ID) */
  agentId: string;
  /** Optional public key for cryptographic verification */
  pubkey?: string;
}

// =============================================================================
// MESSAGE ENVELOPE
// =============================================================================

/** Envelope types for inter-agent communication */
export type RaticrossEnvelopeType = 'message' | 'task' | 'result' | 'status';

/** Priority levels for message routing */
export type RaticrossPriority = 'low' | 'normal' | 'high';

/**
 * The raticross envelope — the unit of inter-agent communication.
 * All messages flowing through the bridge use this JSON format.
 */
export interface RaticrossEnvelope {
  /** Unique message identifier (UUID) */
  id: string;
  /** Distributed trace ID for correlating request/response pairs */
  traceId?: string;
  /** Protocol version (e.g., '0.1') */
  protocol?: string;
  /** Unix timestamp in milliseconds */
  timestamp: number;
  /** Sending agent */
  from: RaticrossActor;
  /** Target agent */
  to: RaticrossActor;
  /** Envelope type */
  type: RaticrossEnvelopeType;
  /** Conversation thread identifier */
  conversationId: string;
  /** Message content (text body) */
  content: string;
  /** Optional structured context for the receiving agent */
  context?: RaticrossContext;
  /** Optional metadata for routing and lifecycle */
  meta?: RaticrossMeta;
}

/**
 * Structured context passed alongside the message content.
 * Helps the receiving agent understand intent without parsing free text.
 */
export interface RaticrossContext {
  /** Short summary of conversation so far */
  summary?: string;
  /** Constraints the receiver should respect */
  constraints?: string;
  /** Hints about which tools might be useful */
  toolHints?: string[];
}

/**
 * Routing and lifecycle metadata for an envelope.
 */
export interface RaticrossMeta {
  /** Time-to-live in milliseconds (message expires after this) */
  ttl?: number;
  /** Routing priority */
  priority?: RaticrossPriority;
  /** Free-form tags for filtering/observability */
  tags?: string[];
}

// =============================================================================
// HEALTH CHECK
// =============================================================================

/** Health check request sent to a bridge peer */
export interface RaticrossHealthRequest {
  type: 'health';
  timestamp: number;
  from: RaticrossActor;
  protocol: string;
}

/** Health check response from a bridge peer */
export interface RaticrossHealthResponse {
  ok: boolean;
  system: string;
  protocol: string;
  timestamp: number;
  uptime?: number;
  agents?: string[];
}

// =============================================================================
// BRIDGE CLIENT TYPES
// =============================================================================

/** Configuration for the raticross bridge client */
export interface RaticrossBridgeConfig {
  /** Base URL of the peer relay endpoint */
  relayUrl: string;
  /** Shared secret for authentication */
  relayKey?: string;
  /** This system's identifier (default: 'swarm') */
  localSystem?: string;
  /** Target system identifier (default: 'kyro') */
  remoteSystem?: string;
  /** Request timeout in milliseconds (default: 10000) */
  timeoutMs?: number;
}

/** Result of a bridge send operation */
export interface RaticrossSendResult {
  ok: boolean;
  /** The envelope ID that was sent */
  id: string;
  /** Error message if ok is false */
  error?: string;
}
