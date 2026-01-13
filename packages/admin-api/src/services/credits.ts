/**
 * Credit System Service
 * Rate limiting via token bucket algorithm with hourly refill and daily limits
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { CreditBucket } from '../types.js';

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
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
 * Energy system configuration
 * Agents get 1 energy per hour, max 10
 */
export const ENERGY_MAX = 10;
export const ENERGY_PER_HOUR = 1;

/**
 * Energy costs for expensive tools
 */
export const ENERGY_COSTS = {
  voice: 1,
  image: 2,
  video: 3,
} as const;

/**
 * Get or create a credit bucket for an agent/tool
 */
async function getOrCreateBucket(
  agentId: string,
  toolName: string
): Promise<CreditBucket> {
  const config = TOOL_CREDITS[toolName];
  if (!config) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  const pk = `AGENT#${agentId}`;
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
    agentId,
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

async function getOrCreateEnergyBucket(agentId: string): Promise<CreditBucket> {
  const pk = `AGENT#${agentId}`;
  const sk = 'CREDIT#energy';

  const result = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: { pk, sk },
  }));

  if (result.Item) {
    return result.Item as CreditBucket;
  }

  const now = Date.now();
  const bucket: CreditBucket = {
    pk,
    sk,
    agentId,
    toolName: 'energy',
    credits: ENERGY_MAX, // Start with full energy
    maxCredits: ENERGY_MAX,
    lastRefillAt: now,
    dailyUsed: 0,
    dailyLimit: 999999, // No daily limit for hourly system
    dailyResetAt: getNextMidnightUTC(),
  };

  await dynamoClient.send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: bucket,
  }));

  return bucket;
}

/**
 * Calculate refilled energy based on time elapsed
 * +1 energy per hour, capped at ENERGY_MAX
 */
function calculateEnergyRefill(bucket: CreditBucket): number {
  const now = Date.now();
  const hoursSinceRefill = (now - bucket.lastRefillAt) / (1000 * 60 * 60);
  const energyToAdd = Math.floor(hoursSinceRefill * ENERGY_PER_HOUR);
  return Math.min(bucket.credits + energyToAdd, ENERGY_MAX);
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
  agentId: string,
  toolName: string
): Promise<{ allowed: boolean; reason?: string; credits?: number }> {
  const config = TOOL_CREDITS[toolName];
  if (!config) {
    return { allowed: true }; // Unknown tools are always allowed
  }

  const bucket = await getOrCreateBucket(agentId, toolName);
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
  agentId: string,
  toolName: string
): Promise<boolean> {
  const config = TOOL_CREDITS[toolName];
  if (!config) {
    return true; // Unknown tools don't consume credits
  }

  const bucket = await getOrCreateBucket(agentId, toolName);
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

export async function canUseEnergy(
  agentId: string,
  cost: number
): Promise<{ allowed: boolean; reason?: string; remaining?: number }> {
  if (cost <= 0) {
    return { allowed: true, remaining: ENERGY_MAX };
  }

  const bucket = await getOrCreateEnergyBucket(agentId);

  // Calculate current energy with hourly refill
  const currentEnergy = calculateEnergyRefill(bucket);

  if (currentEnergy < cost) {
    const hoursUntilEnough = Math.ceil((cost - currentEnergy) / ENERGY_PER_HOUR);
    return {
      allowed: false,
      reason: `Not enough energy (have ${currentEnergy}, need ${cost}). +1 energy per hour. ~${hoursUntilEnough}h until enough.`,
      remaining: currentEnergy,
    };
  }

  return { allowed: true, remaining: currentEnergy };
}

export async function consumeEnergy(
  agentId: string,
  cost: number
): Promise<boolean> {
  if (cost <= 0) {
    return true;
  }

  const bucket = await getOrCreateEnergyBucket(agentId);
  const now = Date.now();

  // Calculate current energy with hourly refill
  const currentEnergy = calculateEnergyRefill(bucket);

  if (currentEnergy < cost) {
    return false;
  }

  await dynamoClient.send(new UpdateCommand({
    TableName: ADMIN_TABLE,
    Key: { pk: bucket.pk, sk: bucket.sk },
    UpdateExpression: 'SET credits = :credits, lastRefillAt = :now',
    ExpressionAttributeValues: {
      ':credits': currentEnergy - cost,
      ':now': now,
    },
  }));

  return true;
}

/**
 * Get current energy status for an agent
 */
export async function getEnergyStatus(
  agentId: string
): Promise<{ current: number; max: number; nextRefillIn: number }> {
  const bucket = await getOrCreateEnergyBucket(agentId);
  const now = Date.now();
  const currentEnergy = calculateEnergyRefill(bucket);
  
  // Calculate minutes until next energy point
  const msSinceRefill = now - bucket.lastRefillAt;
  const msUntilNextRefill = (60 * 60 * 1000) - (msSinceRefill % (60 * 60 * 1000));
  const minutesUntilNext = Math.ceil(msUntilNextRefill / (60 * 1000));

  return {
    current: currentEnergy,
    max: ENERGY_MAX,
    nextRefillIn: currentEnergy >= ENERGY_MAX ? 0 : minutesUntilNext,
  };
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
  agentId: string
): Promise<Record<string, ToolCreditStatus>> {
  const result: Record<string, ToolCreditStatus> = {};

  for (const [toolName, config] of Object.entries(TOOL_CREDITS)) {
    const bucket = await getOrCreateBucket(agentId, toolName);
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
export async function getToolStatus(agentId: string): Promise<string> {
  const statuses: string[] = [];

  for (const [toolName, config] of Object.entries(TOOL_CREDITS)) {
    const bucket = await getOrCreateBucket(agentId, toolName);
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
  agentId: string,
  toolName: string
): Promise<CreditBucket | null> {
  const result = await dynamoClient.send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: `AGENT#${agentId}`,
      sk: `CREDIT#${toolName}`,
    },
  }));

  return (result.Item as CreditBucket) || null;
}
