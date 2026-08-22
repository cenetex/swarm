/**
 * Twitter Rate Limit Service
 *
 * Manages rate limiting for Twitter API calls with:
 * - Per-tier limits (free: 100/month, basic: 15,000/month)
 * - 429 detection with exponential backoff
 * - Circuit breaker pattern for consecutive failures
 * - Daily and monthly budget tracking
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from '@swarm/core';
import {
  type RateLimitState,
  type TwitterApiTier,
  getBackoffDuration,
} from '@swarm/core';

// Monthly limits by tier
const TIER_MONTHLY_LIMITS: Record<TwitterApiTier, number> = {
  free: 100,
  basic: 15_000,
};

// Daily limit as percentage of monthly budget
const DEFAULT_DAILY_RESERVE_PCT = 20;

/**
 * Rate limit check result
 */
export interface RateLimitCheckResult {
  /** Whether posting is allowed */
  allowed: boolean;
  /** Seconds until rate limit expires (if blocked) */
  retryAfter?: number;
  /** Reason for blocking (if not allowed) */
  reason?: 'monthly_limit' | 'daily_limit' | 'backoff' | 'circuit_breaker';
  /** Current state snapshot */
  state: RateLimitState;
}

/**
 * Rate Limit Service Interface
 */
export interface RateLimitService {
  /** Check if posting is allowed */
  canPost(avatarId?: string): Promise<RateLimitCheckResult>;
  /** Record a successful post */
  recordSuccess(avatarId?: string): Promise<void>;
  /** Record a 429 error */
  record429(avatarId?: string, retryAfterSeconds?: number): Promise<void>;
  /** Record a non-429 failure */
  recordFailure(avatarId?: string, error?: string): Promise<void>;
  /** Get current rate limit state */
  getState(avatarId?: string): Promise<RateLimitState>;
  /** Reset consecutive 429 count (e.g., after successful retry) */
  resetBackoff(avatarId?: string): Promise<void>;
}

/**
 * DynamoDB implementation of RateLimitService
 */
export class DynamoDBRateLimitService implements RateLimitService {
  private docClient: DynamoDBDocumentClient;
  private tableName: string;
  private tier: TwitterApiTier;
  private dailyReservePct: number;
  private monthlyBudget?: number;

  constructor(
    tableName: string,
    options?: {
      tier?: TwitterApiTier;
      dailyReservePct?: number;
      monthlyBudget?: number;
      docClient?: DynamoDBDocumentClient;
    }
  ) {
    if (options?.docClient) {
      this.docClient = options.docClient;
    } else {
      const client = new DynamoDBClient({});
      this.docClient = DynamoDBDocumentClient.from(client, {
        marshallOptions: { removeUndefinedValues: true },
      });
    }
    this.tableName = tableName;
    this.tier = options?.tier || 'basic';
    this.dailyReservePct = options?.dailyReservePct ?? DEFAULT_DAILY_RESERVE_PCT;
    this.monthlyBudget = options?.monthlyBudget;
  }

  // =========================================================================
  // PRIVATE HELPERS
  // =========================================================================

  private buildPK(): string {
    return 'RATELIMIT#twitter';
  }

  private buildSK(avatarId?: string): string {
    return avatarId ? `AVATAR#${avatarId}` : 'GLOBAL';
  }

  private getCurrentMonth(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  private getCurrentDay(): string {
    const now = new Date();
    return now.toISOString().split('T')[0];
  }

  private getMonthlyLimit(): number {
    return this.monthlyBudget ?? TIER_MONTHLY_LIMITS[this.tier];
  }

  private getDailyLimit(): number {
    const monthlyLimit = this.getMonthlyLimit();
    // Calculate daily limit based on reserve percentage
    // Reserve some budget for spikes, distribute the rest evenly across days
    const daysInMonth = new Date(
      new Date().getFullYear(),
      new Date().getMonth() + 1,
      0
    ).getDate();
    const availableBudget = monthlyLimit * (1 - this.dailyReservePct / 100);
    return Math.floor(availableBudget / daysInMonth);
  }

  private getDefaultState(): RateLimitState {
    return {
      isRateLimited: false,
      tier: this.tier,
      postsThisMonth: 0,
      postsToday: 0,
      consecutive429s: 0,
      currentMonth: this.getCurrentMonth(),
      currentDay: this.getCurrentDay(),
      updatedAt: Date.now(),
    };
  }

  // =========================================================================
  // PUBLIC API
  // =========================================================================

  async getState(avatarId?: string): Promise<RateLimitState> {
    const result = await this.docClient.send(new GetCommand({
      TableName: this.tableName,
      Key: {
        pk: this.buildPK(),
        sk: this.buildSK(avatarId),
      },
    }));

    if (!result.Item) {
      return this.getDefaultState();
    }

    const item = result.Item as Record<string, unknown>;
    const currentMonth = this.getCurrentMonth();
    const currentDay = this.getCurrentDay();

    // Reset counters if month/day changed
    let postsThisMonth = item.postsThisMonth as number || 0;
    let postsToday = item.postsToday as number || 0;

    if (item.currentMonth !== currentMonth) {
      postsThisMonth = 0;
      postsToday = 0;
    } else if (item.currentDay !== currentDay) {
      postsToday = 0;
    }

    return {
      isRateLimited: item.isRateLimited as boolean || false,
      rateLimitedUntil: item.rateLimitedUntil as number | undefined,
      tier: item.tier as TwitterApiTier || this.tier,
      postsThisMonth,
      postsToday,
      consecutive429s: item.consecutive429s as number || 0,
      last429At: item.last429At as number | undefined,
      backoffUntil: item.backoffUntil as number | undefined,
      currentMonth,
      currentDay,
      lastSuccessAt: item.lastSuccessAt as number | undefined,
      updatedAt: item.updatedAt as number || Date.now(),
    };
  }

  async canPost(avatarId?: string): Promise<RateLimitCheckResult> {
    const state = await this.getState(avatarId);
    const now = Date.now();

    // Check circuit breaker (backoff from consecutive 429s)
    if (state.backoffUntil && now < state.backoffUntil) {
      const retryAfter = Math.ceil((state.backoffUntil - now) / 1000);
      return {
        allowed: false,
        retryAfter,
        reason: state.consecutive429s >= 4 ? 'circuit_breaker' : 'backoff',
        state,
      };
    }

    // Check monthly limit
    const monthlyLimit = this.getMonthlyLimit();
    if (state.postsThisMonth >= monthlyLimit) {
      // Calculate retry after (start of next month)
      const nextMonth = new Date();
      nextMonth.setMonth(nextMonth.getMonth() + 1);
      nextMonth.setDate(1);
      nextMonth.setHours(0, 0, 0, 0);
      const retryAfter = Math.ceil((nextMonth.getTime() - now) / 1000);

      return {
        allowed: false,
        retryAfter,
        reason: 'monthly_limit',
        state,
      };
    }

    // Check daily limit (soft limit - can exceed if monthly budget allows)
    const dailyLimit = this.getDailyLimit();
    if (state.postsToday >= dailyLimit) {
      // Calculate retry after (start of next day)
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(0, 0, 0, 0);
      const retryAfter = Math.ceil((tomorrow.getTime() - now) / 1000);

      // If we still have monthly budget, allow with warning
      if (state.postsThisMonth < monthlyLimit * 0.9) {
        return {
          allowed: true,
          state: { ...state, isRateLimited: false },
        };
      }

      return {
        allowed: false,
        retryAfter,
        reason: 'daily_limit',
        state,
      };
    }

    return {
      allowed: true,
      state: { ...state, isRateLimited: false },
    };
  }

  async recordSuccess(avatarId?: string): Promise<void> {
    const currentMonth = this.getCurrentMonth();
    const currentDay = this.getCurrentDay();
    const now = Date.now();

    await this.docClient.send(new UpdateCommand({
      TableName: this.tableName,
      Key: {
        pk: this.buildPK(),
        sk: this.buildSK(avatarId),
      },
      UpdateExpression: `
        SET postsThisMonth = if_not_exists(postsThisMonth, :zero) + :one,
            postsToday = if_not_exists(postsToday, :zero) + :one,
            currentMonth = :month,
            currentDay = :day,
            consecutive429s = :zero,
            isRateLimited = :false,
            lastSuccessAt = :now,
            updatedAt = :now,
            tier = :tier
        REMOVE backoffUntil, rateLimitedUntil
      `,
      ExpressionAttributeValues: {
        ':zero': 0,
        ':one': 1,
        ':month': currentMonth,
        ':day': currentDay,
        ':false': false,
        ':now': now,
        ':tier': this.tier,
      },
    }));
  }

  async record429(avatarId?: string, retryAfterSeconds?: number): Promise<void> {
    const state = await this.getState(avatarId);
    const now = Date.now();
    const consecutive429s = state.consecutive429s + 1;

    // Calculate backoff duration
    const backoffMs = retryAfterSeconds
      ? retryAfterSeconds * 1000
      : getBackoffDuration(consecutive429s);
    const backoffUntil = now + backoffMs;

    await this.docClient.send(new UpdateCommand({
      TableName: this.tableName,
      Key: {
        pk: this.buildPK(),
        sk: this.buildSK(avatarId),
      },
      UpdateExpression: `
        SET consecutive429s = :count,
            last429At = :now,
            backoffUntil = :backoff,
            isRateLimited = :true,
            rateLimitedUntil = :backoff,
            updatedAt = :now,
            currentMonth = :month,
            currentDay = :day,
            tier = :tier
      `,
      ExpressionAttributeValues: {
        ':count': consecutive429s,
        ':now': now,
        ':backoff': backoffUntil,
        ':true': true,
        ':month': this.getCurrentMonth(),
        ':day': this.getCurrentDay(),
        ':tier': this.tier,
      },
    }));
  }

  async recordFailure(avatarId?: string, _error?: string): Promise<void> {
    // Non-429 failures don't trigger backoff, just update timestamp
    await this.docClient.send(new UpdateCommand({
      TableName: this.tableName,
      Key: {
        pk: this.buildPK(),
        sk: this.buildSK(avatarId),
      },
      UpdateExpression: `
        SET updatedAt = :now,
            currentMonth = :month,
            currentDay = :day,
            tier = :tier
      `,
      ExpressionAttributeValues: {
        ':now': Date.now(),
        ':month': this.getCurrentMonth(),
        ':day': this.getCurrentDay(),
        ':tier': this.tier,
      },
    }));
  }

  async resetBackoff(avatarId?: string): Promise<void> {
    await this.docClient.send(new UpdateCommand({
      TableName: this.tableName,
      Key: {
        pk: this.buildPK(),
        sk: this.buildSK(avatarId),
      },
      UpdateExpression: `
        SET consecutive429s = :zero,
            isRateLimited = :false,
            updatedAt = :now
        REMOVE backoffUntil, rateLimitedUntil
      `,
      ExpressionAttributeValues: {
        ':zero': 0,
        ':false': false,
        ':now': Date.now(),
      },
    }));
  }
}

/**
 * Factory function
 */
export function createRateLimitService(
  tableName: string,
  options?: {
    tier?: TwitterApiTier;
    dailyReservePct?: number;
    monthlyBudget?: number;
  }
): RateLimitService {
  return new DynamoDBRateLimitService(tableName, options);
}
