/**
 * Usage metering routes.
 *
 * - GET /avatars/{id}/usage          — today's usage vs limits
 * - GET /avatars/{id}/usage/history  — historical daily usage (last N days)
 */
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { RouteContext } from './types.js';
import { jsonResponse, requireOwnerOrAdmin } from './shared.js';
import * as avatarService from '../../services/avatars.js';
import * as entitlementsService from '../../services/billing/entitlements.js';
import { getEffectiveLimitsForAvatar, applyOrbHolderBoost } from '../../services/billing/runtime-limits.js';
import { getToolStatusStructured } from '../../services/billing/credits.js';
import { getEnergyStatus, getEnergyBankBalance } from '../../services/billing/energy.js';
import { getUsageHistory } from '../../services/usage-history.js';
import { getAvatarUsageRollups } from '../../services/token-accounting.js';

export async function handleUsageRoutes(
  ctx: RouteContext,
): Promise<APIGatewayProxyResultV2 | null> {
  const { method, path, corsHeaders } = ctx;

  // ── GET /avatars/{id}/usage ──────────────────────────────────────────────
  const usageMatch = path.match(/^\/avatars\/([^/]+)\/usage$/);
  if (method === 'GET' && usageMatch) {
    const avatarId = usageMatch[1];

    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    // Gather usage, limits, energy, and tool credits in parallel
    const [usage, entitlement, toolCredits, energyResult] = await Promise.all([
      entitlementsService.getUsage(avatarId),
      entitlementsService.getEntitlement(avatarId),
      getToolStatusStructured(avatarId),
      Promise.all([
        getEnergyStatus(avatarId).catch(() => null),
        getEnergyBankBalance(avatarId).catch(() => ({ credits: 0 })),
      ]),
    ]);

    const [energyStatus, bankBalance] = energyResult;

    let effective = getEffectiveLimitsForAvatar(avatarId, entitlement);
    // Apply Orb holder boost if applicable
    effective = applyOrbHolderBoost(effective);

    const limits = effective.limits;

    const meters = {
      messages: {
        used: usage?.messagesProcessed ?? 0,
        limit: limits.dailyMessageLimit,
        label: 'Messages',
      },
      media: {
        used: usage?.mediaCreditsUsed ?? 0,
        limit: limits.dailyMediaCredits,
        label: 'Media Credits',
      },
      voice: {
        used: usage?.voiceMinutesUsed ?? 0,
        limit: limits.dailyVoiceMinutes,
        label: 'Voice (min)',
      },
    };

    return jsonResponse(corsHeaders, 200, {
      avatarId,
      date: usage?.date ?? new Date().toISOString().split('T')[0],
      plan: effective.plan,
      source: effective.source,
      meters,
      toolCredits,
      energy: energyStatus
        ? {
            current: energyStatus.current,
            max: energyStatus.max,
            refillPerHour: energyStatus.refillPerHour,
            bankCredits: bankBalance.credits,
          }
        : null,
    });
  }

  // ── GET /avatars/{id}/usage/history ──────────────────────────────────────
  const historyMatch = path.match(/^\/avatars\/([^/]+)\/usage\/history$/);
  if (method === 'GET' && historyMatch) {
    const avatarId = historyMatch[1];

    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    const params = ctx.event.queryStringParameters || {};
    const days = Math.min(Math.max(parseInt(params.days || '7', 10) || 7, 1), 30);

    const history = await getUsageHistory(avatarId, days);

    return jsonResponse(corsHeaders, 200, {
      avatarId,
      days,
      history,
    });
  }

  // ── GET /avatars/{id}/usage/tokens ─────────────────────────────────────
  const tokensMatch = path.match(/^\/avatars\/([^/]+)\/usage\/tokens$/);
  if (method === 'GET' && tokensMatch) {
    const avatarId = tokensMatch[1];

    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    const params = ctx.event.queryStringParameters || {};
    const days = Math.min(Math.max(parseInt(params.days || '7', 10) || 7, 1), 90);

    const rollups = await getAvatarUsageRollups(avatarId, days);

    // Compute totals across the period
    const totals = rollups.reduce(
      (acc, r) => ({
        requestCount: acc.requestCount + r.requestCount,
        totalPromptTokens: acc.totalPromptTokens + r.totalPromptTokens,
        totalCompletionTokens: acc.totalCompletionTokens + r.totalCompletionTokens,
        totalTokens: acc.totalTokens + r.totalTokens,
        totalCostMicroUsd: acc.totalCostMicroUsd + r.totalCostMicroUsd,
        providerReportedCount: acc.providerReportedCount + r.providerReportedCount,
        estimatedCount: acc.estimatedCount + r.estimatedCount,
      }),
      {
        requestCount: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalTokens: 0,
        totalCostMicroUsd: 0,
        providerReportedCount: 0,
        estimatedCount: 0,
      },
    );

    return jsonResponse(corsHeaders, 200, {
      avatarId,
      days,
      totals,
      daily: rollups,
    });
  }

  return null;
}
