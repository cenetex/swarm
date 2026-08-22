/**
 * Energy system routes.
 *
 * - GET  /avatars/{id}/energy
 * - POST /avatars/{id}/energy/burn
 * - POST /avatars/{id}/energy/set
 * - POST /avatars/{id}/energy/add
 * - GET  /avatars/{id}/energy/history
 */
import type { HttpResponse } from "@swarm/core";
import type { RouteContext } from './types.js';
import { jsonResponse, requireOwnerOrAdmin } from './shared.js';
import { syncRuntimeContractForAvatar } from './runtime-sync.js';
import { parseJsonBody } from '../../http/request-body.js';
import { logger } from '@swarm/core';
import * as avatarService from '../../services/avatars.js';
import * as energyService from '../../services/billing/energy.js';
import * as energyBurnService from '../../services/billing/energy-burn.js';

export async function handleEnergyRoutes(
  ctx: RouteContext,
): Promise<HttpResponse | null> {
  const { method, path, event, corsHeaders, session, walletAddress, effectiveIsAdmin } = ctx;

  // ── GET /avatars/{id}/energy ─────────────────────────────────────────────
  const energyMatch = path.match(/^\/avatars\/([^/]+)\/energy$/);
  if (method === 'GET' && energyMatch) {
    const avatarId = energyMatch[1];

    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    const status = await energyService.getEnergyStatus(avatarId);
    const bank = await energyService.getEnergyBankBalance(avatarId);

    return jsonResponse(corsHeaders, 200, {
      avatarId,
      ...status,
      bankCredits: bank.credits,
      costs: energyService.ENERGY_COSTS,
    });
  }

  // ── POST /avatars/{id}/energy/burn ───────────────────────────────────────
  const energyBurnMatch = path.match(/^\/avatars\/([^/]+)\/energy\/burn$/);
  if (method === 'POST' && energyBurnMatch) {
    const avatarId = energyBurnMatch[1];

    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    const body = parseJsonBody<{ mint?: unknown }>(event);
    const mint = typeof body?.mint === 'string' ? body.mint : undefined;
    const actorId = walletAddress || session.email || 'unknown';

    const result = await energyBurnService.burnDepositedTokensForEnergy({
      avatarId,
      mint,
      actorId,
    });

    if (!result.success) {
      return jsonResponse(corsHeaders, 400, {
        error: result.error || 'Failed to burn tokens for energy',
        signature: result.signature,
        mint: result.mint,
      });
    }

    try {
      await syncRuntimeContractForAvatar(avatarId);
    } catch (err) {
      logger.warn('Failed to sync runtime limits after energy burn', {
        avatarId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const status = await energyService.getEnergyStatus(avatarId);
    const bank = await energyService.getEnergyBankBalance(avatarId);

    return jsonResponse(corsHeaders, 200, {
      ...result,
      energy: {
        ...status,
        bankCredits: bank.credits,
        costs: energyService.ENERGY_COSTS,
      },
    });
  }

  // ── POST /avatars/{id}/energy/set — Admin-only ───────────────────────────
  const energySetMatch = path.match(/^\/avatars\/([^/]+)\/energy\/set$/);
  if (method === 'POST' && energySetMatch) {
    if (!effectiveIsAdmin) {
      return jsonResponse(corsHeaders, 403, { error: 'Admin access required' });
    }
    const avatarId = energySetMatch[1];
    const body = parseJsonBody<{ value?: unknown }>(event);
    const { value } = body;

    if (typeof value !== 'number' || value < 0) {
      return jsonResponse(corsHeaders, 400, {
        error: 'value must be a non-negative number',
      });
    }

    const result = await energyService.setEnergy(avatarId, value);
    try {
      await syncRuntimeContractForAvatar(avatarId);
    } catch (err) {
      logger.warn('Failed to sync runtime limits after setEnergy', {
        avatarId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return jsonResponse(corsHeaders, 200, {
      avatarId,
      success: result.success,
      newValue: result.newValue,
    });
  }

  // ── POST /avatars/{id}/energy/add — Admin-only ───────────────────────────
  const energyAddMatch = path.match(/^\/avatars\/([^/]+)\/energy\/add$/);
  if (method === 'POST' && energyAddMatch) {
    if (!effectiveIsAdmin) {
      return jsonResponse(corsHeaders, 403, { error: 'Admin access required' });
    }
    const avatarId = energyAddMatch[1];
    const body = parseJsonBody<{ amount?: unknown }>(event);
    const { amount } = body;

    if (typeof amount !== 'number') {
      return jsonResponse(corsHeaders, 400, { error: 'amount must be a number' });
    }

    const result = await energyService.addEnergy(avatarId, amount);
    try {
      await syncRuntimeContractForAvatar(avatarId);
    } catch (err) {
      logger.warn('Failed to sync runtime limits after addEnergy', {
        avatarId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return jsonResponse(corsHeaders, 200, {
      avatarId,
      success: result.success,
      newValue: result.newValue,
    });
  }

  // ── GET /avatars/{id}/energy/history ─────────────────────────────────────
  const energyHistoryMatch = path.match(/^\/avatars\/([^/]+)\/energy\/history$/);
  if (method === 'GET' && energyHistoryMatch) {
    const avatarId = energyHistoryMatch[1];

    const denied = await requireOwnerOrAdmin(ctx, avatarId, avatarService.getAvatar);
    if (denied) return denied;

    const params = event.queryStringParameters || {};
    const limit = params.limit ? Number.parseInt(params.limit, 10) : 50;

    const history = await energyService.getEnergyHistory(avatarId, limit);

    return jsonResponse(corsHeaders, 200, {
      avatarId,
      events: history.map((e) => ({
        operation: e.operation,
        cost: e.cost,
        energyBefore: e.energyBefore,
        energyAfter: e.energyAfter,
        refillRate: e.refillRate,
        timestamp: new Date(e.timestamp).toISOString(),
      })),
      count: history.length,
    });
  }

  return null;
}
