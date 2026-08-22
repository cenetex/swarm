/**
 * Energy Service
 *
 * Dynamic energy system for avatars with burn tier-based max energy and regen rates.
 * Base values come from the avatar's burn tier (more RATI burned = higher tier).
 * Bonus: +0.5 energy/hour per 1M tokens held by owner (capped at +2/hour)
 */
import {
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@swarm/core';
import { BURN_TIERS, ASCENSION_ENERGY_BOOST } from '@swarm/core';
import type { CreditBucket, AvatarRecord } from '../../types.js';
import { getDynamoClient } from '../dynamo-client.js';
import { createAvatarLogger } from '../structured-logger.js';

// Default DynamoDB clients
const dynamoClient = getDynamoClient();
const ADMIN_TABLE = process.env.ADMIN_TABLE!;

// =============================================================================
// ENERGY CONFIGURATION
// =============================================================================

/** Tier 0 defaults (used when burn stats unavailable) */
const TIER_0_DEFAULTS = BURN_TIERS[0];

/** Default energy configuration (uses tier 0 values) */
export const DEFAULT_ENERGY_CONFIG = {
  maxEnergy: TIER_0_DEFAULTS.maxEnergy,
  baseRefillPerHour: TIER_0_DEFAULTS.regenPerHour,
  // Wallet-based bonus config
  bonusPerMillionTokens: 0.5,  // +0.5 energy/hour per 1M tokens
  maxBonusPerHour: 2,          // Cap bonus at +2/hour
  tokenMint: 'RATixVzMQdWThJWTL7Y9sN7ypTGnBuwoUqTdmLCpump',  // $RATI token
} as const;

/** Energy costs for different operations */
export const ENERGY_COSTS = {
  voice: 1,
  image: 2,
  video: 3,
  launch: 5,  // Token launch operation - requires RATI burn to get energy
} as const;

export type EnergyCostType = keyof typeof ENERGY_COSTS;

/** Energy configuration (can be per-avatar via config.yaml) */
export interface EnergyConfig {
  maxEnergy: number;
  baseRefillPerHour: number;
  bonusPerMillionTokens: number;
  maxBonusPerHour: number;
  tokenMint?: string;
  refillCap?: number;  // Stop auto-refill when energy reaches this level
}

/** Extended energy status with refill rate info */
export interface EnergyStatus {
  current: number;
  max: number;
  nextRefillIn: number;       // Minutes until next energy point
  refillPerHour: number;      // Current refill rate (base + bonus)
  baseRefillPerHour: number;  // Base rate
  bonusRefillPerHour: number; // Wallet-based bonus
  ownerTokenBalance?: number; // Owner's token balance (if available)
  refillCap?: number;         // Auto-refill stops at this level
}

/** Energy consumption result */
export interface ConsumeEnergyResult {
  success: boolean;
  energyBefore: number;
  energyAfter: number;
  error?: {
    code: 'INSUFFICIENT_ENERGY';
    current: number;
    required: number;
    waitMinutes: number;
    alternatives: string[];
  };
}

/** Energy event for logging */
export interface EnergyEvent {
  pk: string;                  // AVATAR#{avatarId}
  sk: string;                  // ENERGY_EVENT#{timestamp}#{uuid}
  avatarId: string;
  operation: EnergyCostType;
  cost: number;
  energyBefore: number;
  energyAfter: number;
  refillRate: number;
  timestamp: number;
  requestId?: string;
  metadata?: Record<string, unknown>;
  ttl: number;                 // Auto-cleanup after 30 days
}

// =============================================================================
// DEPENDENCY INJECTION
// =============================================================================

/** Burn stats subset needed for energy calculations */
export interface BurnStatsForEnergy {
  maxEnergy: number;
  regenPerHour: number;
}

export interface EnergyServiceDeps {
  dynamoClient: Pick<DynamoDBDocumentClient, 'send'>;
  tableName: string;
  getAvatar: (avatarId: string) => Promise<AvatarRecord | null>;
  getOwnerTokenBalance: (avatarId: string, tokenMint: string) => Promise<number>;
  getBurnStatsForEnergy: (avatarId: string) => Promise<BurnStatsForEnergy>;
  now: () => number;
  uuid: () => string;
}

let defaultDeps: EnergyServiceDeps | null = null;

async function getDefaultDeps(): Promise<EnergyServiceDeps> {
  if (!defaultDeps) {
    // Lazy import to avoid circular dependencies
    const { getAvatar } = await import('../avatars.js');
    const { getOwnerTokenBalance } = await import('../web3/wallet-balance.js');
    const { getBurnStats } = await import('../web3/burn-stats.js');
    const { randomUUID } = await import('crypto');

    defaultDeps = {
      dynamoClient,
      tableName: ADMIN_TABLE,
      getAvatar,
      getOwnerTokenBalance,
      getBurnStatsForEnergy: async (avatarId: string) => {
        const stats = await getBurnStats(avatarId);
        return {
          maxEnergy: stats.maxEnergy,
          regenPerHour: stats.regenPerHour,
        };
      },
      now: () => Date.now(),
      uuid: () => randomUUID(),
    };
  }
  return defaultDeps;
}

// =============================================================================
// ENERGY BUCKET MANAGEMENT
// =============================================================================

/**
 * Get or create energy bucket for an avatar
 */
/** Extended bucket with custom energy config fields */
type EnergyBucket = CreditBucket & {
  max?: number;
  refillRate?: number;
  refillIntervalMinutes?: number;
  refillCap?: number;
};

type EnergyBankBucket = {
  pk: string;
  sk: 'CREDIT#energy_bank';
  avatarId: string;
  toolName: 'energy_bank';
  credits: number;
  updatedAt: number;
};

async function getOrCreateEnergyBucket(
  avatarId: string,
  config: EnergyConfig,
  deps: EnergyServiceDeps
): Promise<EnergyBucket> {
  const pk = `AVATAR#${avatarId}`;
  const sk = 'CREDIT#energy';

  const result = await deps.dynamoClient.send(new GetCommand({
    TableName: deps.tableName,
    Key: { pk, sk },
  }));

  if (result.Item) {
    return result.Item as EnergyBucket;
  }

  const now = deps.now();
  const bucket: EnergyBucket = {
    pk,
    sk,
    avatarId,
    toolName: 'energy',
    credits: config.maxEnergy,  // Start with full energy
    maxCredits: config.maxEnergy,
    lastRefillAt: now,
    dailyUsed: 0,
    dailyLimit: 999999,  // No daily limit for energy
    dailyResetAt: getNextMidnightUTC(now),
  };

  await deps.dynamoClient.send(new PutCommand({
    TableName: deps.tableName,
    Item: bucket,
  }));

  return bucket;
}

async function getOrCreateEnergyBankBucket(
  avatarId: string,
  deps: EnergyServiceDeps
): Promise<EnergyBankBucket> {
  const pk = `AVATAR#${avatarId}`;
  const sk = 'CREDIT#energy_bank' as const;

  const result = await deps.dynamoClient.send(new GetCommand({
    TableName: deps.tableName,
    Key: { pk, sk },
  }));

  if (result.Item) {
    return result.Item as EnergyBankBucket;
  }

  const now = deps.now();
  const bucket: EnergyBankBucket = {
    pk,
    sk,
    avatarId,
    toolName: 'energy_bank',
    credits: 0,
    updatedAt: now,
  };

  await deps.dynamoClient.send(new PutCommand({
    TableName: deps.tableName,
    Item: bucket,
  }));

  return bucket;
}

function getNextMidnightUTC(now: number): number {
  const date = new Date(now);
  const tomorrow = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + 1,
    0, 0, 0, 0
  ));
  return tomorrow.getTime();
}

// =============================================================================
// DYNAMIC REFILL RATE CALCULATION
// =============================================================================

/**
 * Get energy configuration for an avatar
 * Uses burn tier-based values for maxEnergy and baseRefillPerHour,
 * with optional bucket overrides for advanced configurations.
 * Ascended avatars get boosted energy (+50% max, +50% regen).
 */
export async function getAvatarEnergyConfig(
  avatarId: string,
  deps?: EnergyServiceDeps
): Promise<EnergyConfig> {
  const d = deps ?? await getDefaultDeps();
  const pk = `AVATAR#${avatarId}`;
  const sk = 'CREDIT#energy';

  // Fetch burn stats for tier-based values (with fallback to tier 0)
  let burnStats: BurnStatsForEnergy;
  try {
    burnStats = await d.getBurnStatsForEnergy(avatarId);
  } catch (error) {
    createAvatarLogger(avatarId, 'billing').warn('burn_stats', 'burn_stats_fetch_failed', {
      message: 'Failed to get burn stats, using tier 0 defaults',
      error: error instanceof Error ? error.message : String(error),
    });
    burnStats = {
      maxEnergy: TIER_0_DEFAULTS.maxEnergy,
      regenPerHour: TIER_0_DEFAULTS.regenPerHour,
    };
  }

  // Check if avatar is ascended (for energy boost)
  let isAscended = false;
  try {
    const avatar = await d.getAvatar(avatarId);
    isAscended = avatar?.isAscended === true;
  } catch (error) {
    createAvatarLogger(avatarId, 'billing').warn('ascension', 'ascension_status_check_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  // Apply ascension boost if applicable (+50% max energy, +50% regen)
  let maxEnergy = burnStats.maxEnergy;
  let regenPerHour = burnStats.regenPerHour;
  if (isAscended) {
    maxEnergy = Math.floor(maxEnergy * ASCENSION_ENERGY_BOOST.maxEnergyMultiplier);
    regenPerHour = regenPerHour * ASCENSION_ENERGY_BOOST.regenRateMultiplier;
  }

  // Check if bucket has custom config overrides
  const result = await d.dynamoClient.send(new GetCommand({
    TableName: d.tableName,
    Key: { pk, sk },
  }));

  const bucket = result.Item as CreditBucket & {
    max?: number;
    refillRate?: number;
    refillIntervalMinutes?: number;
    refillCap?: number;
  } | undefined;

  // Use tier-based values as defaults, allow bucket overrides for special cases
  let baseRefillPerHour = regenPerHour;
  if (bucket?.refillRate && bucket?.refillIntervalMinutes) {
    // Convert refillRate per interval to per hour (legacy override)
    // e.g., 1 per 15 min = 4 per hour
    baseRefillPerHour = (bucket.refillRate * 60) / bucket.refillIntervalMinutes;
  }

  return {
    maxEnergy: bucket?.max ?? maxEnergy,
    baseRefillPerHour,
    bonusPerMillionTokens: DEFAULT_ENERGY_CONFIG.bonusPerMillionTokens,
    maxBonusPerHour: DEFAULT_ENERGY_CONFIG.maxBonusPerHour,
    tokenMint: DEFAULT_ENERGY_CONFIG.tokenMint,
    refillCap: bucket?.refillCap,
  };
}

/**
 * Calculate dynamic refill rate based on owner's token balance
 */
export async function calculateRefillRate(
  avatarId: string,
  config: EnergyConfig,
  deps: EnergyServiceDeps
): Promise<{ refillPerHour: number; bonusPerHour: number; tokenBalance: number }> {
  try {
    // Get owner's token balance
    const tokenMint = config.tokenMint || DEFAULT_ENERGY_CONFIG.tokenMint;
    const tokenBalance = await deps.getOwnerTokenBalance(avatarId, tokenMint);
    
    // Calculate bonus: +0.5/hour per 1M tokens, capped
    const millionTokens = tokenBalance / 1_000_000;
    const rawBonus = millionTokens * config.bonusPerMillionTokens;
    const bonusPerHour = Math.min(rawBonus, config.maxBonusPerHour);
    
    const refillPerHour = config.baseRefillPerHour + bonusPerHour;
    
    return { refillPerHour, bonusPerHour, tokenBalance };
  } catch (error) {
    // On error, fall back to base rate
    createAvatarLogger(avatarId, 'billing').warn('refill_rate', 'token_balance_fetch_failed', {
      message: 'Failed to get token balance, using base rate',
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      refillPerHour: config.baseRefillPerHour,
      bonusPerHour: 0,
      tokenBalance: 0,
    };
  }
}

/**
 * Calculate current energy with refill
 * Respects refillCap - auto-refill stops when energy is at or above the cap
 */
function calculateCurrentEnergy(
  bucket: EnergyBucket,
  refillPerHour: number,
  maxEnergy: number,
  now: number
): number {
  const refillCap = bucket.refillCap ?? maxEnergy;  // Default to max if no cap
  
  // If already at or above refill cap, no auto-refill applies
  if (bucket.credits >= refillCap) {
    return Math.min(bucket.credits, maxEnergy);  // Still respect maxEnergy
  }
  
  const hoursSinceRefill = (now - bucket.lastRefillAt) / (1000 * 60 * 60);
  const energyToAdd = hoursSinceRefill * refillPerHour;
  const newEnergy = bucket.credits + energyToAdd;
  
  // Cap at refillCap for auto-refill, but allow manual additions above
  return Math.min(newEnergy, refillCap);
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Get current energy status for an avatar (with dynamic refill rate)
 */
export async function getEnergyStatus(
  avatarId: string,
  deps?: EnergyServiceDeps
): Promise<EnergyStatus> {
  const d = deps ?? await getDefaultDeps();
  const config = await getAvatarEnergyConfig(avatarId, d);
  const bucket = await getOrCreateEnergyBucket(avatarId, config, d);
  const now = d.now();
  
  // Calculate dynamic refill rate
  const { refillPerHour, bonusPerHour, tokenBalance } = await calculateRefillRate(avatarId, config, d);
  
  // Calculate current energy
  const currentEnergy = calculateCurrentEnergy(bucket, refillPerHour, config.maxEnergy, now);
  const flooredEnergy = Math.floor(currentEnergy);
  
  // Calculate minutes until next energy point (only if below refillCap)
  const refillCap = config.refillCap ?? config.maxEnergy;
  const fractionalEnergy = currentEnergy - flooredEnergy;
  const energyNeededForNext = 1 - fractionalEnergy;
  const hoursUntilNext = energyNeededForNext / refillPerHour;
  const minutesUntilNext = Math.ceil(hoursUntilNext * 60);
  
  // No refill if at or above refillCap
  const effectiveNextRefill = flooredEnergy >= refillCap ? 0 : minutesUntilNext;

  return {
    current: flooredEnergy,
    max: config.maxEnergy,
    nextRefillIn: effectiveNextRefill,
    refillPerHour: Math.round(refillPerHour * 100) / 100,  // Round to 2 decimals
    baseRefillPerHour: config.baseRefillPerHour,
    bonusRefillPerHour: Math.round(bonusPerHour * 100) / 100,
    ownerTokenBalance: tokenBalance,
    refillCap: config.refillCap,
  };
}

/**
 * Check if avatar can use energy (pre-check before operation)
 */
export async function canUseEnergy(
  avatarId: string,
  cost: number,
  deps?: EnergyServiceDeps
): Promise<{ allowed: boolean; reason?: string; remaining?: number; refillPerHour?: number }> {
  if (cost <= 0) {
    return { allowed: true, remaining: DEFAULT_ENERGY_CONFIG.maxEnergy };
  }

  const d = deps ?? await getDefaultDeps();
  const config = await getAvatarEnergyConfig(avatarId, d);
  const bucket = await getOrCreateEnergyBucket(avatarId, config, d);
  const now = d.now();
  
  // Calculate dynamic refill rate
  const { refillPerHour } = await calculateRefillRate(avatarId, config, d);
  
  // Calculate current energy
  const currentEnergy = Math.floor(calculateCurrentEnergy(bucket, refillPerHour, config.maxEnergy, now));

  if (currentEnergy < cost) {
    // Consider purchased energy credits (bank) as an instant top-up source.
    const deficit = cost - currentEnergy;
    if (deficit > 0) {
      try {
        const bank = await getOrCreateEnergyBankBucket(avatarId, d);
        const bankCredits = bank.credits ?? 0;
        if (bankCredits >= deficit) {
          return { allowed: true, remaining: currentEnergy, refillPerHour };
        }
      } catch {
        // Ignore bank errors and fall back to normal insufficient response.
      }
    }

    const hoursUntilEnough = (cost - currentEnergy) / refillPerHour;
    const minutesUntilEnough = Math.ceil(hoursUntilEnough * 60);
    
    return {
      allowed: false,
      reason: `Not enough energy (have ${currentEnergy}⚡, need ${cost}⚡). ` +
              `Regenerating at ${refillPerHour}/hour. ` +
              `~${minutesUntilEnough}m until enough.`,
      remaining: currentEnergy,
      refillPerHour,
    };
  }

  return { allowed: true, remaining: currentEnergy, refillPerHour };
}

/**
 * Consume energy for an operation (with logging)
 */
export async function consumeEnergy(
  avatarId: string,
  cost: number,
  operation: EnergyCostType,
  options?: {
    requestId?: string;
    metadata?: Record<string, unknown>;
  },
  deps?: EnergyServiceDeps
): Promise<ConsumeEnergyResult> {
  if (cost <= 0) {
    return { success: true, energyBefore: 0, energyAfter: 0 };
  }

  const d = deps ?? await getDefaultDeps();
  const config = await getAvatarEnergyConfig(avatarId, d);
  const bucket = await getOrCreateEnergyBucket(avatarId, config, d);
  const now = d.now();
  
  // Calculate dynamic refill rate
  const { refillPerHour } = await calculateRefillRate(avatarId, config, d);
  
  // Calculate current energy
  const currentEnergy = calculateCurrentEnergy(bucket, refillPerHour, config.maxEnergy, now);
  const flooredEnergy = Math.floor(currentEnergy);

  if (flooredEnergy < cost) {
    // If the avatar has purchased energy credits (bank), auto-spend them to cover the deficit.
    const deficit = cost - flooredEnergy;
    if (deficit > 0) {
      try {
        const bank = await getOrCreateEnergyBankBucket(avatarId, d);
        const bankCredits = bank.credits ?? 0;

        if (bankCredits >= deficit) {
          const newEnergy = currentEnergy + deficit - cost;

          await d.dynamoClient.send(new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: d.tableName,
                  Key: { pk: bucket.pk, sk: bucket.sk },
                  UpdateExpression: 'SET credits = :credits, lastRefillAt = :now',
                  ExpressionAttributeValues: {
                    ':credits': newEnergy,
                    ':now': now,
                  },
                },
              },
              {
                Update: {
                  TableName: d.tableName,
                  Key: { pk: bank.pk, sk: bank.sk },
                  ConditionExpression: 'credits >= :deficit',
                  UpdateExpression: 'SET credits = credits - :deficit, updatedAt = :now',
                  ExpressionAttributeValues: {
                    ':deficit': deficit,
                    ':now': now,
                  },
                },
              },
            ],
          }));

          await logEnergyEvent({
            avatarId,
            operation,
            cost,
            energyBefore: flooredEnergy,
            energyAfter: Math.floor(newEnergy),
            refillRate: refillPerHour,
            requestId: options?.requestId,
            metadata: {
              ...options?.metadata,
              bankCreditsUsed: deficit,
            },
          }, d);

          return {
            success: true,
            energyBefore: flooredEnergy,
            energyAfter: Math.floor(newEnergy),
          };
        }
      } catch {
        // Fall through to insufficient-energy response below.
      }
    }

    const hoursUntilEnough = (cost - flooredEnergy) / refillPerHour;
    const minutesUntilEnough = Math.ceil(hoursUntilEnough * 60);
    
    return {
      success: false,
      energyBefore: flooredEnergy,
      energyAfter: flooredEnergy,
      error: {
        code: 'INSUFFICIENT_ENERGY',
        current: flooredEnergy,
        required: cost,
        waitMinutes: minutesUntilEnough,
        alternatives: getSuggestedAlternatives(cost, operation),
      },
    };
  }

  // Consume energy atomically
  const newEnergy = currentEnergy - cost;
  
  await d.dynamoClient.send(new UpdateCommand({
    TableName: d.tableName,
    Key: { pk: bucket.pk, sk: bucket.sk },
    UpdateExpression: 'SET credits = :credits, lastRefillAt = :now',
    ExpressionAttributeValues: {
      ':credits': newEnergy,
      ':now': now,
    },
  }));

  // Log energy event
  await logEnergyEvent({
    avatarId,
    operation,
    cost,
    energyBefore: flooredEnergy,
    energyAfter: Math.floor(newEnergy),
    refillRate: refillPerHour,
    requestId: options?.requestId,
    metadata: options?.metadata,
  }, d);

  return {
    success: true,
    energyBefore: flooredEnergy,
    energyAfter: Math.floor(newEnergy),
  };
}

// =============================================================================
// ENERGY BANK (PURCHASED CREDITS)
// =============================================================================

/**
 * Get purchased energy credits (bank) for an avatar.
 * These credits can be auto-spent to cover energy deficits.
 */
export async function getEnergyBankBalance(
  avatarId: string,
  deps?: EnergyServiceDeps
): Promise<{ credits: number }> {
  const d = deps ?? await getDefaultDeps();
  const bank = await getOrCreateEnergyBankBucket(avatarId, d);
  return { credits: bank.credits ?? 0 };
}

/**
 * Add purchased energy credits (bank) for an avatar.
 */
export async function addEnergyBankCredits(
  avatarId: string,
  amount: number,
  deps?: EnergyServiceDeps
): Promise<{ success: boolean; newCredits: number }> {
  const d = deps ?? await getDefaultDeps();
  const now = d.now();
  const safeAmount = Number.isFinite(amount) ? Math.floor(amount) : 0;
  if (safeAmount <= 0) {
    const bank = await getOrCreateEnergyBankBucket(avatarId, d);
    return { success: true, newCredits: bank.credits ?? 0 };
  }

  const pk = `AVATAR#${avatarId}`;
  const sk = 'CREDIT#energy_bank' as const;

  const result = await d.dynamoClient.send(new UpdateCommand({
    TableName: d.tableName,
    Key: { pk, sk },
    UpdateExpression: 'SET toolName = :toolName, avatarId = :avatarId, credits = if_not_exists(credits, :zero) + :amount, updatedAt = :now',
    ExpressionAttributeValues: {
      ':toolName': 'energy_bank',
      ':avatarId': avatarId,
      ':zero': 0,
      ':amount': safeAmount,
      ':now': now,
    },
    ReturnValues: 'ALL_NEW',
  }));

  const newCredits = (result.Attributes?.credits as number | undefined) ?? safeAmount;
  return { success: true, newCredits };
}

/**
 * Consume energy (simple version for backward compatibility)
 */
export async function consumeEnergySimple(
  avatarId: string,
  cost: number,
  deps?: EnergyServiceDeps
): Promise<boolean> {
  const result = await consumeEnergy(avatarId, cost, 'image', undefined, deps);
  return result.success;
}

/**
 * Admin: Set energy level for an avatar
 */
export async function setEnergy(
  avatarId: string,
  value: number,
  deps?: EnergyServiceDeps
): Promise<{ success: boolean; newValue: number }> {
  const d = deps ?? await getDefaultDeps();
  const config = await getAvatarEnergyConfig(avatarId, d);
  
  // Clamp value to valid range
  const clampedValue = Math.max(0, Math.min(value, config.maxEnergy));
  
  const pk = `AVATAR#${avatarId}`;
  const sk = 'CREDIT#energy';
  const now = d.now();

  await d.dynamoClient.send(new UpdateCommand({
    TableName: d.tableName,
    Key: { pk, sk },
    UpdateExpression: 'SET credits = :credits, lastRefillAt = :now',
    ExpressionAttributeValues: {
      ':credits': clampedValue,
      ':now': now,
    },
  }));

  return { success: true, newValue: clampedValue };
}

/**
 * Admin: Add energy to an avatar
 */
export async function addEnergy(
  avatarId: string,
  amount: number,
  deps?: EnergyServiceDeps
): Promise<{ success: boolean; newValue: number }> {
  const d = deps ?? await getDefaultDeps();
  const status = await getEnergyStatus(avatarId, d);
  const config = await getAvatarEnergyConfig(avatarId, d);
  
  const newValue = Math.min(status.current + amount, config.maxEnergy);
  return setEnergy(avatarId, newValue, d);
}

// =============================================================================
// ENERGY EVENT LOGGING
// =============================================================================

async function logEnergyEvent(
  event: Omit<EnergyEvent, 'pk' | 'sk' | 'timestamp' | 'ttl'>,
  deps: EnergyServiceDeps
): Promise<void> {
  const now = deps.now();
  const ttl = Math.floor(now / 1000) + (30 * 24 * 60 * 60);  // 30 days
  
  const record: EnergyEvent = {
    pk: `AVATAR#${event.avatarId}`,
    sk: `ENERGY_EVENT#${now}#${deps.uuid()}`,
    timestamp: now,
    ttl,
    ...event,
  };

  try {
    await deps.dynamoClient.send(new PutCommand({
      TableName: deps.tableName,
      Item: record,
    }));
  } catch (error) {
    // Don't fail the operation if logging fails
    createAvatarLogger(event.avatarId, 'billing').error('energy_event', 'log_write_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Get recent energy events for an avatar
 */
export async function getEnergyHistory(
  avatarId: string,
  limit: number = 50,
  deps?: EnergyServiceDeps
): Promise<EnergyEvent[]> {
  const d = deps ?? await getDefaultDeps();
  
  const result = await d.dynamoClient.send(new QueryCommand({
    TableName: d.tableName,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: {
      ':pk': `AVATAR#${avatarId}`,
      ':prefix': 'ENERGY_EVENT#',
    },
    ScanIndexForward: false,  // Most recent first
    Limit: limit,
  }));

  return (result.Items || []) as EnergyEvent[];
}

// =============================================================================
// HELPERS
// =============================================================================

function getSuggestedAlternatives(cost: number, operation: EnergyCostType): string[] {
  const alternatives: string[] = [];

  if (operation === 'video' || cost === ENERGY_COSTS.video) {
    alternatives.push('Try generating an image instead (costs 2⚡ vs 3⚡)');
  }
  if (operation === 'image' || cost === ENERGY_COSTS.image) {
    alternatives.push('Voice messages only cost 1⚡');
  }

  alternatives.push('Burn RATI to increase your tier for higher max energy and faster regen');
  alternatives.push('Hold more $RATI tokens to get a bonus to your energy regeneration rate');
  alternatives.push('Wait for energy to regenerate (check your current rate with get_energy_status)');

  return alternatives;
}

// =============================================================================
// BACKWARD COMPATIBILITY EXPORTS
// =============================================================================

// Re-export constants for backward compatibility
export const ENERGY_MAX = DEFAULT_ENERGY_CONFIG.maxEnergy;
export const ENERGY_PER_HOUR = DEFAULT_ENERGY_CONFIG.baseRefillPerHour;
