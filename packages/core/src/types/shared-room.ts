import type { Platform } from './platform.js';

// =============================================================================
// SHARED ROOM LEDGER TYPES
// =============================================================================

/**
 * Metadata for a shared room (one per room, independent of any avatar).
 */
export interface SharedRoomState {
  /** Unique room identifier (e.g. Telegram chatId, Discord channelId) */
  roomId: string;
  /** Platform this room belongs to */
  platform: Platform;
  /** When the room record was first created (epoch ms) */
  createdAt: number;
  /** Running count of messages appended to the ledger */
  messageCount: number;
}

/**
 * Sender type discriminator for shared room messages.
 */
export type SharedRoomSenderType = 'human' | 'avatar';

/**
 * A single message in the shared room ledger.
 * Both human and avatar messages share this shape.
 */
export interface SharedRoomMessage {
  /** Room this message belongs to */
  roomId: string;
  /** Message timestamp (epoch ms) */
  timestamp: number;
  /** Platform-level sender ID (userId or avatarId) */
  senderId: string;
  /** Whether the sender is human or avatar */
  senderType: SharedRoomSenderType;
  /** Platform the message originated from */
  platform: Platform;
  /** Message text content */
  content: string;
  /** Platform-specific message ID (for dedup / reply tracking) */
  messageId: string;
}

/**
 * Per-avatar overlay on a shared room.
 * Tracks participation signals that are avatar-specific.
 */
export interface AvatarRoomOverlay {
  /** Avatar this overlay belongs to */
  avatarId: string;
  /** Room this overlay is scoped to */
  roomId: string;
  /** When the avatar last sent a message in this room (epoch ms) */
  lastParticipatedAt: number;
  /** Messages in the room since this avatar last replied */
  messagesSinceLastReply: number;
  /** If set, the avatar should not respond until this time (epoch ms) */
  cooldownUntil?: number;
  /** Opaque thread hint strings (e.g. topic IDs the avatar is tracking) */
  threadHints?: string[];
  /** Numeric affinity score (higher = more engaged in this room) */
  affinityScore?: number;
}
