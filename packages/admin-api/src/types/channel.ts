/**
 * Channel state types — Telegram channel state machine, chat modifications, home channels
 */

// === CHANNEL STATE (Kyro-style architecture) ===

// Channel state machine states
export type ChannelState = 'IDLE' | 'ACTIVE' | 'COOLDOWN';

// Media attachment in a buffered message
export interface BufferedMedia {
  type: 'photo' | 'video' | 'animation' | 'document' | 'sticker';
  fileId: string;
  mimeType?: string;
}

// Buffered message in a channel
export interface BufferedMessage {
  messageId: number;
  userId: number;
  userName: string;
  username?: string;
  text: string;
  timestamp: number;
  replyToMessageId?: number;
  replyToUserId?: number;
  replyToUserName?: string;
  replyToUsername?: string;
  replyToText?: string;
  isMention?: boolean;
  isReplyToBot?: boolean;
  media?: BufferedMedia[];
  // Bot-to-bot interaction tracking
  isFromBot?: boolean;           // True if sender is a bot
  senderBotUsername?: string;    // Bot username if isFromBot
}

// Channel state record stored in DynamoDB
export interface ChannelStateRecord {
  pk: string;              // CHANNEL#{avatarId}#{chatId}
  sk: string;              // STATE
  avatarId: string;
  chatId: number;
  chatType: 'private' | 'group' | 'supergroup' | 'channel';
  chatTitle?: string;

  // State machine
  state: ChannelState;
  stateChangedAt: number;

  // Message buffer (last N messages)
  messageBuffer: BufferedMessage[];
  bufferSize: number;

  // Response tracking
  lastResponseAt?: number;
  lastResponseMessageId?: number;
  pendingResponseAt?: number;  // Scheduled response time

  // Bot-to-bot interaction tracking
  lastBotResponseAt?: number;     // Last time we responded to a bot message
  lastBotRespondedTo?: string;    // Username of last bot we responded to

  // Engagement tracking
  directEngagementAt?: number;  // Last mention/reply

  // Sticky engagement window (after mention/reply, stay responsive to the engager)
  stickyEngagementUserId?: number;
  stickyEngagementUntil?: number;
  stickyEngagementRemaining?: number;
  lastActivityAt: number;

  // TTL for cleanup
  ttl: number;
  updatedAt: number;
}

// Response trigger types
export type ResponseTrigger =
  | 'direct_engagement'    // Mention or reply to bot
  | 'sticky_followup'      // Follow-up messages after a mention/reply
  | 'message_threshold'    // N messages accumulated
  | 'conversation_gap'     // Silence after activity
  | 'scheduled'            // Scheduled evaluation
  | 'private_chat';        // Always respond in private

// Response decision
export interface ResponseDecision {
  shouldRespond: boolean;
  trigger: ResponseTrigger | 'none';
  delay: number;           // Delay in ms before responding (0 = immediate)
  priority: 'high' | 'normal' | 'low';
}

// ============================================================================
// Chat Modification Voting System
// ============================================================================

/**
 * Types of chat modifications that require voting
 */
export type ChatModificationType = 'photo' | 'description' | 'title';

/**
 * Status of a chat modification proposal
 */
export type ChatModificationStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'expired';

/**
 * Chat modification proposal record
 * Tracks proposals for changing chat photo, description, or title
 * Key: pk=CHAT_VOTE#{chatId}, sk=PROPOSAL#{proposalId}
 */
export interface ChatModificationProposal {
  pk: string;              // CHAT_VOTE#{chatId}
  sk: string;              // PROPOSAL#{proposalId}
  proposalId: string;      // UUID
  chatId: number;
  type: ChatModificationType;

  // Proposal details
  proposedBy: string;      // Avatar ID who proposed
  proposedAt: number;      // Timestamp

  // What to change
  newValue: string;        // URL for photo, text for description/title
  currentValue?: string;   // Current value for reference
  reason?: string;         // Why the change is proposed

  // Voting
  status: ChatModificationStatus;
  votes: Record<string, {
    avatarId: string;
    vote: 'approve' | 'reject';
    votedAt: number;
    comment?: string;
  }>;
  requiredVotes: number;   // Number of avatars that need to approve

  // Execution
  executedAt?: number;
  executedBy?: string;

  ttl: number;             // Auto-cleanup after 7 days
}

/**
 * Chat modification rate limit record
 * Tracks when modifications were last made to enforce weekly limit
 * Key: pk=CHAT_MOD_LIMIT#{chatId}, sk=TYPE#{type}
 */
export interface ChatModificationLimit {
  pk: string;              // CHAT_MOD_LIMIT#{chatId}
  sk: string;              // TYPE#{type}
  chatId: number;
  type: ChatModificationType;
  lastModifiedAt: number;  // Timestamp of last successful modification
  lastModifiedBy: string;  // Avatar ID
  proposalId: string;      // Reference to the approved proposal
  ttl: number;             // Auto-cleanup after 30 days
}

// ============================================================================
// Home Channel Registry (for multi-bot channel filtering)
// ============================================================================

/**
 * Home channel record
 * Tracks which chat IDs are "home channels" for any ratibot avatar.
 * Avatars can only respond in their own home channel OR home channels of other ratibots.
 * Key: pk=HOME_CHANNELS, sk={chatId}
 */
export interface HomeChannelRecord {
  pk: string;              // "HOME_CHANNELS"
  sk: string;              // "{chatId}" (e.g., "-1001234567890")
  chatId: string;          // Chat ID as string
  avatarId: string;        // Avatar that owns this home channel
  botUsername: string;     // Bot username for reference
  /**
   * Avatars that have registered this chat as a home/allowed channel.
   * Includes the owner avatar.
   */
  registeredAvatars?: Array<{ avatarId: string; botUsername: string }>;
  channelUsername?: string; // Channel @username without @ (e.g., "ratibots")
  channelTitle?: string;   // Human-readable title
  registeredAt: number;    // When first registered
  updatedAt: number;       // Last update timestamp
}
