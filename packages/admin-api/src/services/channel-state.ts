/**
 * Channel State Service
 * Kyro-style channel-aware messaging with message buffering and state machine
 *
 * Architecture:
 * - Messages are buffered per channel (not responded to individually)
 * - State machine: IDLE → ACTIVE → COOLDOWN
 * - Response triggers: direct engagement, message threshold, conversation gap
 * - Responds to CHANNEL with full context, not individual messages
 */
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type {
  ChannelState,
  ChannelStateRecord,
  BufferedMessage,
  ResponseDecision,
  SharedChannelMessage,
  SharedChannelHistoryRecord,
} from '../types.js';
import { getDynamoClient } from './dynamo-client.js';

const dynamoClient = getDynamoClient();
const ADMIN_TABLE = process.env.ADMIN_TABLE!;

// === CONFIGURATION ===
export const CHANNEL_CONFIG = {
  // Buffer settings
  MAX_BUFFER_SIZE: 50,          // Max messages to keep in buffer
  BUFFER_TTL_SECONDS: 3600,      // 1 hour TTL for channel state

  // Context retention
  POST_RESPONSE_CONTEXT_KEEP_MESSAGES: 20, // Keep last N messages for continuity after responding

  // Sticky engagement (after mention/reply, respond to next few messages)
  STICKY_ENGAGEMENT_WINDOW_MS: 120000,      // 2 minutes
  STICKY_ENGAGEMENT_MAX_MESSAGES: 3,        // respond to next N messages from engager
  STICKY_MIN_REPLY_INTERVAL_MS: 1500,       // avoid rapid-fire replies

  // State machine timings
  COOLDOWN_DURATION_MS: 60000,   // 60 seconds cooldown after response (prevents spam)
  ACTIVE_TIMEOUT_MS: 120000,     // 2 minutes before ACTIVE → IDLE

  // Response triggers
  DIRECT_ENGAGEMENT_DELAY_MS: 2000,   // 2 second delay even for mentions (more cosy)
  MESSAGE_THRESHOLD: 6,                // Respond after N messages accumulated
  CONVERSATION_GAP_MS: 45000,          // 45 seconds of silence triggers response

  // Response timing - increased for cosy vibes
  MIN_RESPONSE_DELAY_MS: 2000,    // Minimum 2s delay to seem natural
  MAX_RESPONSE_DELAY_MS: 8000,    // Maximum 8s random delay

  // Private chat rate limiting
  PRIVATE_COOLDOWN_MS: 5000,      // 5 second minimum between responses in private chats
  
  // Multi-avatar stagger - delay added per avatar in channel
  STAGGER_DELAY_PER_AGENT_MS: 3000,   // Add 3s delay per additional avatar
  MAX_STAGGER_DELAY_MS: 15000,         // Cap stagger at 15 seconds
};

// === MULTI-AGENT DYNAMIC COOLDOWN CONFIGURATION ===
export const MULTI_AGENT_CONFIG = {
  // Initiative system
  INITIATIVE_ROUND_TIMEOUT_MS: 8000,    // 8s for all avatars to roll (increased from 5s)
  REACTION_WINDOW_MS: 15000,             // 15s window for reactions after winner responds

  // Interest check - raised thresholds for less spam
  BASE_INTEREST_DC: 14,                  // Default difficulty class (increased from 10)
  MENTION_INTEREST_BONUS: 3,             // DC reduction for topic mentions (reduced from 5)
  RECENT_RESPONSE_PENALTY: 8,            // DC increase if avatar responded recently (increased from 5)

  // Reaction limits
  MAX_REACTIONS_PER_MESSAGE: 2,          // Max emoji reactions per avatar per message (reduced from 3)
  REACTION_COOLDOWN_MS: 10000,           // Min time between reactions (increased from 5000)

  // Dynamic cooldown settings - increased for cosy vibes
  BASE_COOLDOWN_MS: 60000,               // Base cooldown (60 seconds, up from 30)
  MIN_COOLDOWN_MS: 20000,                // Minimum cooldown during high activity (20 seconds)
  MAX_COOLDOWN_MS: 180000,               // Maximum cooldown during quiet periods (3 minutes)
  ACTIVITY_WINDOW_MS: 300000,            // 5 minute window for activity measurement
  MESSAGES_FOR_SHORT_COOLDOWN: 30,       // Messages in window for minimum cooldown (increased from 20)
  QUIET_THRESHOLD_MS: 90000,             // 90 seconds of silence = "quiet" (increased from 60)
  
  // Bot-to-bot interaction settings
  BOT_MESSAGE_INTEREST_DC_BONUS: 4,      // Extra DC for responding to bot messages
  BOT_RESPONSE_RATE_LIMIT_MS: 120000,    // 2 minute cooldown between responding to bots
};

// === SHARED HISTORY CONFIGURATION ===
export const SHARED_HISTORY_CONFIG = {
  MAX_MESSAGES: 30,                      // Max bot messages to keep in shared history
  TTL_SECONDS: 3600,                     // 1 hour TTL for shared history
};

/**
 * Calculate dynamic cooldown based on channel activity.
 *
 * - High activity (20+ msgs in 5 min): 10s cooldown
 * - Normal activity: 30s base cooldown
 * - Quiet (60s+ silence): up to 120s cooldown
 *
 * @param state - Current channel state
 * @returns Cooldown duration in milliseconds
 */
export function calculateDynamicCooldown(state: ChannelStateRecord): number {
  const now = Date.now();
  const windowStart = now - MULTI_AGENT_CONFIG.ACTIVITY_WINDOW_MS;

  // Count human messages in activity window
  const recentHumanMessages = state.messageBuffer.filter(
    m => m.timestamp > windowStart
  ).length;

  // Time since last activity
  const timeSinceLastActivity = now - state.lastActivityAt;

  // High activity: shorter cooldown
  if (recentHumanMessages >= MULTI_AGENT_CONFIG.MESSAGES_FOR_SHORT_COOLDOWN) {
    return MULTI_AGENT_CONFIG.MIN_COOLDOWN_MS;
  }

  // Quiet channel: longer cooldown
  if (timeSinceLastActivity > MULTI_AGENT_CONFIG.QUIET_THRESHOLD_MS) {
    const quietMultiplier = Math.min(
      4,
      1 + (timeSinceLastActivity / MULTI_AGENT_CONFIG.QUIET_THRESHOLD_MS)
    );
    return Math.min(
      MULTI_AGENT_CONFIG.MAX_COOLDOWN_MS,
      Math.floor(MULTI_AGENT_CONFIG.BASE_COOLDOWN_MS * quietMultiplier)
    );
  }

  // Normal activity: scale cooldown inversely with message count
  const activityRatio = recentHumanMessages / MULTI_AGENT_CONFIG.MESSAGES_FOR_SHORT_COOLDOWN;
  const cooldown = MULTI_AGENT_CONFIG.BASE_COOLDOWN_MS * (1 - activityRatio * 0.5);

  return Math.max(MULTI_AGENT_CONFIG.MIN_COOLDOWN_MS, Math.floor(cooldown));
}

/**
 * Check if dynamic cooldown has expired (for multi-avatar channels)
 */
export function isDynamicCooldownExpired(state: ChannelStateRecord): boolean {
  if (state.state !== 'COOLDOWN') return true;

  const dynamicCooldown = calculateDynamicCooldown(state);
  const elapsed = Date.now() - state.stateChangedAt;

  return elapsed > dynamicCooldown;
}

/**
 * Calculate stagger delay based on number of avatars in channel.
 * This helps space out responses when multiple bots are present.
 * 
 * @param avatarCount - Number of avatars in the channel
 * @returns Delay in milliseconds (randomized within range)
 */
export function calculateStaggerDelay(avatarCount: number): number {
  if (avatarCount <= 1) {
    // Single avatar: use base response delay
    return CHANNEL_CONFIG.MIN_RESPONSE_DELAY_MS + 
      Math.random() * (CHANNEL_CONFIG.MAX_RESPONSE_DELAY_MS - CHANNEL_CONFIG.MIN_RESPONSE_DELAY_MS);
  }
  
  // Multi-avatar: add per-avatar stagger
  const baseStagger = (avatarCount - 1) * CHANNEL_CONFIG.STAGGER_DELAY_PER_AGENT_MS;
  const cappedStagger = Math.min(baseStagger, CHANNEL_CONFIG.MAX_STAGGER_DELAY_MS);
  
  // Add randomization to prevent deterministic ordering
  const randomFactor = 0.5 + Math.random(); // 0.5x to 1.5x
  const totalDelay = CHANNEL_CONFIG.MIN_RESPONSE_DELAY_MS + (cappedStagger * randomFactor);
  
  return Math.floor(totalDelay);
}

/**
 * Calculate a natural "thinking" delay for cosy conversation pacing.
 * Longer delays for longer messages, bot messages, etc.
 * 
 * @param messageLength - Length of the incoming message
 * @param isFromBot - Whether the triggering message is from a bot
 * @param avatarCount - Number of avatars in channel
 * @returns Delay in milliseconds
 */
export function calculateThinkingDelay(
  messageLength: number,
  isFromBot: boolean,
  avatarCount: number
): number {
  // Base delay
  let delay = CHANNEL_CONFIG.MIN_RESPONSE_DELAY_MS;
  
  // Add reading time (roughly 200 chars per second)
  delay += Math.min(messageLength * 5, 3000);
  
  // Extra delay for bot messages (think longer before responding to bots)
  if (isFromBot) {
    delay += 5000 + Math.random() * 5000; // 5-10s extra for bot messages
  }
  
  // Add stagger for multi-avatar
  delay += calculateStaggerDelay(avatarCount);
  
  // Cap at reasonable maximum
  return Math.min(delay, 20000);
}

// === CHANNEL STATE MANAGEMENT ===

/**
 * Get channel state from DynamoDB
 */
export async function getChannelState(
  avatarId: string,
  chatId: number
): Promise<ChannelStateRecord | null> {
  try {
    const result = await dynamoClient.send(new GetCommand({
      TableName: ADMIN_TABLE,
      Key: {
        pk: `CHANNEL#${avatarId}#${chatId}`,
        sk: 'STATE',
      },
    }));

    if (!result.Item) return null;

    // Check TTL
    const record = result.Item as ChannelStateRecord;
    if (record.ttl && Date.now() / 1000 > record.ttl) {
      return null;
    }

    return record;
  } catch (err) {
    console.warn('[ChannelState] Failed to get channel state:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Create or get channel state
 */
export async function getOrCreateChannelState(
  avatarId: string,
  chatId: number,
  chatType: 'private' | 'group' | 'supergroup' | 'channel',
  chatTitle?: string
): Promise<ChannelStateRecord> {
  const existing = await getChannelState(avatarId, chatId);
  if (existing) return existing;

  const now = Date.now();
  const ttl = Math.floor(now / 1000) + CHANNEL_CONFIG.BUFFER_TTL_SECONDS;

  const newState: ChannelStateRecord = {
    pk: `CHANNEL#${avatarId}#${chatId}`,
    sk: 'STATE',
    avatarId,
    chatId,
    chatType,
    chatTitle,
    state: 'IDLE',
    stateChangedAt: now,
    messageBuffer: [],
    bufferSize: 0,
    lastActivityAt: now,
    ttl,
    updatedAt: now,
  };

  try {
    await dynamoClient.send(new PutCommand({
      TableName: ADMIN_TABLE,
      Item: newState,
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
  } catch (err: unknown) {
    // If already exists (race condition), fetch it
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      const fetched = await getChannelState(avatarId, chatId);
      if (fetched) return fetched;
    }
    throw err;
  }

  return newState;
}

/**
 * Add message to channel buffer
 */
export async function addMessageToBuffer(
  avatarId: string,
  chatId: number,
  chatType: 'private' | 'group' | 'supergroup' | 'channel',
  chatTitle: string | undefined,
  message: BufferedMessage
): Promise<ChannelStateRecord> {
  const now = Date.now();
  const ttl = Math.floor(now / 1000) + CHANNEL_CONFIG.BUFFER_TTL_SECONDS;

  const isDirect = Boolean(message.isMention || message.isReplyToBot);
  const stickyUntil = isDirect
    ? now + CHANNEL_CONFIG.STICKY_ENGAGEMENT_WINDOW_MS
    : undefined;
  const updateParts = [
    'messageBuffer = list_append(if_not_exists(messageBuffer, :emptyList), :newMessage)',
    'bufferSize = if_not_exists(bufferSize, :zero) + :one',
    'lastActivityAt = :now',
    'updatedAt = :now',
    '#ttl = :ttl',
    'avatarId = if_not_exists(avatarId, :avatarId)',
    'chatId = if_not_exists(chatId, :chatId)',
    'chatType = :chatType',
  ];

  if (chatTitle) {
    updateParts.push('chatTitle = :chatTitle');
  }

  if (isDirect) {
    updateParts.push(
      '#state = :active',
      'stateChangedAt = :now',
      'directEngagementAt = :now',
      'stickyEngagementUserId = :stickyUserId',
      'stickyEngagementUntil = :stickyUntil',
      'stickyEngagementRemaining = :stickyRemaining'
    );
  } else {
    updateParts.push('#state = if_not_exists(#state, :idle)', 'stateChangedAt = if_not_exists(stateChangedAt, :now)');
  }

  const response = await dynamoClient.send(new UpdateCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: `CHANNEL#${avatarId}#${chatId}`,
      sk: 'STATE',
    },
    UpdateExpression: `SET ${updateParts.join(', ')}`,
    ExpressionAttributeNames: {
      '#state': 'state',
      '#ttl': 'ttl',
    },
    ExpressionAttributeValues: {
      ':emptyList': [],
      ':newMessage': [message],
      ':zero': 0,
      ':one': 1,
      ':now': now,
      ':ttl': ttl,
      ':avatarId': avatarId,
      ':chatId': chatId,
      ':chatType': chatType,
      ...(chatTitle ? { ':chatTitle': chatTitle } : {}),
      ...(isDirect ? { ':active': 'ACTIVE' } : { ':idle': 'IDLE' }),
      ...(isDirect ? {
        ':stickyUserId': message.userId,
        ':stickyUntil': stickyUntil,
        ':stickyRemaining': CHANNEL_CONFIG.STICKY_ENGAGEMENT_MAX_MESSAGES,
      } : {}),
    },
    ReturnValues: 'ALL_NEW',
  }));

  let updated = response.Attributes as ChannelStateRecord;

  if ((updated.messageBuffer?.length || 0) > CHANNEL_CONFIG.MAX_BUFFER_SIZE) {
    const trimmedBuffer = updated.messageBuffer.slice(-CHANNEL_CONFIG.MAX_BUFFER_SIZE);
    const trimmedAt = Date.now();

    try {
      await dynamoClient.send(new UpdateCommand({
        TableName: ADMIN_TABLE,
        Key: {
          pk: `CHANNEL#${avatarId}#${chatId}`,
          sk: 'STATE',
        },
        UpdateExpression: 'SET messageBuffer = :buffer, bufferSize = :size, updatedAt = :updatedAt, #ttl = :ttl',
        ConditionExpression: 'updatedAt = :expectedUpdatedAt',
        ExpressionAttributeNames: {
          '#ttl': 'ttl',
        },
        ExpressionAttributeValues: {
          ':buffer': trimmedBuffer,
          ':size': trimmedBuffer.length,
          ':updatedAt': trimmedAt,
          ':ttl': ttl,
          ':expectedUpdatedAt': updated.updatedAt,
        },
      }));

      updated = {
        ...updated,
        messageBuffer: trimmedBuffer,
        bufferSize: trimmedBuffer.length,
        updatedAt: trimmedAt,
        ttl,
      };
    } catch (err: unknown) {
      if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') {
        console.warn('[ChannelState] Failed to trim channel buffer:', err instanceof Error ? err.message : String(err));
      }
    }
  }

  return updated;
}

/**
 * Save channel state to DynamoDB
 */
export async function saveChannelState(
  state: ChannelStateRecord
): Promise<void> {
  try {
    await dynamoClient.send(new PutCommand({
      TableName: ADMIN_TABLE,
      Item: state,
    }));
  } catch (err) {
    console.warn('[ChannelState] Failed to save channel state:', err instanceof Error ? err.message : String(err));
    throw err;
  }
}

/**
 * Transition channel state
 */
export async function transitionState(
  avatarId: string,
  chatId: number,
  newState: ChannelState
): Promise<ChannelStateRecord | null> {
  const current = await getChannelState(avatarId, chatId);
  if (!current) return null;

  const now = Date.now();
  const updated: ChannelStateRecord = {
    ...current,
    state: newState,
    stateChangedAt: now,
    updatedAt: now,
    ttl: Math.floor(now / 1000) + CHANNEL_CONFIG.BUFFER_TTL_SECONDS,
  };

  await saveChannelState(updated);
  return updated;
}

/**
 * Mark response sent - transitions to COOLDOWN and clears relevant state
 * @param respondedToBotUsername - If set, tracks that we responded to a bot message
 */
export async function markResponseSent(
  avatarId: string,
  chatId: number,
  responseMessageId: number,
  options?: { trigger?: string; respondedToBotUsername?: string }
): Promise<ChannelStateRecord | null> {
  const current = await getChannelState(avatarId, chatId);
  if (!current) return null;

  const now = Date.now();

  // Keep a small tail of the buffer for continuity, but rely on lastResponseAt
  // to ensure we don't re-trigger on old messages.
  const keepCount = current.chatType === 'private'
    ? 0
    : CHANNEL_CONFIG.POST_RESPONSE_CONTEXT_KEEP_MESSAGES;
  const keptBuffer = keepCount > 0
    ? current.messageBuffer.slice(-keepCount)
    : [];

  const trigger = options?.trigger;
  const respondedToBotUsername = options?.respondedToBotUsername;

  const stickyActive =
    typeof current.stickyEngagementUntil === 'number' &&
    current.stickyEngagementUntil > now &&
    (current.stickyEngagementRemaining ?? 0) > 0;

  const shouldConsumeSticky = trigger === 'sticky_followup';
  const nextStickyRemaining = stickyActive && shouldConsumeSticky
    ? Math.max(0, (current.stickyEngagementRemaining ?? 0) - 1)
    : current.stickyEngagementRemaining;

  const stickyExpired =
    (typeof current.stickyEngagementUntil === 'number' && current.stickyEngagementUntil <= now) ||
    (typeof nextStickyRemaining === 'number' && nextStickyRemaining <= 0);

  const updated: ChannelStateRecord = {
    ...current,
    state: 'COOLDOWN',
    stateChangedAt: now,
    lastResponseAt: now,
    lastResponseMessageId: responseMessageId,
    pendingResponseAt: undefined,
    messageBuffer: keptBuffer,
    bufferSize: keptBuffer.length,
    updatedAt: now,
    ttl: Math.floor(now / 1000) + CHANNEL_CONFIG.BUFFER_TTL_SECONDS,
    stickyEngagementRemaining: stickyExpired ? undefined : nextStickyRemaining,
    stickyEngagementUntil: stickyExpired ? undefined : current.stickyEngagementUntil,
    stickyEngagementUserId: stickyExpired ? undefined : current.stickyEngagementUserId,
    // Track bot-to-bot interactions
    ...(respondedToBotUsername ? {
      lastBotResponseAt: now,
      lastBotRespondedTo: respondedToBotUsername,
    } : {}),
  };

  await saveChannelState(updated);
  return updated;
}

/**
 * Check if cooldown has expired
 */
export function isCooldownExpired(state: ChannelStateRecord): boolean {
  if (state.state !== 'COOLDOWN') return true;
  const elapsed = Date.now() - state.stateChangedAt;
  return elapsed > CHANNEL_CONFIG.COOLDOWN_DURATION_MS;
}

/**
 * Check if active state has timed out
 */
export function isActiveTimedOut(state: ChannelStateRecord): boolean {
  if (state.state !== 'ACTIVE') return false;
  const elapsed = Date.now() - state.lastActivityAt;
  return elapsed > CHANNEL_CONFIG.ACTIVE_TIMEOUT_MS;
}

// === RESPONSE DECISION LOGIC ===

/**
 * Evaluate whether to respond to this channel
 * Returns decision with trigger type and delay
 */
export function evaluateResponseTrigger(
  state: ChannelStateRecord,
  _botUsername?: string,
  _botId?: number
): ResponseDecision {
  // _botUsername and _botId reserved for future use (e.g., name-based triggers)
  void _botUsername;
  void _botId;
  const now = Date.now();

  const pendingMessages = getPendingMessages(state);
  const pendingCount = pendingMessages.length;
  const timeSinceLastResponse = state.lastResponseAt ? now - state.lastResponseAt : Infinity;

  const stickyActive =
    typeof state.stickyEngagementUntil === 'number' &&
    state.stickyEngagementUntil > now &&
    (state.stickyEngagementRemaining ?? 0) > 0 &&
    typeof state.stickyEngagementUserId === 'number';

  const hasStickyFollowup = stickyActive
    ? pendingMessages.some(m => m.userId === state.stickyEngagementUserId && !m.isFromBot)
    : false;

  // Check if we're in cooldown (applies to all chat types)
  // Private chats get quick responses but still have rate limiting
  if (state.chatType === 'private') {
    // Respect minimum cooldown even in private chats
    if (timeSinceLastResponse < CHANNEL_CONFIG.PRIVATE_COOLDOWN_MS) {
      return {
        shouldRespond: false,
        trigger: 'none',
        delay: 0,
        priority: 'low',
      };
    }
    
    return {
      shouldRespond: true,
      trigger: 'private_chat',
      delay: CHANNEL_CONFIG.DIRECT_ENGAGEMENT_DELAY_MS,
      priority: 'high',
    };
  }

  // In COOLDOWN - don't respond unless there's new direct engagement
  if (state.state === 'COOLDOWN' && !isCooldownExpired(state)) {
    // Check if there's a new direct engagement since the last response
    const hasNewEngagement = pendingMessages.some(
      m => m.isMention || m.isReplyToBot
    );

    if (hasNewEngagement) {
      return {
        shouldRespond: true,
        trigger: 'direct_engagement',
        delay: CHANNEL_CONFIG.DIRECT_ENGAGEMENT_DELAY_MS,
        priority: 'high',
      };
    }

    // Sticky follow-up: allow a few follow-up messages from the engager
    if (hasStickyFollowup && timeSinceLastResponse >= CHANNEL_CONFIG.STICKY_MIN_REPLY_INTERVAL_MS) {
      return {
        shouldRespond: true,
        trigger: 'sticky_followup',
        delay: CHANNEL_CONFIG.DIRECT_ENGAGEMENT_DELAY_MS,
        priority: 'high',
      };
    }

    return {
      shouldRespond: false,
      trigger: 'none',
      delay: 0,
      priority: 'low',
    };
  }

  // Check for direct engagement (mention/reply)
  const hasDirectEngagement = pendingMessages.some(
    m => m.isMention || m.isReplyToBot
  );

  if (hasDirectEngagement) {
    return {
      shouldRespond: true,
      trigger: 'direct_engagement',
      delay: CHANNEL_CONFIG.DIRECT_ENGAGEMENT_DELAY_MS,
      priority: 'high',
    };
  }

  // Sticky follow-up (outside cooldown)
  if (hasStickyFollowup && timeSinceLastResponse >= CHANNEL_CONFIG.STICKY_MIN_REPLY_INTERVAL_MS) {
    return {
      shouldRespond: true,
      trigger: 'sticky_followup',
      delay: CHANNEL_CONFIG.DIRECT_ENGAGEMENT_DELAY_MS,
      priority: 'high',
    };
  }

  // In IDLE state, check other triggers
  if (state.state === 'IDLE' || isCooldownExpired(state)) {
    // Message threshold trigger
    if (pendingCount >= CHANNEL_CONFIG.MESSAGE_THRESHOLD) {
      return {
        shouldRespond: true,
        trigger: 'message_threshold',
        delay: randomDelay(),
        priority: 'normal',
      };
    }

    // Conversation gap trigger (activity followed by silence)
    const timeSinceActivity = now - state.lastActivityAt;
    if (
      pendingCount > 0 &&
      timeSinceActivity > CHANNEL_CONFIG.CONVERSATION_GAP_MS
    ) {
      return {
        shouldRespond: true,
        trigger: 'conversation_gap',
        delay: 0,
        priority: 'normal',
      };
    }
  }

  // ACTIVE state but no trigger met yet
  if (state.state === 'ACTIVE') {
    // If we've been active for a while with messages, consider responding
    if (pendingCount >= 2) {
      return {
        shouldRespond: true,
        trigger: 'message_threshold',
        delay: randomDelay(),
        priority: 'normal',
      };
    }
  }

  return {
    shouldRespond: false,
    trigger: 'none',
    delay: 0,
    priority: 'low',
  };
}

/**
 * Generate a natural-feeling random delay
 */
function randomDelay(): number {
  return Math.floor(
    CHANNEL_CONFIG.MIN_RESPONSE_DELAY_MS +
    Math.random() * (CHANNEL_CONFIG.MAX_RESPONSE_DELAY_MS - CHANNEL_CONFIG.MIN_RESPONSE_DELAY_MS)
  );
}

// === CONTEXT BUILDING ===

/**
 * Build conversation context from buffered messages
 * Formats all messages in buffer for LLM context
 */
export function buildConversationContext(
  state: ChannelStateRecord,
  maxTokens: number = 4000
): string {
  if (state.messageBuffer.length === 0) {
    return '';
  }

  const lines: string[] = [];
  let approxTokens = 0;

  const truncate = (value: string, maxLen: number): string => {
    if (value.length <= maxLen) return value;
    return `${value.slice(0, Math.max(0, maxLen - 1))}…`;
  };

  // Process messages oldest to newest
  for (const msg of state.messageBuffer) {
    const timestamp = new Date(msg.timestamp).toLocaleTimeString();
    const baseUserLabel = msg.username ? `@${msg.username}` : msg.userName;
    const userLabel = msg.isFromBot ? `🤖 ${baseUserLabel}` : baseUserLabel;
    
    // Build message content with media indicators
    let content = msg.text;
    if (msg.media && msg.media.length > 0) {
      const mediaLabels = msg.media.map(m => {
        switch (m.type) {
          case 'photo': return '📷 [photo]';
          case 'video': return '🎥 [video]';
          case 'animation': return '🎬 [GIF]';
          case 'sticker': return '🎭 [sticker]';
          case 'document': return '📎 [file]';
          default: return '[media]';
        }
      });
      content = content ? `${content} ${mediaLabels.join(' ')}` : mediaLabels.join(' ');
    }
    
    let replySuffix = '';
    if (typeof msg.replyToMessageId === 'number') {
      const repliedTo = state.messageBuffer.find(m => m.messageId === msg.replyToMessageId);
      const replyUserLabel = repliedTo?.username
        ? `@${repliedTo.username}`
        : (msg.replyToUsername ? `@${msg.replyToUsername}` : (msg.replyToUserName ? `@${msg.replyToUserName}` : undefined));
      const replyText = repliedTo?.text || msg.replyToText;

      if (replyUserLabel && replyText) {
        replySuffix = ` (reply to ${replyUserLabel}: "${truncate(replyText, 120)}")`;
      } else if (replyUserLabel) {
        replySuffix = ` (reply to ${replyUserLabel})`;
      }
    }

    const line = `[${timestamp}] ${userLabel}${replySuffix}: ${content}`;

    // Rough token estimate (4 chars = 1 token)
    const lineTokens = Math.ceil(line.length / 4);

    if (approxTokens + lineTokens > maxTokens) {
      break;
    }

    lines.push(line);
    approxTokens += lineTokens;
  }

  return lines.join('\n');
}

/**
 * Get the most recent message that triggered response (for reply targeting)
 */
export function getResponseTarget(
  state: ChannelStateRecord
): BufferedMessage | null {
  const pending = getPendingMessages(state);
  const candidates = pending.length > 0 ? pending : state.messageBuffer;

  // If sticky engagement is active, prefer replying to the engager's latest message
  const stickyActive =
    typeof state.stickyEngagementUntil === 'number' &&
    state.stickyEngagementUntil > Date.now() &&
    (state.stickyEngagementRemaining ?? 0) > 0 &&
    typeof state.stickyEngagementUserId === 'number';

  if (stickyActive) {
    for (let i = candidates.length - 1; i >= 0; i--) {
      const msg = candidates[i];
      if (msg.userId === state.stickyEngagementUserId && !msg.isFromBot) {
        return msg;
      }
    }
  }

  // Find the last direct engagement message in the pending/candidate set
  for (let i = candidates.length - 1; i >= 0; i--) {
    const msg = candidates[i];
    if (msg.isMention || msg.isReplyToBot) {
      return msg;
    }
  }

  // Otherwise return the most recent message
  return candidates[candidates.length - 1] || null;
}

function getPendingMessages(state: ChannelStateRecord): BufferedMessage[] {
  if (!state.lastResponseAt) return state.messageBuffer;
  return state.messageBuffer.filter(m => m.timestamp > state.lastResponseAt!);
}

/**
 * Get users actively participating in the conversation
 * Useful for the LLM to know who's talking
 */
export function getActiveParticipants(
  state: ChannelStateRecord
): Array<{ userId: number; userName: string; username?: string; messageCount: number }> {
  const participants = new Map<number, { userName: string; username?: string; messageCount: number }>();

  for (const msg of state.messageBuffer) {
    const existing = participants.get(msg.userId);
    if (existing) {
      existing.messageCount++;
    } else {
      participants.set(msg.userId, {
        userName: msg.userName,
        username: msg.username,
        messageCount: 1,
      });
    }
  }

  return Array.from(participants.entries())
    .map(([userId, data]) => ({ userId, ...data }))
    .sort((a, b) => b.messageCount - a.messageCount);
}

// ========================================
// SHARED CHANNEL HISTORY (Multi-Avatar)
// ========================================

/**
 * Get shared channel history - contains bot messages visible to all bots
 */
export async function getSharedHistory(
  chatId: number
): Promise<SharedChannelHistoryRecord | null> {
  try {
    const result = await dynamoClient.send(new GetCommand({
      TableName: ADMIN_TABLE,
      Key: {
        pk: `SHARED_HISTORY#${chatId}`,
        sk: 'HISTORY',
      },
    }));

    if (!result.Item) return null;

    const record = result.Item as SharedChannelHistoryRecord;
    if (record.ttl && Date.now() / 1000 > record.ttl) {
      return null;
    }

    return record;
  } catch (err) {
    console.warn('[SharedHistory] Failed to get shared history:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Record a bot's message in shared history so other bots can see it
 */
export async function recordBotMessage(
  chatId: number,
  message: SharedChannelMessage
): Promise<void> {
  const now = Date.now();
  const ttl = Math.floor(now / 1000) + SHARED_HISTORY_CONFIG.TTL_SECONDS;

  try {
    // Get existing history
    const existing = await getSharedHistory(chatId);
    
    let messages: SharedChannelMessage[];
    if (existing) {
      // Add new message and trim to max size
      messages = [...existing.messages, message];
      if (messages.length > SHARED_HISTORY_CONFIG.MAX_MESSAGES) {
        messages = messages.slice(-SHARED_HISTORY_CONFIG.MAX_MESSAGES);
      }
    } else {
      messages = [message];
    }

    // Write back
    const record: SharedChannelHistoryRecord = {
      pk: `SHARED_HISTORY#${chatId}`,
      sk: 'HISTORY',
      chatId,
      messages,
      ttl,
      updatedAt: now,
    };

    await dynamoClient.send(new PutCommand({
      TableName: ADMIN_TABLE,
      Item: record,
    }));

    console.log('[SharedHistory] Recorded bot message:', {
      chatId,
      avatarId: message.avatarId,
      messageId: message.messageId,
      totalMessages: messages.length,
    });
  } catch (err) {
    console.error('[SharedHistory] Failed to record bot message:', err instanceof Error ? err.message : String(err));
    // Don't throw - this is best-effort
  }
}

/**
 * Build combined conversation context from human messages + shared bot history
 * Interleaves messages by timestamp for natural conversation flow
 */
export function buildCombinedConversationContext(
  state: ChannelStateRecord,
  sharedHistory: SharedChannelHistoryRecord | null,
  currentAvatarId: string,
  maxTokens: number = 4000
): string {
  // Combine human messages and bot messages
  const allMessages: Array<{
    timestamp: number;
    isBot: boolean;
    userName: string;
    username?: string;
    text: string;
    avatarId?: string;
  }> = [];

  // Add human messages from buffer
  for (const msg of state.messageBuffer) {
    // Build message content with media indicators
    let content = msg.text;
    if (msg.media && msg.media.length > 0) {
      const mediaLabels = msg.media.map(m => {
        switch (m.type) {
          case 'photo': return '📷 [photo]';
          case 'video': return '🎥 [video]';
          case 'animation': return '🎬 [GIF]';
          case 'sticker': return '🎭 [sticker]';
          case 'document': return '📎 [file]';
          default: return '[media]';
        }
      });
      content = content ? `${content} ${mediaLabels.join(' ')}` : mediaLabels.join(' ');
    }

    allMessages.push({
      timestamp: msg.timestamp,
      isBot: false,
      userName: msg.userName,
      username: msg.username,
      text: content,
    });
  }

  // Add bot messages from shared history (including self for continuity)
  if (sharedHistory) {
    for (const msg of sharedHistory.messages) {
      const isSelf = msg.avatarId === currentAvatarId;
      const selfIndicator = isSelf ? ' [self]' : '';
      allMessages.push({
        timestamp: msg.timestamp,
        isBot: true,
        userName: msg.botUsername,
        username: msg.botUsername,
        text: `${msg.text}${selfIndicator}`,
        avatarId: msg.avatarId,
      });
    }
  }

  // Sort by timestamp
  allMessages.sort((a, b) => a.timestamp - b.timestamp);

  // Build context string
  const lines: string[] = [];
  let approxTokens = 0;

  for (const msg of allMessages) {
    const timestamp = new Date(msg.timestamp).toLocaleTimeString();
    const userLabel = msg.username ? `@${msg.username}` : msg.userName;
    const botIndicator = msg.isBot ? ' [bot]' : '';
    const line = `[${timestamp}] ${userLabel}${botIndicator}: ${msg.text}`;

    // Rough token estimate (4 chars = 1 token)
    const lineTokens = Math.ceil(line.length / 4);

    if (approxTokens + lineTokens > maxTokens) {
      break;
    }

    lines.push(line);
    approxTokens += lineTokens;
  }

  return lines.join('\n');
}

// ========================================
// KNOWN USERS QUERY
// ========================================

export interface KnownTelegramUser {
  userId: number;
  username?: string;
  displayName: string;
  lastSeen: number;
  chatId: number;
  chatTitle?: string;
  chatType: 'private' | 'group' | 'supergroup' | 'channel';
}

/**
 * Get all known Telegram users who have interacted with this avatar.
 * Queries all active channel states and extracts unique users.
 *
 * Since channel states have a 1-hour TTL, this returns users from recent activity only.
 */
export async function getKnownTelegramUsers(
  avatarId: string
): Promise<KnownTelegramUser[]> {
  const { ScanCommand } = await import('@aws-sdk/lib-dynamodb');

  try {
    // Scan for all channel states for this avatar
    const result = await dynamoClient.send(new ScanCommand({
      TableName: ADMIN_TABLE,
      FilterExpression: 'begins_with(pk, :prefix) AND sk = :sk',
      ExpressionAttributeValues: {
        ':prefix': `CHANNEL#${avatarId}#`,
        ':sk': 'STATE',
      },
    }));

    if (!result.Items || result.Items.length === 0) {
      return [];
    }

    // Extract unique users from all channel states
    const userMap = new Map<number, KnownTelegramUser>();
    const now = Date.now();

    for (const item of result.Items) {
      const state = item as ChannelStateRecord;

      // Skip expired records
      if (state.ttl && now / 1000 > state.ttl) continue;

      for (const msg of state.messageBuffer || []) {
        // Skip bot messages
        if (msg.isFromBot) continue;

        const existing = userMap.get(msg.userId);
        if (!existing || msg.timestamp > existing.lastSeen) {
          userMap.set(msg.userId, {
            userId: msg.userId,
            username: msg.username,
            displayName: msg.userName,
            lastSeen: msg.timestamp,
            chatId: state.chatId,
            chatTitle: state.chatTitle,
            chatType: state.chatType,
          });
        }
      }
    }

    // Sort by last seen (most recent first)
    return Array.from(userMap.values()).sort((a, b) => b.lastSeen - a.lastSeen);
  } catch (err) {
    console.warn('[ChannelState] Failed to get known Telegram users:', err instanceof Error ? err.message : String(err));
    return [];
  }
}
