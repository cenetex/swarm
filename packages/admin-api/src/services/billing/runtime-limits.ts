/**
 * Runtime Limits Sync
 *
 * Admin API writes a compact, runtime-friendly copy of an avatar's effective limits
 * into STATE_TABLE so Lambda handlers can enforce limits without needing ADMIN_TABLE.
 */
import { UpdateCommand } from '@swarm/core';
import {
  type EntitlementRecord,
  type PlanLimits,
  type PlanType,
  PLAN_DEFAULTS,
} from '../../types.js';
import { getDynamoClient } from '../dynamo-client.js';

export interface RuntimeLimits {
  memoryEnabled: boolean;
  dailyMessageLimit: number;
  dailyMediaCredits: number;
  dailyVoiceMinutes: number;
  maxToolCallsPerMessage: number;
  autonomousPostsEnabled: boolean;
  priorityProcessing: boolean;
}

export interface RuntimeBurnAugmentation {
  totalBurned?: number;
  tier?: number;
  tierName?: string;
  maxEnergy?: number;
  regenPerHour?: number;
  updatedAt?: number;
}

export interface RuntimeEnergyAugmentation {
  current?: number;
  max?: number;
  refillPerHour?: number;
  nextRefillIn?: number;
  bankCredits?: number;
  updatedAt?: number;
}

export interface RuntimeResonanceAugmentation {
  resonance?: number;
  tier?: string;
  tierLabel?: string;
  energyRegenBonus?: number;
  updatedAt?: number;
}

export interface RuntimeAugmentations {
  burn?: RuntimeBurnAugmentation;
  energy?: RuntimeEnergyAugmentation;
  resonance?: RuntimeResonanceAugmentation;
}

export interface EffectiveLimitsResult {
  avatarId: string;
  plan: PlanType;
  limits: PlanLimits;
  source: 'entitlement' | 'default' | 'free+orb_boost';
  entitlementStatus?: EntitlementRecord['status'];
}

/**
 * Boosted limits applied to free-tier avatars whose creator
 * holds at least one Gate NFT (Orb). The boost augments the free-tier
 * defaults without changing the plan itself, so billing stays on 'free'.
 */
export const ORB_HOLDER_BOOST: Partial<PlanLimits> = {
  dailyMessageLimit: 100,
  dailyMediaCredits: 15,
  dailyVoiceMinutes: 5,
  maxToolCallsPerMessage: 5,
};

/**
 * Apply Orb-holder boost to an EffectiveLimitsResult.
 *
 * Only applies when the resolved plan is 'free'.  Returns the original
 * result untouched for any paid plan (pro / enterprise) since those
 * already exceed the boost values.
 */
export function applyOrbHolderBoost(
  result: EffectiveLimitsResult,
): EffectiveLimitsResult {
  if (result.plan !== 'free') return result;

  return {
    ...result,
    source: 'free+orb_boost',
    limits: {
      ...result.limits,
      ...ORB_HOLDER_BOOST,
    },
  };
}

export function getEffectiveLimitsForAvatar(
  avatarId: string,
  entitlement: EntitlementRecord | null
): EffectiveLimitsResult {
  const entitlementStatus = entitlement?.status;

  if (!entitlement) {
    return {
      avatarId,
      plan: 'free',
      limits: PLAN_DEFAULTS.free,
      source: 'default',
      entitlementStatus: undefined,
    };
  }

  if (entitlementStatus !== 'active' && entitlementStatus !== 'trial') {
    return {
      avatarId,
      plan: 'free',
      limits: PLAN_DEFAULTS.free,
      source: 'default',
      entitlementStatus,
    };
  }

  return {
    avatarId,
    plan: entitlement.plan,
    limits: entitlement.limits ?? PLAN_DEFAULTS[entitlement.plan],
    source: 'entitlement',
    entitlementStatus,
  };
}

export function toRuntimeLimits(limits: PlanLimits): RuntimeLimits {
  return {
    memoryEnabled: Boolean(limits.memoryEnabled),
    dailyMessageLimit: limits.dailyMessageLimit ?? PLAN_DEFAULTS.free.dailyMessageLimit,
    dailyMediaCredits: limits.dailyMediaCredits ?? PLAN_DEFAULTS.free.dailyMediaCredits,
    dailyVoiceMinutes: limits.dailyVoiceMinutes ?? PLAN_DEFAULTS.free.dailyVoiceMinutes,
    maxToolCallsPerMessage: limits.maxToolCallsPerMessage ?? PLAN_DEFAULTS.free.maxToolCallsPerMessage,
    autonomousPostsEnabled: Boolean(limits.autonomousPostsEnabled),
    priorityProcessing: Boolean(limits.priorityProcessing),
  };
}

export async function syncRuntimeLimitsToState(params: {
  avatarId: string;
  runtimeLimits: RuntimeLimits;
  plan: PlanType;
  source: EffectiveLimitsResult['source'];
  entitlementStatus?: EffectiveLimitsResult['entitlementStatus'];
  augmentations?: RuntimeAugmentations;
}): Promise<void> {
  const stateTable = process.env.STATE_TABLE;
  if (!stateTable) return;

  const { avatarId, runtimeLimits, plan, source, entitlementStatus, augmentations } = params;

  await getDynamoClient().send(new UpdateCommand({
    TableName: stateTable,
    Key: {
      pk: `LIMITS#${avatarId}`,
      sk: 'RUNTIME',
    },
    UpdateExpression: `
      SET memoryEnabled = :memoryEnabled,
          dailyMessageLimit = :dailyMessageLimit,
          dailyMediaCredits = :dailyMediaCredits,
          dailyVoiceMinutes = :dailyVoiceMinutes,
          maxToolCallsPerMessage = :maxToolCallsPerMessage,
          autonomousPostsEnabled = :autonomousPostsEnabled,
          priorityProcessing = :priorityProcessing,
          #plan = :plan,
          #source = :source,
          entitlementStatus = :entitlementStatus,
          contractVersion = :contractVersion,
          augmentations = :augmentations,
          updatedAt = :now
    `,
    ExpressionAttributeNames: {
      '#plan': 'plan',
      '#source': 'source',
    },
    ExpressionAttributeValues: {
      ':memoryEnabled': runtimeLimits.memoryEnabled,
      ':dailyMessageLimit': runtimeLimits.dailyMessageLimit,
      ':dailyMediaCredits': runtimeLimits.dailyMediaCredits,
      ':dailyVoiceMinutes': runtimeLimits.dailyVoiceMinutes,
      ':maxToolCallsPerMessage': runtimeLimits.maxToolCallsPerMessage,
      ':autonomousPostsEnabled': runtimeLimits.autonomousPostsEnabled,
      ':priorityProcessing': runtimeLimits.priorityProcessing,
      ':plan': plan,
      ':source': source,
      ':entitlementStatus': entitlementStatus ?? 'none',
      ':contractVersion': 'entitlement-runtime-v1',
      ':augmentations': augmentations ?? {},
      ':now': Date.now(),
    },
  }));
}
