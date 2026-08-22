/**
 * Presence Service
 *
 * Aggregates cross-platform presence information for avatars.
 * Provides channel discovery, summaries, and rate limiting for cross-platform posting.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@swarm/core';
import type { Platform, ChannelState } from '../types/index.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Platform connection status
 */
export interface PlatformConnection {
  platform: Platform;
  connected: boolean;
  botUsername?: string;
  botId?: string;
  lastActivity?: number;
  channelCount?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Channel information
 */
export interface ChannelInfo {
  channelId: string;
  platform: Platform;
  title?: string;
  type?: 'private' | 'group' | 'supergroup' | 'channel' | 'text' | 'voice' | 'dm' | 'guild';
  memberCount?: number;
  lastActivityAt?: number;
  messageCount?: number;
  summary?: string;
  summaryUpdatedAt?: number;
}

/**
 * Detailed channel information with LLM summary
 */
export interface ChannelDetail extends ChannelInfo {
  recentMessages?: Array<{
    sender: string;
    content: string;
    timestamp: number;
  }>;
  activeParticipants?: Array<{
    id: string;
    name: string;
    messageCount: number;
  }>;
}

/**
 * Rate limit status
 */
export interface RateLimitStatus {
  allowed: boolean;
  remaining: number;
  windowStart: number;
  windowEnd: number;
  totalPosts: number;
  maxPosts: number;
}

/**
 * Rate limit record stored in DynamoDB
 */
interface RateLimitRecord {
  posts: Array<{
    platform: Platform;
    channelId: string;
    timestamp: number;
  }>;
  windowStart: number;
}

// =============================================================================
// CONFIGURATION
// =============================================================================

export const PRESENCE_CONFIG = {
  // Rate limiting
  MAX_POSTS_PER_HOUR: 20,
  RATE_WINDOW_MS: 60 * 60 * 1000, // 1 hour

  // Summary caching
  SUMMARY_TTL_MS: 5 * 60 * 1000, // 5 minutes
  PRESENCE_CACHE_TTL_MS: 60 * 1000, // 1 minute

  // Channel discovery
  MAX_CHANNELS_PER_PLATFORM: 50,
  CHANNEL_STATE_TTL_SECONDS: 86400, // 24 hours
};

// =============================================================================
// PRESENCE SERVICE
// =============================================================================

export interface PresenceService {
  /**
   * Get all connected platforms for an avatar
   */
  getConnectedPlatforms(avatarId: string): Promise<PlatformConnection[]>;

  /**
   * Get all known channels across platforms
   */
  getAllChannels(avatarId: string): Promise<ChannelInfo[]>;

  /**
   * Get channels for a specific platform
   */
  getChannelsForPlatform(avatarId: string, platform: Platform): Promise<ChannelInfo[]>;

  /**
   * Get channel with LLM-generated summary
   */
  getChannelWithSummary(avatarId: string, channelId: string, platform: Platform): Promise<ChannelDetail | null>;

  /**
   * Build presence context string for system prompt
   */
  buildPresenceContext(avatarId: string): Promise<string>;

  /**
   * Check global rate limit for cross-platform posting
   */
  checkGlobalRateLimit(avatarId: string): Promise<RateLimitStatus>;

  /**
   * Record a post for rate limiting
   */
  recordPost(avatarId: string, platform: Platform, channelId: string): Promise<void>;

  /**
   * Register a channel (called when avatar receives messages from a channel)
   */
  registerChannel(
    avatarId: string,
    channelId: string,
    platform: Platform,
    metadata?: Partial<ChannelInfo>
  ): Promise<void>;

  /**
   * Update channel summary
   */
  updateChannelSummary(
    avatarId: string,
    channelId: string,
    platform: Platform,
    summary: string
  ): Promise<void>;
}

// =============================================================================
// DYNAMODB IMPLEMENTATION
// =============================================================================

export class DynamoDBPresenceService implements PresenceService {
  private docClient: DynamoDBDocumentClient;
  private tableName: string;

  constructor(tableName: string, docClient?: DynamoDBDocumentClient) {
    if (docClient) {
      this.docClient = docClient;
    } else {
      const client = new DynamoDBClient({ region: 'us-east-1' });
      this.docClient = DynamoDBDocumentClient.from(client, {
        marshallOptions: { removeUndefinedValues: true },
      });
    }
    this.tableName = tableName;
  }

  async getConnectedPlatforms(avatarId: string): Promise<PlatformConnection[]> {
    // Query all PLATFORM# entries for this avatar
    const result = await this.docClient.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': `AVATAR#${avatarId}`,
        ':prefix': 'PLATFORM#',
      },
    }));

    return (result.Items || []).map(item => ({
      platform: item.platform as Platform,
      connected: item.connected ?? true,
      botUsername: item.botUsername,
      botId: item.botId,
      lastActivity: item.lastActivity,
      channelCount: item.channelCount,
      metadata: item.metadata,
    }));
  }

  async getAllChannels(avatarId: string): Promise<ChannelInfo[]> {
    // Query all CHANNEL_REG# entries for this avatar
    const result = await this.docClient.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': `AVATAR#${avatarId}`,
        ':prefix': 'CHANNEL_REG#',
      },
      Limit: PRESENCE_CONFIG.MAX_CHANNELS_PER_PLATFORM * 4, // 4 platforms max
    }));

    return (result.Items || []).map(item => ({
      channelId: item.channelId,
      platform: item.platform as Platform,
      title: item.title,
      type: item.type,
      memberCount: item.memberCount,
      lastActivityAt: item.lastActivityAt,
      messageCount: item.messageCount,
      summary: item.summary,
      summaryUpdatedAt: item.summaryUpdatedAt,
    }));
  }

  async getChannelsForPlatform(avatarId: string, platform: Platform): Promise<ChannelInfo[]> {
    // Query CHANNEL_REG# entries for specific platform
    const result = await this.docClient.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': `AVATAR#${avatarId}`,
        ':prefix': `CHANNEL_REG#${platform}#`,
      },
      Limit: PRESENCE_CONFIG.MAX_CHANNELS_PER_PLATFORM,
    }));

    return (result.Items || []).map(item => ({
      channelId: item.channelId,
      platform: item.platform as Platform,
      title: item.title,
      type: item.type,
      memberCount: item.memberCount,
      lastActivityAt: item.lastActivityAt,
      messageCount: item.messageCount,
      summary: item.summary,
      summaryUpdatedAt: item.summaryUpdatedAt,
    }));
  }

  async getChannelWithSummary(
    avatarId: string,
    channelId: string,
    platform: Platform
  ): Promise<ChannelDetail | null> {
    // Get channel registry entry
    const regResult = await this.docClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        pk: `AVATAR#${avatarId}`,
        sk: `CHANNEL_REG#${platform}#${channelId}`,
      },
    }));

    if (!regResult.Item) {
      return null;
    }

    // Get channel state for recent messages
    const stateResult = await this.docClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        pk: `AVATAR#${avatarId}`,
        sk: `CHANNEL#${channelId}#STATE`,
      },
    }));

    const state = stateResult.Item as ChannelState | undefined;
    const reg = regResult.Item;

    return {
      channelId: reg.channelId,
      platform: reg.platform as Platform,
      title: reg.title,
      type: reg.type,
      memberCount: reg.memberCount,
      lastActivityAt: reg.lastActivityAt,
      messageCount: reg.messageCount,
      summary: reg.summary,
      summaryUpdatedAt: reg.summaryUpdatedAt,
      recentMessages: state?.recentMessages?.slice(-10).map(m => ({
        sender: m.sender,
        content: m.content,
        timestamp: m.timestamp,
      })),
      activeParticipants: state ? this.getActiveParticipants(state) : undefined,
    };
  }

  private getActiveParticipants(state: ChannelState): Array<{
    id: string;
    name: string;
    messageCount: number;
  }> {
    const participants = new Map<string, { name: string; messageCount: number }>();

    for (const msg of state.recentMessages || []) {
      const id = msg.userId || msg.sender;
      const existing = participants.get(id);
      if (existing) {
        existing.messageCount++;
      } else {
        participants.set(id, { name: msg.sender, messageCount: 1 });
      }
    }

    return Array.from(participants.entries())
      .map(([id, data]) => ({ id, ...data }))
      .sort((a, b) => b.messageCount - a.messageCount);
  }

  async buildPresenceContext(avatarId: string): Promise<string> {
    const platforms = await this.getConnectedPlatforms(avatarId);
    const channels = await this.getAllChannels(avatarId);

    if (platforms.length === 0 && channels.length === 0) {
      return 'No platforms connected.';
    }

    const lines: string[] = [];
    const now = Date.now();

    // Group channels by platform
    const channelsByPlatform = new Map<Platform, ChannelInfo[]>();
    for (const channel of channels) {
      const list = channelsByPlatform.get(channel.platform) || [];
      list.push(channel);
      channelsByPlatform.set(channel.platform, list);
    }

    for (const platform of platforms) {
      const statusIcon = platform.connected ? '✓' : '✗';
      const botInfo = platform.botUsername ? ` as @${platform.botUsername}` : '';
      lines.push(`**${platform.platform.charAt(0).toUpperCase() + platform.platform.slice(1)}** (${statusIcon} connected${botInfo})`);

      const platformChannels = channelsByPlatform.get(platform.platform) || [];
      if (platformChannels.length === 0) {
        lines.push('  No active channels');
      } else {
        // Sort by last activity
        platformChannels.sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));

        for (const channel of platformChannels.slice(0, 5)) { // Show top 5 per platform
          const title = channel.title || channel.channelId;
          const typeLabel = channel.type ? ` (${channel.type})` : '';
          const timeAgo = channel.lastActivityAt
            ? this.formatTimeAgo(now - channel.lastActivityAt)
            : 'unknown';
          const summary = channel.summary ? `: ${channel.summary}` : '';

          lines.push(`  - ${title}${typeLabel}: Last active ${timeAgo}${summary}`);
        }

        if (platformChannels.length > 5) {
          lines.push(`  ... and ${platformChannels.length - 5} more channels`);
        }
      }

      lines.push('');
    }

    // Add rate limit info
    const rateStatus = await this.checkGlobalRateLimit(avatarId);
    lines.push(`**Rate Limit**: ${rateStatus.remaining}/${rateStatus.maxPosts} posts remaining this hour`);

    return lines.join('\n');
  }

  private formatTimeAgo(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  async checkGlobalRateLimit(avatarId: string): Promise<RateLimitStatus> {
    const now = Date.now();
    const windowStart = now - PRESENCE_CONFIG.RATE_WINDOW_MS;

    const result = await this.docClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        pk: `AVATAR#${avatarId}`,
        sk: 'RATE_LIMIT#GLOBAL',
      },
    }));

    if (!result.Item) {
      return {
        allowed: true,
        remaining: PRESENCE_CONFIG.MAX_POSTS_PER_HOUR,
        windowStart: now,
        windowEnd: now + PRESENCE_CONFIG.RATE_WINDOW_MS,
        totalPosts: 0,
        maxPosts: PRESENCE_CONFIG.MAX_POSTS_PER_HOUR,
      };
    }

    const record = result.Item as RateLimitRecord & { pk: string; sk: string };

    // Filter posts within the current window
    const recentPosts = (record.posts || []).filter(p => p.timestamp > windowStart);
    const totalPosts = recentPosts.length;
    const remaining = Math.max(0, PRESENCE_CONFIG.MAX_POSTS_PER_HOUR - totalPosts);

    return {
      allowed: remaining > 0,
      remaining,
      windowStart,
      windowEnd: now + PRESENCE_CONFIG.RATE_WINDOW_MS,
      totalPosts,
      maxPosts: PRESENCE_CONFIG.MAX_POSTS_PER_HOUR,
    };
  }

  async recordPost(avatarId: string, platform: Platform, channelId: string): Promise<void> {
    const now = Date.now();
    const windowStart = now - PRESENCE_CONFIG.RATE_WINDOW_MS;

    // Get current record
    const result = await this.docClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        pk: `AVATAR#${avatarId}`,
        sk: 'RATE_LIMIT#GLOBAL',
      },
    }));

    const record = result.Item as (RateLimitRecord & { pk: string; sk: string }) | undefined;

    // Filter old posts and add new one
    const posts = [
      ...(record?.posts || []).filter(p => p.timestamp > windowStart),
      { platform, channelId, timestamp: now },
    ];

    await this.docClient.send(new PutCommand({
      TableName: this.tableName,
      Item: {
        pk: `AVATAR#${avatarId}`,
        sk: 'RATE_LIMIT#GLOBAL',
        posts,
        windowStart: now,
        updatedAt: now,
        ttl: Math.floor(now / 1000) + PRESENCE_CONFIG.CHANNEL_STATE_TTL_SECONDS * 2,
      },
    }));
  }

  async registerChannel(
    avatarId: string,
    channelId: string,
    platform: Platform,
    metadata?: Partial<ChannelInfo>
  ): Promise<void> {
    const now = Date.now();

    await this.docClient.send(new UpdateCommand({
      TableName: this.tableName,
      Key: {
        pk: `AVATAR#${avatarId}`,
        sk: `CHANNEL_REG#${platform}#${channelId}`,
      },
      UpdateExpression: `
        SET channelId = :channelId,
            platform = :platform,
            lastActivityAt = :now,
            messageCount = if_not_exists(messageCount, :zero) + :one,
            updatedAt = :now,
            #ttl = :ttl
            ${metadata?.title ? ', title = :title' : ''}
            ${metadata?.type ? ', #type = :type' : ''}
            ${metadata?.memberCount ? ', memberCount = :memberCount' : ''}
      `,
      ExpressionAttributeNames: {
        '#ttl': 'ttl',
        ...(metadata?.type ? { '#type': 'type' } : {}),
      },
      ExpressionAttributeValues: {
        ':channelId': channelId,
        ':platform': platform,
        ':now': now,
        ':zero': 0,
        ':one': 1,
        ':ttl': Math.floor(now / 1000) + PRESENCE_CONFIG.CHANNEL_STATE_TTL_SECONDS,
        ...(metadata?.title ? { ':title': metadata.title } : {}),
        ...(metadata?.type ? { ':type': metadata.type } : {}),
        ...(metadata?.memberCount ? { ':memberCount': metadata.memberCount } : {}),
      },
    }));

    // Also update platform connection stats
    await this.updatePlatformStats(avatarId, platform);
  }

  private async updatePlatformStats(avatarId: string, platform: Platform): Promise<void> {
    const now = Date.now();

    // Count channels for this platform
    const channels = await this.getChannelsForPlatform(avatarId, platform);

    await this.docClient.send(new UpdateCommand({
      TableName: this.tableName,
      Key: {
        pk: `AVATAR#${avatarId}`,
        sk: `PLATFORM#${platform}`,
      },
      UpdateExpression: `
        SET platform = :platform,
            connected = :connected,
            lastActivity = :now,
            channelCount = :count,
            updatedAt = :now
      `,
      ExpressionAttributeValues: {
        ':platform': platform,
        ':connected': true,
        ':now': now,
        ':count': channels.length,
      },
    }));
  }

  async updateChannelSummary(
    avatarId: string,
    channelId: string,
    platform: Platform,
    summary: string
  ): Promise<void> {
    const now = Date.now();

    await this.docClient.send(new UpdateCommand({
      TableName: this.tableName,
      Key: {
        pk: `AVATAR#${avatarId}`,
        sk: `CHANNEL_REG#${platform}#${channelId}`,
      },
      UpdateExpression: 'SET summary = :summary, summaryUpdatedAt = :now, updatedAt = :now',
      ExpressionAttributeValues: {
        ':summary': summary,
        ':now': now,
      },
    }));
  }

  /**
   * Register platform connection (called during config setup or when bot connects)
   */
  async registerPlatform(
    avatarId: string,
    platform: Platform,
    connection: Partial<PlatformConnection>
  ): Promise<void> {
    const now = Date.now();

    await this.docClient.send(new PutCommand({
      TableName: this.tableName,
      Item: {
        pk: `AVATAR#${avatarId}`,
        sk: `PLATFORM#${platform}`,
        platform,
        connected: connection.connected ?? true,
        botUsername: connection.botUsername,
        botId: connection.botId,
        lastActivity: now,
        channelCount: connection.channelCount ?? 0,
        metadata: connection.metadata,
        updatedAt: now,
      },
    }));
  }
}

// =============================================================================
// FACTORY
// =============================================================================

export function createPresenceService(tableName: string): PresenceService {
  return new DynamoDBPresenceService(tableName);
}
