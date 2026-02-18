/**
 * State types - channel state machine, response triggers, context messages
 */
import type { Platform } from './platform.js';

// =============================================================================
// STATE TYPES
// =============================================================================

/**
 * Channel state machine states (Kyro-style)
 */
export type ChannelStateMachine = 'IDLE' | 'ACTIVE' | 'COOLDOWN';

/**
 * Response trigger types
 */
export type ResponseTrigger =
  | 'direct_engagement'    // Mention or reply to bot
  | 'engaged_user'         // Follow-up from recently engaged user
  | 'message_threshold'    // N messages accumulated
  | 'conversation_gap'     // Silence after activity
  | 'scheduled'            // Scheduled evaluation
  | 'private_chat'         // Always respond in private
  | 'none';                // No trigger

/**
 * Response decision from evaluateResponseTrigger
 */
export interface ResponseDecision {
  shouldRespond: boolean;
  trigger: ResponseTrigger;
  delay: number;           // Delay in ms before responding (0 = immediate)
  priority: 'high' | 'normal' | 'low';
}

export interface ChannelState {
  avatarId: string;
  channelId: string;
  platform: Platform;

  // Recent messages for context
  recentMessages: ContextMessage[];

  // Conversation summary
  summary?: string;
  summaryUpdatedAt?: number;

  // Channel metadata
  lastActivityAt: number;
  messageCount: number;

  // === Kyro-style state machine fields ===

  // State machine
  state?: ChannelStateMachine;
  stateChangedAt?: number;

  // Chat context (Telegram-specific)
  chatType?: 'private' | 'group' | 'supergroup' | 'channel';
  chatTitle?: string;

  // Response tracking
  lastResponseAt?: number;
  lastResponseMessageId?: string;
  pendingResponseAt?: number;  // Scheduled response time

  // Engagement tracking
  directEngagementAt?: number;  // Last mention/reply timestamp

  // Engaged users tracking: { [userId]: engagedUntil timestamp }
  engagedUsers?: Record<string, number>;

  // TTL for cleanup (DynamoDB TTL in seconds)
  ttl?: number;
}

export interface ContextMessage {
  messageId: string;
  sender: string;
  isBot: boolean;
  content: string;
  timestamp: number;

  // Extended fields for Kyro-style context
  userId?: string;
  username?: string;
  isMention?: boolean;
  isReplyToBot?: boolean;
  replyToMessageId?: string;
}

export interface UserCooldown {
  avatarId: string;
  platform: Platform;
  userId: string;
  cooldownUntil: number;
  reason?: string;
}
