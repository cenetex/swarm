/**
 * Message envelope types - universal message format across all platforms
 */
import type { Platform } from './platform.js';

// =============================================================================
// MESSAGE ENVELOPE
// =============================================================================

/**
 * Universal message envelope that normalizes messages across all platforms
 */
export interface SwarmEnvelope {
  // Routing
  avatarId: string;
  platform: Platform;

  // Correlation
  traceId?: string;

  // Message identification
  messageId: string;
  conversationId: string; // Channel/chat/thread ID
  timestamp: number;

  // Sender info
  sender: SenderInfo;

  // Content
  content: MessageContent;

  // Context
  replyTo?: string; // Message ID being replied to
  mentions: Mention[];

  // Platform-specific raw data
  raw: unknown;

  // Processing metadata
  metadata: EnvelopeMetadata;
}

export interface SenderInfo {
  id: string;
  username?: string;
  displayName?: string;
  isBot: boolean;

  // Platform-specific
  platform: Platform;
  platformUserId: string;

  // Solana integration
  walletAddress?: string;
  tokenBalance?: number;
  nftHoldings?: string[];
}

export interface MessageContent {
  text?: string;
  media?: MediaAttachment[];
  sticker?: StickerInfo;
  command?: CommandInfo;
}

export interface MediaAttachment {
  type: 'photo' | 'video' | 'audio' | 'document' | 'animation';
  url?: string;
  fileId?: string; // Platform file reference
  mimeType?: string;
  size?: number;
}

export interface StickerInfo {
  fileId: string;
  emoji?: string;
  setName?: string;
  isAnimated: boolean;
}

export interface CommandInfo {
  command: string; // Without leading /
  args: string[];
  raw: string;
}

export interface Mention {
  userId: string;
  username?: string;
  offset: number;
  length: number;
}

/**
 * Metadata about a forwarded message (Telegram-specific)
 */
export interface ForwardMetadata {
  /** Type of forward origin */
  originType: 'user' | 'hidden_user' | 'chat' | 'channel' | 'unknown';
  /** User ID of the original sender (if available) */
  originalSenderId?: string;
  /** Username of the original sender (if available) */
  originalSenderUsername?: string;
  /** Display name of the original sender (if available) */
  originalSenderName?: string;
  /** Whether the original sender is a bot */
  originalSenderIsBot?: boolean;
  /** Whether the forward is from BotFather specifically */
  isFromBotFather: boolean;
  /** Original message date (Unix timestamp) */
  originalDate?: number;
  /** Chat ID if forwarded from a channel/group */
  originalChatId?: string;
  /** Chat title if forwarded from a channel/group */
  originalChatTitle?: string;
}

export interface EnvelopeMetadata {
  receivedAt: number;
  processedAt?: number;

  // Processing flags
  shouldRespond?: boolean;
  responseReason?: string;
  priority: 'high' | 'normal' | 'low';

  // Rate limiting
  userCooldownUntil?: number;

  // Idempotency
  idempotencyKey: string;

  // Direct engagement detection (Kyro-style)
  isMention?: boolean;      // Message contains @botUsername
  isReplyToBot?: boolean;   // Message is a reply to bot's message

  // Async continuation context
  isContinuation?: boolean;
  continuationType?: string;
  originalJobId?: string;

  // Telegram-specific context (preserved for channel state)
  chatType?: 'private' | 'group' | 'supergroup' | 'channel';
  chatTitle?: string;

  // Telegram-specific forward metadata (for detecting BotFather messages, etc.)
  forwardMetadata?: ForwardMetadata;

  // Discord-specific context
  guildId?: string;

  // Platform-specific raw update ID (for deduplication)
  platformUpdateId?: string | number;
}
