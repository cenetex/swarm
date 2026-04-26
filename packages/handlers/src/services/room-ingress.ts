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
 *
 * Shared-room detection uses a platform-agnostic ChannelAvatarResolver
 * abstraction so both Telegram (home-channel registry) and Discord (in-memory
 * gateway bindings) resolve avatar counts through the same interface.
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

/**
 * Platform-agnostic interface for resolving which avatars are present in a
 * channel. Implementations can back onto DynamoDB (Telegram home-channel
 * registry), in-memory gateway bindings (Discord), or any future store.
 */
export type ChannelAvatarResolver = (channelId: string) => Promise<string[]>;

/**
 * Avatar metadata required for the room coordinator to score a turn:
 * the id, display name (for name-hit), and platform handle (for @-mention).
 */
export interface ChannelAvatarMeta {
  avatarId: string;
  /** Display name as the avatar shows up to humans (used for name-hit scoring). */
  avatarName: string;
  /** Platform handle for @-mention matching. Telegram = botUsername, Discord = bot user id-as-mention. */
  platformHandle?: string;
}

/**
 * Platform-agnostic resolver returning rich metadata for every avatar in a
 * channel. Used by the message-processor's room coordinator to build turn
 * candidates. Falls back to ids-only when not registered.
 */
export type ChannelAvatarMetaResolver = (channelId: string) => Promise<ChannelAvatarMeta[]>;

/** Overridable dependencies for testing without process-global mock.module. */
export interface RoomIngressDeps {
  appendMessage: typeof _appendMessage;
  getRecentMessages: typeof _getRecentMessages;
  getChannelAvatarIds: ChannelAvatarResolver;
}

const defaultDeps: RoomIngressDeps = {
  appendMessage: _appendMessage,
  getRecentMessages: _getRecentMessages,
  getChannelAvatarIds: _getChannelAvatarIds,
};

/**
 * Per-platform resolver registry. Callers (e.g. Discord gateway) can register
 * a platform-specific ChannelAvatarResolver so that isSharedRoom uses the
 * correct data source for each platform.
 */
const platformResolvers = new Map<Platform, ChannelAvatarResolver>();
const platformMetaResolvers = new Map<Platform, ChannelAvatarMetaResolver>();

/**
 * Register a platform-specific ChannelAvatarResolver.
 *
 * Discord registers its in-memory binding lookup here; Telegram falls through
 * to the default (home-channel registry) if no resolver is registered.
 */
export function registerChannelAvatarResolver(
  platform: Platform,
  resolver: ChannelAvatarResolver,
): void {
  platformResolvers.set(platform, resolver);
}

/**
 * Register a platform-specific ChannelAvatarMetaResolver. The room-coordinator
 * runner uses this to build turn candidates with display names and @-handles.
 */
export function registerChannelAvatarMetaResolver(
  platform: Platform,
  resolver: ChannelAvatarMetaResolver,
): void {
  platformMetaResolvers.set(platform, resolver);
}

/**
 * Resolve the meta-bearing avatar list for a channel. Returns [] if no meta
 * resolver is registered for the platform — callers should treat that as
 * "coordinator unavailable, fall through".
 */
export async function resolveChannelAvatarsWithMeta(
  platform: Platform,
  channelId: string,
): Promise<ChannelAvatarMeta[]> {
  const resolver = platformMetaResolvers.get(platform);
  if (!resolver) return [];
  return resolver(channelId);
}

/**
 * Unregister a platform-specific resolver (useful for cleanup/testing).
 */
export function unregisterChannelAvatarResolver(platform: Platform): void {
  platformResolvers.delete(platform);
  platformMetaResolvers.delete(platform);
}

/** Replace dependencies for testing. */
export function _setDeps(deps: Partial<RoomIngressDeps>): void {
  Object.assign(defaultDeps, deps);
}

/** Reset dependencies to originals. */
export function _resetDeps(): void {
  defaultDeps.appendMessage = _appendMessage;
  defaultDeps.getRecentMessages = _getRecentMessages;
  defaultDeps.getChannelAvatarIds = _getChannelAvatarIds;
  platformResolvers.clear();
  platformMetaResolvers.clear();
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
 * Uses the platform-specific resolver if one has been registered via
 * registerChannelAvatarResolver(), otherwise falls back to the default
 * home-channel registry lookup. Returns true if 2+ avatars are present.
 *
 * This is the single platform-agnostic entry point for shared-room detection
 * used by both Telegram and Discord ingress paths.
 */
export async function isSharedRoom(
  platform: Platform,
  channelId: string,
): Promise<boolean> {
  const resolver = platformResolvers.get(platform) ?? defaultDeps.getChannelAvatarIds;
  const avatarIds = await resolver(channelId);
  return avatarIds.length >= 2;
}
