/**
 * Room Event Types
 *
 * Canonical room-scoped event primitives that bridge platform-specific
 * message events with the cross-platform turn arbiter.
 */
import type { Platform } from './platform.js';
import type { TurnCandidate, TurnDecision } from './turn-arbiter.js';

// =============================================================================
// SENDER TYPE
// =============================================================================

/**
 * Discriminator for the sender of a room event.
 */
export type RoomSenderType = 'human' | 'avatar' | 'bot';

// =============================================================================
// DECISION REASON
// =============================================================================

/**
 * Why a particular avatar was chosen (or not) to respond to a room event.
 */
export type DecisionReason =
  | 'direct-mention'
  | 'reply-to-avatar'
  | 'thread-owner'
  | 'sticky-affinity'
  | 'topic-match'
  | 'proactive'
  | 'random-fallback'
  | 'none';

// =============================================================================
// ROOM EVENT
// =============================================================================

/**
 * A canonical, platform-agnostic representation of a message arriving
 * in a shared room.  Handlers map their platform-specific events into
 * this shape before handing off to the coordinator.
 */
export interface RoomEvent {
  /** Unique room key (see generateRoomKey) */
  roomKey: string;
  /** Originating platform */
  platform: Platform;
  /** Platform-specific message identifier */
  messageId: string;
  /** Sender identifier (userId or avatarId) */
  senderId: string;
  /** Whether the sender is human, avatar, or generic bot */
  senderType: RoomSenderType;
  /** Plain text content of the message */
  content: string;
  /** Message timestamp (epoch ms) */
  timestamp: number;
  /** If the message is a reply to an avatar, the target avatar's ID */
  replyToAvatarId?: string;
  /** Avatar IDs explicitly @mentioned in the message */
  mentionedAvatarIds?: string[];
  /** Thread ID (platform-specific) if the message belongs to a thread */
  threadId?: string;
}

// =============================================================================
// ROOM TURN DECISION
// =============================================================================

/**
 * Extends TurnDecision with room-scoped context and a human-readable
 * reason enum.
 */
export interface RoomTurnDecision extends TurnDecision {
  /** Room key this decision applies to */
  roomKey: string;
  /** Why the primary responder was chosen */
  decisionReason: DecisionReason;
}

// =============================================================================
// ROOM COORDINATOR INTERFACE
// =============================================================================

/**
 * Evaluates a room event against a set of candidate avatars and returns
 * a turn decision.  Handlers call this instead of the low-level arbiter.
 */
export interface RoomCoordinator {
  evaluateTurn(
    event: RoomEvent,
    candidates: TurnCandidate[],
  ): Promise<RoomTurnDecision>;
}
