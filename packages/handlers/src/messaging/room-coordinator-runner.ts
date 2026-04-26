/**
 * Room Coordinator Runner
 *
 * Bridges the Lambda message-processor to the platform-agnostic room
 * coordinator. The shared-room SQS job arrives with envelope.avatarId set to
 * whichever bot's webhook won the dedup race — this runner re-decides the
 * primary responder using the full coordinator (mention, name-hit, plus
 * future signals) so the right avatar processes the message.
 *
 * Wired in `messaging/message-processor.ts` behind ROOM_COORDINATOR_ENABLED.
 *
 * Scope (v1):
 *   - Mention scoring (`@<platformHandle>`)
 *   - Name-hit scoring (avatar display name in text)
 *
 * Deferred:
 *   - sticky-affinity (needs activity-table lookup for last-responder)
 *   - reply-target (needs activity-table lookup for replyTo author)
 *   - thread-owner (Discord threads / Telegram topics)
 */
import {
  DefaultRoomCoordinator,
  logger,
  type SwarmEnvelope,
  type AvatarConfig,
  type RoomEvent,
  type RoomTurnDecision,
  type TurnCandidate,
} from '@swarm/core';
import {
  buildRoomKey,
  registerChannelAvatarMetaResolver,
  resolveChannelAvatarsWithMeta,
  type ChannelAvatarMeta,
} from '../services/room-ingress.js';
import { getChannelRegisteredAvatars } from '../telegram/webhook-home-channel.js';

/**
 * Minimal state-service surface needed by the meta resolver. Declared here
 * to avoid extending the @swarm/core StateService interface for one method
 * (`getAvatarConfig` lives on the DynamoDB implementation only).
 */
interface AvatarConfigReader {
  getAvatarConfig(avatarId: string): Promise<AvatarConfig | null>;
}

/**
 * Build the candidate list from a room's avatar metadata + the inbound text.
 * Pure: no I/O, just scoring of presence flags.
 */
export function buildTurnCandidates(
  meta: ChannelAvatarMeta[],
  text: string,
  platform: SwarmEnvelope['platform'],
): TurnCandidate[] {
  const lower = text.toLowerCase();
  return meta.map((m) => {
    const handle = m.platformHandle?.toLowerCase();
    const name = m.avatarName?.toLowerCase();

    // @-mention: requires a `@<handle>` substring with a word boundary after.
    let isMentioned = false;
    if (handle) {
      const needle = `@${handle}`;
      const idx = lower.indexOf(needle);
      if (idx !== -1) {
        const after = lower[idx + needle.length];
        isMentioned = after === undefined || !/[a-z0-9_]/.test(after);
      }
    }

    // Name-hit: avatar's display name appears as a standalone token.
    let isNameHit = false;
    if (name && name.length >= 2) {
      const re = new RegExp(`(^|[^a-z0-9_])${escapeRegExp(name)}([^a-z0-9_]|$)`, 'i');
      isNameHit = re.test(text);
    }

    return {
      avatarId: m.avatarId,
      avatarName: m.avatarName,
      platform,
      isMentioned,
      isReplyTarget: false,
      isThreadOwner: false,
      isNameHit,
      hasStickyAffinity: false,
      isBot: false,
    };
  });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Register the Telegram-side meta resolver. The resolver reads HOME_CHANNELS
 * for the chat (which already stores avatarId + botUsername) and joins each
 * avatar's display name from its CONFIG record via the state service.
 *
 * Called from message-processor's initialize(). Idempotent: re-registering
 * just replaces the previous resolver.
 */
export function registerTelegramRoomMetaResolver(
  stateService: AvatarConfigReader,
): void {
  registerChannelAvatarMetaResolver('telegram', async (channelId: string) => {
    const registered = await getChannelRegisteredAvatars(channelId);
    if (registered.length === 0) return [];
    const metas = await Promise.all(
      registered.map(async (r) => {
        let name = r.avatarId;
        try {
          const cfg = await stateService.getAvatarConfig(r.avatarId);
          if (cfg?.name) name = cfg.name;
        } catch {
          // Tolerate config read failures — fall back to id as name; name-hit
          // simply won't match for that avatar this turn.
        }
        return {
          avatarId: r.avatarId,
          avatarName: name,
          platformHandle: r.botUsername,
        };
      }),
    );
    return metas;
  });
}

/**
 * Run the coordinator for an inbound shared-room envelope.
 *
 * Returns the decision plus the candidate list it considered. The caller
 * decides whether to override `envelope.avatarId` based on `decision.primary`.
 *
 * Returns `null` when no meta resolver is registered for the platform — the
 * caller should fall through to today's webhook-decided avatarId.
 */
export async function runRoomCoordinator(
  envelope: SwarmEnvelope,
): Promise<{ decision: RoomTurnDecision; candidates: TurnCandidate[] } | null> {
  const meta = await resolveChannelAvatarsWithMeta(
    envelope.platform,
    envelope.conversationId,
  );
  if (meta.length === 0) {
    return null;
  }

  const text = envelope.content?.text ?? '';
  const candidates = buildTurnCandidates(meta, text, envelope.platform);

  const event: RoomEvent = {
    roomKey: buildRoomKey(envelope.platform, envelope.conversationId),
    messageId: envelope.messageId,
    platform: envelope.platform,
    senderId: String(envelope.sender.platformUserId ?? envelope.sender.id),
    senderType: envelope.sender.isBot ? 'avatar' : 'human',
    content: text,
    timestamp: envelope.timestamp ?? Date.now(),
  };

  const coordinator = new DefaultRoomCoordinator();
  const decision = await coordinator.evaluateTurn(event, candidates);

  logger.info('room_coordinator: turn evaluated (processor)', {
    event: 'room_coordinator_evaluated',
    subsystem: 'room-coordinator',
    roomKey: event.roomKey,
    messageId: event.messageId,
    incomingAvatarId: envelope.avatarId,
    primaryAvatarId: decision.primary?.avatarId ?? null,
    decisionReason: decision.decisionReason,
    candidateCount: candidates.length,
  });

  return { decision, candidates };
}
