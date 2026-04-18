/**
 * Enterprise → Creator Migration
 *
 * Migrates existing $29/mo enterprise subscribers to the $9/mo Creator (pro) plan.
 * - Preserves all current features and overrides (enterprise-level limits kept as overrides)
 * - Updates entitlement plan to 'pro'
 * - Does NOT change Stripe subscription — that must be handled separately via
 *   Stripe dashboard or API to archive the $29 price and move to $9 price.
 * - Does NOT break any existing bot configurations or memory.
 *
 * Usage:
 *   Called from admin API endpoint or one-off script.
 *   Safe to run multiple times (idempotent).
 */
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { EntitlementRecord, PlanLimits } from '../../types.js';
import { PLAN_DEFAULTS } from '../../types.js';
import { getDynamoClient } from '../dynamo-client.js';
import { createAvatarLogger, createSystemLogger } from '../structured-logger.js';
import { setEntitlement } from './entitlements.js';

const log = createSystemLogger('migrate-enterprise');
const ADMIN_TABLE = process.env.ADMIN_TABLE!;

export interface MigrationResult {
  migrated: number;
  skipped: number;
  errors: Array<{ avatarId: string; error: string }>;
  details: Array<{
    accountId: string;
    avatarId: string;
    previousPlan: string;
    newPlan: string;
    featuresPreserved: boolean;
  }>;
}

/**
 * Find all entitlements on the enterprise plan.
 */
async function findEnterpriseEntitlements(): Promise<EntitlementRecord[]> {
  const entitlements: EntitlementRecord[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await getDynamoClient().send(new QueryCommand({
      TableName: ADMIN_TABLE,
      IndexName: 'GSI1',
      KeyConditionExpression: 'gsi1sk = :gsi1sk',
      FilterExpression: '#plan = :plan',
      ExpressionAttributeNames: { '#plan': 'plan' },
      ExpressionAttributeValues: {
        ':gsi1sk': 'ENTITLEMENT',
        ':plan': 'enterprise',
      },
      ExclusiveStartKey: lastKey,
    }));

    if (result.Items) {
      entitlements.push(...(result.Items as EntitlementRecord[]));
    }
    lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  return entitlements;
}

/**
 * Compute overrides needed to preserve enterprise-level features when
 * downgrading the plan type to 'pro'. Any enterprise limit that exceeds
 * the pro default is kept as an explicit override.
 */
function computePreservationOverrides(
  currentLimits: PlanLimits,
): Partial<PlanLimits> {
  const proDefaults = PLAN_DEFAULTS.pro;
  const overrides: Partial<PlanLimits> = {};

  // Preserve numeric limits that exceed pro defaults
  const numericKeys: (keyof PlanLimits)[] = [
    'memoryRetentionDays',
    'maxMemoriesPerTier',
    'dailyMessageLimit',
    'dailyMediaCredits',
    'dailyVoiceMinutes',
    'maxToolCallsPerMessage',
    'maxPlatforms',
    'maxChannels',
  ];

  for (const key of numericKeys) {
    const current = currentLimits[key] as number;
    const proDefault = proDefaults[key] as number;
    // -1 means unlimited; always preserve unlimited
    if (current === -1 || current > proDefault) {
      (overrides as Record<string, unknown>)[key] = current;
    }
  }

  // Preserve boolean features that are enabled in enterprise but not in pro
  const booleanKeys: (keyof PlanLimits)[] = [
    'memoryEnabled',
    'autonomousPostsEnabled',
    'customModelEnabled',
    'priorityProcessing',
  ];

  for (const key of booleanKeys) {
    if (currentLimits[key] === true && proDefaults[key] !== true) {
      (overrides as Record<string, unknown>)[key] = true;
    }
  }

  return overrides;
}

/**
 * Migrate all enterprise subscribers to Creator (pro) plan.
 *
 * Preserves all features via overrides so no functionality is lost.
 * Safe to run multiple times.
 */
export async function migrateEnterpriseToCreator(): Promise<MigrationResult> {
  const result: MigrationResult = {
    migrated: 0,
    skipped: 0,
    errors: [],
    details: [],
  };

  const entitlements = await findEnterpriseEntitlements();
  log.info('migration', 'enterprise_entitlements_found', {
    count: entitlements.length,
  });

  for (const entitlement of entitlements) {
    try {
      // Skip already-cancelled or already-migrated
      if (entitlement.plan !== 'enterprise') {
        result.skipped++;
        continue;
      }

      // Compute overrides to preserve current limits
      const preservationOverrides = computePreservationOverrides(entitlement.limits);
      const mergedOverrides = {
        ...entitlement.overrides,
        ...preservationOverrides,
      };

      // Update to pro plan with preservation overrides
      await setEntitlement({
        accountId: entitlement.accountId,
        avatarId: entitlement.avatarId,
        plan: 'pro',
        overrides: Object.keys(mergedOverrides).length > 0 ? mergedOverrides : undefined,
        stripeSubscriptionId: entitlement.stripeSubscriptionId,
        stripeCustomerId: entitlement.stripeCustomerId,
        status: entitlement.status,
        trialEndsAt: entitlement.trialEndsAt,
        actorId: 'migration-enterprise-to-creator',
        entitlementSource: entitlement.entitlementSource,
      });

      result.migrated++;
      result.details.push({
        accountId: entitlement.accountId,
        avatarId: entitlement.avatarId,
        previousPlan: 'enterprise',
        newPlan: 'pro',
        featuresPreserved: true,
      });

      createAvatarLogger(entitlement.avatarId, 'billing').info('migration', 'avatar_migrated', {
        fromPlan: 'enterprise',
        toPlan: 'pro',
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      result.errors.push({ avatarId: entitlement.avatarId, error: errorMsg });
      createAvatarLogger(entitlement.avatarId, 'billing').error('migration', 'avatar_migration_failed', {
        error: errorMsg,
      });
    }
  }

  log.info('migration', 'migration_complete', {
    migrated: result.migrated,
    skipped: result.skipped,
    errors: result.errors.length,
  });
  return result;
}
