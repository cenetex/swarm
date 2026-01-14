/**
 * Usage Metering Service - Track and enforce tool/feature usage limits
 * Supports daily recharges and credit-based consumption.
 */
import {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import type {
  UsageMeteringService,
  UsageCredit,
  UsageConfig,
} from '../types/index.js';

export class DynamoDBUsageMeteringService implements UsageMeteringService {
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

  /**
   * Get the current credits for a tool/feature.
   */
  async getCredits(agentId: string, toolId: string, config: UsageConfig): Promise<UsageCredit> {
    try {
      const result = await this.docClient.send(new GetCommand({
        TableName: this.tableName,
        Key: {
          pk: `AGENT#${agentId}`,
          sk: `USAGE#${toolId}`,
        },
      }));

      if (!result.Item) {
        // New record - start with max credits
        return {
          credits: config.maxCredits,
          lastRecharge: Date.now(),
        };
      }

      const stored = result.Item as UsageCredit;
      const currentCredits = this.calculateRecharge(stored, config);

      return {
        credits: currentCredits,
        lastRecharge: stored.lastRecharge,
      };
    } catch (err) {
      console.error(`[UsageMetering] Failed to get credits for agent=${agentId}, tool=${toolId}:`, err);
      // Fail open with 0 credits to be safe, or 1 to avoid breaking things?
      // Defaulting to 0 for better enforcement.
      return { credits: 0, lastRecharge: Date.now() };
    }
  }

  /**
   * Check if a tool/feature can be used.
   */
  async canUseTool(agentId: string, toolId: string, config: UsageConfig): Promise<boolean> {
    const { credits } = await this.getCredits(agentId, toolId, config);
    return credits > 0;
  }

  /**
   * Consume a credit for a tool/feature.
   */
  async consumeCredit(agentId: string, toolId: string, config: UsageConfig): Promise<{ allowed: boolean; remaining: number }> {
    const now = Date.now();
    const stored = await this.getCredits(agentId, toolId, config);
    
    if (stored.credits <= 0) {
      return { allowed: false, remaining: 0 };
    }

    const newCredits = stored.credits - 1;
    
    // We update the lastRecharge only if we actually recharged, 
    // but the calculateRecharge logic usually keeps the old lastRecharge
    // if we haven't hit a full interval yet.
    // To simplify, if we recharged, we should update lastRecharge to 'now'
    // but offset by the remainder to not lose progress towards next credit.
    
    let updatedLastRecharge = stored.lastRecharge;
    const elapsed = now - stored.lastRecharge;
    if (elapsed >= config.rechargeIntervalMs) {
      const intervals = Math.floor(elapsed / config.rechargeIntervalMs);
      updatedLastRecharge = stored.lastRecharge + (intervals * config.rechargeIntervalMs);
    }

    try {
      await this.docClient.send(new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: `AGENT#${agentId}`,
          sk: `USAGE#${toolId}`,
          credits: newCredits,
          lastRecharge: updatedLastRecharge,
          updatedAt: now,
        },
      }));

      return {
        allowed: true,
        remaining: newCredits,
      };
    } catch (err) {
      console.error(`[UsageMetering] Failed to consume credit for agent=${agentId}, tool=${toolId}:`, err);
      return { allowed: false, remaining: stored.credits };
    }
  }

  /**
   * Calculate credits after recharge interval.
   */
  private calculateRecharge(stored: UsageCredit, config: UsageConfig): number {
    const now = Date.now();
    const elapsed = now - stored.lastRecharge;

    if (elapsed < config.rechargeIntervalMs) {
      return stored.credits;
    }

    const intervals = Math.floor(elapsed / config.rechargeIntervalMs);
    const rechargeAmount = intervals * config.rechargeAmount;
    
    return Math.min(stored.credits + rechargeAmount, config.maxCredits);
  }
}

/**
 * Factory function to create a usage metering service
 */
export function createUsageMeteringService(tableName: string, region?: string) {
  return new DynamoDBUsageMeteringService(tableName, region);
}
