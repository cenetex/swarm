/**
 * Turn Arbiter Types
 *
 * Types for cross-platform turn arbitration in shared rooms.
 * Elects at most one primary responder per human message.
 */
import type { Platform } from './platform.js';

/**
 * A candidate avatar eligible to respond to a message.
 */
export interface TurnCandidate {
  /** Unique avatar identifier */
  avatarId: string;
  /** Avatar display name (used for name-hit matching) */
  avatarName: string;
  /** Platform the avatar operates on */
  platform: Platform;
  /** Whether this avatar is directly @mentioned in the message */
  isMentioned: boolean;
  /** Whether the message is a reply to this avatar's prior message */
  isReplyTarget: boolean;
  /** Whether this avatar owns / started the thread */
  isThreadOwner: boolean;
  /** Whether the message text contains this avatar's name (case-insensitive) */
  isNameHit: boolean;
  /** Whether this avatar was the last to respond in the room */
  hasStickyAffinity: boolean;
  /** Whether this candidate is a bot (for bot-to-bot suppression) */
  isBot: boolean;
  /** Optional numeric confidence for reply-to matching (0-1) */
  replyConfidence?: number;
  /** Timestamp of this avatar's last response in the room */
  lastResponseAt?: number;
}

/**
 * The incoming message context used for arbitration.
 */
export interface TurnMessage {
  /** Unique message identifier */
  messageId: string;
  /** Room / channel / conversation ID */
  conversationId: string;
  /** Whether the sender is a bot */
  senderIsBot: boolean;
  /** Platform the message originated on */
  platform: Platform;
  /** Plain text content (for name matching) */
  text?: string;
}

/**
 * Configuration knobs for the turn arbiter.
 */
export interface TurnArbiterConfig {
  /** Allow suppressed avatars to send delayed secondary reactions (default: false) */
  allowSecondaryReactions: boolean;
  /** Delay in ms before a secondary reaction is permitted (default: 30000) */
  secondaryDelayMs: number;
  /** Minimum reply confidence to win via reply-to (default: 0.7) */
  replyConfidenceThreshold: number;
  /** Suppress all candidates when the sender is a bot (default: true) */
  suppressBotToBot: boolean;
}

/**
 * The result of turn arbitration for a single human message.
 */
export interface TurnDecision {
  /** The elected primary responder, or null if no one should respond */
  primary: TurnCandidate | null;
  /** Candidates that were suppressed (not allowed to respond as primary) */
  suppressed: TurnCandidate[];
  /** Per-avatar reason string keyed by avatarId */
  reasons: Record<string, string>;
  /** Whether secondary reactions are allowed for suppressed avatars */
  allowSecondaryReactions: boolean;
  /** Delay in ms before secondary reactions may fire */
  secondaryDelayMs: number;
}
