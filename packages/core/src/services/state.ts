/**
 * State Service - DynamoDB-based state management
 * Multi-tenant storage for channel state, user cooldowns, and agent state
 */
import {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import type {
  StateService,
  ChannelState,
  UserCooldown,
  Platform,
  ContextMessage,
  AgentConfig,
} from '../types/index.js';

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
    const result = await this.docClient.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'begins_with(pk, :prefix) AND sk = :sk',
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
