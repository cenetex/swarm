/**
 * Default Room Coordinator
 *
 * Wraps the low-level selectPrimaryResponder() arbiter with RoomEvent
 * normalization and DecisionReason mapping.
 */
import { logger } from '../utils/logger.js';
import { selectPrimaryResponder } from './turn-arbiter.js';
import type { TurnCandidate, TurnMessage, TurnArbiterConfig } from '../types/turn-arbiter.js';
import type {
  RoomEvent,
  RoomTurnDecision,
  RoomCoordinator,
  DecisionReason,
} from '../types/room-event.js';

// =============================================================================
// ROOM EVENT -> TURN MESSAGE MAPPING
// =============================================================================

/**
 * Map a canonical RoomEvent into the TurnMessage shape consumed by the
 * turn arbiter.
 */
export function roomEventToTurnMessage(event: RoomEvent): TurnMessage {
  return {
    messageId: event.messageId,
    conversationId: event.roomKey,
    senderIsBot: event.senderType !== 'human',
    platform: event.platform,
    text: event.content,
  };
}

// =============================================================================
// WIN-REASON -> DECISION-REASON MAPPING
// =============================================================================

/**
 * Convert the arbiter's internal win reason string into a DecisionReason enum.
 */
export function mapWinReason(reason: string | undefined): DecisionReason {
  if (!reason) return 'none';

  if (reason.includes('reply-to')) return 'reply-to-avatar';
  if (reason.includes('mention') || reason.includes('name-hit')) return 'direct-mention';
  if (reason.includes('sticky-affinity')) return 'sticky-affinity';
  if (reason.includes('thread-owner')) return 'thread-owner';
  if (reason.includes('random-fallback')) return 'random-fallback';

  return 'none';
}

// =============================================================================
// DEFAULT COORDINATOR
// =============================================================================

/**
 * Default implementation of RoomCoordinator.
 *
 * Delegates scoring to selectPrimaryResponder and enriches the result
 * with room-scoped context.
 */
export class DefaultRoomCoordinator implements RoomCoordinator {
  private readonly configOverrides?: Partial<TurnArbiterConfig>;

  constructor(configOverrides?: Partial<TurnArbiterConfig>) {
    this.configOverrides = configOverrides;
  }

  async evaluateTurn(
    event: RoomEvent,
    candidates: TurnCandidate[],
  ): Promise<RoomTurnDecision> {
    const turnMessage = roomEventToTurnMessage(event);
    const decision = selectPrimaryResponder(candidates, turnMessage, this.configOverrides);

    const primaryId = decision.primary?.avatarId;
    const winReason = primaryId ? decision.reasons[primaryId] : undefined;
    const decisionReason = mapWinReason(winReason);

    logger.info('room_coordinator: turn evaluated', {
      subsystem: 'room-coordinator',
      roomKey: event.roomKey,
      messageId: event.messageId,
      primaryAvatarId: primaryId ?? null,
      decisionReason,
      candidateCount: candidates.length,
    });

    return {
      ...decision,
      roomKey: event.roomKey,
      decisionReason,
    };
  }
}
