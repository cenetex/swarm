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
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
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

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const ADMIN_TABLE = process.env.ADMIN_TABLE!;

// === CONFIGURATION ===
export const CHANNEL_CONFIG = {
  // Buffer settings
  MAX_BUFFER_SIZE: 50,           // Max messages to keep in buffer
  BUFFER_TTL_SECONDS: 3600,      // 1 hour TTL for channel state

  // State machine timings
  COOLDOWN_DURATION_MS: 60000,   // 60 seconds cooldown after response (prevents spam)
  ACTIVE_TIMEOUT_MS: 120000,     // 2 minutes before ACTIVE → IDLE

  // Response triggers
  DIRECT_ENGAGEMENT_DELAY_MS: 2000,   // 2 second delay even for mentions (more cosy)
  MESSAGE_THRESHOLD: 8,                // Respond after N messages accumulated (was 5)
  CONVERSATION_GAP_MS: 45000,          // 45 seconds of silence triggers response

  // Response timing - increased for cosy vibes
  MIN_RESPONSE_DELAY_MS: 2000,    // Minimum 2s delay to seem natural
  MAX_RESPONSE_DELAY_MS: 8000,    // Maximum 8s random delay

  // Private chat rate limiting
  PRIVATE_COOLDOWN_MS: 5000,      // 5 second minimum between responses in private chats
  
  // Multi-agent stagger - delay added per agent in channel
  STAGGER_DELAY_PER_AGENT_MS: 3000,   // Add 3s delay per additional agent
  MAX_STAGGER_DELAY_MS: 15000,         // Cap stagger at 15 seconds
};

// === MULTI-AGENT DYNAMIC COOLDOWN CONFIGURATION ===
export const MULTI_AGENT_CONFIG = {
  // Initiative system
  INITIATIVE_ROUND_TIMEOUT_MS: 8000,    // 8s for all agents to roll (increased from 5s)
  REACTION_WINDOW_MS: 15000,             // 15s window for reactions after winner responds

  // Interest check - raised thresholds for less spam
  BASE_INTEREST_DC: 14,                  // Default difficulty class (increased from 10)
  MENTION_INTEREST_BONUS: 3,             // DC reduction for topic mentions (reduced from 5)
  RECENT_RESPONSE_PENALTY: 8,            // DC increase if agent responded recently (increased from 5)

  // Reaction limits
  MAX_REACTIONS_PER_MESSAGE: 2,          // Max emoji reactions per agent per message (reduced from 3)
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
 * Check if dynamic cooldown has expired (for multi-agent channels)
 */
export function isDynamicCooldownExpired(state: ChannelStateRecord): boolean {
  if (state.state !== 'COOLDOWN') return true;

  const dynamicCooldown = calculateDynamicCooldown(state);
  const elapsed = Date.now() - state.stateChangedAt;

  return elapsed > dynamicCooldown;
}

/**
 * Calculate stagger delay based on number of agents in channel.
 * This helps space out responses when multiple bots are present.
 * 
 * @param agentCount - Number of agents in the channel
 * @returns Delay in milliseconds (randomized within range)
 */
export function calculateStaggerDelay(agentCount: number): number {
  if (agentCount <= 1) {
    // Single agent: use base response delay
    return CHANNEL_CONFIG.MIN_RESPONSE_DELAY_MS + 
      Math.random() * (CHANNEL_CONFIG.MAX_RESPONSE_DELAY_MS - CHANNEL_CONFIG.MIN_RESPONSE_DELAY_MS);
  }
  
  // Multi-agent: add per-agent stagger
  const baseStagger = (agentCount - 1) * CHANNEL_CONFIG.STAGGER_DELAY_PER_AGENT_MS;
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
 * @param agentCount - Number of agents in channel
 * @returns Delay in milliseconds
 */
export function calculateThinkingDelay(
  messageLength: number,
  isFromBot: boolean,
  agentCount: number
): number {
  // Base delay
  let delay = CHANNEL_CONFIG.MIN_RESPONSE_DELAY_MS;
  
  // Add reading time (roughly 200 chars per second)
  delay += Math.min(messageLength * 5, 3000);
  
  // Extra delay for bot messages (think longer before responding to bots)
  if (isFromBot) {
    delay += 5000 + Math.random() * 5000; // 5-10s extra for bot messages
  }
  
  // Add stagger for multi-agent
  delay += calculateStaggerDelay(agentCount);
  
  // Cap at reasonable maximum
  return Math.min(delay, 20000);
}

// === CHANNEL STATE MANAGEMENT ===

/**
 * Get channel state from DynamoDB
 */
export async function getChannelState(
  agentId: string,
  chatId: number
): Promise<ChannelStateRecord | null> {
  try {
    const result = await dynamoClient.send(new GetCommand({
      TableName: ADMIN_TABLE,
      Key: {
        pk: `CHANNEL#${agentId}#${chatId}`,
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
    console.warn('[ChannelState] Failed to get channel state:', err);
    return null;
  }
}

/**
 * Create or get channel state
 */
export async function getOrCreateChannelState(
  agentId: string,
  chatId: number,
  chatType: 'private' | 'group' | 'supergroup' | 'channel',
  chatTitle?: string
): Promise<ChannelStateRecord> {
  const existing = await getChannelState(agentId, chatId);
  if (existing) return existing;

  const now = Date.now();
  const ttl = Math.floor(now / 1000) + CHANNEL_CONFIG.BUFFER_TTL_SECONDS;

  const newState: ChannelStateRecord = {
    pk: `CHANNEL#${agentId}#${chatId}`,
    sk: 'STATE',
    agentId,
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
      const fetched = await getChannelState(agentId, chatId);
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
  agentId: string,
  chatId: number,
  chatType: 'private' | 'group' | 'supergroup' | 'channel',
  chatTitle: string | undefined,
  message: BufferedMessage
): Promise<ChannelStateRecord> {
  const now = Date.now();
  const ttl = Math.floor(now / 1000) + CHANNEL_CONFIG.BUFFER_TTL_SECONDS;

  const isDirect = Boolean(message.isMention || message.isReplyToBot);
  const updateParts = [
    'messageBuffer = list_append(if_not_exists(messageBuffer, :emptyList), :newMessage)',
    'bufferSize = if_not_exists(bufferSize, :zero) + :one',
    'lastActivityAt = :now',
    'updatedAt = :now',
    '#ttl = :ttl',
    'agentId = if_not_exists(agentId, :agentId)',
    'chatId = if_not_exists(chatId, :chatId)',
    'chatType = :chatType',
  ];

  if (chatTitle) {
    updateParts.push('chatTitle = :chatTitle');
  }

  if (isDirect) {
    updateParts.push('#state = :active', 'stateChangedAt = :now', 'directEngagementAt = :now');
  } else {
    updateParts.push('#state = if_not_exists(#state, :idle)', 'stateChangedAt = if_not_exists(stateChangedAt, :now)');
  }

  const response = await dynamoClient.send(new UpdateCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: `CHANNEL#${agentId}#${chatId}`,
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
      ':agentId': agentId,
      ':chatId': chatId,
      ':chatType': chatType,
      ...(chatTitle ? { ':chatTitle': chatTitle } : {}),
      ...(isDirect ? { ':active': 'ACTIVE' } : { ':idle': 'IDLE' }),
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
          pk: `CHANNEL#${agentId}#${chatId}`,
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
        console.warn('[ChannelState] Failed to trim channel buffer:', err);
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
    console.warn('[ChannelState] Failed to save channel state:', err);
    throw err;
  }
}

/**
 * Transition channel state
 */
export async function transitionState(
  agentId: string,
  chatId: number,
  newState: ChannelState
): Promise<ChannelStateRecord | null> {
  const current = await getChannelState(agentId, chatId);
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
  agentId: string,
  chatId: number,
  responseMessageId: number,
  respondedToBotUsername?: string
): Promise<ChannelStateRecord | null> {
  const current = await getChannelState(agentId, chatId);
  if (!current) return null;

  const now = Date.now();

  // Clear the buffer of messages we've responded to
  // Keep only messages after the current response
  const updated: ChannelStateRecord = {
    ...current,
    state: 'COOLDOWN',
    stateChangedAt: now,
    lastResponseAt: now,
    lastResponseMessageId: responseMessageId,
    pendingResponseAt: undefined,
    messageBuffer: [],  // Clear buffer after response
    bufferSize: 0,
    updatedAt: now,
    ttl: Math.floor(now / 1000) + CHANNEL_CONFIG.BUFFER_TTL_SECONDS,
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

  // Check if we're in cooldown (applies to all chat types)
  const timeSinceLastResponse = state.lastResponseAt ? now - state.lastResponseAt : Infinity;
  
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
    // Check if there's a new direct engagement since cooldown started
    const hasNewEngagement = state.messageBuffer.some(
      m => (m.isMention || m.isReplyToBot) && m.timestamp > state.stateChangedAt
    );

    if (hasNewEngagement) {
      return {
        shouldRespond: true,
        trigger: 'direct_engagement',
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
  const hasDirectEngagement = state.messageBuffer.some(
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

  // In IDLE state, check other triggers
  if (state.state === 'IDLE' || isCooldownExpired(state)) {
    // Message threshold trigger
    if (state.bufferSize >= CHANNEL_CONFIG.MESSAGE_THRESHOLD) {
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
      state.bufferSize > 0 &&
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
    if (state.bufferSize >= 2) {
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

  // Process messages oldest to newest
  for (const msg of state.messageBuffer) {
    const timestamp = new Date(msg.timestamp).toLocaleTimeString();
    const userLabel = msg.username ? `@${msg.username}` : msg.userName;
    
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
    
    const line = `[${timestamp}] ${userLabel}: ${content}`;

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
  // Find the last direct engagement message
  for (let i = state.messageBuffer.length - 1; i >= 0; i--) {
    const msg = state.messageBuffer[i];
    if (msg.isMention || msg.isReplyToBot) {
      return msg;
    }
  }

  // Otherwise return the most recent message
  return state.messageBuffer[state.messageBuffer.length - 1] || null;
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
// SHARED CHANNEL HISTORY (Multi-Agent)
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
    console.warn('[SharedHistory] Failed to get shared history:', err);
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
      agentId: message.agentId,
      messageId: message.messageId,
      totalMessages: messages.length,
    });
  } catch (err) {
    console.error('[SharedHistory] Failed to record bot message:', err);
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
  currentAgentId: string,
  maxTokens: number = 4000
): string {
  // Combine human messages and bot messages
  const allMessages: Array<{
    timestamp: number;
    isBot: boolean;
    userName: string;
    username?: string;
    text: string;
    agentId?: string;
  }> = [];

  // Add human messages from buffer
  for (const msg of state.messageBuffer) {
    allMessages.push({
      timestamp: msg.timestamp,
      isBot: false,
      userName: msg.userName,
      username: msg.username,
      text: msg.text,
    });
  }

  // Add bot messages from shared history (excluding self)
  if (sharedHistory) {
    for (const msg of sharedHistory.messages) {
      // Skip messages from self - agent already knows what it said
      if (msg.agentId === currentAgentId) continue;
      
      allMessages.push({
        timestamp: msg.timestamp,
        isBot: true,
        userName: msg.botUsername,
        username: msg.botUsername,
        text: msg.text,
        agentId: msg.agentId,
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
