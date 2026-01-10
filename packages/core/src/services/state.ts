/**
 * State Service - DynamoDB-based state management
 * Multi-tenant storage for channel state, user cooldowns, and agent state
 *
 * Supports Kyro-style channel-aware messaging:
 * - State machine: IDLE → ACTIVE → COOLDOWN
 * - Response triggers: direct engagement, message threshold, conversation gap
 * - Message buffering with context preservation
 */
import {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import type {
  StateService,
  ChannelState,
  ChannelStateMachine,
  UserCooldown,
  Platform,
  ContextMessage,
  AgentConfig,
  ResponseDecision,
} from '../types/index.js';

// =============================================================================
// CHANNEL STATE CONFIGURATION (Kyro-style)
// =============================================================================

export const CHANNEL_CONFIG = {
  // Buffer settings
  MAX_BUFFER_SIZE: 50,           // Max messages to keep in buffer
  BUFFER_TTL_SECONDS: 3600,      // 1 hour TTL for channel state

  // State machine timings
  COOLDOWN_DURATION_MS: 10000,   // 10 seconds cooldown after response
  ACTIVE_TIMEOUT_MS: 60000,      // 60 seconds before ACTIVE → IDLE

  // Response triggers
  DIRECT_ENGAGEMENT_DELAY_MS: 0,      // Immediate for mentions/replies
  MESSAGE_THRESHOLD: 5,                // Respond after N messages accumulated
  CONVERSATION_GAP_MS: 30000,          // 30 seconds of silence triggers response

  // Response timing
  MIN_RESPONSE_DELAY_MS: 500,     // Minimum delay to seem natural
  MAX_RESPONSE_DELAY_MS: 3000,    // Maximum random delay
};

export class DynamoDBStateService implements StateService {
  private docClient: DynamoDBDocumentClient;
  private tableName: string;

  constructor(tableName: string, region: string = 'us-east-1') {
    const client = new DynamoDBClient({ region });
    this.docClient = DynamoDBDocumentClient.from(client, {
      marshallOptions: {
        removeUndefinedValues: true,
      },
    });
    this.tableName = tableName;
  }

  // =====================================================================
  // CHANNEL STATE
  // =====================================================================

  async getChannelState(agentId: string, channelId: string): Promise<ChannelState | null> {
    const result = await this.docClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        pk: `AGENT#${agentId}`,
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
      agentId: result.Item.agentId,
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
      ttl: result.Item.ttl,
    };
  }

  async updateChannelState(state: ChannelState): Promise<void> {
    const now = Date.now();
    const ttl = Math.floor(now / 1000) + CHANNEL_CONFIG.BUFFER_TTL_SECONDS;

    await this.docClient.send(new PutCommand({
      TableName: this.tableName,
      Item: {
        pk: `AGENT#${state.agentId}`,
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
  async getOrCreateChannelState(
    agentId: string,
    channelId: string,
    platform: Platform,
    chatType?: 'private' | 'group' | 'supergroup' | 'channel',
    chatTitle?: string
  ): Promise<ChannelState> {
    const existing = await this.getChannelState(agentId, channelId);
    if (existing) {
      // Update chat context if provided
      if (chatType && existing.chatType !== chatType) {
        existing.chatType = chatType;
        existing.chatTitle = chatTitle;
        await this.updateChannelState(existing);
      }
      return existing;
    }

    const now = Date.now();
    const newState: ChannelState = {
      agentId,
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
      await this.docClient.send(new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: `AGENT#${agentId}`,
          sk: `CHANNEL#${channelId}#STATE`,
          ...newState,
          updatedAt: now,
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      }));
    } catch (err: unknown) {
      // Race condition - another request created it first
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
        const fetched = await this.getChannelState(agentId, channelId);
        if (fetched) return fetched;
      }
      throw err;
    }

    return newState;
  }

  /**
   * Add message to channel with Kyro-style state machine updates
   */
  async addMessageToChannel(
    agentId: string,
    channelId: string,
    platform: Platform,
    message: ContextMessage,
    maxMessages: number = CHANNEL_CONFIG.MAX_BUFFER_SIZE
  ): Promise<ChannelState> {
    // Get existing state
    let state = await this.getChannelState(agentId, channelId);

    const now = Date.now();

    if (!state) {
      state = {
        agentId,
        channelId,
        platform,
        recentMessages: [],
        lastActivityAt: now,
        messageCount: 0,
        state: 'IDLE',
        stateChangedAt: now,
      };
    }

    // Add message and trim to max
    state.recentMessages.push(message);
    if (state.recentMessages.length > maxMessages) {
      state.recentMessages = state.recentMessages.slice(-maxMessages);
    }

    state.lastActivityAt = now;
    state.messageCount++;

    // Kyro-style state machine updates
    const previousState = state.state;

    if (message.isMention || message.isReplyToBot) {
      // Direct engagement → ACTIVE immediately
      state.state = 'ACTIVE';
      state.directEngagementAt = now;
    } else if (state.state === 'IDLE') {
      // Regular message in IDLE → stay IDLE (buffer only)
    } else if (state.state === 'COOLDOWN') {
      // Message during cooldown → extend activity but stay in cooldown
    }
    // ACTIVE stays ACTIVE

    if (state.state !== previousState) {
      state.stateChangedAt = now;
    }

    // Update TTL
    state.ttl = Math.floor(now / 1000) + CHANNEL_CONFIG.BUFFER_TTL_SECONDS;

    await this.updateChannelState(state);
    return state;
  }

  // =====================================================================
  // KYRO-STYLE STATE MACHINE
  // =====================================================================

  /**
   * Transition channel to a new state
   */
  async transitionState(
    agentId: string,
    channelId: string,
    newState: ChannelStateMachine
  ): Promise<ChannelState | null> {
    const current = await this.getChannelState(agentId, channelId);
    if (!current) return null;

    const now = Date.now();
    current.state = newState;
    current.stateChangedAt = now;
    current.ttl = Math.floor(now / 1000) + CHANNEL_CONFIG.BUFFER_TTL_SECONDS;

    await this.updateChannelState(current);
    return current;
  }

  /**
   * Mark response sent - transitions to COOLDOWN and clears buffer
   */
  async markResponseSent(
    agentId: string,
    channelId: string,
    responseMessageId: string
  ): Promise<ChannelState | null> {
    const current = await this.getChannelState(agentId, channelId);
    if (!current) return null;

    const now = Date.now();
    current.state = 'COOLDOWN';
    current.stateChangedAt = now;
    current.lastResponseAt = now;
    current.lastResponseMessageId = responseMessageId;
    current.pendingResponseAt = undefined;
    // Clear buffer after response
    current.recentMessages = [];
    current.ttl = Math.floor(now / 1000) + CHANNEL_CONFIG.BUFFER_TTL_SECONDS;

    await this.updateChannelState(current);
    return current;
  }

  /**
   * Check if cooldown has expired
   */
  isCooldownExpired(state: ChannelState): boolean {
    if (state.state !== 'COOLDOWN') return true;
    if (!state.stateChangedAt) return true;
    const elapsed = Date.now() - state.stateChangedAt;
    return elapsed > CHANNEL_CONFIG.COOLDOWN_DURATION_MS;
  }

  /**
   * Check if active state has timed out
   */
  isActiveTimedOut(state: ChannelState): boolean {
    if (state.state !== 'ACTIVE') return false;
    const elapsed = Date.now() - state.lastActivityAt;
    return elapsed > CHANNEL_CONFIG.ACTIVE_TIMEOUT_MS;
  }

  /**
   * Evaluate whether to respond to this channel (Kyro-style)
   * Returns decision with trigger type and delay
   */
  evaluateResponseTrigger(state: ChannelState): ResponseDecision {
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

    // In COOLDOWN - don't respond unless there's new direct engagement
    if (state.state === 'COOLDOWN' && !this.isCooldownExpired(state)) {
      // Check if there's a new direct engagement since cooldown started
      const hasNewEngagement = state.recentMessages.some(
        m => (m.isMention || m.isReplyToBot) &&
             m.timestamp > (state.stateChangedAt || 0)
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
    const hasDirectEngagement = state.recentMessages.some(
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

    // In IDLE state or expired cooldown, check other triggers
    if (state.state === 'IDLE' || this.isCooldownExpired(state)) {
      // Message threshold trigger
      if (state.recentMessages.length >= CHANNEL_CONFIG.MESSAGE_THRESHOLD) {
        return {
          shouldRespond: true,
          trigger: 'message_threshold',
          delay: this.randomDelay(),
          priority: 'normal',
        };
      }

      // Conversation gap trigger (activity followed by silence)
      const timeSinceActivity = now - state.lastActivityAt;
      if (
        state.recentMessages.length > 0 &&
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
      if (state.recentMessages.length >= 2) {
        return {
          shouldRespond: true,
          trigger: 'message_threshold',
          delay: this.randomDelay(),
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
  private randomDelay(): number {
    return Math.floor(
      CHANNEL_CONFIG.MIN_RESPONSE_DELAY_MS +
      Math.random() * (CHANNEL_CONFIG.MAX_RESPONSE_DELAY_MS - CHANNEL_CONFIG.MIN_RESPONSE_DELAY_MS)
    );
  }

  /**
   * Get the most recent message that triggered response (for reply targeting)
   */
  getResponseTarget(state: ChannelState): ContextMessage | null {
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
  buildConversationContext(state: ChannelState, maxTokens: number = 4000): string {
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
  getActiveParticipants(state: ChannelState): Array<{
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

  // =====================================================================
  // USER COOLDOWNS
  // =====================================================================

  async getUserCooldown(
    agentId: string,
    platform: Platform,
    userId: string
  ): Promise<UserCooldown | null> {
    const result = await this.docClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        pk: `AGENT#${agentId}`,
        sk: `COOLDOWN#${platform}#${userId}`,
      },
    }));

    if (!result.Item) {
      return null;
    }

    // Check if cooldown is expired
    if (result.Item.cooldownUntil < Date.now()) {
      return null;
    }

    return {
      agentId: result.Item.agentId,
      platform: result.Item.platform,
      userId: result.Item.userId,
      cooldownUntil: result.Item.cooldownUntil,
      reason: result.Item.reason,
    };
  }

  async setUserCooldown(cooldown: UserCooldown): Promise<void> {
    const ttl = Math.floor(cooldown.cooldownUntil / 1000) + 86400; // 1 day after expiry

    await this.docClient.send(new PutCommand({
      TableName: this.tableName,
      Item: {
        pk: `AGENT#${cooldown.agentId}`,
        sk: `COOLDOWN#${cooldown.platform}#${cooldown.userId}`,
        ...cooldown,
        ttl,
      },
    }));
  }

  async clearUserCooldown(
    agentId: string,
    platform: Platform,
    userId: string
  ): Promise<void> {
    await this.docClient.send(new DeleteCommand({
      TableName: this.tableName,
      Key: {
        pk: `AGENT#${agentId}`,
        sk: `COOLDOWN#${platform}#${userId}`,
      },
    }));
  }

  // =====================================================================
  // AGENT CONFIG
  // =====================================================================

  async getAgentConfig(agentId: string): Promise<AgentConfig | null> {
    const result = await this.docClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        pk: `AGENT#${agentId}`,
        sk: 'CONFIG',
      },
    }));

    if (!result.Item) {
      return null;
    }

    return result.Item.config as AgentConfig;
  }

  async saveAgentConfig(config: AgentConfig): Promise<void> {
    await this.docClient.send(new PutCommand({
      TableName: this.tableName,
      Item: {
        pk: `AGENT#${config.id}`,
        sk: 'CONFIG',
        config,
        updatedAt: Date.now(),
      },
    }));
  }

  async listAgents(): Promise<string[]> {
    // Note: Using Scan because begins_with() cannot be used on partition keys in Query.
    // For better performance at scale, consider adding a GSI with entityType as PK.
    const result = await this.docClient.send(new ScanCommand({
      TableName: this.tableName,
      FilterExpression: 'begins_with(pk, :prefix) AND sk = :sk',
      ExpressionAttributeValues: {
        ':prefix': 'AGENT#',
        ':sk': 'CONFIG',
      },
      ProjectionExpression: 'pk',
    }));

    return (result.Items || []).map(item =>
      (item.pk as string).replace('AGENT#', '')
    );
  }

  // =====================================================================
  // IDEMPOTENCY
  // =====================================================================

  async checkAndSetIdempotency(key: string, ttlSeconds: number = 3600): Promise<boolean> {
    const ttl = Math.floor(Date.now() / 1000) + ttlSeconds;

    try {
      await this.docClient.send(new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: 'IDEMPOTENCY',
          sk: key,
          createdAt: Date.now(),
          ttl,
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      }));

      return true; // Key was set, this is the first processing
    } catch (error: unknown) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') {
        return false; // Key exists, already processed
      }
      throw error;
    }
  }

  // =====================================================================
  // SCHEDULED TASKS STATE
  // =====================================================================

  async getLastMentionId(agentId: string): Promise<string | null> {
    const result = await this.docClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        pk: `AGENT#${agentId}`,
        sk: 'TWITTER#LAST_MENTION',
      },
    }));

    return result.Item?.lastMentionId || null;
  }

  async setLastMentionId(agentId: string, mentionId: string): Promise<void> {
    await this.docClient.send(new PutCommand({
      TableName: this.tableName,
      Item: {
        pk: `AGENT#${agentId}`,
        sk: 'TWITTER#LAST_MENTION',
        lastMentionId: mentionId,
        updatedAt: Date.now(),
      },
    }));
  }
}

/**
 * Factory function
 */
export function createStateService(tableName: string, region?: string): DynamoDBStateService {
  return new DynamoDBStateService(tableName, region);
}
