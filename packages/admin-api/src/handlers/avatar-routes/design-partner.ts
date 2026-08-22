/**
 * Design Partner Beta routes.
 *
 * Admin-only routes for managing invite codes and partner lifecycle:
 *   POST   /design-partners/invites         — Create a new invite code
 *   GET    /design-partners/invites         — List all invite codes
 *   DELETE /design-partners/invites/{code}  — Revoke an invite code
 *   POST   /design-partners/redeem          — Redeem an invite code (user-facing)
 *   GET    /design-partners                 — List all partners + meta
 *   GET    /design-partners/{accountId}     — Get a single partner record
 *   POST   /design-partners/{accountId}/cancel — Cancel a partner (admin-only)
 *
 * Chat-first philosophy: the redeem endpoint is called via the admin AI chat
 * when a user says something like "I have an invite code: DP-XXXX-XXXX".
 */
import type { HttpResponse } from "@swarm/core";
import type { RouteContext } from './types.js';
import { jsonResponse } from './shared.js';
import { parseJsonBody } from '../../http/request-body.js';
import { logger } from '@swarm/core';
import * as designPartnerService from '../../services/billing/design-partner.js';
import * as entitlementsService from '../../services/billing/entitlements.js';
import { syncRuntimeContractForAvatar } from './runtime-sync.js';
import * as auditLogService from '../../services/audit-log.js';

export async function handleDesignPartnerRoutes(
  ctx: RouteContext,
): Promise<HttpResponse | null> {
  const { method, path, event, corsHeaders, walletAddress, effectiveIsAdmin, session } = ctx;

  // ── POST /design-partners/invites — Create invite code (admin-only) ─────
  if (method === 'POST' && path === '/design-partners/invites') {
    if (!effectiveIsAdmin) {
      return jsonResponse(corsHeaders, 403, { error: 'Admin access required' });
    }

    const body = parseJsonBody<{
      plan?: unknown;
      note?: unknown;
      expiresAt?: unknown;
    }>(event);

    const plan = body?.plan;
    if (plan !== 'pro' && plan !== 'enterprise') {
      return jsonResponse(corsHeaders, 400, {
        error: 'Invalid plan. Must be "pro" or "enterprise".',
      });
    }

    const actorId = walletAddress || session.email || 'unknown';
    const note = typeof body?.note === 'string' ? body.note : undefined;
    const expiresAt = typeof body?.expiresAt === 'number' ? body.expiresAt : undefined;

    const invite = await designPartnerService.createInviteCode({
      plan,
      createdBy: actorId,
      note,
      expiresAt,
    });

    if (!invite) {
      return jsonResponse(corsHeaders, 409, {
        error: `Maximum design partner limit (${designPartnerService.MAX_DESIGN_PARTNERS}) reached. Cannot create more invite codes.`,
      });
    }

    return jsonResponse(corsHeaders, 201, {
      invite,
      message: `Invite code created: ${invite.code} (${plan} plan)`,
    });
  }

  // ── GET /design-partners/invites — List all invite codes (admin-only) ───
  if (method === 'GET' && path === '/design-partners/invites') {
    if (!effectiveIsAdmin) {
      return jsonResponse(corsHeaders, 403, { error: 'Admin access required' });
    }

    const invites = await designPartnerService.listInviteCodes();

    return jsonResponse(corsHeaders, 200, {
      invites,
      count: invites.length,
    });
  }

  // ── DELETE /design-partners/invites/{code} — Revoke an invite (admin-only)
  const revokeMatch = path.match(/^\/design-partners\/invites\/([A-Z0-9-]+)$/);
  if (method === 'DELETE' && revokeMatch) {
    if (!effectiveIsAdmin) {
      return jsonResponse(corsHeaders, 403, { error: 'Admin access required' });
    }

    const code = revokeMatch[1];
    const actorId = walletAddress || session.email || 'unknown';
    const success = await designPartnerService.revokeInviteCode(code, actorId);

    if (!success) {
      return jsonResponse(corsHeaders, 404, {
        error: 'Invite code not found or not in active status.',
      });
    }

    return jsonResponse(corsHeaders, 200, {
      success: true,
      message: `Invite code ${code} has been revoked.`,
    });
  }

  // ── POST /design-partners/redeem — Redeem an invite code (user-facing) ──
  if (method === 'POST' && path === '/design-partners/redeem') {
    const body = parseJsonBody<{
      code?: unknown;
      avatarId?: unknown;
    }>(event);

    const code = typeof body?.code === 'string' ? body.code.trim().toUpperCase() : null;
    const avatarId = typeof body?.avatarId === 'string' ? body.avatarId : null;

    if (!code) {
      return jsonResponse(corsHeaders, 400, { error: 'Invite code is required.' });
    }
    if (!avatarId) {
      return jsonResponse(corsHeaders, 400, { error: 'avatarId is required.' });
    }

    const accountId = ctx.accountId;
    if (!accountId) {
      return jsonResponse(corsHeaders, 401, {
        error: 'Account context required. Please sign in with your wallet.',
      });
    }

    const actorId = walletAddress || session.email || 'unknown';

    const result = await designPartnerService.redeemInviteCode({
      code,
      accountId,
      avatarId,
      actorId,
    });

    if (!result.success) {
      const messages: Record<string, string> = {
        invalid_code: 'Invalid invite code. Please check and try again.',
        already_redeemed: 'This invite code has already been used.',
        expired: 'This invite code has expired.',
        revoked: 'This invite code has been revoked.',
        max_partners: `The Design Partner Beta is full (${designPartnerService.MAX_DESIGN_PARTNERS} partners maximum).`,
        already_partner: 'This account is already an active design partner.',
      };

      return jsonResponse(corsHeaders, 400, {
        error: messages[result.error] || 'Failed to redeem invite code.',
        code: result.error,
      });
    }

    // Provision Pro/Enterprise entitlement for the partner
    const partner = result.partner;
    try {
      await entitlementsService.setEntitlement({
        accountId: partner.accountId,
        avatarId: partner.avatarId,
        plan: partner.plan,
        status: 'active',
        actorId,
        entitlementSource: 'design-partner',
      });

      await syncRuntimeContractForAvatar(partner.avatarId);
    } catch (err) {
      logger.error('Failed to provision design partner entitlement', {
        accountId: partner.accountId,
        avatarId: partner.avatarId,
        error: err instanceof Error ? err.message : String(err),
      });
      // The partner record was created even if entitlement provisioning failed.
      // Admin can re-provision manually.
    }

    // Audit log
    try {
      await auditLogService.recordAuditEvent({
        avatarId: partner.avatarId,
        eventType: 'entitlement_changed',
        actorId,
        actorType: effectiveIsAdmin ? 'admin' : 'owner',
        details: {
          action: 'design_partner_redeemed',
          inviteCode: code,
          plan: partner.plan,
          refundDeadline: new Date(partner.refundDeadline).toISOString(),
        },
      });
    } catch (err) {
      logger.warn('Failed to record design partner audit event', {
        avatarId: partner.avatarId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return jsonResponse(corsHeaders, 200, {
      success: true,
      message: `Welcome to the Design Partner Beta! Your avatar has been upgraded to ${partner.plan}.`,
      partner: {
        accountId: partner.accountId,
        avatarId: partner.avatarId,
        plan: partner.plan,
        status: partner.status,
        refundEligible: partner.refundEligible,
        refundDeadline: new Date(partner.refundDeadline).toISOString(),
        feedbackSchedule: partner.feedbackSchedule,
      },
    });
  }

  // ── GET /design-partners — List all partners + meta (admin-only) ────────
  if (method === 'GET' && path === '/design-partners') {
    if (!effectiveIsAdmin) {
      return jsonResponse(corsHeaders, 403, { error: 'Admin access required' });
    }

    const [partners, meta] = await Promise.all([
      designPartnerService.listPartners(),
      designPartnerService.getDesignPartnerMeta(),
    ]);

    return jsonResponse(corsHeaders, 200, {
      partners,
      count: partners.length,
      meta: meta || {
        activePartnerCount: 0,
        totalCodesIssued: 0,
        totalRedeemed: 0,
      },
      maxPartners: designPartnerService.MAX_DESIGN_PARTNERS,
    });
  }

  // ── GET /design-partners/{accountId} — Get partner detail (admin-only) ──
  const partnerDetailMatch = path.match(/^\/design-partners\/([^/]+)$/);
  if (method === 'GET' && partnerDetailMatch && partnerDetailMatch[1] !== 'invites') {
    if (!effectiveIsAdmin) {
      return jsonResponse(corsHeaders, 403, { error: 'Admin access required' });
    }

    const accountId = partnerDetailMatch[1];
    const partner = await designPartnerService.getPartner(accountId);

    if (!partner) {
      return jsonResponse(corsHeaders, 404, { error: 'Design partner not found.' });
    }

    return jsonResponse(corsHeaders, 200, {
      partner,
      refundEligible: designPartnerService.isRefundEligible(partner),
    });
  }

  // ── POST /design-partners/{accountId}/cancel — Cancel partner (admin-only)
  const cancelMatch = path.match(/^\/design-partners\/([^/]+)\/cancel$/);
  if (method === 'POST' && cancelMatch) {
    if (!effectiveIsAdmin) {
      return jsonResponse(corsHeaders, 403, { error: 'Admin access required' });
    }

    const accountId = cancelMatch[1];
    const body = parseJsonBody<{
      reason?: unknown;
      isRefund?: unknown;
    }>(event);

    const reason = typeof body?.reason === 'string' ? body.reason : undefined;
    const isRefund = body?.isRefund === true;

    // If requesting refund, check eligibility
    if (isRefund) {
      const partner = await designPartnerService.getPartner(accountId);
      if (partner && !designPartnerService.isRefundEligible(partner)) {
        return jsonResponse(corsHeaders, 400, {
          error: 'Refund window has expired. The 30-day refund period is over.',
        });
      }
    }

    const actorId = walletAddress || session.email || 'unknown';
    const cancelled = await designPartnerService.cancelPartner({
      accountId,
      reason,
      isRefund,
      actorId,
    });

    if (!cancelled) {
      return jsonResponse(corsHeaders, 404, {
        error: 'Design partner not found or not in active status.',
      });
    }

    // Downgrade entitlement to free tier
    try {
      await entitlementsService.setEntitlement({
        accountId: cancelled.accountId,
        avatarId: cancelled.avatarId,
        plan: 'free',
        status: 'active',
        actorId,
        entitlementSource: 'design-partner',
      });

      await syncRuntimeContractForAvatar(cancelled.avatarId);
    } catch (err) {
      logger.error('Failed to downgrade design partner entitlement', {
        accountId: cancelled.accountId,
        avatarId: cancelled.avatarId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Audit log
    try {
      await auditLogService.recordAuditEvent({
        avatarId: cancelled.avatarId,
        eventType: 'entitlement_changed',
        actorId,
        actorType: 'admin',
        details: {
          action: 'design_partner_cancelled',
          status: cancelled.status,
          reason,
          isRefund,
        },
      });
    } catch (err) {
      logger.warn('Failed to record design partner cancellation audit event', {
        avatarId: cancelled.avatarId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return jsonResponse(corsHeaders, 200, {
      success: true,
      message: isRefund
        ? `Design partner ${accountId} has been cancelled with a full refund.`
        : `Design partner ${accountId} has been cancelled.`,
      partner: cancelled,
    });
  }

  return null;
}
