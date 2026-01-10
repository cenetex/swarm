/**
 * Activity Service - Activity feed for dashboards and websites
 */
import {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import type { Platform, ResponseAction } from '../types/index.js';

export interface ActivityEvent {
  agentId: string;
  timestamp: number;
  eventType: 'message_received' | 'response_sent' | 'media_generated' | 'error';
  platform: Platform;
  summary: string;
  details?: Record<string, unknown>;
}

export class ActivityService {
  private docClient: DynamoDBDocumentClient;
  private tableName: string;

  constructor(tableName: string, region: string = 'us-east-1') {
    const client = new DynamoDBClient({ region });
    this.docClient = DynamoDBDocumentClient.from(client);
    this.tableName = tableName;
  }

  /**
   * Log an activity event
   */
  async log(event: ActivityEvent): Promise<void> {
    const ttl = Math.floor(Date.now() / 1000) + 86400; // 24 hour TTL

    await this.docClient.send(new PutCommand({
      TableName: this.tableName,
      Item: {
        pk: `AGENT#${event.agentId}`,
        sk: `ACT#${event.timestamp}#${Math.random().toString(36).slice(2)}`,
        ...event,
        ttl,
      },
    }));
  }

  /**
   * Log a received message
   */
  async logMessageReceived(
    agentId: string,
    platform: Platform,
    senderName: string,
    preview: string
  ): Promise<void> {
    await this.log({
      agentId,
      timestamp: Date.now(),
      eventType: 'message_received',
      platform,
      summary: `Message from ${senderName}: "${preview.slice(0, 50)}${preview.length > 50 ? '...' : ''}"`,
      details: { senderName, preview },
    });
  }

  /**
   * Log a sent response
   */
  async logResponseSent(
    agentId: string,
    platform: Platform,
    actions: ResponseAction[]
  ): Promise<void> {
    const actionTypes = actions.map(a => a.type).join(', ');
    const messageAction = actions.find(a => a.type === 'send_message');
    const preview = messageAction && 'text' in messageAction 
      ? messageAction.text.slice(0, 50)
      : actionTypes;

    await this.log({
      agentId,
      timestamp: Date.now(),
      eventType: 'response_sent',
      platform,
      summary: `Responded with: ${preview}`,
      details: { actions: actionTypes },
    });
  }

  /**
   * Log media generation
   */
  async logMediaGenerated(
    agentId: string,
    platform: Platform,
    mediaType: 'image' | 'video',
    prompt: string
  ): Promise<void> {
    await this.log({
      agentId,
      timestamp: Date.now(),
      eventType: 'media_generated',
      platform,
      summary: `Generated ${mediaType}: "${prompt.slice(0, 40)}..."`,
      details: { mediaType, prompt },
    });
  }

  /**
   * Log an error
   */
  async logError(
    agentId: string,
    platform: Platform,
    error: string,
    context?: Record<string, unknown>
  ): Promise<void> {
    await this.log({
      agentId,
      timestamp: Date.now(),
      eventType: 'error',
      platform,
      summary: `Error: ${error.slice(0, 100)}`,
      details: { error, ...context },
    });
  }

  /**
   * Get recent activity for an agent
   */
  async getRecentActivity(
    agentId: string,
    limit: number = 50
  ): Promise<ActivityEvent[]> {
    const result = await this.docClient.send(new QueryCommand({
      TableName: this.tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': `AGENT#${agentId}`,
        ':prefix': 'ACT#',
      },
      ScanIndexForward: false, // Newest first
      Limit: limit,
    }));

    return (result.Items || []).map(item => ({
      agentId: item.agentId,
      timestamp: item.timestamp,
      eventType: item.eventType,
      platform: item.platform,
      summary: item.summary,
      details: item.details,
    }));
  }

  /**
   * Get activity feed for multiple agents (dashboard)
   */
  async getSwarmActivity(
    agentIds: string[],
    limit: number = 100
  ): Promise<ActivityEvent[]> {
    const activities: ActivityEvent[] = [];

    await Promise.all(
      agentIds.map(async (agentId) => {
        const events = await this.getRecentActivity(agentId, Math.ceil(limit / agentIds.length));
        activities.push(...events);
      })
    );

    // Sort by timestamp descending
    return activities
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }
}

/**
 * Factory function
 */
export function createActivityService(tableName: string, region?: string): ActivityService {
  return new ActivityService(tableName, region);
}
