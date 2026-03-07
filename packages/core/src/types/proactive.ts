/**
 * Proactive Participation Types
 *
 * Configuration and decision types for proactive avatar participation —
 * avatars speaking up without being directly addressed.
 */

/**
 * Configuration for proactive participation in a room.
 */
export interface ProactiveConfig {
  /** Whether proactive participation is enabled */
  enabled: boolean;
  /** Maximum number of proactive messages per hour per room */
  maxProactivePerHour: number;
  /** Minimum silence window (ms) before proactive participation is allowed */
  silenceWindowMs: number;
  /** Bot density threshold (0-1); suppress proactive when ratio exceeds this */
  botDensityThreshold: number;
  /** Extra delay (ms) before bot-to-bot proactive continuation */
  botToBotDelayMs: number;
  /** Maximum bot-to-bot proactive continuations per hour */
  botToBotBudgetPerHour: number;
}

/**
 * Reason codes for proactive participation decisions.
 */
export type ProactiveReason =
  | 'budget-exceeded'
  | 'bot-density-high'
  | 'silence-window'
  | 'cooldown'
  | 'eligible'
  | 'disabled';

/**
 * Result of evaluating whether an avatar should proactively speak.
 */
export interface ProactiveDecision {
  /** Whether the avatar should speak proactively */
  shouldSpeak: boolean;
  /** Which avatar was evaluated (echoed back for caller convenience) */
  avatarId?: string;
  /** Suggested delay in ms before the avatar speaks */
  delayMs?: number;
  /** Reason for the decision */
  reason: ProactiveReason;
}
