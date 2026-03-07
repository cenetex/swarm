/**
 * Cross-Platform Turn Arbiter
 *
 * Elects at most one primary responder for a human message in a shared room.
 *
 * Priority order (highest to lowest):
 *   1. Direct reply-to (when confidence >= threshold)
 *   2. Explicit @mention
 *   3. Name hit (avatar name appears in message text)
 *   4. Sticky affinity (avatar was the last responder)
 *   5. Thread ownership
 *   6. Random fallback (deterministic from messageId for reproducibility)
 *
 * Hard suppressors:
 *   - Bot-to-bot chains are suppressed by default
 *   - Once a primary is elected, all others are suppressed
 */
import { logger } from '../utils/logger.js';
import type {
  TurnCandidate,
  TurnMessage,
  TurnArbiterConfig,
  TurnDecision,
} from '../types/turn-arbiter.js';

export type {
  TurnCandidate,
  TurnMessage,
  TurnArbiterConfig,
  TurnDecision,
} from '../types/turn-arbiter.js';

/** Default configuration */
export const DEFAULT_TURN_ARBITER_CONFIG: TurnArbiterConfig = {
  allowSecondaryReactions: false,
  secondaryDelayMs: 30_000,
  replyConfidenceThreshold: 0.7,
  suppressBotToBot: true,
};

/**
 * Compute a deterministic numeric hash from a string.
 * Used for stable random fallback so the same messageId always picks the same avatar.
 */
function deterministicHash(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    hash = ((hash << 5) - hash + ch) | 0; // 32-bit integer
  }
  return Math.abs(hash);
}

/**
 * Score a candidate according to the priority tiers.
 * Higher score = higher priority.
 */
function scoreCandidate(
  candidate: TurnCandidate,
  config: TurnArbiterConfig,
): number {
  // Tier 1: reply-to with high confidence
  if (
    candidate.isReplyTarget &&
    (candidate.replyConfidence ?? 1) >= config.replyConfidenceThreshold
  ) {
    return 600;
  }

  // Tier 2: explicit @mention
  if (candidate.isMentioned) {
    return 500;
  }

  // Tier 3: name hit in message text
  if (candidate.isNameHit) {
    return 400;
  }

  // Tier 4: sticky affinity
  if (candidate.hasStickyAffinity) {
    return 300;
  }

  // Tier 5: thread ownership
  if (candidate.isThreadOwner) {
    return 200;
  }

  // Tier 6: baseline (random tiebreak handled separately)
  return 100;
}

/**
 * Select the primary responder from a set of candidates for a given message.
 *
 * @param candidates - All avatars eligible to respond in this room
 * @param message    - The incoming human (or bot) message
 * @param configOverrides - Optional partial config overrides
 * @returns A TurnDecision with at most one primary and structured reasons
 */
export function selectPrimaryResponder(
  candidates: TurnCandidate[],
  message: TurnMessage,
  configOverrides?: Partial<TurnArbiterConfig>,
): TurnDecision {
  const config: TurnArbiterConfig = {
    ...DEFAULT_TURN_ARBITER_CONFIG,
    ...configOverrides,
  };

  const reasons: Record<string, string> = {};
  const logContext = { subsystem: 'turn-arbiter', messageId: message.messageId, conversationId: message.conversationId };
  const log = {
    info: (msg: string, data?: Record<string, unknown>) => logger.info(msg, { ...logContext, ...data }),
    warn: (msg: string, data?: Record<string, unknown>) => logger.warn(msg, { ...logContext, ...data }),
  };

  // Edge case: no candidates
  if (candidates.length === 0) {
    log.info('turn_decision: no candidates', { candidateCount: 0 });
    return {
      primary: null,
      suppressed: [],
      reasons,
      allowSecondaryReactions: config.allowSecondaryReactions,
      secondaryDelayMs: config.secondaryDelayMs,
    };
  }

  // Hard suppressor: bot-to-bot
  if (config.suppressBotToBot && message.senderIsBot) {
    for (const c of candidates) {
      reasons[c.avatarId] = 'suppressed:bot-to-bot';
    }
    log.info('turn_decision: bot-to-bot suppressed', {
      candidateCount: candidates.length,
      suppressedAvatars: candidates.map(c => c.avatarId),
    });
    return {
      primary: null,
      suppressed: [...candidates],
      reasons,
      allowSecondaryReactions: config.allowSecondaryReactions,
      secondaryDelayMs: config.secondaryDelayMs,
    };
  }

  // Score all candidates
  const scored = candidates.map(c => ({
    candidate: c,
    score: scoreCandidate(c, config),
  }));

  // Sort descending by score, then use deterministic tiebreak
  const hash = deterministicHash(message.messageId);
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    // Deterministic tiebreak: hash XOR with avatar ID hash
    const aHash = deterministicHash(a.candidate.avatarId) ^ hash;
    const bHash = deterministicHash(b.candidate.avatarId) ^ hash;
    return bHash - aHash;
  });

  const winner = scored[0];
  const suppressed: TurnCandidate[] = [];

  // Build reason for winner
  const winnerScore = winner.score;
  let winReason: string;
  if (winnerScore >= 600) {
    winReason = 'won:reply-to';
  } else if (winnerScore >= 500) {
    winReason = 'won:mention';
  } else if (winnerScore >= 400) {
    winReason = 'won:name-hit';
  } else if (winnerScore >= 300) {
    winReason = 'won:sticky-affinity';
  } else if (winnerScore >= 200) {
    winReason = 'won:thread-owner';
  } else {
    winReason = 'won:random-fallback';
  }

  reasons[winner.candidate.avatarId] = winReason;

  // Suppress everyone else
  for (let i = 1; i < scored.length; i++) {
    const loser = scored[i].candidate;
    suppressed.push(loser);
    reasons[loser.avatarId] = `suppressed:lost-to-${winner.candidate.avatarId}`;
  }

  log.info('turn_decision: primary elected', {
    candidateCount: candidates.length,
    primaryAvatarId: winner.candidate.avatarId,
    primaryReason: winReason,
    primaryScore: winnerScore,
    suppressedAvatars: suppressed.map(c => c.avatarId),
    allScores: scored.map(s => ({ avatarId: s.candidate.avatarId, score: s.score })),
  });

  return {
    primary: winner.candidate,
    suppressed,
    reasons,
    allowSecondaryReactions: config.allowSecondaryReactions,
    secondaryDelayMs: config.secondaryDelayMs,
  };
}
