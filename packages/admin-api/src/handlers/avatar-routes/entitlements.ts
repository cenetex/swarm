/**
 * Entitlement, Orb-slot, and activation lifecycle routes.
 *
 * - PUT / DELETE /avatars/{id}/orb
 * - GET / PUT  /avatars/{id}/entitlement
 * - GET        /avatars/{id}/effective-limits
 * - POST       /avatars/{id}/activate
 * - POST       /avatars/{id}/deactivate
 * - GET        /avatars/{id}/audit-log
 */
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { RouteContext } from './types.js';
import { jsonResponse } from './shared.js';
import { syncRuntimeContractForAvatar } from './runtime-sync.js';
import { parseJsonBody } from '../../http/request-body.js';
import { logger } from '@swarm/core';
import * as avatarService from '../../services/avatars.js';
import * as orbSlotsService from '../../services/web3/orb-slots.js';
import * as entitlementsService from '../../services/billing/entitlements.js';
import { getEffectiveLimitsForAvatar } from '../../services/billing/runtime-limits.js';
import {
  ACTIVATION_READINESS_VERSION,
  evaluateActivationReadiness,
  toLegacyActivationIssues,
} from '../../services/activation-readiness.js';
import * as auditLogService from '../../services/audit-log.js';
import type { ActorType } from '../../services/audit-log.js';
import type { EntitlementRecord, PlanLimits } from '../../types.js';

/**
 * Resolve actor type from context: admin or owner.
 */
function resolveActorType(
  effectiveIsAdmin: boolean,
  _walletAddress: string | null,
  _avatar: { creatorWallet?: string | null } | null,
): ActorType {
  if (effectiveIsAdmin) return 'admin';
  return 'owner';
}

export async function handleEntitlementRoutes(
  ctx: RouteContext,
): Promise<APIGatewayProxyResultV2 | null> {
  const { method, path, event, corsHeaders, session, walletAddress, effectiveIsAdmin } = ctx;

  // ── PUT / DELETE /avatars/{id}/orb ───────────────────────────────────────
  const avatarOrbMatch = path.match(/^\/avatars\/([^/]+)\/orb$/);
  if (avatarOrbMatch && (method === 'PUT' || method === 'DELETE')) {
    const avatarId = avatarOrbMatch[1];

    if (!walletAddress) {
      return jsonResponse(corsHeaders, 403, { error: 'Wallet sign-in required' });
    }

    const avatar = await avatarService.getAvatar(avatarId);
    if (!avatar) {
      return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
    }

    const canManage =
      effectiveIsAdmin ||
      avatar.creatorWallet === walletAddress;

    if (!canManage) {
      return jsonResponse(corsHeaders, 403, { error: 'Forbidden' });
    }

    if (method === 'PUT') {
      const body = parseJsonBody<{ mintAddress?: unknown }>(event);
      const mintAddress = body?.mintAddress;
      if (!mintAddress || typeof mintAddress !== 'string') {
        return jsonResponse(corsHeaders, 400, { error: 'mintAddress is required' });
      }

      const result = await orbSlotsService.slotOrbToAvatar(walletAddress, avatar, mintAddress);
      if (!result.success) {
        const message =
          result.error === 'not_owned'
            ? 'You do not own this Orb.'
            : result.error === 'already_slotted'
            ? 'This Orb is already slotted into another avatar.'
            : 'This avatar already has an Orb slotted.';
        return jsonResponse(corsHeaders, 403, { error: message });
      }

      return jsonResponse(corsHeaders, 200, { success: true, avatarId, mintAddress });
    }

    // DELETE
    const result = await orbSlotsService.unslotOrbFromAvatar(walletAddress, avatar);
    if (!result.success) {
      if (result.error === 'not_owner') {
        return jsonResponse(corsHeaders, 403, { error: 'Forbidden' });
      }
      return jsonResponse(corsHeaders, 400, {
        error: 'No Orb is currently slotted into this avatar.',
      });
    }

    return jsonResponse(corsHeaders, 200, { success: true, avatarId });
  }

  // ── GET /avatars/{id}/entitlement ────────────────────────────────────────
  const entitlementMatch = path.match(/^\/avatars\/([^/]+)\/entitlement$/);
  if (method === 'GET' && entitlementMatch) {
    const avatarId = entitlementMatch[1];

    const avatar = await avatarService.getAvatar(avatarId);
    if (!avatar) {
      return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
    }

    if (!effectiveIsAdmin) {
      if (
        !walletAddress ||
        avatar.creatorWallet !== walletAddress
      ) {
        return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
      }
    }

    const entitlement = await entitlementsService.getEntitlement(avatarId);
    return jsonResponse(corsHeaders, 200, { avatarId, entitlement });
  }

  // ── PUT /avatars/{id}/entitlement — Admin-only ───────────────────────────
  if (method === 'PUT' && entitlementMatch) {
    if (!effectiveIsAdmin) {
      return jsonResponse(corsHeaders, 403, { error: 'Admin access required' });
    }

    const avatarId = entitlementMatch[1];
    const avatar = await avatarService.getAvatar(avatarId);
    if (!avatar) {
      return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
    }

    const body = parseJsonBody<{
      plan?: unknown;
      accountId?: unknown;
      overrides?: unknown;
      status?: unknown;
      trialEndsAt?: unknown;
      stripeCustomerId?: unknown;
      stripeSubscriptionId?: unknown;
    }>(event);
    const plan = body?.plan;
    const overrides =
      body?.overrides && typeof body.overrides === 'object' && !Array.isArray(body.overrides)
        ? (body.overrides as Partial<PlanLimits>)
        : undefined;
    const status =
      body?.status === 'active' ||
      body?.status === 'suspended' ||
      body?.status === 'cancelled' ||
      body?.status === 'trial'
        ? (body.status as EntitlementRecord['status'])
        : undefined;
    const trialEndsAt = typeof body?.trialEndsAt === 'number' ? body.trialEndsAt : undefined;
    const stripeCustomerId =
      typeof body?.stripeCustomerId === 'string' ? body.stripeCustomerId : undefined;
    const stripeSubscriptionId =
      typeof body?.stripeSubscriptionId === 'string' ? body.stripeSubscriptionId : undefined;

    if (plan !== 'free' && plan !== 'pro' && plan !== 'enterprise') {
      return jsonResponse(corsHeaders, 400, { error: 'Invalid plan' });
    }

    // Resolve the wallet session for accountId if not provided in body.
    const accountId =
      body?.accountId && typeof body.accountId === 'string'
        ? body.accountId
        : ctx.accountId;
    if (!accountId) {
      return jsonResponse(corsHeaders, 400, {
        error: 'accountId is required (no wallet session found)',
      });
    }

    const actorId = walletAddress || session.email || 'unknown';

    const entitlement = await entitlementsService.setEntitlement({
      accountId,
      avatarId,
      plan,
      overrides,
      status,
      trialEndsAt,
      stripeCustomerId,
      stripeSubscriptionId,
      actorId,
    });

    await syncRuntimeContractForAvatar(avatarId);

    // Audit: record entitlement change
    try {
      await auditLogService.recordAuditEvent({
        avatarId,
        eventType: 'entitlement_changed',
        actorId,
        actorType: resolveActorType(effectiveIsAdmin, walletAddress, avatar),
        details: {
          plan,
          overrides: overrides ?? null,
          status: status ?? null,
          accountId,
        },
      });
    } catch (err) {
      logger.warn('Failed to record entitlement audit event', {
        avatarId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return jsonResponse(corsHeaders, 200, {
      avatarId,
      entitlement,
      effective: getEffectiveLimitsForAvatar(avatarId, entitlement),
    });
  }

  // ── GET /avatars/{id}/effective-limits ───────────────────────────────────
  const effectiveLimitsMatch = path.match(/^\/avatars\/([^/]+)\/effective-limits$/);
  if (method === 'GET' && effectiveLimitsMatch) {
    const avatarId = effectiveLimitsMatch[1];

    const avatar = await avatarService.getAvatar(avatarId);
    if (!avatar) {
      return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
    }

    if (!effectiveIsAdmin) {
      if (
        !walletAddress ||
        avatar.creatorWallet !== walletAddress
      ) {
        return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
      }
    }

    const entitlement = await entitlementsService.getEntitlement(avatarId);
    const effective = getEffectiveLimitsForAvatar(avatarId, entitlement);

    return jsonResponse(corsHeaders, 200, {
      avatarId,
      plan: effective.plan,
      limits: effective.limits,
      source: effective.source,
      entitlementStatus: effective.entitlementStatus,
    });
  }

  // ── GET /avatars/{id}/activation-readiness ───────────────────────────────
  const activationReadinessMatch = path.match(/^\/avatars\/([^/]+)\/activation-readiness$/);
  if (method === 'GET' && activationReadinessMatch) {
    const avatarId = activationReadinessMatch[1];

    const avatar = await avatarService.getAvatar(avatarId);
    if (!avatar) {
      return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
    }

    if (!effectiveIsAdmin) {
      if (!walletAddress || avatar.creatorWallet !== walletAddress) {
        return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
      }
    }

    const readiness = await evaluateActivationReadiness(avatar, {
      effectiveIsAdmin,
      walletAddress,
      accountId: ctx.accountId ?? null,
    });

    return jsonResponse(corsHeaders, 200, readiness);
  }

  // ── POST /avatars/{id}/activate ──────────────────────────────────────────
  const activateMatch = path.match(/^\/avatars\/([^/]+)\/activate$/);
  if (method === 'POST' && activateMatch) {
    const avatarId = activateMatch[1];

    const avatar = await avatarService.getAvatar(avatarId);
    if (!avatar) {
      return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
    }

    const canActivate =
      effectiveIsAdmin ||
      avatar.creatorWallet === walletAddress;

    if (!canActivate) {
      return jsonResponse(corsHeaders, 403, { error: 'Forbidden' });
    }

    // Evaluate activation readiness gate using canonical contract.
    const readiness = await evaluateActivationReadiness(avatar, {
      effectiveIsAdmin,
      walletAddress,
      accountId: ctx.accountId ?? null,
    });
    if (readiness.gateStatus === 'fail') {
      return jsonResponse(corsHeaders, 409, {
        error: {
          code: 'ACTIVATION_GATE_BLOCKED',
          message: 'Activation blocked until required readiness checks pass.',
          retryable: true,
        },
        avatarId,
        readiness,
        issues: toLegacyActivationIssues(readiness),
      });
    }

    const actorId = walletAddress || session.email || 'unknown';
    const result = await avatarService.activateAvatar(avatarId, actorId);

    if (!result.success) {
      return jsonResponse(corsHeaders, 500, {
        error: result.error || 'Failed to activate avatar',
      });
    }

    // Ensure runtime limits are synced for immediate enforcement.
    try {
      await syncRuntimeContractForAvatar(avatarId);
    } catch (err) {
      logger.warn('Failed to sync runtime limits on activation', {
        avatarId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    logger.info('Avatar activated', {
      event: 'avatar_activated',
      avatarId,
      actor: actorId,
      previousStatus: avatar.status,
    });

    // Audit: record activation
    try {
      await auditLogService.recordAuditEvent({
        avatarId,
        eventType: 'activated',
        actorId,
        actorType: resolveActorType(effectiveIsAdmin, walletAddress, avatar),
        details: {
          previousStatus: avatar.status,
          readinessVersion: ACTIVATION_READINESS_VERSION,
          gateStatus: readiness.gateStatus,
          readinessSummary: readiness.summary ?? null,
        },
      });
    } catch (err) {
      logger.warn('Failed to record activation audit event', {
        avatarId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return jsonResponse(corsHeaders, 200, {
      success: true,
      avatarId,
      status: 'active',
      activatedAt: Date.now(),
      activatedBy: actorId,
      readinessVersion: ACTIVATION_READINESS_VERSION,
    });
  }

  // ── POST /avatars/{id}/deactivate ────────────────────────────────────────
  const deactivateMatch = path.match(/^\/avatars\/([^/]+)\/deactivate$/);
  if (method === 'POST' && deactivateMatch) {
    const avatarId = deactivateMatch[1];

    const avatar = await avatarService.getAvatar(avatarId);
    if (!avatar) {
      return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
    }

    const canDeactivate =
      effectiveIsAdmin ||
      avatar.creatorWallet === walletAddress;

    if (!canDeactivate) {
      return jsonResponse(corsHeaders, 403, { error: 'Forbidden' });
    }

    const actorId = walletAddress || session.email || 'unknown';
    const result = await avatarService.deactivateAvatar(avatarId, actorId);

    if (!result.success) {
      return jsonResponse(corsHeaders, 500, {
        error: result.error || 'Failed to deactivate avatar',
      });
    }

    logger.info('Avatar deactivated', {
      event: 'avatar_deactivated',
      avatarId,
      actor: actorId,
    });

    // Audit: record deactivation
    const body = parseJsonBody<{ reason?: unknown }>(event);
    try {
      await auditLogService.recordAuditEvent({
        avatarId,
        eventType: 'deactivated',
        actorId,
        actorType: resolveActorType(effectiveIsAdmin, walletAddress, avatar),
        details: {
          previousStatus: avatar.status,
          reason: body?.reason ?? null,
        },
      });
    } catch (err) {
      logger.warn('Failed to record deactivation audit event', {
        avatarId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return jsonResponse(corsHeaders, 200, {
      success: true,
      avatarId,
      status: 'paused',
    });
  }

  // ── GET /avatars/{id}/audit-log — Admin-only ────────────────────────────
  const auditLogMatch = path.match(/^\/avatars\/([^/]+)\/audit-log$/);
  if (method === 'GET' && auditLogMatch) {
    if (!effectiveIsAdmin) {
      return jsonResponse(corsHeaders, 403, { error: 'Admin access required' });
    }

    const avatarId = auditLogMatch[1];
    const params = event.queryStringParameters || {};
    const limit = params.limit ? Number.parseInt(params.limit, 10) : undefined;
    const since = params.since ? Number.parseInt(params.since, 10) : undefined;
    const eventType = params.eventType as auditLogService.AuditEventType | undefined;

    const events = await auditLogService.listAuditEvents(avatarId, {
      eventType,
      limit,
      since,
    });

    return jsonResponse(corsHeaders, 200, {
      avatarId,
      events,
      count: events.length,
    });
  }

  return null;
}
