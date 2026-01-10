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
  ResponseTrigger,
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

    return {
      agentId: result.Item.agentId,
      channelId: result.Item.channelId,
      platform: result.Item.platform,
      recentMessages: result.Item.recentMessages || [],
      summary: result.Item.summary,
      summaryUpdatedAt: result.Item.summaryUpdatedAt,
      lastActivityAt: result.Item.lastActivityAt,
      messageCount: result.Item.messageCount || 0,
    };
  }

  async updateChannelState(state: ChannelState): Promise<void> {
    await this.docClient.send(new PutCommand({
      TableName: this.tableName,
      Item: {
        pk: `AGENT#${state.agentId}`,
        sk: `CHANNEL#${state.channelId}#STATE`,
        ...state,
        updatedAt: Date.now(),
      },
    }));
  }

  async addMessageToChannel(
    agentId: string,
    channelId: string,
    platform: Platform,
    message: ContextMessage,
    maxMessages: number = 50
  ): Promise<void> {
    // Get existing state
    let state = await this.getChannelState(agentId, channelId);

    if (!state) {
      state = {
        agentId,
        channelId,
        platform,
        recentMessages: [],
        lastActivityAt: Date.now(),
        messageCount: 0,
      };
    }

    // Add message and trim to max
    state.recentMessages.push(message);
    if (state.recentMessages.length > maxMessages) {
      state.recentMessages = state.recentMessages.slice(-maxMessages);
    }

    state.lastActivityAt = Date.now();
    state.messageCount++;

    await this.updateChannelState(state);
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
