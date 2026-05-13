/**
 * Avatar CRUD routes: create, list, get, update, delete, reassign, integrations.
 *
 * Extracted from the monolithic avatars.ts handler.
 */
import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { RouteContext } from './types.js';
import { jsonResponse } from './shared.js';
import { logger } from '@swarm/core';
import * as avatarService from '../../services/avatars.js';
import * as galleryService from '../../services/gallery.js';
import * as integrationsService from '../../services/integrations.js';
import * as auditLogService from '../../services/audit-log.js';
import { scanNftAvatarsForWallet } from '../../services/scan-nft-avatars.js';
import type { ActorType } from '../../services/audit-log.js';
import { parseJsonBody } from '../../http/request-body.js';
import {
  resolveOnboardingRoutingDecision,
  type OnboardingRoutingDecision,
} from '../../services/onboarding-rollout.js';

/**
 * Resolve actor type from context: admin or owner.
 */
function resolveActorType(effectiveIsAdmin: boolean): ActorType {
  return effectiveIsAdmin ? 'admin' : 'owner';
}

// ── Profile-image hydration ────────────────────────────────────────────────

/**
 * Back-compat helper: older avatars may not have `profileImage` set but may
 * have a generated profile image in the gallery.  Fill it in when missing.
 */
async function hydrateAvatarProfileImage<
  T extends { avatarId: string; profileImage?: { url: string } },
>(avatar: T): Promise<T> {
  if (avatar.profileImage?.url) return avatar;
  const inferred = await galleryService.getLatestProfileImageFromGallery(avatar.avatarId);
  if (!inferred) return avatar;

  return {
    ...avatar,
    profileImage: {
      url: inferred.url,
      s3Key: inferred.s3Key,
      updatedAt: inferred.createdAt,
    },
  };
}

function buildOnboardingDiagnostics(decision: OnboardingRoutingDecision) {
  return {
    version: decision.onboardingVersion,
    reason: decision.reason,
    cohortBucket: decision.cohortBucket,
    assignmentKeyHash: decision.assignmentKeyHash,
    assignmentKeySource: decision.assignmentKeySource,
    matchedAvatarAllowlist: decision.matchedAvatarAllowlist,
    flags: {
      enabled: decision.flags.enabled,
      rolloutPercent: decision.flags.rolloutPercent,
      avatarAllowlist: decision.flags.avatarAllowlist,
      forceLegacy: decision.flags.forceLegacy,
      source: decision.flags.source,
      readAt: decision.flags.readAt,
    },
  };
}

// ── Route handler ──────────────────────────────────────────────────────────

export async function handleCrudRoutes(
  ctx: RouteContext,
): Promise<APIGatewayProxyResultV2 | null> {
  const { method, path, event, corsHeaders, session, walletAddress, effectiveIsAdmin } = ctx;

  // ── POST /avatars — Create a new avatar ──────────────────────────────────
  if (method === 'POST' && path === '/avatars') {
    const body = parseJsonBody<Record<string, unknown>>(event);
    const name = body.name;
    const description =
      typeof body.description === 'string'
        ? body.description
        : undefined;
    const onboardingAttemptKey =
      typeof body?.onboardingAttemptKey === 'string'
        ? body.onboardingAttemptKey
        : undefined;
    const onboardingAvatarId =
      typeof body?.avatarId === 'string'
        ? body.avatarId
        : undefined;

    if (!name || typeof name !== 'string') {
      return {
        statusCode: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Name is required' }),
      };
    }

    const onboardingDecision = await resolveOnboardingRoutingDecision({
      attemptKey: onboardingAttemptKey,
      accountId: ctx.accountId,
      walletAddress: walletAddress ?? undefined,
      userId: session.userId || session.email,
      avatarId: onboardingAvatarId,
      avatarName: name,
    });
    const onboardingDiagnostics = buildOnboardingDiagnostics(onboardingDecision);
    const walletPrefix = walletAddress ? `${walletAddress.slice(0, 8)}...` : undefined;

    logger.info('Onboarding rollout decision', {
      event: 'onboarding_rollout_decision',
      subsystem: 'onboarding',
      onboarding: onboardingDiagnostics,
      wallet: walletPrefix,
      accountId: ctx.accountId,
      avatarId: onboardingAvatarId,
    });

    // Wallet user: use gated creation (non-admin allowed)
    if (walletAddress) {
      const createLegacy = avatarService.createAvatarWithWalletLegacy ?? avatarService.createAvatarWithWallet;
      const createV2 = avatarService.createAvatarWithWalletV2 ?? avatarService.createAvatarWithWallet;
      const result = onboardingDecision.onboardingVersion === 'v2'
        ? await createV2(name, walletAddress, description)
        : await createLegacy(name, walletAddress, description);
      if (!result.success) {
        const errorMessage = result.error === 'no_gate_slot'
          ? 'No available avatar slots. Hold an Orb NFT to create more avatars.'
          : result.error === 'name_taken'
          ? 'An avatar with this name already exists.'
          : 'Failed to create avatar.';
        return jsonResponse(corsHeaders, result.error === 'no_gate_slot' ? 403 : 400, {
          error: errorMessage,
          gateStatus: result.gateStatus,
          onboarding: onboardingDiagnostics,
        });
      }

      logger.info(`[Avatars] Created avatar=${result.avatar!.avatarId} by wallet=${walletAddress.slice(0, 8)}...`);

      // Audit: record avatar creation
      try {
        await auditLogService.recordAuditEvent({
          avatarId: result.avatar!.avatarId,
          eventType: 'avatar_created',
          actorId: walletAddress,
          actorType: resolveActorType(effectiveIsAdmin),
          details: {
            name,
            creationMethod: 'wallet',
          },
        });
      } catch (err) {
        logger.warn('Failed to record avatar creation audit event', {
          avatarId: result.avatar!.avatarId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      return jsonResponse(corsHeaders, 201, {
        ...result.avatar,
        onboarding: onboardingDiagnostics,
      });
    }

    // Legacy email-based creation stays admin-only
    if (!effectiveIsAdmin) {
      return jsonResponse(corsHeaders, 403, {
        error: 'Wallet sign-in required',
        onboarding: onboardingDiagnostics,
      });
    }

    const avatar = await avatarService.createAvatar(name, session, description);

    // Audit: record avatar creation (admin email-based)
    try {
      await auditLogService.recordAuditEvent({
        avatarId: avatar.avatarId,
        eventType: 'avatar_created',
        actorId: session.email || 'unknown',
        actorType: 'admin',
        details: {
          name,
          creationMethod: 'email',
        },
      });
    } catch (err) {
      logger.warn('Failed to record avatar creation audit event', {
        avatarId: avatar.avatarId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return jsonResponse(corsHeaders, 201, {
      ...avatar,
      onboarding: onboardingDiagnostics,
    });
  }

  // ── GET /avatars — List avatars (filtered by wallet unless admin) ────────
  if (method === 'GET' && path === '/avatars') {
    let avatars: Awaited<ReturnType<typeof avatarService.listAvatars>>;

    if (walletAddress) {
      if (effectiveIsAdmin) {
        avatars = await avatarService.listAvatars();
        logger.info(`[Avatars] Admin wallet=${walletAddress.slice(0, 8)}... listed all ${avatars.length} avatars`);
      } else {
        avatars = await avatarService.listAvatarsByWallet(walletAddress);
        logger.info(`[Avatars] Listed ${avatars.length} avatars for wallet=${walletAddress.slice(0, 8)}...`);
      }
    } else if (effectiveIsAdmin) {
      avatars = await avatarService.listAvatars();
      logger.info(`[Avatars] Listed all ${avatars.length} avatars (no wallet session)`);
    } else {
      return jsonResponse(corsHeaders, 403, { error: 'Authentication required' });
    }

    // Back-compat: older avatars may not have `profileImage` set, but may have
    // a generated profile image in the gallery.
    const hydrated = await Promise.all(avatars.map(hydrateAvatarProfileImage));

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(hydrated),
    };
  }

  // ── POST /avatars/scan-nft — Create draft avatars from held collection NFTs ─
  if (method === 'POST' && path === '/avatars/scan-nft') {
    if (!walletAddress) {
      return jsonResponse(corsHeaders, 403, { error: 'Wallet sign-in required' });
    }

    const result = await scanNftAvatarsForWallet(walletAddress);
    return jsonResponse(corsHeaders, 200, result);
  }

  // ── PUT /avatars/{id}/reassign — Admin-only: Reassign avatar ownership ───
  const reassignMatch = path.match(/^\/avatars\/([^/]+)\/reassign$/);
  if (method === 'PUT' && reassignMatch) {
    const avatarId = reassignMatch[1];

    // Admin-only endpoint
    if (!effectiveIsAdmin) {
      return jsonResponse(corsHeaders, 403, { error: 'Admin access required' });
    }

    const body = parseJsonBody<{ creatorWallet?: string }>(event);

    const existing = await avatarService.getAvatar(avatarId);
    if (!existing) {
      return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
    }

    try {
      const result = await avatarService.reassignAvatar(avatarId, body, session);
      logger.info(`[Avatars] Reassigned avatar=${avatarId}`, {
        event: 'avatar_reassigned',
        avatarId,
        oldCreator: existing.creatorWallet?.slice(0, 8),
        newCreator: body.creatorWallet?.slice(0, 8),
      });

      // Audit: record avatar reassignment
      try {
        await auditLogService.recordAuditEvent({
          avatarId,
          eventType: 'avatar_reassigned',
          actorId: walletAddress || session.email || 'unknown',
          actorType: 'admin',
          details: {
            previousOwner: existing.creatorWallet ?? null,
            newOwner: body.creatorWallet ?? null,
          },
        });
      } catch (auditErr) {
        logger.warn('Failed to record avatar reassignment audit event', {
          avatarId,
          error: auditErr instanceof Error ? auditErr.message : String(auditErr),
        });
      }

      return jsonResponse(corsHeaders, 200, result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to reassign avatar';
      return jsonResponse(corsHeaders, 400, { error: msg });
    }
  }

  // ── GET /avatars/{id}/integrations — List integration statuses ───────────
  const avatarIntegrationsMatch = path.match(/^\/avatars\/([^/]+)\/integrations$/);
  if (method === 'GET' && avatarIntegrationsMatch) {
    const avatarId = avatarIntegrationsMatch[1];

    if (!effectiveIsAdmin) {
      if (!walletAddress) {
        return jsonResponse(corsHeaders, 403, { error: 'Authentication required' });
      }
      const existing = await avatarService.getAvatar(avatarId);
      if (!existing || existing.creatorWallet !== walletAddress) {
        return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
      }
    }

    const statuses = await integrationsService.getAllIntegrationStatuses(avatarId);
    return jsonResponse(corsHeaders, 200, { integrations: statuses });
  }

  // ── GET / PUT / DELETE /avatars/{id} ─────────────────────────────────────
  const avatarIdMatch = path.match(/^\/avatars\/([^/]+)$/);
  if (avatarIdMatch) {
    const avatarId = avatarIdMatch[1];

    // GET /avatars/{id} - Get single avatar
    if (method === 'GET') {
      // Admin branch: unchanged — admins may read any avatar even when no
      // on-chain ownership exists (e.g., a claimed NFT's current holder
      // could have transferred it away).
      if (effectiveIsAdmin) {
        const avatarRaw = await avatarService.getAvatar(avatarId);
        const avatar = avatarRaw ? await hydrateAvatarProfileImage(avatarRaw) : null;
        if (!avatar) {
          return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
        }
        return {
          statusCode: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify(avatar),
        };
      }

      // #1385: non-admin branch enforces current on-chain ownership for
      // NFT-backed avatars via `assertAvatarOwnership`.
      let avatarRaw: Awaited<ReturnType<typeof avatarService.getAvatar>> | null;
      try {
        avatarRaw = await avatarService.assertAvatarOwnership(avatarId, walletAddress ?? '', {
          isAdmin: false,
        });
      } catch (err) {
        if (err instanceof avatarService.AvatarOwnershipError) {
          if (err.code === 'verification_unavailable') {
            return jsonResponse(corsHeaders, 503, {
              error: 'Ownership verification temporarily unavailable',
              code: err.code,
            });
          }
          // not_found | not_owner | nft_revoked — deny without leaking existence.
          return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
        }
        throw err;
      }

      const avatar = avatarRaw ? await hydrateAvatarProfileImage(avatarRaw) : null;
      if (!avatar) {
        return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
      }

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(avatar),
      };
    }

    // PUT /avatars/{id} - Update avatar
    if (method === 'PUT') {
      const body = parseJsonBody<Record<string, unknown>>(event);

      // Non-admin branch: #1385 enforce current on-chain ownership.
      if (!effectiveIsAdmin) {
        if (!walletAddress) {
          return jsonResponse(corsHeaders, 403, { error: 'Authentication required' });
        }
        try {
          await avatarService.assertAvatarOwnership(avatarId, walletAddress, {
            isAdmin: false,
          });
        } catch (err) {
          if (err instanceof avatarService.AvatarOwnershipError) {
            if (err.code === 'verification_unavailable') {
              return jsonResponse(corsHeaders, 503, {
                error: 'Ownership verification temporarily unavailable',
                code: err.code,
              });
            }
            return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
          }
          throw err;
        }
      }

      const avatar = await avatarService.updateAvatar(avatarId, body, session);

      // Audit: record avatar update
      try {
        const actorId = walletAddress || session.email || 'unknown';
        await auditLogService.recordAuditEvent({
          avatarId,
          eventType: 'avatar_updated',
          actorId,
          actorType: resolveActorType(effectiveIsAdmin),
          details: {
            updatedFields: Object.keys(body),
          },
        });
      } catch (err) {
        logger.warn('Failed to record avatar update audit event', {
          avatarId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(avatar),
      };
    }

    // DELETE /avatars/{id} - Delete avatar (creator only for non-admin)
    if (method === 'DELETE') {
      if (!effectiveIsAdmin) {
        if (!walletAddress) {
          return jsonResponse(corsHeaders, 403, { error: 'Authentication required' });
        }
        const existing = await avatarService.getAvatar(avatarId);
        if (!existing || existing.creatorWallet !== walletAddress) {
          return jsonResponse(corsHeaders, 404, { error: 'Avatar not found' });
        }
      }

      await avatarService.deleteAvatar(avatarId, session);

      // Audit: record avatar deletion
      try {
        const actorId = walletAddress || session.email || 'unknown';
        await auditLogService.recordAuditEvent({
          avatarId,
          eventType: 'avatar_deleted',
          actorId,
          actorType: resolveActorType(effectiveIsAdmin),
          details: {},
        });
      } catch (err) {
        logger.warn('Failed to record avatar deletion audit event', {
          avatarId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      return {
        statusCode: 204,
        headers: corsHeaders,
      };
    }
  }

  // No route matched
  return null;
}
