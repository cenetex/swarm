import { GetCommand, PutCommand, UpdateCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type {
  ChannelState,
  ChannelStateMachine,
  ContextMessage,
  Platform,
  ResponseDecision,
} from '../../types/index.js';
import { truncateContent } from '../../utils/redact-pii.js';

// =============================================================================
// CHANNEL STATE CONFIGURATION (Kyro-style)
// =============================================================================

export const CHANNEL_CONFIG = {
  // Buffer settings
  MAX_BUFFER_SIZE: 50,          // Max messages to keep in buffer
  BUFFER_TTL_SECONDS: 7776000,  // 90 day TTL for channel state (cleanup for truly abandoned channels)

  // State machine timings
  COOLDOWN_DURATION_MS: 10000,   // 10 seconds cooldown after response
  ACTIVE_TIMEOUT_MS: 60000,      // 60 seconds before ACTIVE → IDLE

  // Response triggers
  DIRECT_ENGAGEMENT_DELAY_MS: 0,      // Immediate for mentions/replies
  MESSAGE_THRESHOLD: 3,                // Respond after N messages accumulated
  CONVERSATION_GAP_MS: 20000,          // 20 seconds of silence triggers response

  // Engaged user tracking
  ENGAGEMENT_WINDOW_MS: 5 * 60 * 1000, // 5 minutes - how long to keep responding to a user after direct engagement

  // Response rate limiting
  MAX_FOLLOW_UPS: parseInt(process.env.MAX_FOLLOW_UPS || '3', 10),         // Max consecutive follow-ups per engagement window
  AMBIENT_COOLDOWN_MS: parseInt(process.env.AMBIENT_COOLDOWN_MS || '300000', 10), // 5 minutes minimum between non-direct responses

  // Response timing
  MIN_RESPONSE_DELAY_MS: 500,     // Minimum delay to seem natural
  MAX_RESPONSE_DELAY_MS: 3000,    // Maximum random delay
};

export async function getChannelState(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  avatarId: string,
  channelId: string
): Promise<ChannelState | null> {
  const result = await docClient.send(new GetCommand({
    TableName: tableName,
    Key: {
      pk: `AVATAR#${avatarId}`,
      sk: `CHANNEL#${channelId}#STATE`,
    },
  }));

  if (!result.Item) {
    return null;
  }

  // Check TTL
  if (result.Item.ttl && Date.now() / 1000 > result.Item.ttl) {
    return null;
  }

  return {
    avatarId: result.Item.avatarId,
    channelId: result.Item.channelId,
    platform: result.Item.platform,
    recentMessages: result.Item.recentMessages || [],
    summary: result.Item.summary,
    summaryUpdatedAt: result.Item.summaryUpdatedAt,
    lastActivityAt: result.Item.lastActivityAt,
    messageCount: result.Item.messageCount || 0,
    // Kyro-style fields
    state: result.Item.state,
    stateChangedAt: result.Item.stateChangedAt,
    chatType: result.Item.chatType,
    chatTitle: result.Item.chatTitle,
    lastResponseAt: result.Item.lastResponseAt,
    lastResponseMessageId: result.Item.lastResponseMessageId,
    pendingResponseAt: result.Item.pendingResponseAt,
    directEngagementAt: result.Item.directEngagementAt,
    engagedUsers: result.Item.engagedUsers,
    followUpCountByWindow: result.Item.followUpCountByWindow,
    ttl: result.Item.ttl,
  };
}

export async function updateChannelState(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  state: ChannelState
): Promise<void> {
  const now = Date.now();
  const ttl = Math.floor(now / 1000) + CHANNEL_CONFIG.BUFFER_TTL_SECONDS;

  await docClient.send(new PutCommand({
    TableName: tableName,
    Item: {
      pk: `AVATAR#${state.avatarId}`,
      sk: `CHANNEL#${state.channelId}#STATE`,
      ...state,
      ttl: state.ttl || ttl,
      updatedAt: now,
    },
  }));
}

/**
 * Get or create channel state with Kyro-style initialization
 */
export async function getOrCreateChannelState(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  avatarId: string,
  channelId: string,
  platform: Platform,
  chatType?: 'private' | 'group' | 'supergroup' | 'channel',
  chatTitle?: string
): Promise<ChannelState> {
  const existing = await getChannelState(docClient, tableName, avatarId, channelId);
  if (existing) {
    // Update chat context if provided
    if (chatType && existing.chatType !== chatType) {
      existing.chatType = chatType;
      existing.chatTitle = chatTitle;
      await updateChannelState(docClient, tableName, existing);
    }
    return existing;
  }

  const now = Date.now();
  const newState: ChannelState = {
    avatarId,
    channelId,
    platform,
    recentMessages: [],
    lastActivityAt: now,
    messageCount: 0,
    // Kyro-style initialization
    state: 'IDLE',
    stateChangedAt: now,
    chatType,
    chatTitle,
    ttl: Math.floor(now / 1000) + CHANNEL_CONFIG.BUFFER_TTL_SECONDS,
  };

  try {
    await docClient.send(new PutCommand({
      TableName: tableName,
      Item: {
        pk: `AVATAR#${avatarId}`,
        sk: `CHANNEL#${channelId}#STATE`,
        ...newState,
        updatedAt: now,
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    }));
  } catch (err: unknown) {
    // Race condition - another request created it first
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      const fetched = await getChannelState(docClient, tableName, avatarId, channelId);
      if (fetched) return fetched;
    }
    throw err;
  }

  return newState;
}

/**
 * Add message to channel with Kyro-style state machine updates
 */
export async function addMessageToChannel(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  avatarId: string,
  channelId: string,
  platform: Platform,
  message: ContextMessage,
  maxMessages: number = CHANNEL_CONFIG.MAX_BUFFER_SIZE,
  chatType?: 'private' | 'group' | 'supergroup' | 'channel',
  chatTitle?: string
): Promise<ChannelState> {
  const now = Date.now();
  const ttl = Math.floor(now / 1000) + CHANNEL_CONFIG.BUFFER_TTL_SECONDS;
  const isDirect = Boolean(message.isMention || message.isReplyToBot);

  // Data minimization: truncate message content stored in channel state buffers.
  // Full content is available in CloudWatch logs for debugging; the state buffer
  // only needs enough context for response evaluation and conversation display.
  const truncatedMessage: ContextMessage = {
    ...message,
    content: truncateContent(message.content, 200),
  };

  const updateParts = [
    'recentMessages = list_append(if_not_exists(recentMessages, :emptyList), :newMessage)',
    'messageCount = if_not_exists(messageCount, :zero) + :one',
    'lastActivityAt = :now',
    'updatedAt = :now',
    '#ttl = :ttl',
    'avatarId = if_not_exists(avatarId, :avatarId)',
    'channelId = if_not_exists(channelId, :channelId)',
    'platform = if_not_exists(platform, :platform)',
  ];

  if (chatType) {
    updateParts.push('chatType = :chatType');
  }
  if (chatTitle) {
    updateParts.push('chatTitle = :chatTitle');
  }

  if (isDirect) {
    updateParts.push('#state = :active', 'stateChangedAt = :now', 'directEngagementAt = :now');
  } else {
    updateParts.push('#state = if_not_exists(#state, :idle)', 'stateChangedAt = if_not_exists(stateChangedAt, :now)');
  }

  // Engaged user tracking: when isDirect and we have a userId, record the sender
  // with an engagement expiry timestamp. We always set the full engagedUsers map
  // because DynamoDB doesn't support atomic map-key-level updates with cleanup in
  // a single expression. We read-then-write the engagedUsers map, which is acceptable
  // because the map is small and the engagement window is lenient.
  const expressionAttributeNames: Record<string, string> = {
    '#state': 'state',
    '#ttl': 'ttl',
  };

  // Build engaged users map: start from current state if available, add/refresh sender, clean expired
  let engagedUsersMap: Record<string, number> | undefined;
  if (isDirect && message.userId) {
    // We need to fetch current engagedUsers to merge. Read existing state if possible.
    const existing = await getChannelState(docClient, tableName, avatarId, channelId);
    const currentEngaged = existing?.engagedUsers || {};
    const engagedUntil = now + CHANNEL_CONFIG.ENGAGEMENT_WINDOW_MS;

    // Clean expired entries and add/refresh current user
    engagedUsersMap = {};
    for (const [userId, expiresAt] of Object.entries(currentEngaged)) {
      if (expiresAt > now) {
        engagedUsersMap[userId] = expiresAt;
      }
    }
    engagedUsersMap[message.userId] = engagedUntil;

    updateParts.push('engagedUsers = :engagedUsers');
  }

  const response = await docClient.send(new UpdateCommand({
    TableName: tableName,
    Key: {
      pk: `AVATAR#${avatarId}`,
      sk: `CHANNEL#${channelId}#STATE`,
    },
    UpdateExpression: `SET ${updateParts.join(', ')}`,
    ExpressionAttributeNames: expressionAttributeNames,
    ExpressionAttributeValues: {
      ':emptyList': [],
      ':newMessage': [truncatedMessage],
      ':zero': 0,
      ':one': 1,
      ':now': now,
      ':ttl': ttl,
      ':avatarId': avatarId,
      ':channelId': channelId,
      ':platform': platform,
      ...(chatType ? { ':chatType': chatType } : {}),
      ...(chatTitle ? { ':chatTitle': chatTitle } : {}),
      ...(isDirect ? { ':active': 'ACTIVE' } : { ':idle': 'IDLE' }),
      ...(engagedUsersMap ? { ':engagedUsers': engagedUsersMap } : {}),
    },
    ReturnValues: 'ALL_NEW',
  }));

  // Validate the response has expected shape
  if (!response.Attributes) {
    console.error('[State] DynamoDB UpdateCommand returned no Attributes');
    throw new Error('DynamoDB UpdateCommand returned no Attributes');
  }

  let updated: ChannelState & { updatedAt?: number } = {
    avatarId: response.Attributes.avatarId ?? avatarId,
    channelId: response.Attributes.channelId ?? channelId,
    platform: response.Attributes.platform ?? platform,
    recentMessages: response.Attributes.recentMessages ?? [],
    lastActivityAt: response.Attributes.lastActivityAt ?? now,
    messageCount: response.Attributes.messageCount ?? 0,
    state: response.Attributes.state ?? 'IDLE',
    stateChangedAt: response.Attributes.stateChangedAt,
    chatType: response.Attributes.chatType,
    chatTitle: response.Attributes.chatTitle,
    lastResponseAt: response.Attributes.lastResponseAt,
    lastResponseMessageId: response.Attributes.lastResponseMessageId,
    pendingResponseAt: response.Attributes.pendingResponseAt,
    directEngagementAt: response.Attributes.directEngagementAt,
    engagedUsers: response.Attributes.engagedUsers,
    ttl: response.Attributes.ttl,
    updatedAt: response.Attributes.updatedAt,
  };

  if ((updated.recentMessages?.length || 0) > maxMessages) {
    const trimmedMessages = updated.recentMessages.slice(-maxMessages);
    const trimmedAt = Date.now();
    const expectedUpdatedAt = updated.updatedAt ?? now;

    try {
      await docClient.send(new UpdateCommand({
        TableName: tableName,
        Key: {
          pk: `AVATAR#${avatarId}`,
          sk: `CHANNEL#${channelId}#STATE`,
        },
        UpdateExpression: 'SET recentMessages = :messages, updatedAt = :updatedAt, #ttl = :ttl',
        ConditionExpression: 'updatedAt = :expectedUpdatedAt',
        ExpressionAttributeNames: {
          '#ttl': 'ttl',
        },
        ExpressionAttributeValues: {
          ':messages': trimmedMessages,
          ':updatedAt': trimmedAt,
          ':ttl': ttl,
          ':expectedUpdatedAt': expectedUpdatedAt,
        },
      }));

      updated = {
        ...updated,
        recentMessages: trimmedMessages,
        updatedAt: trimmedAt,
        ttl,
      };
    } catch (err: unknown) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
        // Race condition - another request modified the state. This is expected in concurrent environments.
        // The returned state may have more messages than maxMessages until next update.
        console.info('[State] Concurrent update detected during message trim, skipping trim operation');
      } else {
        console.warn('[State] Failed to trim channel messages:', err);
      }
    }
  }

  return updated;
}

/**
 * Transition channel to a new state
 */
export async function transitionState(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  avatarId: string,
  channelId: string,
  newState: ChannelStateMachine
): Promise<ChannelState | null> {
  const current = await getChannelState(docClient, tableName, avatarId, channelId);
  if (!current) return null;

  const now = Date.now();
  current.state = newState;
  current.stateChangedAt = now;
  current.ttl = Math.floor(now / 1000) + CHANNEL_CONFIG.BUFFER_TTL_SECONDS;

  await updateChannelState(docClient, tableName, current);
  return current;
}

/**
 * Mark response sent - transitions to COOLDOWN
 * Note: recentMessages is NOT cleared here to preserve conversation history
 * for context in future interactions. Buffer trimming is handled by addMessageToChannel.
 *
 * If this is an engaged_user response, increments the follow-up count for the current window.
 */
export async function markResponseSent(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  avatarId: string,
  channelId: string,
  responseMessageId: string,
  trigger?: string
): Promise<ChannelState | null> {
  const current = await getChannelState(docClient, tableName, avatarId, channelId);
  if (!current) return null;

  const now = Date.now();
  current.state = 'COOLDOWN';
  current.stateChangedAt = now;
  current.lastResponseAt = now;
  current.lastResponseMessageId = responseMessageId;
  current.pendingResponseAt = undefined;
  // Keep recentMessages intact for conversation history/context
  current.ttl = Math.floor(now / 1000) + CHANNEL_CONFIG.BUFFER_TTL_SECONDS;

  // Follow-up cap bookkeeping (#1534). Per-window counter keyed by
  // `windowStart = engagedUntil - ENGAGEMENT_WINDOW_MS`. Only engaged_user
  // responses consume a slot; direct_engagement opens a fresh window by
  // timestamp so no reset is needed.
  if (trigger === 'engaged_user' && current.engagedUsers) {
    const latest = current.recentMessages[current.recentMessages.length - 1];
    if (latest?.userId) {
      const engagedUntil = current.engagedUsers[latest.userId];
      if (engagedUntil && engagedUntil > now) {
        const windowStart = engagedUntil - CHANNEL_CONFIG.ENGAGEMENT_WINDOW_MS;
        if (!current.followUpCountByWindow) current.followUpCountByWindow = {};
        current.followUpCountByWindow[windowStart] =
          (current.followUpCountByWindow[windowStart] ?? 0) + 1;
      }
    }
  }

  // Prune stale window entries (end time already passed) so the map can't grow.
  if (current.followUpCountByWindow) {
    const pruned: Record<number, number> = {};
    for (const [startStr, count] of Object.entries(current.followUpCountByWindow)) {
      const windowStart = Number(startStr);
      const windowEnd = windowStart + CHANNEL_CONFIG.ENGAGEMENT_WINDOW_MS;
      if (windowEnd > now) pruned[windowStart] = count;
    }
    current.followUpCountByWindow =
      Object.keys(pruned).length > 0 ? pruned : undefined;
  }

  await updateChannelState(docClient, tableName, current);
  return current;
}

/**
 * Check if cooldown has expired
 */
export function isCooldownExpired(state: ChannelState): boolean {
  if (state.state !== 'COOLDOWN') return true;
  if (!state.stateChangedAt) return true;
  const elapsed = Date.now() - state.stateChangedAt;
  return elapsed > CHANNEL_CONFIG.COOLDOWN_DURATION_MS;
}

/**
 * Check if active state has timed out
 */
export function isActiveTimedOut(state: ChannelState): boolean {
  if (state.state !== 'ACTIVE') return false;
  const elapsed = Date.now() - state.lastActivityAt;
  return elapsed > CHANNEL_CONFIG.ACTIVE_TIMEOUT_MS;
}

/**
 * Get the number of follow-ups the bot has already sent inside the current
 * engagement window. Simpler than a per-window map: we only care about the
 * *current* window, tracked by `ChannelState.followUpsInWindow` /
 * `windowStartedAt`. The counter is reset on every direct mention/reply by
 * `markResponseSent`.
 */
function getFollowUpCountInCurrentWindow(state: ChannelState, engagedUntil: number): number {
  if (!state.followUpCountByWindow) return 0;
  const windowStart = engagedUntil - CHANNEL_CONFIG.ENGAGEMENT_WINDOW_MS;
  return state.followUpCountByWindow[windowStart] ?? 0;
}

/**
 * Check if ambient cooldown is currently active
 * Applies to non-direct responses (message_threshold, conversation_gap, etc.)
 * Private chats bypass this. Direct responses always bypass this.
 */
function isAmbientCooldownActive(state: ChannelState): boolean {
  if (!state.lastResponseAt) return false;
  const elapsed = Date.now() - state.lastResponseAt;
  return elapsed < CHANNEL_CONFIG.AMBIENT_COOLDOWN_MS;
}

/**
 * Evaluate whether to respond to this channel (Kyro-style)
 * Returns decision with trigger type and delay
 */
export function evaluateResponseTrigger(state: ChannelState): ResponseDecision {
  const now = Date.now();

  // Private chats always get immediate response
  if (state.chatType === 'private') {
    return {
      shouldRespond: true,
      trigger: 'private_chat',
      delay: 0,
      priority: 'high',
    };
  }

  // In COOLDOWN - don't respond unless there's new direct engagement or engaged user
  if (state.state === 'COOLDOWN' && !isCooldownExpired(state)) {
    // Check if there's a new direct engagement: any message in the buffer
    // that is a mention/reply AND is newer than the last state transition.
    // Scoped by timestamp (not "latest only") so if a user mentions the bot
    // and then sends a follow-up chatter message before we process, we still
    // recognize the mention as unanswered. See #1534.
    const lastMessage = state.recentMessages[state.recentMessages.length - 1];
    const hasNewDirectEngagement = state.recentMessages.some(
      m => (m.isMention || m.isReplyToBot) &&
           m.timestamp > (state.stateChangedAt || 0)
    );

    if (hasNewDirectEngagement) {
      return {
        shouldRespond: true,
        trigger: 'direct_engagement',
        delay: CHANNEL_CONFIG.DIRECT_ENGAGEMENT_DELAY_MS,
        priority: 'high',
      };
    }

    // Check if the most recent message is from an engaged user (with follow-up cap)
    if (state.engagedUsers && lastMessage?.userId && lastMessage.timestamp > (state.stateChangedAt || 0)) {
      const engagedUntil = state.engagedUsers[lastMessage.userId];
      if (engagedUntil && engagedUntil > now) {
        // Check if we've hit the follow-up cap for this engagement window
        const followUpCount = getFollowUpCountInCurrentWindow(state, engagedUntil);
        if (followUpCount >= CHANNEL_CONFIG.MAX_FOLLOW_UPS) {
          return {
            shouldRespond: false,
            trigger: 'none',
            delay: 0,
            priority: 'low',
            suppressionReason: 'follow_up_cap',
            suppressionDetails: {
              followUpsInWindow: followUpCount,
              windowEndsAt: engagedUntil,
            },
          };
        }

        return {
          shouldRespond: true,
          trigger: 'engaged_user',
          delay: CHANNEL_CONFIG.DIRECT_ENGAGEMENT_DELAY_MS,
          priority: 'high',
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

  // Check for direct engagement (#1534).
  // - If we've responded before (`lastResponseAt` set), any mention/reply
  //   newer than that response is fresh and deserves an immediate reply.
  // - If we've never responded, only the LATEST message being a mention/
  //   reply counts; older mentions in the buffer are assumed already
  //   handled or stale, preventing the 50-msg-buffer spam vector.
  const lastMessage = state.recentMessages[state.recentMessages.length - 1];
  const hasDirectEngagement = state.lastResponseAt
    ? state.recentMessages.some(
        m => (m.isMention || m.isReplyToBot) &&
             m.timestamp > (state.lastResponseAt as number)
      )
    : !!(lastMessage && (lastMessage.isMention || lastMessage.isReplyToBot));

  if (hasDirectEngagement) {
    return {
      shouldRespond: true,
      trigger: 'direct_engagement',
      delay: CHANNEL_CONFIG.DIRECT_ENGAGEMENT_DELAY_MS,
      priority: 'high',
    };
  }

  // Check if the most recent message is from an engaged user (within the engagement window, with follow-up cap)
  if (state.engagedUsers && lastMessage?.userId) {
    const engagedUntil = state.engagedUsers[lastMessage.userId];
    if (engagedUntil && engagedUntil > now) {
      const followUpCount = getFollowUpCountInCurrentWindow(state, engagedUntil);
      if (followUpCount >= CHANNEL_CONFIG.MAX_FOLLOW_UPS) {
        return {
          shouldRespond: false,
          trigger: 'none',
          delay: 0,
          priority: 'low',
          suppressionReason: 'follow_up_cap',
          suppressionDetails: {
            followUpsInWindow: followUpCount,
            windowEndsAt: engagedUntil,
          },
        };
      }

      return {
        shouldRespond: true,
        trigger: 'engaged_user',
        delay: CHANNEL_CONFIG.DIRECT_ENGAGEMENT_DELAY_MS,
        priority: 'high',
      };
    }
  }

  // In group/supergroup chats, the bot ONLY responds to direct engagement
  // and engaged-user follow-ups (handled above). Ambient triggers
  // (message_threshold, conversation_gap, ACTIVE-state pile-up) are
  // disabled because they fire on chat the bot wasn't addressed in,
  // producing the "responds to everyone" complaint reported in #1505.
  // Heartbeat-driven proactive replies are tracked separately.
  const isGroup = state.chatType === 'group' || state.chatType === 'supergroup';
  if (isGroup) {
    return {
      shouldRespond: false,
      trigger: 'none',
      delay: 0,
      priority: 'low',
    };
  }

  // In IDLE state or expired cooldown, check other triggers (1:1 chats only)
  if (state.state === 'IDLE' || isCooldownExpired(state)) {
    // Message threshold trigger - subject to ambient cooldown
    if (state.recentMessages.length >= CHANNEL_CONFIG.MESSAGE_THRESHOLD) {
      if (isAmbientCooldownActive(state)) {
        const elapsed = now - (state.lastResponseAt || 0);
        return {
          shouldRespond: false,
          trigger: 'none',
          delay: 0,
          priority: 'low',
          suppressionReason: 'ambient_cooldown',
          suppressionDetails: {
            msSinceLastResponse: elapsed,
            cooldownMs: CHANNEL_CONFIG.AMBIENT_COOLDOWN_MS,
          },
        };
      }

      return {
        shouldRespond: true,
        trigger: 'message_threshold',
        delay: randomDelay(),
        priority: 'normal',
      };
    }

    // Conversation gap trigger (activity followed by silence) - subject to ambient cooldown
    const timeSinceActivity = now - state.lastActivityAt;
    if (
      state.recentMessages.length > 0 &&
      timeSinceActivity > CHANNEL_CONFIG.CONVERSATION_GAP_MS
    ) {
      if (isAmbientCooldownActive(state)) {
        const elapsed = now - (state.lastResponseAt || 0);
        return {
          shouldRespond: false,
          trigger: 'none',
          delay: 0,
          priority: 'low',
          suppressionReason: 'ambient_cooldown',
          suppressionDetails: {
            msSinceLastResponse: elapsed,
            cooldownMs: CHANNEL_CONFIG.AMBIENT_COOLDOWN_MS,
          },
        };
      }

      return {
        shouldRespond: true,
        trigger: 'conversation_gap',
        delay: 0,
        priority: 'normal',
      };
    }
  }

  // ACTIVE state but no trigger met yet (1:1 chats only)
  if (state.state === 'ACTIVE') {
    // If we've been active for a while with messages, consider responding - subject to ambient cooldown
    if (state.recentMessages.length >= 2) {
      if (isAmbientCooldownActive(state)) {
        const elapsed = now - (state.lastResponseAt || 0);
        return {
          shouldRespond: false,
          trigger: 'none',
          delay: 0,
          priority: 'low',
          suppressionReason: 'ambient_cooldown',
          suppressionDetails: {
            msSinceLastResponse: elapsed,
            cooldownMs: CHANNEL_CONFIG.AMBIENT_COOLDOWN_MS,
          },
        };
      }

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
 * Get the most recent message that triggered response (for reply targeting)
 */
export function getResponseTarget(state: ChannelState): ContextMessage | null {
  // Find the last direct engagement message
  for (let i = state.recentMessages.length - 1; i >= 0; i--) {
    const msg = state.recentMessages[i];
    if (msg.isMention || msg.isReplyToBot) {
      return msg;
    }
  }

  // Otherwise return the most recent message
  return state.recentMessages[state.recentMessages.length - 1] || null;
}

/**
 * Build conversation context string from channel state
 */
export function buildConversationContext(state: ChannelState, maxTokens: number = 4000): string {
  if (state.recentMessages.length === 0) {
    return '';
  }

  const lines: string[] = [];
  let approxTokens = 0;

  for (const msg of state.recentMessages) {
    const timestamp = new Date(msg.timestamp).toLocaleTimeString();
    const userLabel = msg.username ? `@${msg.username}` : msg.sender;
    const line = `[${timestamp}] ${userLabel}: ${msg.content}`;

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
 * Get users actively participating in the conversation
 */
export function getActiveParticipants(state: ChannelState): Array<{
  id: string;
  name: string;
  username?: string;
  messageCount: number;
}> {
  const participants = new Map<string, {
    name: string;
    username?: string;
    messageCount: number;
  }>();

  for (const msg of state.recentMessages) {
    const id = msg.userId || msg.sender;
    const existing = participants.get(id);
    if (existing) {
      existing.messageCount++;
    } else {
      participants.set(id, {
        name: msg.sender,
        username: msg.username,
        messageCount: 1,
      });
    }
  }

  return Array.from(participants.entries())
    .map(([id, data]) => ({ id, ...data }))
    .sort((a, b) => b.messageCount - a.messageCount);
}

function randomDelay(): number {
  return Math.floor(
    CHANNEL_CONFIG.MIN_RESPONSE_DELAY_MS +
    Math.random() * (CHANNEL_CONFIG.MAX_RESPONSE_DELAY_MS - CHANNEL_CONFIG.MIN_RESPONSE_DELAY_MS)
  );
}

// =============================================================================
// CROSS-PLATFORM QUERIES
// =============================================================================

/**
 * Get all channel states for an avatar (across all platforms)
 */
export async function getAllChannelStates(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  avatarId: string,
  limit: number = 50
): Promise<ChannelState[]> {
  const result = await docClient.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: {
      ':pk': `AVATAR#${avatarId}`,
      ':prefix': 'CHANNEL#',
    },
    Limit: limit,
  }));

  return (result.Items || [])
    .filter(item => item.sk?.endsWith('#STATE'))
    .map(item => ({
      avatarId: item.avatarId,
      channelId: item.channelId,
      platform: item.platform,
      recentMessages: item.recentMessages || [],
      summary: item.summary,
      summaryUpdatedAt: item.summaryUpdatedAt,
      lastActivityAt: item.lastActivityAt,
      messageCount: item.messageCount || 0,
      state: item.state,
      stateChangedAt: item.stateChangedAt,
      chatType: item.chatType,
      chatTitle: item.chatTitle,
      lastResponseAt: item.lastResponseAt,
      lastResponseMessageId: item.lastResponseMessageId,
      pendingResponseAt: item.pendingResponseAt,
      directEngagementAt: item.directEngagementAt,
      engagedUsers: item.engagedUsers,
      followUpCountByWindow: item.followUpCountByWindow,
      ttl: item.ttl,
    }));
}

/**
 * Get channel states for a specific platform
 */
export async function getChannelStatesForPlatform(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  avatarId: string,
  platform: Platform,
  limit: number = 50
): Promise<ChannelState[]> {
  // Get all channels then filter by platform
  // Note: For better performance with many channels, consider adding a GSI
  const allChannels = await getAllChannelStates(docClient, tableName, avatarId, limit * 4);
  return allChannels.filter(ch => ch.platform === platform).slice(0, limit);
}

/**
 * Get active channels (channels with recent activity)
 */
export async function getActiveChannels(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  avatarId: string,
  maxAgeMs: number = 24 * 60 * 60 * 1000 // 24 hours default
): Promise<ChannelState[]> {
  const channels = await getAllChannelStates(docClient, tableName, avatarId);
  const cutoff = Date.now() - maxAgeMs;

  return channels
    .filter(ch => ch.lastActivityAt > cutoff)
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}
