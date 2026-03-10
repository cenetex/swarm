/**
 * Runtime contract synchronisation helpers.
 *
 * Isolated in their own module so domain-handler tests can mock the whole
 * file with a single `mock.module('./runtime-sync.js', …)` instead of
 * individually mocking burn-stats, energy, entitlements, and runtime-limits.
 */
import { logger } from '@swarm/core';
import * as burnStatsService from '../../services/web3/burn-stats.js';
import * as energyService from '../../services/billing/energy.js';
import * as entitlementsService from '../../services/billing/entitlements.js';
import * as avatarsService from '../../services/avatars.js';
import { checkNFTGate } from '../../services/web3/nft-gate.js';
import { getOrbResonance } from '../../services/web3/orb-slots.js';
import {
  getEffectiveLimitsForAvatar,
  applyOrbHolderBoost,
  toRuntimeLimits,
  syncRuntimeLimitsToState,
  type RuntimeAugmentations,
} from '../../services/billing/runtime-limits.js';

export type { RuntimeAugmentations };

export async function buildRuntimeAugmentations(
  avatarId: string,
): Promise<RuntimeAugmentations | undefined> {
  const [burnResult, energyResult, bankResult, resonanceResult] = await Promise.allSettled([
    burnStatsService.getBurnStats(avatarId),
    energyService.getEnergyStatus(avatarId),
    energyService.getEnergyBankBalance(avatarId),
    getOrbResonance(avatarId),
  ]);

  if (burnResult.status === 'rejected') {
    logger.warn('Failed to fetch burn stats for runtime augmentation', {
      avatarId,
      error:
        burnResult.reason instanceof Error
          ? burnResult.reason.message
          : String(burnResult.reason),
    });
  }
  if (energyResult.status === 'rejected') {
    logger.warn('Failed to fetch energy status for runtime augmentation', {
      avatarId,
      error:
        energyResult.reason instanceof Error
          ? energyResult.reason.message
          : String(energyResult.reason),
    });
  }
  if (bankResult.status === 'rejected') {
    logger.warn('Failed to fetch energy bank for runtime augmentation', {
      avatarId,
      error:
        bankResult.reason instanceof Error
          ? bankResult.reason.message
          : String(bankResult.reason),
    });
  }
  if (resonanceResult.status === 'rejected') {
    logger.warn('Failed to fetch Orb resonance for runtime augmentation', {
      avatarId,
      error:
        resonanceResult.reason instanceof Error
          ? resonanceResult.reason.message
          : String(resonanceResult.reason),
    });
  }

  const burn =
    burnResult.status === 'fulfilled'
      ? {
          totalBurned: burnResult.value.totalBurned,
          tier: burnResult.value.tier,
          tierName: burnResult.value.tierName,
          maxEnergy: burnResult.value.maxEnergy,
          regenPerHour: burnResult.value.regenPerHour,
          updatedAt: burnResult.value.lastVerifiedAt,
        }
      : undefined;

  const energy =
    energyResult.status === 'fulfilled'
      ? {
          current: energyResult.value.current,
          max: energyResult.value.max,
          refillPerHour: energyResult.value.refillPerHour,
          nextRefillIn: energyResult.value.nextRefillIn,
          bankCredits:
            bankResult.status === 'fulfilled'
              ? bankResult.value.credits
              : undefined,
          updatedAt: Date.now(),
        }
      : undefined;

  // Apply resonance energy regen bonus to burn augmentation
  const resonanceData =
    resonanceResult.status === 'fulfilled' ? resonanceResult.value : null;

  const resonance = resonanceData
    ? {
        resonance: resonanceData.resonance,
        tier: resonanceData.tier.tier,
        tierLabel: resonanceData.tier.label,
        energyRegenBonus: resonanceData.tier.energyRegenBonus,
        updatedAt: Date.now(),
      }
    : undefined;

  // If the resonance tier provides an energy regen bonus, apply it to the
  // burn augmentation's regenPerHour so handlers pick it up automatically.
  if (burn && resonanceData && resonanceData.tier.energyRegenBonus > 0) {
    burn.regenPerHour = (burn.regenPerHour ?? 0) + resonanceData.tier.energyRegenBonus;
  }

  if (!burn && !energy && !resonance) return undefined;

  return {
    ...(burn ? { burn } : {}),
    ...(energy ? { energy } : {}),
    ...(resonance ? { resonance } : {}),
  };
}

export async function syncRuntimeContractForAvatar(
  avatarId: string,
): Promise<void> {
  const entitlement = await entitlementsService.getEntitlement(avatarId);
  let effective = getEffectiveLimitsForAvatar(avatarId, entitlement);

  // If the avatar is on the free plan, check whether the creator wallet
  // holds at least one Gate NFT (Orb). If so, apply
  // the Orb-holder boost to raise limits above free-tier defaults.
  if (effective.plan === 'free') {
    effective = await maybeApplyOrbBoost(avatarId, effective);
  }

  const augmentations = await buildRuntimeAugmentations(avatarId);
  await syncRuntimeLimitsToState({
    avatarId,
    runtimeLimits: toRuntimeLimits(effective.limits),
    plan: effective.plan,
    source: effective.source,
    entitlementStatus: effective.entitlementStatus,
    augmentations,
  });
}

/**
 * Check whether the avatar's creator wallet holds 1+ Orbs
 * and, if so, return boosted limits.  Falls back to the original result
 * on any error so the sync never fails because of NFT checks.
 */
async function maybeApplyOrbBoost(
  avatarId: string,
  effective: ReturnType<typeof getEffectiveLimitsForAvatar>,
): Promise<ReturnType<typeof getEffectiveLimitsForAvatar>> {
  try {
    const avatar = await avatarsService.getAvatar(avatarId);
    if (!avatar) return effective;

    const walletToCheck = avatar.creatorWallet;
    if (!walletToCheck) return effective;

    const nftResult = await checkNFTGate(walletToCheck);
    if (nftResult.ownedCount >= 1) {
      logger.info('Orb holder boost applied', {
        avatarId,
        wallet: walletToCheck.slice(0, 8) + '...',
        orbsHeld: nftResult.ownedCount,
      });
      return applyOrbHolderBoost(effective);
    }
  } catch (err) {
    logger.warn('Failed to check Orb holdings for boost; using base limits', {
      avatarId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return effective;
}
