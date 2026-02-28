/* eslint-disable no-console -- TODO: migrate to structured logger */
/**
 * Entitlements Service
 * 
 * Manages plan-based entitlements for avatars including:
 * - Plan assignment and limits
 * - Usage tracking and enforcement
 * - Memory configuration based on plan
 * 
 * M1 Implementation: Manual entitlements first, Stripe integration later.
 */
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  type PlanType,
  type PlanLimits,
  type EntitlementRecord,
  type UsageRecord,
  type MemoryConfig,
  PLAN_DEFAULTS,
} from '../../types.js';
import { getDynamoClient } from '../dynamo-client.js';
import { emitMetric } from '@swarm/core';

const ADMIN_TABLE = process.env.ADMIN_TABLE!;

// ============================================================================
// Entitlement Management
// ============================================================================

/**
 * Get entitlement for an avatar
 * Returns null if no entitlement exists (avatar uses free tier)
 *
 * GSI1 is an inverted index: partition key = `sk`, sort key = `pk`.
 * Entitlement items have pk=ENTITLEMENT#<accountId>, sk=AVATAR#<avatarId>,
 * so we query GSI1 with sk=AVATAR#<avatarId> and pk begins_with ENTITLEMENT#.
 */
export async function getEntitlement(avatarId: string): Promise<EntitlementRecord | null> {
  const result = await getDynamoClient().send(new QueryCommand({
    TableName: ADMIN_TABLE,
    IndexName: 'GSI1',
    KeyConditionExpression: 'sk = :sk AND begins_with(pk, :pkPrefix)',
    ExpressionAttributeValues: {
      ':sk': `AVATAR#${avatarId}`,
      ':pkPrefix': 'ENTITLEMENT#',
    },
    Limit: 1,
  }));

  if (result.Items && result.Items.length > 0) {
    return result.Items[0] as EntitlementRecord;
  }

  return null;
}

/**
 * Get entitlement by account and avatar
 */
export async function getEntitlementByAccount(
  accountId: string,
  avatarId: string
): Promise<EntitlementRecord | null> {
  const result = await getDynamoClient().send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: `ENTITLEMENT#${accountId}`,
      sk: `AVATAR#${avatarId}`,
    },
  }));

  return (result.Item as EntitlementRecord) || null;
}

/**
 * Get all entitlements for an account
 */
export async function getAccountEntitlements(accountId: string): Promise<EntitlementRecord[]> {
  const result = await getDynamoClient().send(new QueryCommand({
    TableName: ADMIN_TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :sk)',
    ExpressionAttributeValues: {
      ':pk': `ENTITLEMENT#${accountId}`,
      ':sk': 'AVATAR#',
    },
  }));

  return (result.Items || []) as EntitlementRecord[];
}

/**
 * Compute effective limits by merging plan defaults with overrides
 */
export function computeEffectiveLimits(
  plan: PlanType,
  overrides?: Partial<PlanLimits>
): PlanLimits {
  const defaults = PLAN_DEFAULTS[plan];
  if (!overrides) return { ...defaults };

  return {
    ...defaults,
    ...overrides,
  };
}

/**
 * Create or update entitlement for an avatar
 */
export async function setEntitlement(params: {
  accountId: string;
  avatarId: string;
  plan: PlanType;
  overrides?: Partial<PlanLimits>;
  stripeSubscriptionId?: string;
  stripeCustomerId?: string;
  status?: EntitlementRecord['status'];
  trialEndsAt?: number;
  actorId: string;
  entitlementSource?: EntitlementRecord['entitlementSource'];
}): Promise<EntitlementRecord> {
  const {
    accountId,
    avatarId,
    plan,
    overrides,
    stripeSubscriptionId,
    stripeCustomerId,
    status = 'active',
    trialEndsAt,
    actorId,
    entitlementSource,
  } = params;

  const now = Date.now();
  const limits = computeEffectiveLimits(plan, overrides);

  const existing = await getEntitlementByAccount(accountId, avatarId);

  const entitlement: EntitlementRecord = {
    pk: `ENTITLEMENT#${accountId}`,
    sk: `AVATAR#${avatarId}`,
    accountId,
    avatarId,
    plan,
    limits,
    overrides,
    stripeSubscriptionId,
    stripeCustomerId,
    status,
    trialEndsAt,
    entitlementSource,
    createdAt: existing?.createdAt || now,
    createdBy: existing?.createdBy || actorId,
    updatedAt: now,
    updatedBy: actorId,
    // Legacy attributes — GSI1 is an inverted index (sk→pk), so the actual
    // GSI1 lookup uses the sk/pk columns directly.  Kept for backward compat.
    gsi1pk: `AVATAR#${avatarId}`,
    gsi1sk: 'ENTITLEMENT',
  };

  await getDynamoClient().send(new PutCommand({
    TableName: ADMIN_TABLE,
    Item: entitlement,
  }));

  return entitlement;
}

/**
 * Find entitlement by Stripe subscription ID.
 * Uses the StripeSubscriptionIndex GSI for O(1) lookup instead of a table scan.
 */
export async function findEntitlementByStripeSubscriptionId(
  stripeSubscriptionId: string
): Promise<EntitlementRecord | null> {
  const result = await getDynamoClient().send(new QueryCommand({
    TableName: ADMIN_TABLE,
    IndexName: 'StripeSubscriptionIndex',
    KeyConditionExpression: 'stripeSubscriptionId = :subscriptionId',
    ExpressionAttributeValues: {
      ':subscriptionId': stripeSubscriptionId,
    },
    Limit: 1,
  }));

  if (result.Items && result.Items.length > 0) {
    return result.Items[0] as EntitlementRecord;
  }

  return null;
}

/**
 * Update entitlement status without changing plan/limits.
 */
export async function setEntitlementStatus(
  accountId: string,
  avatarId: string,
  status: EntitlementRecord['status'],
  actorId: string,
  suspendedReason?: string
): Promise<void> {
  const now = Date.now();
  if (status === 'suspended') {
    await getDynamoClient().send(new UpdateCommand({
      TableName: ADMIN_TABLE,
      Key: {
        pk: `ENTITLEMENT#${accountId}`,
        sk: `AVATAR#${avatarId}`,
      },
      UpdateExpression: `
        SET #status = :status,
            suspendedAt = :now,
            suspendedReason = :reason,
            updatedAt = :now,
            updatedBy = :actor
      `,
      ExpressionAttributeNames: {
        '#status': 'status',
      },
      ExpressionAttributeValues: {
        ':status': status,
        ':now': now,
        ':reason': suspendedReason || 'Suspended',
        ':actor': actorId,
      },
    }));
    return;
  }

  await getDynamoClient().send(new UpdateCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: `ENTITLEMENT#${accountId}`,
      sk: `AVATAR#${avatarId}`,
    },
    UpdateExpression: `
      SET #status = :status,
          updatedAt = :now,
          updatedBy = :actor
      REMOVE suspendedAt, suspendedReason
    `,
    ExpressionAttributeNames: {
      '#status': 'status',
    },
    ExpressionAttributeValues: {
      ':status': status,
      ':now': now,
      ':actor': actorId,
    },
  }));
}

/**
 * Update entitlement plan
 */
export async function updateEntitlementPlan(
  accountId: string,
  avatarId: string,
  plan: PlanType,
  actorId: string
): Promise<EntitlementRecord | null> {
  const existing = await getEntitlementByAccount(accountId, avatarId);
  if (!existing) return null;

  const limits = computeEffectiveLimits(plan, existing.overrides);

  await getDynamoClient().send(new UpdateCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: `ENTITLEMENT#${accountId}`,
      sk: `AVATAR#${avatarId}`,
    },
    UpdateExpression: 'SET #plan = :plan, #limits = :limits, updatedAt = :now, updatedBy = :actor',
    ExpressionAttributeNames: {
      '#plan': 'plan',
      '#limits': 'limits',
    },
    ExpressionAttributeValues: {
      ':plan': plan,
      ':limits': limits,
      ':now': Date.now(),
      ':actor': actorId,
    },
  }));

  return { ...existing, plan, limits, updatedAt: Date.now(), updatedBy: actorId };
}

/**
 * Suspend an entitlement
 */
export async function suspendEntitlement(
  accountId: string,
  avatarId: string,
  reason: string,
  actorId: string
): Promise<void> {
  await getDynamoClient().send(new UpdateCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: `ENTITLEMENT#${accountId}`,
      sk: `AVATAR#${avatarId}`,
    },
    UpdateExpression: 'SET #status = :status, suspendedAt = :now, suspendedReason = :reason, updatedAt = :now, updatedBy = :actor',
    ExpressionAttributeNames: {
      '#status': 'status',
    },
    ExpressionAttributeValues: {
      ':status': 'suspended',
      ':now': Date.now(),
      ':reason': reason,
      ':actor': actorId,
    },
  }));
}

/**
 * Clear Stripe customer/subscription data from all entitlements for an avatar.
 * Called during avatar reassignment to prevent the new owner from being linked
 * to the previous owner's Stripe customer/subscription context.
 *
 * Returns the number of entitlements that were cleared.
 */
export async function clearStripeDataForAvatar(
  avatarId: string,
  actorId: string
): Promise<number> {
  // Find all entitlements for this avatar via GSI1 (inverted index)
  const result = await getDynamoClient().send(new QueryCommand({
    TableName: ADMIN_TABLE,
    IndexName: 'GSI1',
    KeyConditionExpression: 'sk = :sk AND begins_with(pk, :pkPrefix)',
    ExpressionAttributeValues: {
      ':sk': `AVATAR#${avatarId}`,
      ':pkPrefix': 'ENTITLEMENT#',
    },
  }));

  const entitlements = (result.Items || []) as EntitlementRecord[];
  let clearedCount = 0;

  for (const entitlement of entitlements) {
    if (entitlement.stripeCustomerId || entitlement.stripeSubscriptionId) {
      const now = Date.now();
      await getDynamoClient().send(new UpdateCommand({
        TableName: ADMIN_TABLE,
        Key: {
          pk: entitlement.pk,
          sk: entitlement.sk,
        },
        UpdateExpression: `
          REMOVE stripeCustomerId, stripeSubscriptionId
          SET updatedAt = :now, updatedBy = :actor
        `,
        ExpressionAttributeValues: {
          ':now': now,
          ':actor': actorId,
        },
      }));
      clearedCount++;
    }
  }

  if (clearedCount > 0) {
    console.log(`[Entitlements] Cleared Stripe data from ${clearedCount} entitlement(s) for avatar=${avatarId}`);
  }

  return clearedCount;
}

// ============================================================================
// Usage Tracking
// ============================================================================

/**
 * Get today's date string in YYYY-MM-DD format
 */
function getTodayString(): string {
  return new Date().toISOString().split('T')[0];
}

/**
 * Get usage record for an avatar on a specific day
 */
export async function getUsage(avatarId: string, date?: string): Promise<UsageRecord | null> {
  const dateStr = date || getTodayString();

  const result = await getDynamoClient().send(new GetCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: `USAGE#${avatarId}`,
      sk: `DAY#${dateStr}`,
    },
  }));

  return (result.Item as UsageRecord) || null;
}

/**
 * Increment a usage counter
 */
export async function incrementUsage(
  avatarId: string,
  field: keyof Pick<UsageRecord, 'messagesProcessed' | 'mediaCreditsUsed' | 'voiceMinutesUsed' | 'toolCallsMade' | 'imageGenerations' | 'videoGenerations' | 'stickerGenerations'>,
  amount = 1
): Promise<UsageRecord> {
  const dateStr = getTodayString();
  // TTL: 35 days from today (covers billing cycle + buffer)
  const ttl = Math.floor(Date.now() / 1000) + (35 * 24 * 60 * 60);

  const result = await getDynamoClient().send(new UpdateCommand({
    TableName: ADMIN_TABLE,
    Key: {
      pk: `USAGE#${avatarId}`,
      sk: `DAY#${dateStr}`,
    },
    UpdateExpression: `
      SET avatarId = :avatarId,
          #date = :date,
          #field = if_not_exists(#field, :zero) + :amount,
          #ttl = :ttl,
          updatedAt = :now
    `,
    ExpressionAttributeNames: {
      '#date': 'date',
      '#field': field,
      '#ttl': 'ttl',
    },
    ExpressionAttributeValues: {
      ':avatarId': avatarId,
      ':date': dateStr,
      ':amount': amount,
      ':zero': 0,
      ':ttl': ttl,
      ':now': Date.now(),
    },
    ReturnValues: 'ALL_NEW',
  }));

  return result.Attributes as UsageRecord;
}

// ============================================================================
// Limit Enforcement
// ============================================================================

export interface LimitCheckResult {
  allowed: boolean;
  reason?: string;
  current?: number;
  limit?: number;
  remaining?: number;
}

/**
 * Check if an action is allowed based on entitlements and usage.
 *
 * If the entitlement lookup fails (e.g. DynamoDB error), the function
 * degrades gracefully to free-tier defaults so that media generation
 * is not blocked by transient infrastructure issues.
 */
export async function checkLimit(
  avatarId: string,
  limitType: 'messages' | 'media' | 'voice' | 'tools'
): Promise<LimitCheckResult> {
  // Get entitlement (or use free tier defaults)
  let entitlement: EntitlementRecord | null = null;
  try {
    entitlement = await getEntitlement(avatarId);
  } catch (err) {
    console.error('[Entitlements] getEntitlement failed, falling back to free tier', {
      avatarId,
      error: err instanceof Error ? err.message : String(err),
    });
    // Emit EMF metric so CloudWatch can alarm on sustained fallback rate
    emitMetric('Entitlements', 'EntitlementFallback', 1, 'Count');
  }
  const limits = entitlement?.limits || PLAN_DEFAULTS.free;

  // Check if entitlement is active
  if (entitlement && entitlement.status !== 'active' && entitlement.status !== 'trial') {
    return {
      allowed: false,
      reason: `Entitlement is ${entitlement.status}`,
    };
  }

  // Get today's usage
  const usage = await getUsage(avatarId);
  const current = usage ? getUsageForType(usage, limitType) : 0;
  const limit = getLimitForType(limits, limitType);

  // -1 means unlimited
  if (limit === -1) {
    return { allowed: true, current, limit, remaining: -1 };
  }

  const remaining = limit - current;
  const allowed = remaining > 0;

  return {
    allowed,
    reason: allowed ? undefined : `Daily ${limitType} limit reached`,
    current,
    limit,
    remaining: Math.max(0, remaining),
  };
}

function getUsageForType(usage: UsageRecord, type: 'messages' | 'media' | 'voice' | 'tools'): number {
  switch (type) {
    case 'messages': return usage.messagesProcessed || 0;
    case 'media': return usage.mediaCreditsUsed || 0;
    case 'voice': return usage.voiceMinutesUsed || 0;
    case 'tools': return usage.toolCallsMade || 0;
    default: return 0;
  }
}

function getLimitForType(limits: PlanLimits, type: 'messages' | 'media' | 'voice' | 'tools'): number {
  switch (type) {
    case 'messages': return limits.dailyMessageLimit;
    case 'media': return limits.dailyMediaCredits;
    case 'voice': return limits.dailyVoiceMinutes;
    case 'tools': return limits.maxToolCallsPerMessage;
    default: return 0;
  }
}

/**
 * Check if memory is enabled for an avatar based on entitlement
 */
export async function isMemoryEnabled(avatarId: string): Promise<boolean> {
  const entitlement = await getEntitlement(avatarId);
  if (!entitlement) return false;
  if (entitlement.status !== 'active' && entitlement.status !== 'trial') return false;
  return entitlement.limits.memoryEnabled;
}

/**
 * Get memory configuration for an avatar based on entitlement
 */
export async function getMemoryConfig(avatarId: string): Promise<MemoryConfig> {
  const entitlement = await getEntitlement(avatarId);

  if (!entitlement || (entitlement.status !== 'active' && entitlement.status !== 'trial')) {
    return {
      enabled: false,
      retentionDays: 0,
      consolidationEnabled: false,
      semanticSearchEnabled: false,
    };
  }

  return {
    enabled: entitlement.limits.memoryEnabled,
    retentionDays: entitlement.limits.memoryRetentionDays,
    consolidationEnabled: entitlement.limits.memoryEnabled,
    semanticSearchEnabled: entitlement.limits.memoryEnabled,
  };
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Get effective limits for an avatar (entitlement or free tier)
 */
export async function getEffectiveLimits(avatarId: string): Promise<PlanLimits> {
  const entitlement = await getEntitlement(avatarId);
  return entitlement?.limits || PLAN_DEFAULTS.free;
}

/**
 * Check if avatar has a paid plan
 */
export async function hasPaidPlan(avatarId: string): Promise<boolean> {
  const entitlement = await getEntitlement(avatarId);
  if (!entitlement) return false;
  return entitlement.plan !== 'free' && entitlement.status === 'active';
}

/**
 * Apply free tier entitlement to an avatar (for new avatars)
 */
export async function applyFreeTier(
  accountId: string,
  avatarId: string,
  actorId: string
): Promise<EntitlementRecord> {
  return setEntitlement({
    accountId,
    avatarId,
    plan: 'free',
    status: 'active',
    actorId,
  });
}
