/**
 * Credit System Service
 * Rate limiting via token bucket algorithm with hourly refill and daily limits
 *
 * NOTE: Energy system has been moved to energy.ts with dynamic wallet-based refill rates.
 * This file now re-exports the energy functions for backward compatibility.
 *
 * Unified Burst Pool Model:
 * Entitlement daily limits are checked first. Energy is only consumed when the
 * entitlement daily limit is exhausted, acting as a "burst" mechanism.
 * Enterprise avatars (limit = -1) never touch the energy pool.
 */
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { CreditBucket } from '../../types.js';
import { getDynamoClient } from '../dynamo-client.js';

// Re-export energy functions from the new energy service
export {
  ENERGY_MAX,
  ENERGY_PER_HOUR,
  ENERGY_COSTS,
  getEnergyStatus,
  setEnergy,
  addEnergy,
  getEnergyHistory,
  type EnergyStatus,
  type EnergyConfig,
  type ConsumeEnergyResult,
  type EnergyEvent,
} from './energy.js';

// Import for backward-compatible wrappers
import {
  ENERGY_COSTS as ENERGY_COSTS_INTERNAL,
  canUseEnergy as canUseEnergyNew,
  consumeEnergy as consumeEnergyFull,
  consumeEnergySimple,
  type EnergyCostType,
} from './energy.js';

// Lazy import for entitlements to avoid circular dependencies
async function getCheckLimit() {
  const { checkLimit } = await import('./entitlements.js');
  return checkLimit;
}

/**
 * Check if avatar can use energy (backward compatible signature)
 */
export async function canUseEnergy(
  avatarId: string,
  cost: number
): Promise<{ allowed: boolean; reason?: string; remaining?: number }> {
  return canUseEnergyNew(avatarId, cost);
}

/**
 * Consume energy for an operation (backward compatible signature returning boolean)
 * For detailed result with logging, use consumeEnergyWithResult from energy.js
 */
export async function consumeEnergy(
  avatarId: string,
  cost: number
): Promise<boolean> {
  return consumeEnergySimple(avatarId, cost);
}

const dynamoClient = getDynamoClient();
const ADMIN_TABLE = process.env.ADMIN_TABLE!;

/**
 * Tool credit configuration
 */
export const TOOL_CREDITS: Record<string, {
  creditsPerHour: number;
  maxCredits: number;
  dailyLimit: number;
}> = {
  send_message: {
    creditsPerHour: 3600,
    maxCredits: 1,
    dailyLimit: 86400,
  },
  generate_image: {
    creditsPerHour: 60,
    maxCredits: 1,
    dailyLimit: 1440,
  },
  generate_video: {
    creditsPerHour: 1,
    maxCredits: 1,
    dailyLimit: 24,
  },
  generate_sticker: {
    creditsPerHour: 2,
    maxCredits: 5,
    dailyLimit: 30,
  },
  create_sticker: {
    creditsPerHour: 2,
    maxCredits: 4,
    dailyLimit: 20,
  },
  post_tweet: {
    creditsPerHour: 3,
    maxCredits: 10,
    dailyLimit: 50,
  },
  set_profile_image: {
    creditsPerHour: 1,
    maxCredits: 3,
    dailyLimit: 10,
  },
  set_character_reference: {
    creditsPerHour: 1,
    maxCredits: 3,
    dailyLimit: 10,
  },
};

/**
 * Get or create a credit bucket for an avatar/tool
 */
async function getOrCreateBucket(
  avatarId: string,
  toolName: string
): Promise<CreditBucket> {
  const config = TOOL_CREDITS[toolName];
  if (!config) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  const pk = `AVATAR#${avatarId}`;
  const sk = `CREDIT#${toolName}`;

  const result = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: { pk, sk },
  }));

  if (result.Item) {
    return result.Item as CreditBucket;
  }

  // Create new bucket with full credits
  const now = Date.now();
  const bucket: CreditBucket = {
    pk,
    sk,
    avatarId,
    toolName,
    credits: config.maxCredits,
    maxCredits: config.maxCredits,
    lastRefillAt: now,
    dailyUsed: 0,
    dailyLimit: config.dailyLimit,
    dailyResetAt: getNextMidnightUTC(),
  };

  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: bucket,
  }));

  return bucket;
}

/**
 * Get next midnight UTC timestamp
 */
function getNextMidnightUTC(): number {
  const now = new Date();
  const tomorrow = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0, 0, 0, 0
  ));
  return tomorrow.getTime();
}

/**
 * Calculate refilled credits based on time elapsed
 */
function calculateRefill(bucket: CreditBucket, config: typeof TOOL_CREDITS[string]): number {
  const now = Date.now();
  const hoursSinceRefill = (now - bucket.lastRefillAt) / (1000 * 60 * 60);
  const creditsToAdd = Math.floor(hoursSinceRefill * config.creditsPerHour);

  return Math.min(bucket.credits + creditsToAdd, config.maxCredits);
}

/**
 * Check if a tool can be used (has credits available)
 */
export async function canUseTool(
  avatarId: string,
  toolName: string
): Promise<{ allowed: boolean; reason?: string; credits?: number }> {
  const config = TOOL_CREDITS[toolName];
  if (!config) {
    return { allowed: true }; // Unknown tools are always allowed
  }

  const bucket = await getOrCreateBucket(avatarId, toolName);
  const now = Date.now();

  // Check daily reset
  if (now >= bucket.dailyResetAt) {
    // Daily limit has reset
    bucket.dailyUsed = 0;
    bucket.dailyResetAt = getNextMidnightUTC();
  }

  // Check daily limit
  if (bucket.dailyUsed >= config.dailyLimit) {
    return {
      allowed: false,
      reason: `Daily limit reached (${config.dailyLimit}). Resets at midnight UTC.`,
      credits: 0,
    };
  }

  // Calculate current credits with refill
  const currentCredits = calculateRefill(bucket, config);

  if (currentCredits < 1) {
    const minutesUntilRefill = Math.ceil(60 / config.creditsPerHour);
    return {
      allowed: false,
      reason: `No credits available. Next credit in ~${minutesUntilRefill} minutes.`,
      credits: currentCredits,
    };
  }

  return { allowed: true, credits: currentCredits };
}

/**
 * Consume a credit for tool usage
 */
export async function consumeCredit(
  avatarId: string,
  toolName: string
): Promise<boolean> {
  const config = TOOL_CREDITS[toolName];
  if (!config) {
    return true; // Unknown tools don't consume credits
  }

  const bucket = await getOrCreateBucket(avatarId, toolName);
  const now = Date.now();

  // Calculate current credits with refill
  const currentCredits = calculateRefill(bucket, config);

  if (currentCredits < 1) {
    return false;
  }

  // Reset daily if needed
  let dailyUsed = bucket.dailyUsed;
  let dailyResetAt = bucket.dailyResetAt;
  if (now >= dailyResetAt) {
    dailyUsed = 0;
    dailyResetAt = getNextMidnightUTC();
  }

  // Update bucket
  await dynamoClient.send(new UpdateCommand({
    TableName: ADMIN_TABLE,
    Key: { pk: bucket.pk, sk: bucket.sk },
    UpdateExpression: 'SET credits = :credits, lastRefillAt = :now, dailyUsed = :dailyUsed, dailyResetAt = :dailyResetAt',
    ExpressionAttributeValues: {
      ':credits': currentCredits - 1,
      ':now': now,
      ':dailyUsed': dailyUsed + 1,
      ':dailyResetAt': dailyResetAt,
    },
  }));

  return true;
}

/**
 * Structured credit status for a single tool
 */
export interface ToolCreditStatus {
  used: number;
  limit: number;
  remaining: number;
  dailyUsed: number;
  dailyLimit: number;
  dailyRemaining: number;
}

/**
 * Get structured credit status for all tools
 */
export async function getToolStatusStructured(
  avatarId: string
): Promise<Record<string, ToolCreditStatus>> {
  const result: Record<string, ToolCreditStatus> = {};

  for (const [toolName, config] of Object.entries(TOOL_CREDITS)) {
    const bucket = await getOrCreateBucket(avatarId, toolName);
    const now = Date.now();

    // Calculate current credits
    const currentCredits = calculateRefill(bucket, config);

    // Check daily reset
    let dailyRemaining = config.dailyLimit - bucket.dailyUsed;
    if (now >= bucket.dailyResetAt) {
      dailyRemaining = config.dailyLimit;
    }

    result[toolName] = {
      used: config.maxCredits - currentCredits,
      limit: config.maxCredits,
      remaining: currentCredits,
      dailyUsed: bucket.dailyUsed,
      dailyLimit: config.dailyLimit,
      dailyRemaining,
    };
  }

  return result;
}

/**
 * Get credit status for all tools (for AI prompt injection)
 */
export async function getToolStatus(avatarId: string): Promise<string> {
  const statuses: string[] = [];

  for (const [toolName, config] of Object.entries(TOOL_CREDITS)) {
    const bucket = await getOrCreateBucket(avatarId, toolName);
    const now = Date.now();

    // Calculate current credits
    const currentCredits = calculateRefill(bucket, config);

    // Check daily reset
    let dailyRemaining = config.dailyLimit - bucket.dailyUsed;
    if (now >= bucket.dailyResetAt) {
      dailyRemaining = config.dailyLimit;
    }

    const status = currentCredits > 0
      ? `${toolName}: ${currentCredits}/${config.maxCredits} credits (${dailyRemaining} daily remaining)`
      : `${toolName}: NO CREDITS (refills hourly, ${dailyRemaining} daily remaining)`;

    statuses.push(status);
  }

  return `## Tool Status\n${statuses.join('\n')}`;
}

/**
 * Get credit bucket details
 */
export async function getCreditBucket(
  avatarId: string,
  toolName: string
): Promise<CreditBucket | null> {
  const result = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: `AVATAR#${avatarId}`,
      sk: `CREDIT#${toolName}`,
    },
  }));

  return (result.Item as CreditBucket) || null;
}

// ============================================================================
// Unified Burst Pool (Entitlement-first, Energy-fallback)
// ============================================================================

/** Result of a unified burst pool check */
export interface BurstPoolResult {
  allowed: boolean;
  reason?: string;
  /** When true, the request was served from the energy burst pool. */
  energyBurst?: boolean;
  /** Energy remaining after burst consumption (only set when energyBurst=true). */
  energyRemaining?: number;
}

/**
 * Unified media check: entitlement-first with energy burst fallback.
 *
 * Flow:
 *   1. Check tool rate-limit credit (canUseTool) -- fast local bucket.
 *   2. Check entitlement daily media limit.
 *   3. If within entitlement limit, allow with NO energy cost.
 *   4. If entitlement exhausted AND energy available, consume energy and allow.
 *   5. If entitlement exhausted AND no energy, deny.
 *   6. Enterprise (limit = -1) never touches energy.
 *
 * Callers should still call consumeCredit() after a successful operation to
 * keep tool rate-limit buckets accurate.
 */
export async function checkMediaWithEnergyFallback(
  avatarId: string,
  energyCostType: EnergyCostType = 'image',
): Promise<BurstPoolResult> {
  // Step 1: Tool rate-limit check (fast, non-entitlement)
  const toolCheck = await canUseTool(avatarId, 'generate_image');
  if (!toolCheck.allowed) {
    return { allowed: false, reason: toolCheck.reason };
  }

  // Step 2: Entitlement daily limit check
  const checkLimitFn = await getCheckLimit();
  const entitlementCheck = await checkLimitFn(avatarId, 'media');

  // Enterprise / unlimited
  if (entitlementCheck.limit === -1) {
    return { allowed: true };
  }

  // Within entitlement limit -- no energy consumed
  if (entitlementCheck.allowed) {
    return { allowed: true };
  }

  // Step 3: Entitlement exhausted -- try energy burst
  const energyCost = ENERGY_COSTS_INTERNAL[energyCostType] ?? ENERGY_COSTS_INTERNAL.image;
  const energyCheck = await canUseEnergyNew(avatarId, energyCost);
  if (!energyCheck.allowed) {
    return {
      allowed: false,
      reason: `Daily media limit reached and ${energyCheck.reason ?? 'not enough energy for burst'}`,
    };
  }

  // Consume energy as burst
  const consumeResult = await consumeEnergyFull(avatarId, energyCost, energyCostType);
  if (!consumeResult.success) {
    return {
      allowed: false,
      reason: 'Daily media limit reached and energy burst consumption failed',
    };
  }

  return {
    allowed: true,
    energyBurst: true,
    energyRemaining: consumeResult.energyAfter,
  };
}

/**
 * Unified voice check: entitlement-first with energy burst fallback.
 *
 * Same flow as checkMediaWithEnergyFallback but for voice operations.
 */
export async function checkVoiceWithEnergyFallback(
  avatarId: string,
): Promise<BurstPoolResult> {
  // Entitlement daily limit check
  const checkLimitFn = await getCheckLimit();
  const entitlementCheck = await checkLimitFn(avatarId, 'voice');

  // Enterprise / unlimited
  if (entitlementCheck.limit === -1) {
    return { allowed: true };
  }

  // Within entitlement limit -- no energy consumed
  if (entitlementCheck.allowed) {
    return { allowed: true };
  }

  // Entitlement exhausted -- try energy burst
  const energyCost = ENERGY_COSTS_INTERNAL.voice;
  const energyCheck = await canUseEnergyNew(avatarId, energyCost);
  if (!energyCheck.allowed) {
    return {
      allowed: false,
      reason: `Daily voice limit reached and ${energyCheck.reason ?? 'not enough energy for burst'}`,
    };
  }

  const consumeResult = await consumeEnergyFull(avatarId, energyCost, 'voice');
  if (!consumeResult.success) {
    return {
      allowed: false,
      reason: 'Daily voice limit reached and energy burst consumption failed',
    };
  }

  return {
    allowed: true,
    energyBurst: true,
    energyRemaining: consumeResult.energyAfter,
  };
}

/**
 * Unified video check: entitlement-first with energy burst fallback.
 */
export async function checkVideoWithEnergyFallback(
  avatarId: string,
): Promise<BurstPoolResult> {
  // Step 1: Tool rate-limit check
  const toolCheck = await canUseTool(avatarId, 'generate_video');
  if (!toolCheck.allowed) {
    return { allowed: false, reason: toolCheck.reason };
  }

  // Step 2: Entitlement daily limit check (video shares media counter)
  const checkLimitFn = await getCheckLimit();
  const entitlementCheck = await checkLimitFn(avatarId, 'media');

  if (entitlementCheck.limit === -1) {
    return { allowed: true };
  }

  if (entitlementCheck.allowed) {
    return { allowed: true };
  }

  // Step 3: Energy burst fallback (video costs more energy)
  const energyCost = ENERGY_COSTS_INTERNAL.video;
  const energyCheck = await canUseEnergyNew(avatarId, energyCost);
  if (!energyCheck.allowed) {
    return {
      allowed: false,
      reason: `Daily media limit reached and ${energyCheck.reason ?? 'not enough energy for burst'}`,
    };
  }

  const consumeResult = await consumeEnergyFull(avatarId, energyCost, 'video');
  if (!consumeResult.success) {
    return {
      allowed: false,
      reason: 'Daily media limit reached and energy burst consumption failed',
    };
  }

  return {
    allowed: true,
    energyBurst: true,
    energyRemaining: consumeResult.energyAfter,
  };
}
