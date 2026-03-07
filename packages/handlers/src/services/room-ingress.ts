/**
 * Room-Scoped Ingress Service
 *
 * Converts one inbound message in a shared room into one room-scoped
 * coordination event, instead of N per-avatar events.
 *
 * For shared rooms (channels with multiple active avatars), the message is:
 *   1. Appended once to the shared room ledger
 *   2. Deduplicated by messageId
 *   3. Enqueued once with a room-scoped MessageGroupId
 *
 * Private chats and single-avatar channels continue to use per-avatar enqueue.
 */
import {
  appendMessage as _appendMessage,
  getRecentMessages as _getRecentMessages,
  logger,
  type Platform,
  type SharedRoomMessage,
} from '@swarm/core';
import { getChannelAvatarIds as _getChannelAvatarIds } from '../telegram/webhook-home-channel.js';
import { getRateLimiter, logRateLimited } from './room-rate-limiter.js';

export interface RoomIngressResult {
  /** Room key used for coordination (e.g. "telegram:-1001234567890") */
  roomKey: string;
  /** Platform-specific message ID */
  messageId: string;
  /** Whether this message was new (true) or a duplicate (false) */
  isNew: boolean;
  /** Whether this message was dropped due to rate limiting */
  rateLimited?: boolean;
}

/** Overridable dependencies for testing without process-global mock.module. */
export interface RoomIngressDeps {
  appendMessage: typeof _appendMessage;
  getRecentMessages: typeof _getRecentMessages;
  getChannelAvatarIds: typeof _getChannelAvatarIds;
}

const defaultDeps: RoomIngressDeps = {
  appendMessage: _appendMessage,
  getRecentMessages: _getRecentMessages,
  getChannelAvatarIds: _getChannelAvatarIds,
};

/** Replace dependencies for testing. */
export function _setDeps(deps: Partial<RoomIngressDeps>): void {
  Object.assign(defaultDeps, deps);
}

/** Reset dependencies to originals. */
export function _resetDeps(): void {
  defaultDeps.appendMessage = _appendMessage;
  defaultDeps.getRecentMessages = _getRecentMessages;
  defaultDeps.getChannelAvatarIds = _getChannelAvatarIds;
}

/**
 * Generate a deterministic room key from platform and channel ID.
 */
export function buildRoomKey(platform: Platform, channelId: string): string {
  return `${platform}:${channelId}`;
}

/**
 * Process a shared room message: append to ledger with dedup.
 *
 * Returns `{ isNew: false }` if the message was already in the ledger,
 * allowing the caller to skip downstream coordination.
 */
export async function processSharedRoomMessage(
  platform: Platform,
  channelId: string,
  message: {
    messageId: string;
    senderId: string;
    senderType: SharedRoomMessage['senderType'];
    content: string;
    timestamp: number;
  },
): Promise<RoomIngressResult> {
  const roomKey = buildRoomKey(platform, channelId);

  // Dedup: check recent messages for this messageId
  const recent = await defaultDeps.getRecentMessages(channelId, 50);
  const alreadyExists = recent.some((m) => m.messageId === message.messageId);

  if (alreadyExists) {
    logger.info('Room ingress dedup: message already in ledger', {
      event: 'room_ingress_dedup',
      subsystem: 'room-ingress',
      roomKey,
      messageId: message.messageId,
    });
    return { roomKey, messageId: message.messageId, isNew: false };
  }

  // Rate limit check — drop message with structured logging if limits exceeded
  const rateLimitResult = getRateLimiter().checkMessage(roomKey, message.senderId);
  if (!rateLimitResult.allowed) {
    logRateLimited(roomKey, message.messageId, message.senderId, rateLimitResult);
    return { roomKey, messageId: message.messageId, isNew: false, rateLimited: true };
  }

  // Append to shared room ledger (one write per inbound message)
  await defaultDeps.appendMessage(channelId, {
    messageId: message.messageId,
    senderId: message.senderId,
    senderType: message.senderType,
    platform,
    content: message.content,
    timestamp: message.timestamp,
  });

  logger.info('Room ingress: message appended to shared ledger', {
    event: 'room_ingress_appended',
    subsystem: 'room-ingress',
    roomKey,
    messageId: message.messageId,
    senderId: message.senderId,
    senderType: message.senderType,
  });

  return { roomKey, messageId: message.messageId, isNew: true };
}

/**
 * Check whether a channel is a shared room (has multiple active avatars).
 *
 * Uses the home channel registry from #744 to count registered avatars.
 * Returns true if 2+ avatars are registered in this channel.
 */
export async function isSharedRoom(
  _platform: Platform,
  channelId: string,
): Promise<boolean> {
  const avatarIds = await defaultDeps.getChannelAvatarIds(channelId);
  return avatarIds.length >= 2;
}
